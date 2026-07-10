/**
 * drain —— 一次性把 Telegram 這 24h 內囤的更新撈乾、處理、寫進「參考池」,然後結束。
 *
 * 取代常駐 long polling:給 GitHub Actions cron 週期呼叫,$0、不需常駐機器,
 * 也避開 Docker-on-WSL2 對 googleapis 大封包的 Premature close(Actions 跑 ubuntu 直連)。
 *
 * 為什麼「定時撈一次」不漏訊息:Telegram 會保留未領取的更新約 24h。只要 cron 間隔 < 24h,
 * 每次把待領更新領乾即可。用 getUpdates(offset) 逐批領 + ack(下一次帶新 offset 即確認上一批);
 * 處理走和常駐完全相同的 `bot.handleUpdate`,行為一致、不重寫邏輯。
 *
 * 失敗語意:中途崩潰沒 ack → 下次 cron 重領,storage 去重(連結 key)擋掉重複。
 * at-least-once,寧可重複看得到也不要遺失(對齊 voc move_row 的同款取捨)。
 * 寫入失敗中止(aborted)→ exit 2 讓 collect.yml 紅燈(退出碼契約見 drainCore.ts)。
 *
 * 本檔只剩 entry(組 config/storage → runDrain → 帶碼退出);迴圈本體在 drainCore.ts(可測)。
 */
import { loadConfig } from "./config.js";
import { runDrain } from "./drainCore.js";
import { GoogleSheetsStorage } from "./storage/googleSheets.js";
import { MemoryStorage } from "./storage/memory.js";
import type { Storage } from "./storage/Storage.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<number> {
  const config = loadConfig();
  // DATE / 去重窗一律 Asia/Taipei(utils/date.ts 寫死),不靠 process.env.TZ。

  let storage: Storage;
  if (config.storage === "memory") {
    storage = new MemoryStorage();
    logger.warn("STORAGE=memory 乾跑:不寫真表,只驗領取/處理流程");
  } else {
    if (!config.google) throw new Error("sheets 模式缺 Google 設定");
    storage = new GoogleSheetsStorage({
      credentials: config.google.credentials,
      sheetId: config.google.sheetId,
      sheetName: config.google.poolSheetName,
    });
  }
  return runDrain(config, storage);
}

// 顯式退出:避免 telegraf/gaxios 殘留 keep-alive handle 讓 Actions job 卡到 timeout。
// 退出碼:0=完成、2=寫入失敗中止(runDrain 決定)、1=整體崩潰;非零 → collect.yml 紅燈 → kai-notify。
main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logger.error("drain 失敗", err);
    process.exit(1);
  });
