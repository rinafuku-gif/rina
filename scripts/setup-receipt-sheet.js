#!/usr/bin/env node
// 経費管理用の Google Spreadsheet と Drive フォルダを作成
const https = require("https");
const fs = require("fs");
const path = require("path");

// .env 読み込み
const envPath = path.join(__dirname, "..", ".env");
const envContent = fs.readFileSync(envPath, "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

function googleApi(method, url, body) {
  return getAccessToken().then(token => {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method,
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      };
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`API error ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function getAccessToken() {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }).toString();

    const req = https.request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        const data = JSON.parse(body);
        if (data.access_token) resolve(data.access_token);
        else reject(new Error("Failed to get access token: " + body));
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function main() {
  console.log("=== 経費管理セットアップ ===\n");

  // 1. Create Drive folder for receipts
  console.log("1. Google Drive フォルダ作成中...");
  const folder = await googleApi("POST", "https://www.googleapis.com/drive/v3/files", {
    name: "経費レシート（AI秘書管理）",
    mimeType: "application/vnd.google-apps.folder",
  });
  console.log(`   ✅ フォルダ作成: ${folder.name} (ID: ${folder.id})`);

  // 2. Create Spreadsheet
  console.log("2. Google Spreadsheet 作成中...");
  const sheet = await googleApi("POST", "https://sheets.googleapis.com/v4/spreadsheets", {
    properties: {
      title: "経費管理（AI秘書）",
    },
    sheets: [{
      properties: {
        title: "経費一覧",
        gridProperties: { frozenRowCount: 1 },
      },
    }],
  });
  console.log(`   ✅ スプレッドシート作成: ${sheet.properties.title} (ID: ${sheet.spreadsheetId})`);

  // 3. Set up header row
  console.log("3. ヘッダー行を設定中...");
  await googleApi("PUT",
    `https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values/経費一覧!A1:I1?valueInputOption=USER_ENTERED`,
    {
      values: [["日付", "店名", "金額", "品目", "カテゴリ", "支払方法", "備考", "レシート画像", "登録日時"]],
    }
  );
  console.log("   ✅ ヘッダー設定完了");

  // 4. Format header (bold, background color)
  await googleApi("POST",
    `https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}:batchUpdate`,
    {
      requests: [
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.55, green: 0.45, blue: 0.33 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: 9 },
            properties: { pixelSize: 120 },
            fields: "pixelSize",
          },
        },
      ],
    }
  );
  console.log("   ✅ ヘッダーフォーマット完了");

  // 5. Save IDs to .env
  let envText = fs.readFileSync(envPath, "utf-8");
  envText += `GOOGLE_RECEIPT_FOLDER_ID=${folder.id}\n`;
  envText += `GOOGLE_EXPENSE_SHEET_ID=${sheet.spreadsheetId}\n`;
  fs.writeFileSync(envPath, envText);
  console.log("\n   ✅ .env にフォルダID・シートIDを保存しました");

  console.log("\n=== セットアップ完了 ===");
  console.log(`\nスプレッドシート: https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}`);
  console.log(`Driveフォルダ: https://drive.google.com/drive/folders/${folder.id}`);
}

main().catch(e => {
  console.error("❌ エラー:", e.message);
  process.exit(1);
});
