# CLAUDE.md — clip-collector 協作規則

> 接手這個 repo(含 AI)先讀這份。clip-collector = Telegram 短影音收集 bot,
> 取代舊 n8n 流程。貼「連結+備註」→ 解析→清理→判平台→抽 video ID→去重→**直接寫 VOC 的 Google Sheet「參考池」分頁**。
> (2026-06-22:廢「暫存區」中間層 —— VOC 已砍 sync-pool,bot 與 VOC 同表同 SA,直寫參考池就是最終狀態。)

## 第一層:永久紅線(違反就停)

1. **機密永不進 git**:`TELEGRAM_BOT_TOKEN`、`service_account.json`、`.env`。有人提議 commit 立刻拒絕(`.gitignore` 已擋)。
2. **未經明確同意不 commit / push / 開 PR**。在 branch 做完、跑 `npm test` + `npm run typecheck`、先報告,等 yes。
3. **只改被要求的部分**,不順手改旁邊的 code/欄位。
4. **修 bug 前先想**:能不能用 schema/設定/純函式擋掉?抽取/清理/分群規則的 SSOT 在 `@pei760730/collector-core`——要改去 core 改(先過 core 的 tests + dedupConformance),別在本 repo 憑印象重寫跑掉行為。(舊「n8n regex 1:1」紅線已退役 2026-07-03:pipeline 已兩輪對齊 core canonical。)
5. **不在 Sheet 裡的事實不能編造**;寫入後反向驗證(讀回確認),CLI 自報成功不算數。

## 第二層:資料地圖

| 找什麼 | 去哪 |
|---|---|
| 「參考池」欄位 / schema(SSOT) | `src/types.ts`:`RefRow` / `POOL_COLUMNS`(= VOC `schema.REFS` 5 欄;id 已於 2026-06-24 砍、夯度 於 2026-06-26 加在最後)+ `HOT_VALUES` + `PLATFORM_CODE`(顯示名→小寫碼) |
| 去重 key 演算法(連結→key) | `src/pipeline/index.ts`:`dedupKey`(平台:影片id 優先,抽不到退連結路徑;對齊 VOC `cli._dedup_key`,原 `sync._dedup_key`、sync.py 砍除後邏輯搬到 cli) |
| 抽網址/清網址/判平台/抽 video ID | `@pei760730/collector-core`(SSOT;薄殼已於 2026-07-03 砍,直接 import core) |
| pipeline 組合(parse→組草稿) | `src/pipeline/index.ts` |
| 去重 / 寫入 / 統計介面 | `src/storage/Storage.ts` |
| Google Sheets 實作 | `src/storage/googleSheets.ts` |
| 測試用記憶體 storage | `src/storage/memory.ts` |
| 收集流程 handler | `src/bot/handlers/collect.ts`(`runCollect`,不依賴 Telegraf) |
| `/stats` handler | `src/bot/handlers/stats.ts`(讀參考池統計)。挑片無 bot 指令:在 Sheet 勾「挑」→ GAS 搬待拍 |
| 指令路由 / 錯誤通知 | `src/bot/router.ts` |
| 訊息模板 | `src/messages/templates.ts` |
| 設定 / 環境變數 | `src/config.ts`(範本 `.env.example`) |

## 第三層:技術不變式

- **pipeline 全純函式**:parse / cleanUrl / detectPlatform / extractVideoId 無副作用、無網路,I/O 隔在 storage + handler。改邏輯先補 / 改 `tests/`。
- **測 router(telegraf)的攔截點**:telegraf `handleUpdate` **每筆更新都 `new Telegram(...)`**(telegraf.js),所以 stub `bot.telegram.sendMessage` / `.callApi` 對 context 無效(ctx 拿的是新實例)。要攔回覆/避免真連線,改 stub `Telegram.prototype.callApi`(測完還原)。範例見 `tests/router.test.ts`。
- **時區固定 `Asia/Taipei`**(`src/utils/date.ts`)。參考池「加入日期」用 ISO `YYYY-MM-DD`(`todayIsoTaipei`,對齊 VOC schema)。
- **寫入一律 RAW**(不用 USER_ENTERED),避免 video ID / 開頭 0 被吃成數字。
- **訊息純文字**,不用 MarkdownV2(舊版跳脫漏字會發送失敗)。
- **去重靠連結 key**(`dedupKey`):寫入參考池前讀現有「連結」欄,候選與既有列都用同一支推 key,重複就跳過。**全表比對、無時間窗**(參考池是 VOC 永久池,不像舊暫存區會 prune)。同支影片不同形態(youtu.be/watch?v=/shorts)收斂同 key;抓不到影片id 的退連結路徑 key。
- **storage 只認 `Storage` 介面**:換來源新增實作即可,handlers 不動。
- **最小權限**:Google 只用 `spreadsheets` scope。
- **fail fast**:缺必要 env 啟動就丟錯,不帶半套設定跑。
- **git-tag 依賴 bump 必驗「解析結果」,改 spec 字串不算升級**:bump `github:...#vX.Y.Z` 後必跑 `npm install` 重解析(或 surgical 編輯 lock 的 core 條目),PR 裡確認 package-lock.json 的 resolved sha == `gh api repos/<owner>/<repo>/commits/vX.Y.Z` 的 sha。CI/生產 `npm ci` 只認 lockfile resolved,spec 與 lockfile 漂移**不會報錯**、測試照樣全綠(測的就是舊 code)。
  - 觸發條件:任何 package.json 內 git-tag 依賴的版本變更。
  - 理由:聲明升級 ≠ 部署升級;綠燈對著舊 code 亮。
  - 證據:PR #29(commit 8026229)只改兩處 spec 字串,resolved 仍 95429dc(=v0.2.1),dist/utils/retry.js 無 clamp;short-video-bot、feed-collector 同日同病。修復時 core 已出 v0.2.3,直升 v0.2.3(PR #31)。
  - 失效/複審條件:CI 守門(ci.yml 的「宣稱==實裝」步驟,PR #31 已合入)長期有效後,此條可降級為該步驟的註解;或改走 npm registry 版本依賴時複審。

## 第四層:環境

- 使用者 **Pei**([pei760730](https://github.com/pei760730)),回覆繁體中文、短句直接。
- 技術棧已定案:Node.js + TypeScript、telegraf、googleapis、dayjs、vitest。儲存 Google Sheets。
- **部署:GitHub Actions cron drain($0,預設)** —— `.github/workflows/collect.yml` 設 `*/5` 跑 `npm run drain`(`src/drain.ts`:`getUpdates` 撈乾→`handleUpdate`→ack→結束),但 GitHub 對 public repo 高頻排程大幅節流,**實際約每 2–3h 觸發一次**。Telegram 留更新 ~24h,間隔遠 < 24h 不漏;每次 run 撈乾全部 pending,漏跑自癒。**不要在本機 Docker/WSL2 跑常駐**:連 googleapis 帶 JWT 大封包會 `Premature close`(WSL2 MTU 丟大封包)。Docker/webhook 部署線已於 2026-07-03 解散(生產走 cron drain 數月、常駐線從未上場);`npm run dev` = 本機 long polling,僅開發用。
- 開發指令:`npm run dev`(tsx watch)、`npm test`、`npm run typecheck`、`npm run build`。

## 第五層:待確認(邊做邊修)

- `/stats` 顯示哪些數字 —— 現為預設版,**讀「參考池」**(總筆數+各平台+本週/本月+最近5筆)。注意:已挑走的素材會搬離參考池,故統計反映「目前池中未挑」的素材,不含已挑/已拍。
- `/move` 已退役(隨第二輪瘦身砍 STATUS 欄一起;`move.ts` 已刪)。`/pick` 也已退役(2026-06-23,見第六層):挑片統一走 Sheet 勾「挑」→ GAS 搬待拍。
- 短網址展開(`EXPAND_SHORT_URLS`)預設關;要開再驗 redirect 行為。

## 第六層:與 VOC 對接契約(改欄位前先讀!跨 repo)

bot 是上游:**直接寫** Google 表「**短影音進度N**」(已配置並運作中;sheet id 由 GitHub secret `GOOGLE_SHEET_ID` 注入,= VOC 的 `VOC_SPREADSHEET_ID`)的「**參考池**」分頁。cron 每 5 分鐘成功寫入中。
2026-06-22 起廢「暫存區」中間層 —— VOC 已砍 `sync.py` / `sync-pool`(暫存區→參考池 每日複製是純儀式,第一性原理刪除)。bot 與 VOC 同一張表、同一把 SA,bot 直寫參考池就是最終狀態。

- **同一張表**:bot `GOOGLE_SHEET_ID`(由 GitHub secret 注入,運作中)必須 = VOC `VOC_SPREADSHEET_ID`。憑證共用 VOC 的 service account(由 secret `GOOGLE_SERVICE_ACCOUNT_JSON` 注入)。
- **參考池由 VOC 擁有,bot 不自建/不改表頭**:VOC `init-sheet` 建「參考池」。bot `GoogleSheetsStorage.ensureHeader` 只**驗表頭對齊**,缺分頁 / 表頭不齊一律 fail-fast(不替 VOC 動表結構,避免錯欄寫入靜默毀 VOC 的池)。
- **契約欄位 = VOC `schema.REFS` 5 欄(改名要兩 repo 一起)**。bot append 依**實際表頭具名解析**(非固定欄序),**欄名 + 順序**都要對上;由 `tests/contract.test.ts` 守(改欄名 → CI 紅):
  - (`id` 已於 2026-06-24 砍除:純流水號、非去重 key,挑走搬待拍另發 T 號不沿用 → 廢標籤。)
  - `平台`:**小寫碼**(`PLATFORM_CODE`:tiktok/youtube/facebook/instagram/threads/x/douyin/xiaohongshu;認不得 → `unknown`)。VOC 全系統用小寫碼。
  - `連結`:乾淨連結 —— 「打開」+ 去重的唯一 key。
  - `挑`:checkbox,bot 寫**留空**(=還沒挑)。人在 Sheet 勾它 → GAS 即時搬待拍。
  - `加入日期`:ISO `YYYY-MM-DD`(`todayIsoTaipei`;VOC `normalize_date` 也吃 ISO)。
  - `夯度`(2026-06-26 加,**必在最後一欄**:VOC `init-sheet` 只改表頭,插中間會錯位舊資料):收錄時 bot 寫**留空**;回覆掛一排 inline 按鈕(夯爆了/NPC/拉完了),分享者點 → `bot.action` callback `storage.setHot(dedupKey, 值)` 回填該列。值集合 = `HOT_VALUES`(鏡像 VOC `schema.HOT_VALUES`)。
- **NOTE/VIDEO_ID/SENDER 不進參考池**(VOC 設計如此,不是漏):參考池只存不可化約的 5 欄,梗/點子在搬進待拍後填「待拍.備註」。去重 key 寫入前由連結即時推導(`dedupKey`),不需存欄。
- **去重(寫入前,bot 端負責)**:`src/pipeline/index.ts` 的 `dedupKey` 對齊 VOC `cli._dedup_key`(原 `sync._dedup_key`,sync.py 砍除後邏輯搬到 cli)—— 優先「平台:影片id」(用 bot `detectPlatform`+`extractVideoId`,讓 youtu.be/watch?v=/shorts 收斂),抽不到才退連結路徑(砍 query/fragment + 去尾斜線 + lower)。`collect` 寫入前讀現有「連結」欄、候選與既有列同支推 key 比對,重複跳過。**全表比對、無時間窗**(參考池永久池,不 prune)。
  - **範圍限制(已知,刻意)**:只比對**參考池**的「連結」欄,不比對 待拍/完成。被 `pick` 搬走的素材若再次分享,bot 會當新素材再收一筆(舊 `sync.py` 會連 待拍/完成 一起比)。換取 bot 不耦合 VOC 全 schema;若日後重複太多,再在 bot 端擴比對範圍。
- **挑片 = 在 Sheet 勾「挑」(bot 不參與)**:人在「參考池」勾「挑」checkbox → VOC 的 GAS `pickScan_`(onEdit simple trigger)即時把該列整列搬進待拍、發 T 號、刪參考池本列。bot 沒有挑片指令。
  - **`/pick` 已退役(2026-06-23)**:原本 `/pick R####` 靠 `id`(R 號)在參考池找列打勾。但 bot 直寫的列 `id` 留空(無 R 號),`/pick` 定位不到;且本來就要打字,單人作業多餘。連 `bot/handlers/pick.ts` + `storage/poolPick.ts` 一起砍。挑片統一走 Sheet 勾「挑」。
  - **沒有 `VOC pick` 指令**:搬移在 GAS(`pickScan_`),不是 Python CLI。別在文件/註解寫「VOC pick」(會誤導)。
- **平台偵測器兩套、各自獨立**:bot `detectPlatform`(hostname)與 VOC `parse_url`(regex)是兩份實作。bot 是參考池唯一寫入者 → 平台欄以 bot 判定為準(VOC 不再 re-derive)。`contract.test.ts` 釘住 bot 8 個平台碼都落在 VOC 認得的小寫碼集合。
- **改 VOC 一律另開 VOC session**,別從 bot 滑上游。
- 驗證腳本:`npx tsx scripts/verify-sheet.ts`(列分頁 + 印參考池表頭)、`scripts/read-refs.ts`(讀參考池)。
