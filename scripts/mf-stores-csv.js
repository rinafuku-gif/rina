#!/usr/bin/env node
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const workbook = XLSX.readFile("/tmp/stores_sales.xlsx");
const sheet = workbook.Sheets["シート1"];
const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

// 1行目はサマリ行、2行目がヘッダー
const rows = data.slice(2);

// 売上合計を計算
let totalSales = 0;
let salesCount = 0;
rows.forEach(row => {
  const creditAccount = row[9];
  const creditAmount = parseInt(row[15]) || 0;
  if (creditAccount === "売上高") {
    totalSales += creditAmount;
    salesCount++;
  }
});
console.log("売上高の行数: " + salesCount);
console.log("売上合計: " + totalSales.toLocaleString() + "円");
console.log("全データ行数: " + rows.length);

// CSVエスケープ
function csvEscape(val) {
  if (val === undefined || val === null || val === "") return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// MF仕訳帳インポートCSV生成
const csvHeader = "取引日,借方勘定科目,借方補助科目,借方税区分,借方金額,貸方勘定科目,貸方補助科目,貸方税区分,貸方金額,摘要,仕訳メモ,タグ";
const csvRows = [csvHeader];

rows.forEach(row => {
  // 元データ列: 取引No(0), 取引日(1), 借方勘定科目(2), 借方補助科目(3),
  // 借方部門(4), 借方取引先(5), 借方税区分(6), 借方インボイス(7), 借方金額(8),
  // 貸方勘定科目(9), 貸方補助科目(10), 貸方部門(11), 貸方取引先(12),
  // 貸方税区分(13), 貸方インボイス(14), 貸方金額(15), 摘要(16), タグ(17), メモ(18)

  const date = row[1] || "";
  if (typeof date !== "string" || date.length === 0) return;

  const debitAccount = row[2] || "";
  const debitSub = row[3] || "";
  const debitTax = row[6] || "";
  const debitAmount = row[8] || "";
  const creditAccount = row[9] || "";
  const creditSub = row[10] || "";
  const creditTax = row[13] || "";
  const creditAmount = row[15] || "";
  const description = row[16] || "";
  const tag = row[17] || "";
  const memo = row[18] || "";

  const csvRow = [
    date, debitAccount, debitSub, debitTax, debitAmount,
    creditAccount, creditSub, creditTax, creditAmount,
    description, memo, tag
  ].map(csvEscape).join(",");

  csvRows.push(csvRow);
});

// UTF-8 BOM付きで出力
const csvContent = "\uFEFF" + csvRows.join("\n");
const outputPath = path.join(__dirname, "..", "logs", "MF_STORES売上_2025_import.csv");
fs.writeFileSync(outputPath, csvContent, "utf-8");

console.log("\n=== CSV生成完了 ===");
console.log("出力: " + outputPath);
console.log("データ行数: " + (csvRows.length - 1));
console.log("\nサンプル（最初5行）:");
csvRows.slice(0, 6).forEach(r => console.log(r));
console.log("\n最後3行:");
csvRows.slice(-3).forEach(r => console.log(r));
