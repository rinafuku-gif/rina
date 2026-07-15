/**
 * データ取り込みエンジン（Data Ingester）
 *
 * 既存のデータソースから統合DBにデータを流し込む。
 * line-webhook-server.jsの既存関数を利用して取得→統合DBに格納。
 *
 * cronまたはサーバー起動時に実行。
 */

const db = require("./unified-db");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO_DIR = path.join(__dirname, "..");
const BOOKINGS_LOG = path.join(REPO_DIR, "logs", ".airbnb-bookings.json");

function genId(prefix = "") {
  return `${prefix}${crypto.randomUUID().slice(0, 8)}`;
}

// ===== Airbnb予約 → schedule_events + money_transactions + customers =====

async function ingestAirbnbBookings() {
  let bookings = [];
  try {
    bookings = JSON.parse(fs.readFileSync(BOOKINGS_LOG, "utf-8"));
  } catch {
    console.log("[ingester] Airbnb予約ログなし、スキップ");
    return { events: 0, transactions: 0, customers: 0 };
  }
  // tombstone(status:"cancelled")化した予約は除外（legacyでstatus無しは有効扱いを維持）
  bookings = bookings.filter(b => b.status !== "cancelled");

  let events = 0, transactions = 0, customers = 0;

  for (const b of bookings) {
    const eventId = `airbnb_${b.confirmationCode}`;
    const custId = `airbnb_guest_${b.confirmationCode || (b.guestName?.replace(/\s/g, "_") || "unknown")}`;

    // 予定として登録
    await db.upsertEvent({
      id: eventId,
      title: `${b.guestName} (${b.room || "えんがわ"}) ${b.nights}泊`,
      start_at: b.checkin,
      end_at: b.checkout,
      source: "airbnb",
      source_id: b.confirmationCode,
      calendar_name: b.room || "えんがわ",
      guest_name: b.guestName,
      location: "えんがわ",
    });
    events++;

    // 売上として登録
    if (b.hostEarnings && b.hostEarnings > 0) {
      await db.upsertTransaction({
        id: `airbnb_rev_${b.confirmationCode}`,
        date: b.checkin,
        amount: b.hostEarnings,
        category: "宿泊売上",
        business: "えんがわ",
        source: "airbnb",
        source_id: b.confirmationCode,
        memo: `${b.guestName} ${b.nights}泊 ${b.room || ""}`,
        payment_method: "Airbnb",
      });
      transactions++;
    }

    // 顧客として登録
    await db.upsertCustomer({
      id: custId,
      name: b.guestName || "不明",
      source: "airbnb",
      source_id: b.confirmationCode,
      business: "えんがわ",
      first_contact: b.checkin,
      last_contact: b.checkin,
      total_revenue: b.hostEarnings || 0,
    });
    customers++;
  }

  console.log(`[ingester] Airbnb: ${events}件の予定, ${transactions}件の売上, ${customers}件の顧客`);
  return { events, transactions, customers };
}

// ===== 既存タスクJSON → tasks テーブル =====

async function ingestExistingTasks() {
  const tasksFile = path.join(REPO_DIR, "data", "tasks.json");
  let tasksData;
  try {
    tasksData = JSON.parse(fs.readFileSync(tasksFile, "utf-8"));
  } catch {
    console.log("[ingester] tasks.jsonなし、スキップ");
    return { tasks: 0 };
  }

  let count = 0;
  let skipped = 0;
  const tasks = tasksData.tasks || tasksData;
  if (!Array.isArray(tasks)) return { tasks: 0 };

  // 統合DBに既にあるタスクのステータスを取得（上書き防止用）
  const client = db.getClient();
  const existingTasks = await client.execute(
    "SELECT id, status FROM tasks WHERE source IN ('tasks_json', 'chat', 'manual')"
  );
  const existingStatus = {};
  for (const r of existingTasks.rows) {
    existingStatus[r.id] = r.status;
  }

  for (const t of tasks) {
    const id = t.id || genId("task_");
    const jsonStatus = t.done || t.status === "done" || t.status === "completed" ? "done" : (t.status || "pending");

    // 統合DB側でdone/dismissedにしたタスクは上書きしない
    const dbStatus = existingStatus[id];
    if (dbStatus === "done" || dbStatus === "dismissed") {
      skipped++;
      continue;
    }

    await db.upsertTask({
      id,
      title: t.title || t.text || "無題",
      detail: t.detail || null,
      project: t.project || null,
      priority: t.priority || "medium",
      status: jsonStatus,
      due_date: t.dueDate || t.due_date || null,
      source: t.source || "tasks_json",
      source_id: t.id || null,
      assigned_by: t.assignedBy || null,
      completed_at: t.completedAt || null,
    });
    count++;
  }

  console.log(`[ingester] タスク: ${count}件取り込み, ${skipped}件スキップ（完了済み保護）`);
  return { tasks: count };
}

// ===== Money Forward経費 → money_transactions =====
// ※既存の/api/financeエンドポイントが返すデータを使って統合DBにも書き込む

async function ingestFinanceData(financeData) {
  if (!financeData?.recent) return { transactions: 0 };

  let count = 0;
  for (const item of financeData.recent) {
    const id = `mf_${item.date}_${item.memo?.slice(0, 20) || ""}`.replace(/\s/g, "_");
    await db.upsertTransaction({
      id,
      date: item.date,
      amount: -(item.amount || 0), // 経費は負の値
      category: item.tag || null,
      business: financeData.filters?.business || null,
      source: "moneyforward",
      source_id: null,
      memo: item.memo || item.account,
      payment_method: item.account || null,
    });
    count++;
  }

  console.log(`[ingester] 経費: ${count}件`);
  return { transactions: count };
}

// ===== 全データ取り込み（バッチ実行） =====

async function ingestAll() {
  console.log("[ingester] ========== データ取り込み開始 ==========");
  const start = Date.now();

  const results = {
    airbnb: await ingestAirbnbBookings(),
    tasks: await ingestExistingTasks(),
  };

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[ingester] ========== 完了 (${elapsed}秒) ==========`);
  console.log("[ingester] 結果:", JSON.stringify(results));
  return results;
}

module.exports = {
  ingestAll,
  ingestAirbnbBookings,
  ingestExistingTasks,
  ingestFinanceData,
};
