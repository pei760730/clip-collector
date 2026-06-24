# TeaBus-ClipBot

> **緣起**：給客戶**紅茶巴士**的短影音收集 bot，從 [`short-video-bot`](https://github.com/pei760730/short-video-bot) 複製改造（FB 影片 ID 抽取 port 自姊妹源 [`OF-DOG`](https://github.com/pei760730/OF-DOG)）。引擎完全相同，只把上游對接從 voc 換成 **TeaBus-VOC**。
>
> **待辦**：TeaBus-VOC 尚未建立 —— 開好後把它的 spreadsheet id 填進 `.env` 的 `GOOGLE_SHEET_ID`，並共用同一把 service account。下游契約見 [`CLAUDE.md`](./CLAUDE.md) §6。

Telegram 短影音收集 bot —— 取代原本跑在 n8n 上的流程,改成獨立、可自架、可版本控管的 **Node.js + TypeScript** 服務。功能與 n8n workflow 等價,並修掉舊版已知問題(見[末段](#改自-n8n-版的修正))。

在 Telegram 貼「**連結 + 備註**」,bot 會:**解析 → 清理網址 → 判斷平台 → 抽 video ID → 去重 → 直接寫進 TeaBus-VOC 的 Google Sheet「參考池」分頁 → 回報**。

> 2026-06-22:廢「暫存區」中間層。TeaBus-VOC 已砍 sync-pool(暫存區→參考池 每日複製),bot 與 TeaBus-VOC 同表同 SA,直寫參考池就是最終狀態。

---

## 目錄

- [運作概覽](#運作概覽)
- [收集 pipeline](#收集-pipeline)
- [去重(dedup)機制](#去重dedup機制)
- [支援平台](#支援平台)
- [指令](#指令)
- [專案結構](#專案結構)
- [安裝 / 開發](#安裝--開發)
- [設定(.env)](#設定env)
- [部署](#部署)
- [與 TeaBus-VOC 對接](#與-teabus-voc-對接)
- [工具腳本](#工具腳本)
- [測試](#測試)
- [設計原則](#設計原則)
- [疑難排解](#疑難排解)
- [改自 n8n 版的修正](#改自-n8n-版的修正)

---

## 運作概覽

```
            ┌─────────────┐      貼「連結+備註」      ┌──────────────────┐
   使用者 ──▶│  Telegram    │ ───────────────────────▶ │  TeaBus-ClipBot   │
            └─────────────┘                            │ (本服務,純函式)  │
                                                       └────────┬─────────┘
                                                                │ append(去重後)
                                                                ▼
                                                ┌──────────────────────────────┐
                                                │  Google Sheet「參考池」分頁    │
                                                │  (= TeaBus-VOC 同一張表同一 SA) │
                                                └──────────────────────────────┘
                                                                │ 人在 Sheet 勾「挑」
                                                                ▼  → GAS 搬待拍
                                                          TeaBus-VOC 消費
```

bot 是上游唯一寫入者:只 **append** 進參考池,不刪列、不改表頭。挑片不經 bot —— 人在 Sheet 勾「挑」checkbox,TeaBus-VOC 的 GAS 即時把那列搬進「待拍」。

---

## 收集 pipeline

每則訊息走一條由純函式串成的流水線,產出一筆「參考池」草稿列:

| 步驟 | 檔案 | 做什麼 |
|------|------|--------|
| `parse` | [`src/pipeline/parse.ts`](src/pipeline/parse.ts) | 抽訊息裡**第一個**網址 + 其餘文字當備註 + 提交者名;無網址丟 `NoUrlError` |
| `cleanUrl` | [`src/pipeline/cleanUrl.ts`](src/pipeline/cleanUrl.ts) | 補 `https://`、解 FB 轉址(`l.facebook.com/l.php?u=`)、行動版→桌面版 host、去追蹤參數(utm/fbclid/igsh/xsec_token…)、短網址偵測 |
| `detectPlatform` | [`src/pipeline/detectPlatform.ts`](src/pipeline/detectPlatform.ts) | 依 **hostname 結尾**比對 8 平台(非子字串,擋 `tiktok.com.evil.com`);認不得 → `Unknown`,不誤猜 Instagram |
| `extractVideoId` | [`src/pipeline/extractVideoId.ts`](src/pipeline/extractVideoId.ts) | 依平台 regex 抽帶前綴的影片 id(供去重 key);抓不到 → `unknown_<ts>` 並標 `unsupported` |
| `dedupKey` | [`src/pipeline/index.ts`](src/pipeline/index.ts) | 連結 → 去重 key(平台:影片id 優先,抽不到退連結路徑;對齊 TeaBus-VOC `sync._dedup_key`) |

純函式組裝在 [`src/pipeline/index.ts`](src/pipeline/index.ts) 的 `buildDraft` / `assembleDraft`。**去重比對 + 寫入**屬 I/O,隔在 collect handler([`src/bot/handlers/collect.ts`](src/bot/handlers/collect.ts)):

```
讀參考池「連結」欄 → 候選 key 與既有列 key 比對
  ├─ 命中 → 回「已收過」提醒,不寫入
  └─ 不命中 → append 進「參考池」(4 欄、平台小寫碼、加入日期 ISO) → 回成功
```

> 同連結極短時間連發時,collect 用 `serialize()` 把「查重→append」序列化,擋並發雙寫。

---

## 去重(dedup)機制

去重是這支 bot 的核心,規則與 TeaBus-VOC 對齊:

- **key 演算法**(`dedupKey`):優先「**平台:影片id**」——同支影片的 `youtu.be/`、`watch?v=`、`shorts/` 三形態收斂成**同一 key**;FB 的 `watch?v=N` 與 `/videos/N` 也收斂。抽不到影片 id(平台不支援 / 連結沒帶 id)才退回**連結路徑 key**(砍 query/fragment、去尾斜線、轉小寫)。
- **全表比對、無時間窗**:參考池是 TeaBus-VOC 永久池(不像舊暫存區會 prune),所以比對整張參考池、不限時間。
- **候選與既有列走同一支 `dedupKey`**:吃同樣的乾淨連結,兩邊算出的 key 一致才能正確比對。
- **範圍限制(刻意)**:只比對**參考池**的「連結」欄,**不**比對「待拍 / 完成」。被挑走搬離參考池的素材若再次分享,會被當新素材再收一筆 —— 換取 bot 不耦合 TeaBus-VOC 全 schema。日後重複太多再擴範圍。

---

## 支援平台

| 平台 | Icon | 影片 ID(去重 key 前綴) |
|------|------|----------|
| TikTok | 🎵 | `tiktok_<id>`(`/video/<id>`、`item_id=`、19 位純數字路徑) |
| YouTube | 📺 | `yt_<id>`(`watch?v=` / `youtu.be/` / `shorts/` / `embed/` / `live/`,ID 恰 11 碼) |
| Facebook | 📘 | `fbw_<code>`(fb.watch)、`fb_<id>`(reel·reels·videos·`watch?v=`·`story_fbid`)、`fbs_<code>`(`share/[rvp]/`);皆不中 → `unknown_<ts>` |
| Instagram | 📸 | `ig_<code>`(`/p/` / `/reel/`) |
| Threads | 🧵 | `threads_<id>`(`/post/`) |
| X (Twitter) | 🐦 | 無抽取規則 → `unknown_<ts>` |
| 抖音 | 🎶 | 無抽取規則 → `unknown_<ts>` |
| 小紅書 | 📕 | `xhs_<id>`(`/explore/` / `/discovery/item/`) |

> 影片 ID **只進去重 key,不寫進 Sheet、不出現在回覆**。寫入參考池的「平台」欄是統一小寫碼(`tiktok`/`youtube`/`facebook`…),由 [`src/types.ts`](src/types.ts) 的 `PLATFORM_CODE` 定義。
> 抓不到影片 id(X / 抖音 / 不帶 id 的連結)不代表收不了 —— 仍會收,只是改用**連結路徑**當去重 key,並在回覆標「以連結本身去重收錄」。

---

## 指令

| 指令 | 行為 |
|------|------|
| 一般訊息(含網址) | 走完整收集 pipeline,回成功 / 重複 / 寫入失敗 |
| 無網址 / 格式錯誤 | 回格式錯誤提示 + 範例 |
| `/stats` | 讀「參考池」:總筆數 + 各平台分布 + 本週/本月新增 + 最近 5 筆 |

> `/stats`([`src/bot/handlers/stats.ts`](src/bot/handlers/stats.ts))統計的是**目前池中未挑**的素材 —— 已挑走的會搬離參考池,不計入。
> 挑片**沒有 bot 指令**:在 Sheet 勾「挑」→ GAS 搬待拍。`/pick`(2026-06-23)、`/move`(更早)皆已退役。

---

## 專案結構

```
src/
  index.ts              常駐入口(long polling / webhook;BOT_MODE 決定)
  drain.ts              一次性撈乾入口(GitHub Actions cron 用;getUpdates→處理→ack→結束)
  config.ts             讀 env → 型別化 config(缺必要變數 fail-fast)
  types.ts              SSOT:Platform / PLATFORM_CODE / RefRow / POOL_COLUMNS
  pipeline/             純函式收集流水線(parse/cleanUrl/detectPlatform/extractVideoId/index)
  storage/
    Storage.ts          儲存介面(readRows/append/…)
    googleSheets.ts     Google Sheets 實作(寫 RAW、驗表頭)
    memory.ts           測試/乾跑用記憶體實作
    computeStats.ts     /stats 統計計算(純函式)
  bot/
    router.ts           Telegraf 路由 + 錯誤通知
    handlers/collect.ts 收集 handler(runCollect,不依賴 Telegraf,好測)
    handlers/stats.ts   /stats handler
  messages/templates.ts 回覆訊息模板(一律純文字)
  utils/                date(Asia/Taipei ISO)、expandUrl、logger
scripts/                一次性工具(見下方「工具腳本」)
tests/                  vitest(每個 pipeline 步驟 + handler + 契約)
.github/workflows/      ci.yml(test+typecheck)、collect.yml(cron drain)
```

---

## 安裝 / 開發

需求:**Node.js ≥ 20**。

```bash
npm install
cp .env.example .env      # 填 TELEGRAM_BOT_TOKEN 與 Google 憑證(見下)

npm run dev               # tsx watch,long polling(改檔即重啟)
npm test                  # vitest 跑一輪
npm run test:watch        # vitest watch
npm run typecheck         # tsc(含 tests,不產出檔)
npm run build && npm start # 編譯到 dist/ 後跑常駐版
```

> 只想試 bot 回覆、不想接真表:設 `STORAGE=memory`,就只需要 `TELEGRAM_BOT_TOKEN`,不碰 Google 憑證(寫進記憶體、重啟即失)。

---

## 設定(.env)

機密一律走 env,**不進版控**(`.gitignore` 已擋 `.env` 與 `service_account.json`)。缺必要變數啟動就丟錯(fail-fast)。

### Telegram / 模式

| 變數 | 預設 | 說明 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` | (必填) | BotFather token |
| `BOT_MODE` | `polling` | `polling` 或 `webhook`(正式部署其實走 cron drain,不靠常駐) |
| `STORAGE` | `sheets` | `sheets`(寫 Google,需憑證)或 `memory`(乾跑,只需 token) |
| `WEBHOOK_DOMAIN` | — | `webhook` 模式必填:對外可達網址 |
| `WEBHOOK_PATH` | `/telegraf` | webhook 路徑 |
| `PORT` | `8080` | webhook 監聽埠 |

### Google Sheets

| 變數 | 預設 | 說明 |
|------|------|------|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | — | service account 憑證:JSON 字串(**優先序最高**) |
| `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` | — | 同上,base64 編碼(CI/Secrets 友善) |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | `./service_account.json` | 同上,憑證檔路徑(三者擇一,依此優先序) |
| `GOOGLE_SHEET_ID` | (sheets 必填) | 試算表 ID(= TeaBus-VOC `VOC_SPREADSHEET_ID`) |
| `POOL_SHEET_NAME` | `參考池` | 收錄寫入的目標分頁名 |

### 行為 / 其他

| 變數 | 預設 | 說明 |
|------|------|------|
| `ERROR_CHAT_ID` | — | 錯誤回報 chat:collect/stats 失敗時 bot 主動通知 |
| `EXPAND_SHORT_URLS` | `false` | 是否對已知短網址(bit.ly、vm.tiktok…)跟隨 redirect 展開(會發網路請求) |
| `LOG_LEVEL` | `info` | 記錄層級 |

> 「加入日期」一律 `Asia/Taipei` 的 ISO `YYYY-MM-DD`(寫死於 [`src/utils/date.ts`](src/utils/date.ts)),**無需設 `TZ`**。

---

## 部署

### GitHub Actions cron drain($0,預設)

正式部署**不需要常駐機器**。[`.github/workflows/collect.yml`](.github/workflows/collect.yml) 定時跑 `npm run drain`([`src/drain.ts`](src/drain.ts)):把 Telegram 囤的更新一次 `getUpdates` 撈乾 → 處理 → 寫參考池 → ack → 結束。Telegram 保留未領更新約 24h,間隔 < 24h 就不漏訊息;public repo 的 Actions 免費額度無上限。

- 設 3 個 **GitHub Secrets**:`TELEGRAM_BOT_TOKEN`、`GOOGLE_SERVICE_ACCOUNT_JSON`(或 `_BASE64`)、`GOOGLE_SHEET_ID`。
- 手動補跑:Actions → collect → **Run workflow**。
- **取捨**:收訊息有延遲(下個排程才入庫 + 回覆)。

### (可選)常駐 polling — 要「秒回」才用

不想等排程、要即時回覆,才需要常駐 long polling([`src/index.ts`](src/index.ts))。

> ⚠️ **別在本機 Docker Desktop / WSL2 跑常駐**:連 googleapis 帶 JWT 的大封包會 `Premature close`(見[疑難排解](#疑難排解))。要跑常駐請**部署到雲端 VM / 容器 host**。

```bash
cp .env.example .env          # 填好變數
docker compose up -d --build  # BOT_MODE=polling
docker compose logs -f
```

走 webhook:設 `BOT_MODE=webhook` + `WEBHOOK_DOMAIN`,並在 compose 打開對外埠。

---

## 與 TeaBus-VOC 對接

bot 是上游:**直接寫** Google 表「短影音進度N」的「參考池」分頁。下游 [TeaBus-VOC](https://github.com/pei760730/TeaBus-VOC) 直接消費(挑→待拍→完成);中間不再有「暫存區→sync-pool」複製層(2026-06-22 廢)。

- bot `GOOGLE_SHEET_ID` **必須等於** TeaBus-VOC 的 `VOC_SPREADSHEET_ID`,憑證共用**同一把** service account。
- 寫入「參考池」**4 欄**須與 TeaBus-VOC `schema.REFS` 完全對上(欄名 + 順序),平台用小寫碼。改欄名要**兩 repo 一起改**,由 [`tests/contract.test.ts`](tests/contract.test.ts) 守(改了就 CI 紅)。

  | 欄 | bot 寫入 |
  |----|----------|
  | `平台` | 小寫碼(`PLATFORM_CODE`) |
  | `連結` | 乾淨連結 ——「打開」+ 去重的唯一 key |
  | `挑` | 留空(=還沒挑);人勾它 → GAS 搬待拍 |
  | `加入日期` | ISO `YYYY-MM-DD`(Asia/Taipei) |

  > `id` 欄已於 2026-06-24 砍除(純流水號、非去重 key);`NOTE`/`VIDEO_ID`/`SENDER` 不進參考池(TeaBus-VOC 設計如此,梗在搬進待拍後填「待拍.備註」)。

- 參考池由 TeaBus-VOC `init-sheet` 擁有,**bot 不自建分頁 / 不改表頭**(表頭不齊 fail-fast,避免錯欄寫入靜默毀池)。
- 完整契約(去重 key 對齊、平台偵測器兩套各自獨立、範圍限制)見 [`CLAUDE.md`](./CLAUDE.md) 第六層。**改 TeaBus-VOC 一律另開 TeaBus-VOC session**,別從 bot 滑上游。

---

## 工具腳本

唯讀 / 一次性,需先在 `.env` 設 `GOOGLE_SHEET_ID`(指向 TeaBus-VOC 的表):

| 腳本 | 跑法 | 用途 |
|------|------|------|
| [`scripts/verify-sheet.ts`](scripts/verify-sheet.ts) | `npx tsx scripts/verify-sheet.ts` | 對接驗證(唯讀):列分頁、確認「參考池」在、印表頭。不建分頁、不寫入 |
| [`scripts/read-refs.ts`](scripts/read-refs.ts) | `npx tsx scripts/read-refs.ts` | 唯讀讀回參考池內容 |
| [`scripts/audit-check.ts`](scripts/audit-check.ts) | `npx tsx scripts/audit-check.ts` | 深挖純函式的可疑點(子字串誤判、id 截斷…),不連網 |

---

## 測試

- 框架:**vitest**(`npm test` / `npm run test:watch`)。
- 每個 pipeline 步驟都是純函式 → 各有對應 `tests/*.test.ts`,含邊界案例(YouTube 非 11 碼不截斷、TikTok 20 位不偽造、FB 四形態抽取…)。
- [`tests/contract.test.ts`](tests/contract.test.ts):把與 TeaBus-VOC 的「散文契約」變成 CI 守的不變式(欄名/順序、平台碼落在 voc 認得的集合)。任一方改欄就先紅。
- [`tests/router.test.ts`](tests/router.test.ts):測 Telegraf 攔截點 —— 要 stub `Telegram.prototype.callApi`(telegraf 每筆更新都 `new Telegram()`,stub 實例無效),細節見 [`CLAUDE.md`](./CLAUDE.md) §3。

---

## 設計原則

- **pipeline 全純函式**,I/O(去重 / 寫入)隔在 storage 與 handler → 好測、無網路副作用。
- 儲存包成 **`Storage` 介面**,Google Sheets 只是其一實作(測試用 `MemoryStorage`)→ 換來源不動 handler。
- **寫入 RAW**(不用 USER_ENTERED),避免 video ID / 開頭 0 被當數字。
- **訊息一律純文字**,不用 MarkdownV2(舊版跳脫漏字釀發送失敗)。
- **fail-fast**:缺必要 env、表頭不齊一律啟動就丟錯,不帶半套設定跑。
- **最小權限**:Google 只用 `spreadsheets` scope。
- 失敗回明確錯誤 + 通知 error chat,**不靜默吞掉**。

---

## 疑難排解

| 症狀 | 原因 / 解法 |
|------|-------------|
| 啟動丟「缺少必要環境變數」 | `.env` 沒填齊(token / 憑證 / sheet id);照 `.env.example` 補。乾測可設 `STORAGE=memory` |
| `Premature close`(常駐 polling) | 本機 Docker/WSL2 連 googleapis 帶 JWT 大封包被 MTU 截斷。**別在本機 Docker 跑常駐** → 用 cron drain,或部署雲端 VM |
| 401 / token 失效 | token 打錯(踩過 `l`→`1` typo);`config.ts` 用 `dotenv override:true` 讓 `.env` 蓋過系統殘留變數 |
| 啟動丟「表頭不齊 / 缺分頁」 | 參考池由 TeaBus-VOC `init-sheet` 建,bot 不自建。先確認 TeaBus-VOC 已建好「參考池」分頁且表頭對齊 |
| 同支影片被收成兩筆 | 多半是被挑走搬離參考池後又分享(範圍限制,刻意);或連結形態抽不到 id 退路徑 key。見[去重機制](#去重dedup機制) |

---

## 改自 n8n 版的修正

1. 去重 lookup value 去掉多餘空白。
2. 格式錯誤訊息改純文字(舊 MarkdownV2 未跳脫會發送失敗)。
3. 去重改**連結 key**(平台:影片id 收斂多形態),對齊 TeaBus-VOC;參考池永久池無時間窗。
4. 欄位命名統一成一份 schema([`src/types.ts`](src/types.ts))。
5. 用清楚條件流程取代 n8n 脆弱的 Merge / Is Duplicate 分支。
6. **FB 影片 ID 抽取**(port 自 OF-DOG):fb.watch / reel / videos / share / `watch?v=` / `story_fbid` 四形態,讓同支 FB 影片不同形態能去重(n8n / 舊版 FB 一律落 `unknown`,永遠去重不到)。
</content>
</invoke>
