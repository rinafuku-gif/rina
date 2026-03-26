#!/usr/bin/env node
// MF_銀行仕訳_分類ガイド → MF仕訳帳インポートCSV変換
// expense-rules.md の MF仕訳帳インポート形式に準拠
const fs = require("fs");
const path = require("path");
const https = require("https");

const envPath = path.join(__dirname, "..", ".env");
const envContent = fs.readFileSync(envPath, "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const m = line.match(/^([^=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}

function getAccessToken() {
  return new Promise((resolve) => {
    const postData = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }).toString();
    const req = https.request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => resolve(JSON.parse(body).access_token));
    });
    req.write(postData);
    req.end();
  });
}

// 税区分の判定
function getTaxCategory(debitAccount, memo) {
  // 非課税系
  if (["租税公課", "損害保険料"].includes(debitAccount)) return "対象外";
  if (debitAccount === "支払手数料" && (memo || "").includes("振込")) return "対象外";

  // 入金系
  if (debitAccount === "普通預金") return ""; // 入金は税区分なし（貸方で判定）
  if (debitAccount === "事業主貸") return "対象外";

  // 食品系（軽減税率8%）
  if (debitAccount === "仕入高") return "課税仕入 8%";

  // 一般経費（標準税率10%）
  return "課税仕入 10%";
}

function getCreditTaxCategory(creditAccount) {
  if (creditAccount === "売上高") return "課税売上 10%";
  if (creditAccount === "雑収入") return "対象外";
  return "";
}

// 日付フォーマット: 2025-01-02 → 2025/01/02
function formatDate(dateStr) {
  return dateStr.replace(/-/g, "/");
}

// CSVエスケープ
function csvEscape(val) {
  if (!val) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

async function main() {
  // データ読み込み
  const dataPath = path.join(__dirname, "..", "logs", ".mf-guide-data.json");
  const rows = JSON.parse(fs.readFileSync(dataPath, "utf-8"));

  // ヘッダー: 銀行 | 日付 | 金額 | 入出金 | 借方勘定科目 | 貸方勘定科目 | 摘要 | タグ | メモ
  const header = rows[0];
  const data = rows.slice(1);

  // MF仕訳帳インポート形式のCSVヘッダー
  const csvHeader = [
    "取引日", "借方勘定科目", "借方補助科目", "借方税区分", "借方金額",
    "貸方勘定科目", "貸方補助科目", "貸方税区分", "貸方金額",
    "摘要", "仕訳メモ", "タグ"
  ];

  const csvRows = [csvHeader.join(",")];
  let errorCount = 0;

  for (const row of data) {
    const bank = row[0] || "";
    const date = row[1] || "";
    const amount = row[2] || "";
    const inOut = row[3] || "";
    const debitAccount = row[4] || "";
    const creditAccount = row[5] || "";
    const description = row[6] || "";
    const tag = row[7] || "";
    const memo = row[8] || "";

    if (!date || !amount || !debitAccount || !creditAccount) {
      errorCount++;
      continue;
    }

    // 補助科目: 銀行口座情報
    let debitSub = "";
    let creditSub = "";

    // 普通預金の補助科目に銀行名を設定
    if (debitAccount === "普通預金") {
      debitSub = bank === "住信SBI" ? "住信SBIネット銀行" : bank === "楽天銀行" ? "楽天銀行" : bank;
    }
    if (creditAccount === "普通預金") {
      creditSub = bank === "住信SBI" ? "住信SBIネット銀行" : bank === "楽天銀行" ? "楽天銀行" : bank;
    }

    const debitTax = getTaxCategory(debitAccount, memo);
    const creditTax = getCreditTaxCategory(creditAccount);

    const csvRow = [
      formatDate(date),
      debitAccount,
      debitSub,
      debitTax,
      amount,
      creditAccount,
      creditSub,
      creditTax,
      amount,
      description,
      memo,
      tag
    ].map(csvEscape).join(",");

    csvRows.push(csvRow);
  }

  // CSV出力（UTF-8 BOM付き = MFが文字化けしない）
  const csvContent = "\uFEFF" + csvRows.join("\n");
  const outputPath = path.join(__dirname, "..", "logs", "MF_仕訳帳_2025_import.csv");
  fs.writeFileSync(outputPath, csvContent, "utf-8");

  console.log("=== MF仕訳帳インポートCSV生成完了 ===");
  console.log("出力ファイル: " + outputPath);
  console.log("データ行数: " + (csvRows.length - 1) + "行");
  console.log("スキップ: " + errorCount + "行");
  console.log("\nサンプル（最初の5行）:");
  csvRows.slice(0, 6).forEach(r => console.log(r));

  // Google Driveにアップロード
  console.log("\n--- Google Driveにアップロード中 ---");
  const token = await getAccessToken();

  const boundary = "----FormBoundary" + Date.now();
  const metadata = JSON.stringify({
    name: "MF_仕訳帳_2025_import_" + new Date().toISOString().slice(0, 10) + ".csv",
    mimeType: "text/csv",
    parents: ["1ND0Z-DeDns5moU4Z3KW1sSy1AvqVYBJv"] // 02_収支・経費関連フォルダ
  });

  const csvBuffer = Buffer.from(csvContent, "utf-8");

  const body = Buffer.concat([
    Buffer.from(
      "--" + boundary + "\r\n" +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      metadata + "\r\n" +
      "--" + boundary + "\r\n" +
      "Content-Type: text/csv\r\n\r\n"
    ),
    csvBuffer,
    Buffer.from("\r\n--" + boundary + "--")
  ]);

  const uploadResult = await new Promise((resolve) => {
    const req = https.request({
      hostname: "www.googleapis.com",
      path: "/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "multipart/related; boundary=" + boundary,
        "Content-Length": body.length,
      },
    }, (res) => {
      let responseBody = "";
      res.on("data", (c) => responseBody += c);
      res.on("end", () => resolve(JSON.parse(responseBody)));
    });
    req.write(body);
    req.end();
  });

  if (uploadResult.id) {
    console.log("✅ Driveアップロード成功!");
    console.log("ファイル名: " + uploadResult.name);
    console.log("ファイルID: " + uploadResult.id);
    console.log("URL: https://drive.google.com/file/d/" + uploadResult.id);
  } else {
    console.log("❌ アップロード失敗:", JSON.stringify(uploadResult));
  }
}

main().catch(console.error);
