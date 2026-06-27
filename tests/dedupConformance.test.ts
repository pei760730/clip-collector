/**
 * 跨語言去重契約 conformance(TS / clip 側)。
 *
 * clip-collector 寫 TeaBus-VOC(tbvoc)的「參考池」,去重 `dedupKey` = @pei760730/collector-core
 * 的 `groupKey`(經 dep pin)。本檔釘住「core groupKey 對 canonical 向量分群等價」——
 * bump core 版本時若 core 與 voc/tbvoc 分叉(same_group 不收斂 / distinct 撞 / edge id-path 跑掉),
 * 這裡先紅,不會等到線上靜默漏去重才發現。
 *
 * 對手檔 = canonical `contracts/voc/dedup_vectors.json`(來源 voc,tbvoc 2026-06-27 已對齊共用)。
 * Python 側由 voc / tbvoc 的 test_dedup_contract 守同一份;格式(`:` vs `_`)允許不同,只驗分群等價。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { dedupKey } from "../src/pipeline/index.js";

interface DedupVectors {
  same_group: { name: string; urls: string[] }[];
  distinct: { name: string; urls: string[] }[];
  edge_cases: { name: string; why: string; url: string; expect: "id" | "path" }[];
}

// canonical 去重向量 = @pei760730/collector-core 隨包發布的 contracts/voc/dedup_vectors.json。
// 不再 vendor 進本 repo;改去重規則 → 先改 core canonical → bump core tag → 兩邊測試先紅逼同步。
const _vectorsPath = createRequire(import.meta.url).resolve(
  "@pei760730/collector-core/contracts/voc/dedup_vectors.json",
);
const vectors: DedupVectors = JSON.parse(readFileSync(_vectorsPath, "utf8"));

// path-fallback key 是砍 query 後的乾淨連結(以 http 開頭);id key 是平台前綴_id。
const isPathKey = (k: string): boolean => k.startsWith("http");

describe("voc/tbvoc 去重契約:same_group 收斂同一 key", () => {
  for (const g of vectors.same_group) {
    it(`「${g.name}」`, () => {
      const keys = new Set(g.urls.map(dedupKey));
      expect(keys.size).toBe(1);
    });
  }
});

describe("voc/tbvoc 去重契約:distinct 互不同 key", () => {
  for (const g of vectors.distinct) {
    it(`「${g.name}」`, () => {
      const keys = g.urls.map(dedupKey);
      expect(new Set(keys).size).toBe(keys.length);
    });
  }
});

describe("voc/tbvoc 去重契約:edge_cases 的 id/path 預期", () => {
  for (const e of vectors.edge_cases) {
    it(`「${e.name}」→ ${e.expect}`, () => {
      const got = isPathKey(dedupKey(e.url)) ? "path" : "id";
      expect(got).toBe(e.expect);
    });
  }
});
