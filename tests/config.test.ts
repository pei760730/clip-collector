/**
 * chat id 白名單嚴格解析:白名單是公開 repo 的防灌池閘門,打錯一項就該紅燈,
 * 不能靠 Number() 把 "1e5"/"0x10"/"12.0" 這種寫法默默吞成「看起來合法」的錯 id
 * (白名單靜默失準,以為有保護其實開了)。用 /^-?\d+$/ 只認純十進位整數。
 * 此組守則從 short-video-bot round-1 #58 的嚴格 regex port 過來,兩邊行為需一致。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { chatIdsEnv } from "../src/config.js";

const KEY = "TEST_CHAT_IDS_STRICT";

afterEach(() => {
  delete process.env[KEY];
});

function parse(raw: string): number[] {
  process.env[KEY] = raw;
  return chatIdsEnv(KEY);
}

describe("chatIdsEnv:嚴格純整數解析", () => {
  it("純十進位整數(含負號)通過", () => {
    expect(parse("123")).toEqual([123]);
    expect(parse("-100")).toEqual([-100]);
    expect(parse("123,-100, 456 ")).toEqual([123, -100, 456]);
  });

  it("未設 / 空字串 → 空陣列", () => {
    delete process.env[KEY];
    expect(chatIdsEnv(KEY)).toEqual([]);
    expect(parse("")).toEqual([]);
    expect(parse("   ")).toEqual([]);
  });

  // Number() 會把這些吞成合法整數 → 必須被 regex 擋下,否則白名單靜默失準
  it.each(["1e5", "0x10", "12.0", "0b1", "0o17", "1_000", "12abc", "abc", "+5", "１２３"])(
    "非純整數字面 '%s' → 丟錯",
    (bad) => {
      expect(() => parse(bad)).toThrow(/非整數 chat id/);
    },
  );

  it("有效項中夾一個壞項也整組丟錯(fail-fast)", () => {
    expect(() => parse("123,1e5,456")).toThrow(/非整數 chat id/);
  });
});

/**
 * ERROR_CHAT_ID 告警鏈斷線提醒(finding: sheets-mode-silent-alert-chain):
 * sheets 模式沒設 ERROR_CHAT_ID 時 notifyError / drain 中止告警全 no-op,
 * 從前開機一聲不吭 —— 這裡釘住「開機 logger.warn 一次」的提醒,以及「有設就不吵」。
 */
describe("loadConfig:sheets 模式 ERROR_CHAT_ID 未設 → 開機 warn", () => {
  const ENV_KEYS = [
    "TELEGRAM_BOT_TOKEN",
    "STORAGE",
    "GOOGLE_SHEET_ID",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "ALLOWED_CHAT_IDS",
    "ERROR_CHAT_ID",
  ] as const;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /**
   * loadConfig 有模組層快取(cached)且 import 時跑 dotenv({override:true}),
   * 所以:resetModules 拿全新模組 → 先 import(讓 dotenv 先蓋)→ 再設測試 env(蓋回來)→ 才呼叫。
   * logger 也從同一個新 registry 動態 import,spy 才會盯到 config.ts 用的那個實例。
   */
  async function loadWithEnv(env: Record<string, string | undefined>) {
    vi.resetModules();
    const { logger } = await import("../src/utils/logger.js");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { loadConfig } = await import("../src/config.js");
    for (const k of ENV_KEYS) saved.set(k, process.env[k]);
    const base: Record<string, string | undefined> = {
      TELEGRAM_BOT_TOKEN: "TEST:TOKEN",
      STORAGE: "sheets",
      GOOGLE_SHEET_ID: "SID",
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "x@y", private_key: "k" }),
      ALLOWED_CHAT_IDS: "123",
      ERROR_CHAT_ID: undefined,
      ...env,
    };
    for (const [k, v] of Object.entries(base)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    loadConfig();
    return warn;
  }

  it("未設 ERROR_CHAT_ID → logger.warn 提醒告警鏈斷線", async () => {
    const warn = await loadWithEnv({});
    expect(warn.mock.calls.some(([m]) => m.includes("ERROR_CHAT_ID"))).toBe(true);
  });

  it("有設 ERROR_CHAT_ID → 不 warn(不濫報)", async () => {
    const warn = await loadWithEnv({ ERROR_CHAT_ID: "660" });
    expect(warn.mock.calls.some(([m]) => m.includes("ERROR_CHAT_ID"))).toBe(false);
  });
});
