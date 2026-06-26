/**
 * 共用型別改由 @pei760730/collector-core 提供(PR-6,re-export 保持 import 路徑不變)。
 * RefRow / POOL_COLUMNS / HOT_VALUES 是 TeaBus-VOC「參考池」schema —— collector 專屬寫入契約,留本地。
 * (clip-collector 比個人版多「夯度」欄:分享者 inline 一鍵下標。)
 */
export type {
  Platform,
  DetectionMethod,
  ParsedMessage,
  CleanedUrl,
  PlatformInfo,
  VideoIdInfo,
} from "@pei760730/collector-core";
export { PLATFORM_CODE } from "@pei760730/collector-core";

/**
 * 「參考池」一列資料 —— 欄位即 TeaBus-VOC `schema.REFS`,鍵名/順序就是 Sheet 表頭,不要改。
 *
 * 參考池 5 欄(2026-06-26 契約;砍掉 id,加 夯度):
 * - 平台      :小寫碼(PLATFORM_CODE)。
 * - 連結      :乾淨連結 —— 「打開」+ 去重的唯一 key(= 參考池的身份)。
 * - 挑        :checkbox,留空(=還沒挑);勾它 → GAS 即時搬待拍。
 * - 加入日期  :ISO YYYY-MM-DD(新鮮度;voc `normalize_date` 也吃 ISO)。
 * - 夯度      :分享者一鍵下標(收錄時留空,點 inline 按鈕後由 callback 寫入):夯爆了/NPC/拉完了。
 *
 * 去重 key 由連結即時推導(見 pipeline `dedupKey` = core groupKey),不存欄。
 */
export interface RefRow {
  平台: string;
  連結: string;
  挑: string;
  加入日期: string; // ISO YYYY-MM-DD (Asia/Taipei)
  夯度: string; // 收錄時留空;分享者點 inline 按鈕後由 callback 寫入(夯爆了/NPC/拉完了)
}

/** 「參考池」表頭順序(SSOT),與 TeaBus-VOC schema.REFS.columns 對齊。夯度 一律在最後(voc init-sheet 不錯位)。 */
export const POOL_COLUMNS: (keyof RefRow)[] = ["平台", "連結", "挑", "加入日期", "夯度"];

/**
 * 夯度可選值(與 TeaBus-VOC `schema.HOT_VALUES` 鏡像;順序 = inline 按鈕順序與 callback 索引)。
 * 分享者一鍵直覺判斷(非 AI):夯爆了=爆款優先、NPC=路人普通、拉完了=做爛了跳過。
 */
export const HOT_VALUES = ["夯爆了", "NPC", "拉完了"] as const;
