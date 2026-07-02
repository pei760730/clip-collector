/**
 * 與上游 VOC 引擎對接契約的 drift-catcher(跨 repo)。
 *
 * 這份測試把「散文契約」變成 CI 守的不變式:任何一方改欄名 / 改平台碼,這裡先紅,
 * 不會等到線上靜默漏資料才發現。
 *
 * 對手檔 = 上游 VOC 引擎 `contracts/schema.json`(由 tbvoc `src/tbvoc/schema.py` +
 * `normalize.py` codegen),vendored 到 `contracts/teabus/`(上游是 private repo、
 * clip-collector public 無法跨 repo 抓;上游契約更新時重新 vendor —— 見
 * contracts/teabus/README.md)。
 *
 * 從前這裡手抄 VOC_REFS_COLUMNS / VOC_PLATFORM_CODES 鏡像常數,改 tbvoc 忘了同步就默默壞;
 * 改成載入 vendored 契約後,SSoT 單一化、漂移即紅。
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { POOL_COLUMNS, PLATFORM_CODE, type Platform } from "../src/types.js";
import { detectPlatform } from "../src/pipeline/detectPlatform.js";

// 上游 VOC 引擎發布的 collector 契約(欄名 / 平台碼)。schema.json 只認需要的欄位。
interface EngineSchema {
  schemaVersion: string;
  columns: string[];
  platformCodes: string[];
}

// vendored schema 過期偵測的最低門檻:上游 tbvoc bump 了 schemaVersion 卻忘了重新 vendor 時,
// 這個常數會比 vendored copy 舊 → 斷言先紅。提醒:更新 contracts/teabus/schema.json 後,
// 若上游真的 bump 了版本,也要把這個常數一起調上去(否則新版 vendor 進來這條斷言反而恆過、失去守門)。
// 注意:這只擋「版本號落後」,擋不住「同版本號內欄位/平台碼悄悄漂移」——
// 那仍靠手動 cp + contracts/teabus/README.md 的重新 vendor 流程(本檔上半的欄名/平台碼斷言守同版內容)。
const MIN_SCHEMA_VERSION = "1";

const schema: EngineSchema = JSON.parse(
  readFileSync(new URL("../contracts/teabus/schema.json", import.meta.url), "utf8"),
) as EngineSchema;

describe("上游 VOC 引擎契約:vendored schema 版本不落後", () => {
  it(`vendored schemaVersion(${schema.schemaVersion})>= 預期最低版本(${MIN_SCHEMA_VERSION})`, () => {
    // 版本碼是純數字字串(目前 "1"),用數值比較避免 "10" < "2" 的字典序坑。
    expect(Number(schema.schemaVersion)).toBeGreaterThanOrEqual(Number(MIN_SCHEMA_VERSION));
  });
});

describe("上游 VOC 引擎契約:參考池欄名/順序", () => {
  it("ClipBot 寫的參考池欄名/順序 == tbvoc schema.json columns", () => {
    expect(POOL_COLUMNS).toEqual(schema.columns);
  });

  it("夯度 必在最後一欄(init-sheet 只改表頭,插中間會錯位舊資料)", () => {
    expect(schema.columns[schema.columns.length - 1]).toBe("夯度");
    expect(POOL_COLUMNS[POOL_COLUMNS.length - 1]).toBe("夯度");
  });
});

describe("上游 VOC 引擎契約:bot 平台碼 ⊆ tbvoc 認得的小寫碼", () => {
  it("每個正式平台(非 Unknown)的碼都 ⊆ schema.platformCodes", () => {
    const allowed = new Set(schema.platformCodes);
    for (const p of Object.keys(PLATFORM_CODE) as Platform[]) {
      if (p === "Unknown") continue; // Unknown→"unknown" 是 fallback,不在引擎平台碼集合內
      expect(allowed.has(PLATFORM_CODE[p])).toBe(true);
    }
  });

  // 每平台一個代表性連結 → 偵測得出非 Unknown 平台(host 規則沒漏)、碼落在契約集合。
  const samples: [string, string][] = [
    ["tiktok", "https://www.tiktok.com/@u/video/123"],
    ["youtube", "https://youtu.be/abcdefghijk"],
    ["facebook", "https://www.facebook.com/watch?v=1"],
    ["instagram", "https://www.instagram.com/reel/abc"],
    ["threads", "https://www.threads.net/@u/post/DZwtc9Jk7Yf"],
    ["x", "https://x.com/a/status/1"],
    ["douyin", "https://www.douyin.com/video/123"],
    ["xiaohongshu", "https://www.xiaohongshu.com/explore/abc123"],
  ];
  const allowed = new Set(schema.platformCodes);
  for (const [code, url] of samples) {
    it(`${url} → 偵測非 Unknown、碼=${code} 且 ⊆ 契約`, () => {
      const platform = detectPlatform(url).platform;
      expect(platform).not.toBe("Unknown");
      expect(PLATFORM_CODE[platform]).toBe(code);
      expect(allowed.has(code)).toBe(true);
    });
  }
});
