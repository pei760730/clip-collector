// CI 守門:宣稱的 collector-core 版本 == 實際安裝版本。
// 背景:npm ci 只認 package-lock.json 的 resolved,package.json spec 改了但 lock 沒重解析時
// 不會報錯、測試照樣全綠(測的是舊 code)—— PR #29 即此事故(spec v0.2.2、實裝 v0.2.1)。
// 三姊妹 repo(clip-collector / short-video-bot / feed-collector)共用同一段。
import { readFileSync } from "node:fs";

const DEP = "@pei760730/collector-core";
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

const spec = read("../package.json").dependencies?.[DEP] ?? "";
const m = spec.match(/#v(.+)$/);
if (!m) {
  console.log(`skip: ${DEP} spec 不是 git tag 形態(${spec || "無此依賴"})`);
  process.exit(0);
}
const installed = read(`../node_modules/${DEP}/package.json`).version;
if (installed !== m[1]) {
  console.error(`宣稱 != 實裝:package.json 宣稱 ${DEP} v${m[1]},npm ci 實裝 v${installed}。`);
  console.error(`lockfile 沒跟上 spec —— 跑 npm install 重解析 package-lock.json 再提交。`);
  process.exit(1);
}
console.log(`ok: ${DEP} 宣稱 v${m[1]} == 實裝 v${installed}`);
