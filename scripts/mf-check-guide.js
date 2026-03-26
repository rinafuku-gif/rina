#!/usr/bin/env node
const https = require("https");
const fs = require("fs");
const path = require("path");

const envContent = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf-8");
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

async function getSheet(token, id, range) {
  const r = encodeURIComponent(range);
  const url = "https://sheets.googleapis.com/v4/spreadsheets/" + id + "/values/" + r;
  return new Promise((resolve) => {
    https.get(url, { headers: { Authorization: "Bearer " + token } }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => resolve(JSON.parse(body)));
    });
  });
}

async function main() {
  const token = await getAccessToken();
  const data = await getSheet(token, "17ZuDsTh8quDJjV8ZOjylcwIGUYpm5CP7lDYb7_jQbMo", "MF_銀行仕訳_分類ガイド!A1:I1000");
  const rows = data.values || [];
  console.log("全行数: " + rows.length);
  console.log("ヘッダー: " + rows[0].join(" | "));

  const dates = rows.slice(1).map(r => r[1]).filter(Boolean).sort();
  console.log("日付範囲: " + dates[0] + " ~ " + dates[dates.length - 1]);

  // 借方勘定科目の集計
  const accounts = {};
  let unclassifiedCount = 0;
  rows.slice(1).forEach(r => {
    const debit = r[4];
    if (debit && debit.trim() !== "") {
      accounts[debit] = (accounts[debit] || 0) + 1;
    } else {
      unclassifiedCount++;
    }
  });
  console.log("\n借方勘定科目の内訳:");
  Object.entries(accounts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log("  " + k + ": " + v + "件"));
  console.log("\n未分類: " + unclassifiedCount + "件");

  // 入出金の集計
  let totalIn = 0, totalOut = 0;
  rows.slice(1).forEach(r => {
    const amount = parseInt(r[2]) || 0;
    if (r[3] === "入金") totalIn += amount;
    else if (r[3] === "出金") totalOut += amount;
  });
  console.log("\n入金合計: " + totalIn.toLocaleString() + "円");
  console.log("出金合計: " + totalOut.toLocaleString() + "円");

  console.log("\n最後の5行:");
  rows.slice(-5).forEach(r => console.log(r.join(" | ")));

  // JSONで全データ保存（CSV変換用）
  fs.writeFileSync(path.join(__dirname, "..", "logs", ".mf-guide-data.json"), JSON.stringify(rows, null, 2));
  console.log("\nデータを logs/.mf-guide-data.json に保存しました");
}
main();
