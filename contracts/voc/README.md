# voc / TeaBus-VOC 契約檔(vendored)

從 canonical 來源 `pei760730/voc` 的 `contracts/dedup_vectors.json` 複製過來,給
`tests/dedupConformance.test.ts` 跑跨語言去重 conformance。

- **SSoT 在 voc**：`dedup_vectors.json` 是跨語言去重契約 canonical。clip-collector 寫
  **TeaBus-VOC**(tbvoc),而 tbvoc 經 2026-06-27 與 voc 全面對齊後分群完全一致 → 共用同一份。
  **不要在這裡手改**;改去重規則先改 voc canonical、Python(voc + tbvoc)與 TS(core + sv-bot + clip)
  五側測試一起過,再重新 vendor。
- clip 的去重 `dedupKey` = `@pei760730/collector-core` 的 `groupKey`(經 dep pin)。本檔釘住
  「core groupKey 對 canonical 向量分群等價」,確保 bump core 版本時若 core 與 voc 分叉會先紅。
- 更新時機:voc `contracts/dedup_vectors.json` 變動 → 重新 `cp` 過來。
