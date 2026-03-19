/**
 * 統合データベース — しらたまの全事業データを1箇所に集約
 *
 * ローカルSQLite（libSQL）で動作。
 * 将来TursoDB(クラウド)に移行する場合はURLとauthTokenを変更するだけ。
 */

const { createClient } = require("@libsql/client");
const path = require("path");

const DB_PATH = process.env.UNIFIED_DB_URL || `file:${path.join(__dirname, "..", "data", "unified.db")}`;

let _client = null;

function getClient() {
  if (!_client) {
    _client = createClient({
      url: DB_PATH,
      authToken: process.env.UNIFIED_DB_AUTH_TOKEN || undefined,
    });
  }
  return _client;
}

// ===== スキーマ初期化 =====

async function initSchema() {
  const db = getClient();

  await db.batch([
    // お金（売上・経費・口座残高）
    `CREATE TABLE IF NOT EXISTS money_transactions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      category TEXT,
      business TEXT,
      source TEXT NOT NULL,
      source_id TEXT,
      memo TEXT,
      payment_method TEXT,
      is_recurring INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_money_date ON money_transactions(date)`,
    `CREATE INDEX IF NOT EXISTS idx_money_business ON money_transactions(business)`,
    `CREATE INDEX IF NOT EXISTS idx_money_source ON money_transactions(source)`,

    // 口座残高
    `CREATE TABLE IF NOT EXISTS money_balances (
      id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL,
      balance INTEGER NOT NULL,
      as_of TEXT NOT NULL,
      source TEXT NOT NULL
    )`,

    // 予定（予約・打ち合わせ・締切）
    `CREATE TABLE IF NOT EXISTS schedule_events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT,
      all_day INTEGER DEFAULT 0,
      source TEXT NOT NULL,
      source_id TEXT,
      calendar_name TEXT,
      location TEXT,
      description TEXT,
      guest_name TEXT,
      status TEXT DEFAULT 'confirmed',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_schedule_start ON schedule_events(start_at)`,
    `CREATE INDEX IF NOT EXISTS idx_schedule_source ON schedule_events(source)`,

    // 顧客
    `CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      source TEXT NOT NULL,
      source_id TEXT,
      business TEXT,
      first_contact TEXT,
      last_contact TEXT,
      total_revenue INTEGER DEFAULT 0,
      notes TEXT,
      tags TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_customers_business ON customers(business)`,

    // 顧客インタラクション
    `CREATE TABLE IF NOT EXISTS customer_interactions (
      id TEXT PRIMARY KEY,
      customer_id TEXT REFERENCES customers(id),
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      summary TEXT,
      amount INTEGER,
      metadata TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_interactions_customer ON customer_interactions(customer_id)`,

    // タスク
    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      detail TEXT,
      project TEXT,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'pending',
      due_date TEXT,
      source TEXT NOT NULL,
      source_id TEXT,
      assigned_by TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project)`,

    // 事業指標（集計値）
    `CREATE TABLE IF NOT EXISTS business_metrics (
      id TEXT PRIMARY KEY,
      metric_key TEXT NOT NULL,
      business TEXT,
      period TEXT NOT NULL,
      value REAL NOT NULL,
      metadata TEXT,
      computed_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_metrics_key ON business_metrics(metric_key, period)`,

    // 秘書の気づき（自律判断エンジンの出力）
    `CREATE TABLE IF NOT EXISTS agent_insights (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      urgency TEXT DEFAULT 'info',
      status TEXT DEFAULT 'pending',
      related_table TEXT,
      related_id TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      shown_at TEXT,
      acted_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_insights_status ON agent_insights(status)`,
    `CREATE INDEX IF NOT EXISTS idx_insights_urgency ON agent_insights(urgency)`,
  ]);

  console.log("[unified-db] スキーマ初期化完了");
}

// ===== お金 =====

async function upsertTransaction(tx) {
  const db = getClient();
  await db.execute({
    sql: `INSERT OR REPLACE INTO money_transactions (id, date, amount, category, business, source, source_id, memo, payment_method, is_recurring, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))`,
    args: [tx.id, tx.date, tx.amount, tx.category || null, tx.business || null, tx.source, tx.source_id || null, tx.memo || null, tx.payment_method || null, tx.is_recurring || 0],
  });
}

async function getTransactions({ month, business, limit = 100 } = {}) {
  const db = getClient();
  let sql = "SELECT * FROM money_transactions WHERE 1=1";
  const args = [];
  if (month) { sql += " AND date LIKE ?"; args.push(`${month}%`); }
  if (business) { sql += " AND business = ?"; args.push(business); }
  sql += " ORDER BY date DESC LIMIT ?";
  args.push(limit);
  const result = await db.execute({ sql, args });
  return result.rows;
}

async function getMonthlyTotals({ business, months = 6 } = {}) {
  const db = getClient();
  let sql = `SELECT strftime('%Y-%m', date) as month, SUM(amount) as total
             FROM money_transactions WHERE 1=1`;
  const args = [];
  if (business) { sql += " AND business = ?"; args.push(business); }
  sql += " GROUP BY month ORDER BY month DESC LIMIT ?";
  args.push(months);
  const result = await db.execute({ sql, args });
  return result.rows;
}

// ===== 予定 =====

async function upsertEvent(evt) {
  const db = getClient();
  await db.execute({
    sql: `INSERT OR REPLACE INTO schedule_events (id, title, start_at, end_at, all_day, source, source_id, calendar_name, location, description, guest_name, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [evt.id, evt.title, evt.start_at, evt.end_at || null, evt.all_day || 0, evt.source, evt.source_id || null, evt.calendar_name || null, evt.location || null, evt.description || null, evt.guest_name || null, evt.status || "confirmed"],
  });
}

async function getUpcomingEvents({ days = 7 } = {}) {
  const db = getClient();
  const now = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const result = await db.execute({
    sql: "SELECT * FROM schedule_events WHERE start_at >= ? AND start_at <= ? AND status != 'cancelled' ORDER BY start_at",
    args: [now, future],
  });
  return result.rows;
}

// ===== 顧客 =====

async function upsertCustomer(cust) {
  const db = getClient();
  await db.execute({
    sql: `INSERT OR REPLACE INTO customers (id, name, email, phone, source, source_id, business, first_contact, last_contact, total_revenue, notes, tags)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [cust.id, cust.name, cust.email || null, cust.phone || null, cust.source, cust.source_id || null, cust.business || null, cust.first_contact || null, cust.last_contact || null, cust.total_revenue || 0, cust.notes || null, cust.tags || null],
  });
}

async function getCustomers({ business } = {}) {
  const db = getClient();
  let sql = "SELECT * FROM customers WHERE 1=1";
  const args = [];
  if (business) { sql += " AND business = ?"; args.push(business); }
  sql += " ORDER BY last_contact DESC";
  const result = await db.execute({ sql, args });
  return result.rows;
}

// ===== タスク =====

async function upsertTask(task) {
  const db = getClient();
  await db.execute({
    sql: `INSERT OR REPLACE INTO tasks (id, title, detail, project, priority, status, due_date, source, source_id, assigned_by, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [task.id, task.title, task.detail || null, task.project || null, task.priority || "medium", task.status || "pending", task.due_date || null, task.source, task.source_id || null, task.assigned_by || null, task.completed_at || null],
  });
}

async function getTasks({ project, status, limit = 50 } = {}) {
  const db = getClient();
  let sql = "SELECT * FROM tasks WHERE 1=1";
  const args = [];
  if (project) { sql += " AND project = ?"; args.push(project); }
  if (status) { sql += " AND status = ?"; args.push(status); }
  sql += " ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC LIMIT ?";
  args.push(limit);
  const result = await db.execute({ sql, args });
  return result.rows;
}

// ===== 秘書の気づき =====

async function addInsight(insight) {
  const db = getClient();
  await db.execute({
    sql: `INSERT INTO agent_insights (id, type, title, detail, urgency, status, related_table, related_id)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    args: [insight.id, insight.type, insight.title, insight.detail || null, insight.urgency || "info", insight.related_table || null, insight.related_id || null],
  });
}

async function getPendingInsights() {
  const db = getClient();
  const result = await db.execute(
    "SELECT * FROM agent_insights WHERE status = 'pending' ORDER BY CASE urgency WHEN 'critical' THEN 1 WHEN 'action_needed' THEN 2 ELSE 3 END, created_at DESC"
  );
  return result.rows;
}

async function markInsight(id, status) {
  // 許可されたステータスのみ
  const ALLOWED = ["shown", "acted", "dismissed"];
  if (!ALLOWED.includes(status)) status = "acted";
  const db = getClient();
  const field = status === "shown" ? "shown_at" : "acted_at";
  await db.execute({
    sql: `UPDATE agent_insights SET status = ?, ${field} = datetime('now', 'localtime') WHERE id = ?`,
    args: [status, id],
  });
}

// ===== 事業指標 =====

async function upsertMetric(metric) {
  const db = getClient();
  await db.execute({
    sql: `INSERT OR REPLACE INTO business_metrics (id, metric_key, business, period, value, metadata, computed_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))`,
    args: [metric.id, metric.metric_key, metric.business, metric.period, metric.value, metric.metadata ? JSON.stringify(metric.metadata) : null],
  });
}

// ===== ダッシュボード（統合クエリ） =====

async function getDashboardSummary() {
  const db = getClient();
  const now = new Date();
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const thisMonth = `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, "0")}`;
  const today = jst.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const weekLater = new Date(now.getTime() + 7 * 86400000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

  const [revenue, expenses, events, pendingTasks, insights, bizRevenue, bizBookings, bizCustomers] = await Promise.all([
    db.execute({ sql: "SELECT SUM(amount) as total FROM money_transactions WHERE date LIKE ? AND amount > 0", args: [`${thisMonth}%`] }),
    db.execute({ sql: "SELECT SUM(ABS(amount)) as total FROM money_transactions WHERE date LIKE ? AND amount < 0", args: [`${thisMonth}%`] }),
    db.execute({ sql: "SELECT * FROM schedule_events WHERE start_at >= ? AND start_at <= ? AND status != 'cancelled' ORDER BY start_at LIMIT 10", args: [today, weekLater] }),
    db.execute({ sql: "SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'in_progress')", args: [] }),
    db.execute({ sql: "SELECT * FROM agent_insights WHERE status = 'pending' ORDER BY CASE urgency WHEN 'critical' THEN 1 WHEN 'action_needed' THEN 2 ELSE 3 END LIMIT 5", args: [] }),
    // 事業別の今月売上
    db.execute({ sql: "SELECT business, SUM(amount) as total FROM money_transactions WHERE date LIKE ? AND amount > 0 GROUP BY business", args: [`${thisMonth}%`] }),
    // 事業別の今週予約数
    db.execute({ sql: "SELECT calendar_name, COUNT(*) as cnt FROM schedule_events WHERE start_at >= ? AND start_at <= ? AND source = 'airbnb' AND status != 'cancelled' GROUP BY calendar_name", args: [today, weekLater] }),
    // 事業別の顧客数
    db.execute({ sql: "SELECT business, COUNT(*) as cnt FROM customers GROUP BY business", args: [] }),
  ]);

  // 事業別サマリーを構築
  const businesses = {};
  for (const r of bizRevenue.rows) {
    if (!r.business) continue;
    if (!businesses[r.business]) businesses[r.business] = {};
    businesses[r.business].revenue = r.total || 0;
  }
  for (const r of bizBookings.rows) {
    const biz = r.calendar_name || "えんがわ";
    if (!businesses["えんがわ"]) businesses["えんがわ"] = {};
    businesses["えんがわ"].weeklyBookings = (businesses["えんがわ"].weeklyBookings || 0) + (r.cnt || 0);
  }
  for (const r of bizCustomers.rows) {
    if (!r.business) continue;
    if (!businesses[r.business]) businesses[r.business] = {};
    businesses[r.business].customers = r.cnt || 0;
  }

  return {
    thisMonth,
    revenue: revenue.rows[0]?.total || 0,
    expenses: expenses.rows[0]?.total || 0,
    upcomingEvents: events.rows,
    pendingTaskCount: pendingTasks.rows[0]?.count || 0,
    insights: insights.rows,
    businesses,
  };
}

module.exports = {
  initSchema,
  getClient,
  // お金
  upsertTransaction,
  getTransactions,
  getMonthlyTotals,
  // 予定
  upsertEvent,
  getUpcomingEvents,
  // 顧客
  upsertCustomer,
  getCustomers,
  // タスク
  upsertTask,
  getTasks,
  // 気づき
  addInsight,
  getPendingInsights,
  markInsight,
  // 指標
  upsertMetric,
  // ダッシュボード
  getDashboardSummary,
};
