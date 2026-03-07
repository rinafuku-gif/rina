#!/usr/bin/env node
// スプレッドシートをマネーフォワード仕訳帳インポート形式に更新
const https = require("https");
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const envContent = fs.readFileSync(envPath, "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

function getAccessToken() {
  return new Promise((resolve, reject) => {
    const postData = new (require("url").URLSearchParams)({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }).toString();
    const req = https.request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        const d = JSON.parse(body);
        d.access_token ? resolve(d.access_token) : reject(new Error("No token"));
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function sheetsApi(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const urlObj = new (require("url").URL)(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`${res.statusCode}: ${data}`));
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const token = await getAccessToken();
  const sheetId = env.GOOGLE_EXPENSE_SHEET_ID;
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;

  console.log("=== スプレッドシートをMF形式に更新 ===\n");

  // Get current sheet info
  const info = await sheetsApi("GET", `${baseUrl}?fields=sheets.properties`, null, token);
  const existingSheetId = info.sheets[0].properties.sheetId;

  // 1. Rename existing sheet and add new sheets
  console.log("1. シート構成を更新中...");
  await sheetsApi("POST", `${baseUrl}:batchUpdate`, {
    requests: [
      // Rename existing sheet
      { updateSheetProperties: { properties: { sheetId: existingSheetId, title: "MF仕訳帳" }, fields: "title" } },
      // Add raw data sheet
      { addSheet: { properties: { title: "レシート原本", gridProperties: { frozenRowCount: 1 } } } },
    ],
  }, token);

  // 2. Set up MF仕訳帳 sheet (MoneyForward import format)
  console.log("2. MF仕訳帳ヘッダーを設定中...");
  await sheetsApi("PUT",
    `${baseUrl}/values/MF仕訳帳!A1:L1?valueInputOption=USER_ENTERED`,
    { values: [["取引日", "借方勘定科目", "借方補助科目", "借方税区分", "借方金額", "貸方勘定科目", "貸方補助科目", "貸方税区分", "貸方金額", "摘要", "仕訳メモ", "タグ"]] },
    token
  );

  // 3. Set up レシート原本 sheet (detailed receipt data)
  console.log("3. レシート原本ヘッダーを設定中...");
  await sheetsApi("PUT",
    `${baseUrl}/values/レシート原本!A1:K1?valueInputOption=USER_ENTERED`,
    { values: [["取引日", "店名", "合計金額", "品目", "勘定科目", "税区分", "支払方法", "備考", "Drive画像", "登録日時", "事業区分"]] },
    token
  );

  // 4. Format headers
  console.log("4. ヘッダーをフォーマット中...");
  const newInfo = await sheetsApi("GET", `${baseUrl}?fields=sheets.properties`, null, token);
  const rawSheetId = newInfo.sheets.find(s => s.properties.title === "レシート原本").properties.sheetId;

  await sheetsApi("POST", `${baseUrl}:batchUpdate`, {
    requests: [
      // MF仕訳帳 header format
      {
        repeatCell: {
          range: { sheetId: existingSheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { backgroundColor: { red: 0.2, green: 0.4, blue: 0.6 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      // レシート原本 header format
      {
        repeatCell: {
          range: { sheetId: rawSheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { backgroundColor: { red: 0.55, green: 0.45, blue: 0.33 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      // Column widths for MF
      { updateDimensionProperties: { range: { sheetId: existingSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 12 }, properties: { pixelSize: 130 }, fields: "pixelSize" } },
      // Column widths for raw
      { updateDimensionProperties: { range: { sheetId: rawSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 11 }, properties: { pixelSize: 130 }, fields: "pixelSize" } },
    ],
  }, token);

  // 5. Clear old data from row 2 onwards (in case the old format had data)
  try {
    await sheetsApi("POST", `${baseUrl}/values/MF仕訳帳!A2:L1000:clear`, {}, token);
  } catch { /* no data to clear */ }

  console.log("\n✅ セットアップ完了！");
  console.log(`\nスプレッドシート: https://docs.google.com/spreadsheets/d/${sheetId}`);
  console.log("\nシート構成:");
  console.log("  - MF仕訳帳: マネーフォワード仕訳帳インポート用（CSV書出し用）");
  console.log("  - レシート原本: レシート詳細データ（店名・品目・画像リンク等）");
}

main().catch(e => { console.error("❌ Error:", e.message); process.exit(1); });
