/**
 * 平台碼 → emoji 與「支援平台」清單的單一 SSoT。
 * 原本 stats.ts 與 templates.ts 各自手組 ICON_BY_CODE、templates 的支援清單又是手寫硬字串,
 * core 加/改平台時得多處同步、漏一處就漂移;集中在這裡派生自 PLATFORM_CODE × PLATFORM_ICON。
 * (core 於 collector-core 已內建 ICON_BY_CODE;待本 repo bump core 版後可改直接 import。)
 */
import { PLATFORM_ICON } from "@pei760730/collector-core";

import { PLATFORM_CODE, type Platform } from "./types.js";

/** 小寫平台碼(tiktok…) → emoji。row.平台 存的是碼,不是顯示名。 */
export const ICON_BY_CODE: Record<string, string> = Object.fromEntries(
  (Object.keys(PLATFORM_CODE) as Platform[]).map((p) => [PLATFORM_CODE[p], PLATFORM_ICON[p]]),
);

export function iconFor(code: string): string {
  return ICON_BY_CODE[code] ?? "•";
}

/** 支援平台顯示名(排除 Unknown),動態自 PLATFORM_CODE 派生,避免手寫清單與 core 漂移。 */
export const SUPPORTED_PLATFORMS: string[] = (Object.keys(PLATFORM_CODE) as Platform[]).filter(
  (p) => p !== "Unknown",
);
