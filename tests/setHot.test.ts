/**
 * setHot：回填「夯度」的真表寫入路徑(找列號 + colLetter(夯度) + values.update A1)。
 * 原本只在 router 測試用 MemoryStorage 驗過,Sheets 實作零覆蓋;這裡用與 drainDedup 同款的
 * fake sheets client 補齊,斷言 update 打到正確 A1、找不到列時不打 update。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const updateCalls: Array<{ range: string; values: string[][] }> = [];
let dataRows: string[][] = [];

const fakeSheets = {
  spreadsheets: {
    get: vi.fn(async () => ({ data: { sheets: [{ properties: { title: "參考池" } }] } })),
    values: {
      get: vi.fn(async ({ range }: { range: string }) => {
        if (/!1:1$/.test(range)) {
          return { data: { values: [["平台", "連結", "挑", "加入日期", "夯度"]] } };
        }
        return { data: { values: dataRows.map((r) => [...r]) } };
      }),
      update: vi.fn(async ({ range, requestBody }: { range: string; requestBody: { values: string[][] } }) => {
        updateCalls.push({ range, values: requestBody.values });
        return { data: {} };
      }),
      append: vi.fn(async () => ({ data: {} })),
    },
  },
};

vi.mock("googleapis", () => ({
  google: { auth: { JWT: class {} }, sheets: () => fakeSheets },
}));

const { GoogleSheetsStorage } = await import("../src/storage/googleSheets.js");
const { dedupKey } = await import("../src/pipeline/index.js");

function makeStorage() {
  return new GoogleSheetsStorage({
    credentials: { client_email: "x@y", private_key: "k" },
    sheetId: "SID",
    sheetName: "參考池",
  });
}

beforeEach(() => {
  updateCalls.length = 0;
  dataRows = [];
});

const URL = "https://www.tiktok.com/@u/video/7234567890";

describe("setHot", () => {
  it("找到列 → 更新夯度欄正確 A1(E2)、回 true", async () => {
    dataRows = [["tiktok", URL, "", "2026-07-08", ""]]; // sheet 第 2 列(row 1 是表頭)
    const storage = makeStorage();
    const ok = await storage.setHot(dedupKey(URL), "5");
    expect(ok).toBe(true);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.range).toMatch(/E2$/); // 夯度=第5欄(E),資料在 sheet 第2列
    expect(updateCalls[0]!.values).toEqual([["5"]]);
  });

  it("找不到列(已挑走)→ 不打 update、回 false", async () => {
    dataRows = [];
    const storage = makeStorage();
    const ok = await storage.setHot("nonexistent-key", "5");
    expect(ok).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });
});
