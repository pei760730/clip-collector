import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "@telegraf/types";
import { createBot, hotCbData, hotKeyFits, hotKeyboard } from "../src/bot/router.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { HOT_VALUES, type RefRow } from "../src/types.js";
import { dedupKey } from "../src/pipeline/index.js";
import type { Config } from "../src/config.js";

function memoryConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegramToken: "TEST:TOKEN",
    storage: "memory",
    google: null, // memory 乾跑:pool=null,不碰真表
    errorChatId: "",
    allowedChatIds: [], // 預設不限制(乾跑);白名單測試在下方另傳
    expandShortUrls: false,
    logLevel: "info",
    ...overrides,
  };
}

// telegraf 的 handleUpdate 每筆更新會 new 一個 Telegram 實例(telegraf.js),
// 所以攔截點必須在 prototype.callApi(所有實例共用),不能 stub bot.telegram。
const sent: string[] = [];
// sendMessage 是否帶 inline keyboard(夯度按鈕):記錄每則 sendMessage 的 reply_markup。
const sentMarkups: unknown[] = [];
// 夯度 callback 觀測點:answerCallbackQuery 的 text、editMessageReplyMarkup 的 reply_markup。
const cbAnswers: string[] = [];
const editedMarkups: unknown[] = [];
const origCallApi = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function (
  method: string,
  payload?: { text?: string; reply_markup?: unknown },
) {
  if (method === "sendMessage" && payload?.text) {
    sent.push(payload.text);
    sentMarkups.push(payload.reply_markup);
  }
  if (method === "answerCallbackQuery") cbAnswers.push(payload?.text ?? "");
  if (method === "editMessageReplyMarkup") editedMarkups.push(payload?.reply_markup);
  return {} as never;
} as typeof Telegram.prototype.callApi;
afterAll(() => {
  Telegram.prototype.callApi = origCallApi;
});
beforeEach(() => {
  sent.length = 0;
  sentMarkups.length = 0;
  cbAnswers.length = 0;
  editedMarkups.length = 0;
});

function makeBot(storage: MemoryStorage) {
  const bot = createBot(memoryConfig(), storage);
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: "bot",
    username: "testbot",
  } as typeof bot.botInfo;
  return bot;
}

function photoWithCaption(caption: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 123, type: "private", first_name: "Pei" },
      from: { id: 9, is_bot: false, first_name: "Pei" },
      photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
      caption,
    },
  } as unknown as Update;
}

describe("router caption routing", () => {
  it("媒體 caption 裡的連結 → 走 collect 寫入(不再靜默丟失)", async () => {
    const storage = new MemoryStorage();
    const bot = makeBot(storage);

    await bot.handleUpdate(
      photoWithCaption("https://www.tiktok.com/@u/video/7234567890 轉傳的"),
    );

    const all = await storage.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.平台).toBe("tiktok");
    expect(all[0]!.連結).toBe("https://www.tiktok.com/@u/video/7234567890");
    expect(sent.some((t) => t.includes("已收進參考池"))).toBe(true);
    expect(sent.some((t) => t.includes("轉傳的"))).toBe(true); // 備註顯示在回覆
  });

  it("媒體 caption 沒有連結 → 回提示、不寫入(有回覆即非靜默)", async () => {
    const storage = new MemoryStorage();
    const bot = makeBot(storage);

    await bot.handleUpdate(photoWithCaption("純粹一張圖沒連結"));

    expect(await storage.readAll()).toHaveLength(0);
    expect(sent.some((t) => t.includes("看不懂"))).toBe(true);
  });
});

function textFrom(chatId: number, fromId: number, text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 11,
      date: 0,
      chat: { id: chatId, type: "private", first_name: "X" },
      from: { id: fromId, is_bot: false, first_name: "X" },
      text,
    },
  } as unknown as Update;
}

function makeBotWith(storage: MemoryStorage, allowedChatIds: number[]) {
  const bot = createBot(memoryConfig({ allowedChatIds }), storage);
  bot.botInfo = { id: 1, is_bot: true, first_name: "bot", username: "testbot" } as typeof bot.botInfo;
  return bot;
}

describe("router 來源白名單(公開防護)", () => {
  const link = "https://www.tiktok.com/@u/video/7234567890";

  it("名單內的 chat → 正常收錄", async () => {
    const storage = new MemoryStorage();
    const bot = makeBotWith(storage, [555]);
    await bot.handleUpdate(textFrom(555, 999, link));
    expect(await storage.readAll()).toHaveLength(1);
  });

  it("不在名單的陌生 chat/from → 丟棄、不寫入,但回一句無權限提示(含自己的 id)", async () => {
    const storage = new MemoryStorage();
    const bot = makeBotWith(storage, [555]);
    await bot.handleUpdate(textFrom(424242, 717171, link));
    expect(await storage.readAll()).toHaveLength(0); // 沒寫進池
    expect(sent).toHaveLength(1); // errorChatId 未設 → 只回被擋者、不通知管理員
    expect(sent[0]).toContain("你沒有使用權限"); // 不再靜默
    expect(sent[0]).toContain("717171"); // 回顯發訊者自己的 id(from.id),方便截圖給管理員自助上白名單
  });

  it("errorChatId 有設 → 被擋時同時通知管理員(🔔 開頭、含被擋 id)", async () => {
    const storage = new MemoryStorage();
    const bot = createBot(
      memoryConfig({ allowedChatIds: [555], errorChatId: "999000999" }),
      storage,
    );
    bot.botInfo = { id: 1, is_bot: true, first_name: "bot", username: "testbot" } as typeof bot.botInfo;
    await bot.handleUpdate(textFrom(424242, 717171, link));
    // 兩則:回被擋者(含其 id)+ 通知管理員(🔔 開頭、含被擋 id)。
    expect(sent).toHaveLength(2);
    expect(sent.some((t) => t.startsWith("🔔") && t.includes("717171"))).toBe(true);
  });

  it("同一個被擋 chat 連發多則 → 提示只回一次(防灌爆)", async () => {
    const storage = new MemoryStorage();
    const bot = makeBotWith(storage, [555]);
    await bot.handleUpdate(textFrom(424242, 717171, link));
    await bot.handleUpdate(textFrom(424242, 717171, `${link}2`));
    await bot.handleUpdate(textFrom(424242, 717171, "/start"));
    expect(await storage.readAll()).toHaveLength(0); // 全部沒寫進池
    expect(sent).toHaveLength(1); // 提示只有第一則回,後續靜默丟棄
  });

  it("from.id 命中(私訊以外場景)也放行", async () => {
    const storage = new MemoryStorage();
    const bot = makeBotWith(storage, [999]);
    await bot.handleUpdate(textFrom(-100200300, 999, link)); // chat 是某群、但 from 是我
    expect(await storage.readAll()).toHaveLength(1);
  });
});

// ── 夯度 inline 按鈕 callback 路徑(finding: sethot-callback-no-test-coverage) ──
function callbackUpdate(data: string): Update {
  return {
    update_id: 2,
    callback_query: {
      id: "cb1",
      from: { id: 9, is_bot: false, first_name: "Pei" },
      chat_instance: "ci",
      data,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 123, type: "private", first_name: "Pei" },
        from: { id: 1, is_bot: true, first_name: "bot" },
        text: "已收進參考池",
      },
    },
  } as unknown as Update;
}

function seedRow(連結: string): RefRow {
  return { 平台: "tiktok", 連結, 挑: "", 加入日期: "2026-06-26", 夯度: "" };
}

describe("router 夯度 callback", () => {
  const link = "https://www.tiktok.com/@u/video/7234567890";

  it("(a) 正常點按 → setHot(key,值) 被呼叫、回「夯度:値 ✓」、按鈕列標 ✅", async () => {
    const storage = new MemoryStorage([seedRow(link)]);
    const setHot = vi.spyOn(storage, "setHot");
    const bot = makeBot(storage);
    const key = dedupKey(link);
    const idx = 0; // 夯爆了

    await bot.handleUpdate(callbackUpdate(hotCbData(idx, key)));

    expect(setHot).toHaveBeenCalledWith(key, HOT_VALUES[idx]);
    expect(cbAnswers.some((t) => t === `夯度:${HOT_VALUES[idx]} ✓`)).toBe(true);
    // 寫進了參考池該列的夯度欄
    expect((await storage.readAll())[0]!.夯度).toBe(HOT_VALUES[idx]);
    // 按鈕列重繪、選中的標 ✅
    const mk = editedMarkups[0] as { inline_keyboard: { text: string }[][] };
    expect(mk.inline_keyboard[0]![idx]!.text).toBe(`✅ ${HOT_VALUES[idx]}`);
  });

  it("(b) setHot 回 false(已挑走 / 不在池)→ 回「這支已不在參考池」、不重繪按鈕", async () => {
    const storage = new MemoryStorage(); // 空池 → 找不到 key
    const bot = makeBot(storage);
    const key = dedupKey(link);

    await bot.handleUpdate(callbackUpdate(hotCbData(1, key)));

    expect(cbAnswers.some((t) => t.includes("這支已不在參考池"))).toBe(true);
    expect(editedMarkups).toHaveLength(0); // 沒成功就不標 ✅
  });

  it("(c) idx 超界 → 回「未知選項」且不呼叫 setHot", async () => {
    const storage = new MemoryStorage([seedRow(link)]);
    const setHot = vi.spyOn(storage, "setHot");
    const bot = makeBot(storage);
    const key = dedupKey(link);

    // idx = HOT_VALUES.length(超界)→ value === undefined
    await bot.handleUpdate(callbackUpdate(`h:${HOT_VALUES.length}:${key}`));

    expect(setHot).not.toHaveBeenCalled();
    expect(cbAnswers.some((t) => t === "未知選項")).toBe(true);
  });

  it("(d) hotKeyFits 對超長 path key 回 false → router 不掛按鈕(收錄回覆無 inline keyboard)", async () => {
    const storage = new MemoryStorage();
    const bot = makeBot(storage);
    // 抓不到 video id 的未知網域 → dedupKey 退連結路徑;塞超長 path 讓 key 撐破 64 bytes。
    const longPath = "a".repeat(80);
    const longUrl = `https://example.com/${longPath}`;
    expect(hotKeyFits(dedupKey(longUrl))).toBe(false); // 前提成立:這 key 放不下 callback_data

    await bot.handleUpdate(textFrom(0, 0, `${longUrl} note`)); // 空名單 → 不限制,直接收
    // 有收進池(收錄不受 key 長度影響)
    expect(await storage.readAll()).toHaveLength(1);
    expect(sent.some((t) => t.includes("已收進參考池"))).toBe(true);
    // 關鍵:key 放不下 callback_data → router 給 kb===undefined → sendMessage 不帶 reply_markup。
    expect(sentMarkups).toHaveLength(1);
    expect(sentMarkups[0]).toBeUndefined();
  });

  it("(d′) 正常長度 key → 收錄回覆有掛 inline keyboard(對照組)", async () => {
    const storage = new MemoryStorage();
    const bot = makeBot(storage);
    await bot.handleUpdate(textFrom(0, 0, `${link} note`));
    expect(sentMarkups).toHaveLength(1);
    // ctx.reply(text, Markup.inlineKeyboard(...)) → telegraf 把 Markup 的 reply_markup 攤進
    // sendMessage payload,故 callApi 收到的 reply_markup 直接就是 {inline_keyboard:[...]}。
    const mk = sentMarkups[0] as { inline_keyboard?: unknown[] } | undefined;
    expect(mk?.inline_keyboard).toBeTruthy();
  });
});

describe("夯度純函式單元測", () => {
  it("hotCbData 格式 = h:<idx>:<key>", () => {
    expect(hotCbData(0, "tiktok:123")).toBe("h:0:tiktok:123");
    expect(hotCbData(2, "https://x/y")).toBe("h:2:https://x/y");
  });

  it("hotKeyFits:短 key 放得下、超長 key 放不下(64 bytes 上限)", () => {
    expect(hotKeyFits("tiktok:7234567890")).toBe(true);
    expect(hotKeyFits("a".repeat(80))).toBe(false);
  });

  it("hotKeyboard:一排 HOT_VALUES 顆,chosen 該顆標 ✅、其餘原樣", () => {
    const mk = hotKeyboard("tiktok:1", 1) as unknown as {
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    const row = mk.reply_markup.inline_keyboard[0]!;
    expect(row).toHaveLength(HOT_VALUES.length);
    expect(row[1]!.text).toBe(`✅ ${HOT_VALUES[1]}`);
    expect(row[0]!.text).toBe(HOT_VALUES[0]);
    expect(row[0]!.callback_data).toBe(hotCbData(0, "tiktok:1"));
  });

  it("hotKeyboard 預設 chosen=-1 → 都不標 ✅", () => {
    const mk = hotKeyboard("tiktok:1") as unknown as {
      reply_markup: { inline_keyboard: { text: string }[][] };
    };
    for (const b of mk.reply_markup.inline_keyboard[0]!) {
      expect(b.text.startsWith("✅")).toBe(false);
    }
  });
});
