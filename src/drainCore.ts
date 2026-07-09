/**
 * drain 迴圈本體(從 drain.ts entry 抽出) —— 領更新→處理→ack,回傳「進程退出碼」。
 *
 * 為什麼抽出來:drain.ts 是 entry(import 即跑 main + 真連線),測試無法載入;
 * 抽成可注入 config/storage 的函式後,tests/drainExit.test.ts 才能用
 * Telegram.prototype.callApi stub(CLAUDE.md 第三層攔截點)釘住退出碼語意。
 *
 * 退出碼契約(collect.yml 的紅綠燈就吃這個):
 * - 0 = 撈乾且全部寫入成功。
 * - 2 = 寫入失敗中止(aborted):有更新沒持久化,刻意不 ack 留給下次 cron 重領。
 *   從前 aborted 也 exit 0 → Actions 綠燈、`if: failure()` 的 kai-notify 永不觸發,
 *   寫表持續壞掉(SA 失效/配額炸)會靜默丟資料 —— Telegram 只留更新 ~24h,重領
 *   自癒的前提是「有人知道要修」,所以必須紅燈。
 * - 1 = 整體崩潰(config 缺、getUpdates 炸掉等),由 drain.ts bootstrap 的 catch 負責。
 */
import { createBot } from "./bot/router.js";
import type { Config } from "./config.js";
import type { Storage } from "./storage/Storage.js";
import { logger } from "./utils/logger.js";

export async function runDrain(config: Config, storage: Storage): Promise<number> {
  await storage.ensureHeader();

  // persistFailed:某筆寫入參考池失敗(可重試)的 side-channel 旗標。每筆處理前歸零,
  // handleUpdate 內若觸發 onPersistError 會翻 true → 該筆「沒持久化」,不能 ack。
  let persistFailed = false;
  const bot = createBot(config, storage, {
    onPersistError: () => {
      persistFailed = true;
    },
  });
  // handleUpdate 要 botInfo 才能正確解析群組內的 /command@botname;先抓好(launch 平時會做)。
  bot.botInfo = await bot.telegram.getMe();
  // 確保沒有殘留 webhook(否則 getUpdates 回 409 Conflict);保留待領更新不丟。
  await bot.telegram.deleteWebhook({ drop_pending_updates: false });

  let offset = 0;
  let processed = 0;
  let aborted = false;
  outer: for (;;) {
    // timeout=0 → 不長等:有就回、沒有立刻回空(一次性語意,不要 block 住 Actions)。
    const updates = await bot.telegram.getUpdates(0, 100, offset, undefined);
    if (updates.length === 0) break;
    for (const u of updates) {
      persistFailed = false;
      try {
        await bot.handleUpdate(u);
      } catch (err) {
        // 解析/路由層的非預期例外(非寫入失敗):這類重領也沒用,記錄後跳過。
        logger.error(`處理 update ${u.update_id} 例外(跳過)`, err);
      }
      if (persistFailed) {
        // 寫入失敗(可重試):不前進 offset、結束整個 drain。前面成功的那段下次 cron 的
        // 第一次 getUpdates(offset) 會 ack;這筆與之後的會被重領,靠 storage 連結 key 去重。
        // 這樣才真正 at-least-once,不會把沒寫成功的訊息默默 ack 掉(CLAUDE.md 紅線)。
        logger.error(`update ${u.update_id} 寫入參考池失敗 → 停在此 offset,結束本輪讓下次 cron 重領`);
        aborted = true;
        break outer;
      }
      offset = u.update_id + 1; // 帶到下一輪 getUpdates 即 ack 本批(累積語意)
      processed += 1;
    }
  }
  // 正常結束時最後一次「空批」getUpdates(offset) 已 ack 最後一批,不需額外補 ack。
  // 中止結束時刻意不 ack 未處理段,留給下次 cron 重領。

  logger.info(`drain ${aborted ? "中止(寫入失敗,部分未處理)" : "完成"}:已處理 ${processed} 筆更新`);
  // 不 prune:參考池是 tbvoc 永久池,bot 只 append 不刪列(prune 已隨暫存區一起退役)。

  if (!aborted) return 0;

  // 先送 Telegram 告警、再回非零碼(bootstrap 才 process.exit):第一時間直達 ERROR_CHAT_ID;
  // 告警本身失敗不影響退出碼 —— 紅燈(exit 2 → collect.yml failure → kai-notify)是兜底,不能被吞。
  if (config.errorChatId) {
    await bot.telegram
      .sendMessage(
        config.errorChatId,
        `🐞 drain 中止:寫入參考池失敗(已成功 ${processed} 筆後停下),未 ack 段留待下次 cron 重領。詳見 Actions log。`,
      )
      .catch((e) => logger.error("通知 error chat 失敗", e));
  }
  return 2;
}
