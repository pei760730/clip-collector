/** 唯讀讀回 VOC 表「參考池」。跑法:npx tsx scripts/read-refs.ts(需先在 .env 設 GOOGLE_SHEET_ID) */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEET_ID ?? "";
if (!SHEET_ID) throw new Error("缺 GOOGLE_SHEET_ID（請設 .env，指向 VOC 的表）");

const sa = JSON.parse(readFileSync("./service_account.json", "utf-8")) as {
  client_email: string;
  private_key: string;
};
const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'參考池'!A1:J",
});
const rows = res.data.values ?? [];
console.log("參考池總列數(含表頭):", rows.length);
for (const r of rows) console.log(JSON.stringify(r));
