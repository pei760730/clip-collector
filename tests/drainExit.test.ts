/**
 * drain 退出碼語意(finding: drain-aborted-exits-zero):
 * 寫入失敗中止(aborted)從前也 exit 0 → collect.yml 綠燈、`if: failure()` 的
 * kai-notify 永不觸發 = 寫表持續壞掉時「靜默丟資料」(Telegram 只留更新 ~24h,
 * 沒人知道要修,重領自癒等於沒有)。這裡釘住三件事:
 *  1. aborted → runDrain 回 2(讓 bootstrap process.exit(2) 紅燈),且退出前先送
 *     ERROR_CHAT_ID 告警、不 ack 失敗段(不再帶新 offset 領下一批)。
 *  2. 未設 ERROR_CHAT_ID 也照樣回 2 —— 紅燈不依賴 Telegram 告警。
 *  3. 正常撈乾 → 回 0,offset 前進 ack。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "@telegraf/types";
import { runDrain } from "../src/drainCore.js";
import { MemoryStorage } from "../src/storage/memory.js";
import type { Config } from "../src/config.js";

function memoryConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegramToken: "TEST:TOKEN",
    storage: "memory",
    google: null,
    errorChatId: "",
    allowedChatIds: [], // 空名單 = 不限制(乾跑),讓測試更新直接進 handler
    expandShortUrls: false,
    logLevel: "info",
    ...overrides,
  };
}

// telegraf 的 handleUpdate 每筆更新會 new 一個 Telegram 實例(telegraf.js),
// 所以攔截點必須在 prototype.callApi(所有實例共用),不能 stub bot.telegram(CLAUDE.md 第三層)。
let pendingBatches: Update[][] = []; // getUpdates 每呼叫一次 shift 一批;空批 = 撈乾
const getUpdatesOffsets: number[] = [];
const sentMessages: { chat_id: unknown; text: string }[] = [];
const origCallApi = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function (
  method: string,
  payload?: { offset?: number; chat_id?: unknown; text?: string },
) {
  if (method === "getMe") {
    return { id: 1, is_bot: true, first_name: "bot", username: "testbot" } as never;
  }
  if (method === "deleteWebhook") return true as never;
  if (method === "getUpdates") {
    getUpdatesOffsets.push(payload?.offset ?? 0);
    return (pendingBatches.shift() ?? []) as never;
  }
  if (method === "sendMessage") {
    sentMessages.push({ chat_id: payload?.chat_id, text: payload?.text ?? "" });
  }
  return {} as never;
} as typeof Telegram.prototype.callApi;
afterAll(() => {
  Telegram.prototype.callApi = origCallApi;
});
beforeEach(() => {
  pendingBatches = [];
  getUpdatesOffsets.length = 0;
  sentMessages.length = 0;
});

const link = "https://www.tiktok.com/@u/video/7234567890";
function textUpdate(updateId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 0,
      chat: { id: 123, type: "private", first_name: "Pei" },
      from: { id: 9, is_bot: false, first_name: "Pei" },
      text,
    },
  } as unknown as Update;
}

/** append 一律炸的 storage:模擬 Sheets 寫入失敗(配額用盡 / SA 失效),觸發 onPersistError。 */
class FailingStorage extends MemoryStorage {
  override async append(): Promise<void> {
    throw new Error("quota exceeded");
  }
}

describe("drain 退出碼語意(aborted → 2,正常 → 0)", () => {
  it("寫入失敗中止 → 回 2、先送 ERROR_CHAT_ID 告警、失敗段不 ack(不再領下一批)", async () => {
    pendingBatches = [[textUpdate(42, `${link} note`)]];
    const code = await runDrain(memoryConfig({ errorChatId: "660" }), new FailingStorage());
    expect(code).toBe(2);
    // 告警先於退出送達 ERROR_CHAT_ID(runDrain 回傳前已 await):含「drain 中止」總結。
    const alerts = sentMessages.filter((m) => String(m.chat_id) === "660");
    expect(alerts.some((m) => m.text.includes("drain 中止"))).toBe(true);
    // 中止 = 停在原 offset:只打了第一次 getUpdates(0),沒帶新 offset ack 失敗段。
    expect(getUpdatesOffsets).toEqual([0]);
  });

  it("寫入失敗但未設 ERROR_CHAT_ID → 仍回 2(紅燈不依賴 Telegram 告警)", async () => {
    pendingBatches = [[textUpdate(42, `${link} note`)]];
    const code = await runDrain(memoryConfig(), new FailingStorage());
    expect(code).toBe(2);
    expect(sentMessages.some((m) => m.text.includes("drain 中止"))).toBe(false);
  });

  it("全部撈乾且寫入成功 → 回 0,第二次 getUpdates 帶 update_id+1 ack", async () => {
    const storage = new MemoryStorage();
    pendingBatches = [[textUpdate(42, `${link} note`)], []];
    const code = await runDrain(memoryConfig(), storage);
    expect(code).toBe(0);
    expect(await storage.readAll()).toHaveLength(1); // 真的寫進池
    expect(getUpdatesOffsets).toEqual([0, 43]); // 43 = update_id+1(累積 ack 語意)
  });
});
