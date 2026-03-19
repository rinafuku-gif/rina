/**
 * 統合DB用APIハンドラー
 * line-webhook-server.jsから呼び出される
 *
 * 使い方:
 *   const unifiedApi = require('./unified-api');
 *   // サーバー起動時
 *   await unifiedApi.init();
 *   // リクエスト処理内
 *   if (unifiedApi.canHandle(pathname)) {
 *     return unifiedApi.handle(req, res, pathname, searchParams);
 *   }
 */

const db = require("./unified-db");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

// .env からトークン取得
const envPath = path.join(__dirname, "..", ".env");
let API_TOKEN = "";
try {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^SHIRATAMA_API_TOKEN=(.*)$/);
    if (match) API_TOKEN = match[1].trim();
  }
} catch {}

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB

function genId() {
  return crypto.randomUUID();
}

async function init() {
  await db.initSchema();
  console.log("[unified-api] 統合DB初期化完了");
}

const ROUTES = [
  "/api/unified/dashboard",
  "/api/unified/money",
  "/api/unified/money/import",
  "/api/unified/events",
  "/api/unified/customers",
  "/api/unified/tasks",
  "/api/unified/insights",
  "/api/unified/quick",
];

function canHandle(pathname) {
  return ROUTES.some(r => pathname === r || pathname.startsWith(r + "/"));
}

async function handle(req, res, pathname, searchParams) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" });
    return res.end();
  }

  // 認証チェック
  const token = searchParams.get("token") || (req.headers["authorization"] || "").replace("Bearer ", "");
  if (API_TOKEN && token !== API_TOKEN) {
    return json(res, { error: "Unauthorized" }, 401);
  }

  try {
    // ダッシュボード（統合ビュー）
    if (pathname === "/api/unified/dashboard" && req.method === "GET") {
      const summary = await db.getDashboardSummary();
      return json(res, summary);
    }

    // お金: 一覧取得
    if (pathname === "/api/unified/money" && req.method === "GET") {
      const month = searchParams.get("month");
      const business = searchParams.get("business");
      const limit = parseInt(searchParams.get("limit") || "100");
      const rows = await db.getTransactions({ month, business, limit });
      const totals = await db.getMonthlyTotals({ business });
      return json(res, { transactions: rows, monthlyTotals: totals });
    }

    // お金: 手動追加（CSVインポート含む）
    if (pathname === "/api/unified/money" && req.method === "POST") {
      const body = await readBody(req);
      const data = JSON.parse(body);

      if (Array.isArray(data.transactions)) {
        // バッチインポート（CSV等）
        for (const tx of data.transactions) {
          await db.upsertTransaction({ id: genId(), ...tx, source: tx.source || "manual" });
        }
        return json(res, { imported: data.transactions.length });
      } else {
        // 単体追加
        await db.upsertTransaction({ id: genId(), ...data, source: data.source || "manual" });
        return json(res, { ok: true });
      }
    }

    // お金: 銀行CSVインポート
    if (pathname === "/api/unified/money/import" && req.method === "POST") {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const transactions = parseBankCsv(data.csv, data.bank || "generic", data.business);
      for (const tx of transactions) {
        await db.upsertTransaction(tx);
      }
      return json(res, { imported: transactions.length, transactions });
    }

    // 予定: 取得
    if (pathname === "/api/unified/events" && req.method === "GET") {
      const days = parseInt(searchParams.get("days") || "7");
      const events = await db.getUpcomingEvents({ days });
      return json(res, { events });
    }

    // 予定: 追加
    if (pathname === "/api/unified/events" && req.method === "POST") {
      const body = await readBody(req);
      const data = JSON.parse(body);
      await db.upsertEvent({ id: genId(), ...data, source: data.source || "manual" });
      return json(res, { ok: true });
    }

    // 顧客: 取得
    if (pathname === "/api/unified/customers" && req.method === "GET") {
      const business = searchParams.get("business");
      const customers = await db.getCustomers({ business });
      return json(res, { customers });
    }

    // 顧客: 追加
    if (pathname === "/api/unified/customers" && req.method === "POST") {
      const body = await readBody(req);
      const data = JSON.parse(body);
      await db.upsertCustomer({ id: genId(), ...data, source: data.source || "manual" });
      return json(res, { ok: true });
    }

    // タスク: 取得
    if (pathname === "/api/unified/tasks" && req.method === "GET") {
      const project = searchParams.get("project");
      const status = searchParams.get("status");
      const tasks = await db.getTasks({ project, status });
      return json(res, { tasks });
    }

    // タスク: 追加/更新
    if (pathname === "/api/unified/tasks" && req.method === "POST") {
      const body = await readBody(req);
      const data = JSON.parse(body);
      await db.upsertTask({ id: data.id || genId(), ...data, source: data.source || "manual" });
      return json(res, { ok: true });
    }

    // 秘書の気づき: 取得
    if (pathname === "/api/unified/insights" && req.method === "GET") {
      const insights = await db.getPendingInsights();
      return json(res, { insights });
    }

    // 秘書の気づき: ステータス更新（確認済み・対応済み）
    if (pathname.startsWith("/api/unified/insights/") && req.method === "POST") {
      const id = pathname.split("/").pop();
      const body = await readBody(req);
      const data = JSON.parse(body);
      await db.markInsight(id, data.status || "acted");
      return json(res, { ok: true });
    }

    // クイック操作: チャットからの簡易入力
    // POST /api/unified/quick { type: "expense"|"task", text: "..." }
    if (pathname === "/api/unified/quick" && req.method === "POST") {
      const body = await readBody(req);
      const data = JSON.parse(body);

      if (data.type === "expense") {
        // "コーヒー豆 3000 現金" → 経費登録
        const parts = (data.text || "").trim().split(/\s+/);
        const memo = parts[0] || "不明";
        const amount = parseInt(parts[1]) || 0;
        const payment = parts[2] || null;
        if (amount <= 0) return json(res, { error: "金額が不正です", parsed: { memo, amount, payment } }, 400);
        await db.upsertTransaction({
          id: genId(),
          date: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }),
          amount: -Math.abs(amount),
          category: null,
          business: null,
          source: "chat",
          memo,
          payment_method: payment,
        });
        return json(res, { ok: true, message: `経費登録: ${memo} ¥${amount.toLocaleString()}${payment ? ` (${payment})` : ""}` });
      }

      if (data.type === "task") {
        // "SATOYAMAのLP改善" → タスク追加
        const title = (data.text || "").trim();
        if (!title) return json(res, { error: "タスク名が必要です" }, 400);
        // プロジェクト名を自動検出
        let project = null;
        const projectMap = { satoyama: "SATOYAMA", misoca: "三十日珈琲", engawa: "えんがわ", しらたま: "しらたま", kura: "蔵サウナ", funfare: "funfare" };
        for (const [key, val] of Object.entries(projectMap)) {
          if (title.toLowerCase().includes(key)) { project = val; break; }
        }
        await db.upsertTask({
          id: genId(),
          title,
          project,
          source: "chat",
          assigned_by: "user",
        });
        return json(res, { ok: true, message: `タスク追加: ${title}${project ? ` (${project})` : ""}` });
      }

      return json(res, { error: "type は expense または task を指定してください" }, 400);
    }

    return notFound(res);
  } catch (err) {
    console.error("[unified-api] Error:", err);
    return error(res, err.message);
  }
}

// ===== 銀行CSVパーサー =====

function parseBankCsv(csvText, bank, business) {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return [];

  const transactions = [];
  // ヘッダーをスキップ
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.replace(/^"|"$/g, "").trim());
    if (cols.length < 3) continue;

    let tx;
    if (bank === "shinsei" || bank === "sbi") {
      // 住信SBI: 日付, 内容, 出金, 入金, 残高
      tx = {
        id: genId(),
        date: normalizeDate(cols[0]),
        memo: cols[1],
        amount: cols[3] ? parseInt(cols[3].replace(/,/g, "")) : -parseInt((cols[2] || "0").replace(/,/g, "")),
        category: null,
        business: business || null,
        source: "bank_csv",
        source_id: `${bank}_${cols[0]}_${i}`,
        payment_method: "銀行振込",
      };
    } else {
      // 汎用: 日付, 内容, 金額
      tx = {
        id: genId(),
        date: normalizeDate(cols[0]),
        memo: cols[1],
        amount: parseInt((cols[2] || "0").replace(/,/g, "")),
        category: null,
        business: business || null,
        source: "bank_csv",
        source_id: `${bank}_${cols[0]}_${i}`,
        payment_method: "銀行振込",
      };
    }

    if (tx.date && !isNaN(tx.amount)) {
      transactions.push(tx);
    }
  }

  return transactions;
}

function normalizeDate(dateStr) {
  if (!dateStr) return null;
  // "2026/03/19" or "2026-03-19" or "20260319"
  const cleaned = dateStr.replace(/\//g, "-");
  if (/^\d{8}$/.test(cleaned)) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(cleaned)) {
    return cleaned.slice(0, 10);
  }
  return cleaned;
}

// ===== HTTPユーティリティ =====

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function notFound(res) {
  json(res, { error: "Not found" }, 404);
}

function error(res, message) {
  json(res, { error: message }, 500);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

module.exports = { init, canHandle, handle };
