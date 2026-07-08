/**
 * 平台碼 → emoji 與「支援平台」清單。
 * iconFor / ICON_BY_CODE 已抽進 collector-core(v0.3.0,派生自 PLATFORM_CODE × PLATFORM_ICON),
 * 三個 collector 共用一份;本檔直接 re-export。SUPPORTED_PLATFORMS 是 clip-collector 專屬(未抽 core),
 * 留本地,動態自 core 的 PLATFORM_CODE 派生。
 */
export { iconFor, ICON_BY_CODE } from "@pei760730/collector-core";

import { PLATFORM_CODE, type Platform } from "./types.js";

/** 支援平台顯示名(排除 Unknown),動態自 PLATFORM_CODE 派生,避免手寫清單與 core 漂移。 */
export const SUPPORTED_PLATFORMS: string[] = (Object.keys(PLATFORM_CODE) as Platform[]).filter(
  (p) => p !== "Unknown",
);
