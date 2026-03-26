/**
 * task-store.js — しらたまタスク管理の単一データソース
 *
 * unified.db (SQLite) を正とする。tasks.jsonは起動時のマイグレーション元・バックアップ用。
 * line-webhook-server.js, git-scanner.js, daily-scan.sh から共用。
 *
 * CLI:
 *   node task-store.js get-today
 *   node task-store.js get-all
 *   node task-store.js get-open
 *   node task-store.js complete <id> <by> <note>
 *   node task-store.js add <json>
 *   node task-store.js migrate  (tasks.json → DB に一括取り込み)
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
const TASKS_FILE = path.join(DATA_DIR, "tasks.json");

// DB接続（遅延ロード）
let _db = null;
function getDb() {
  if (!_db) {
    _db = require("./unified-db");
  }
  return _db;
}

function genId() {
  return "t_" + crypto.randomBytes(6).toString("hex");
}

function now() {
  return new Date().toISOString();
}

function todayStr() {
  const d = new Date();
  const jst = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, "0")}-${String(jst.getDate()).padStart(2, "0")}`;
}

// --- Core CRUD (DB-backed) ---

async function addTask({ title, project, priority = "medium", type = "mixed", dueDate = null, source = "manual", sourceDetail = "" }) {
  const db = getDb();
  const id = genId();
  await db.upsertTask({
    id,
    title,
    project: project || "その他",
    priority,
    status: "pending",
    due_date: dueDate,
    source,
    source_id: sourceDetail || null,
    assigned_by: source,
  });
  return { id, title, project: project || "その他", priority, status: "pending", dueDate, source };
}

async function updateTask(id, updates, by = "system", note = "") {
  const db = getDb();
  const tasks = await db.getTasks({});
  const existing = tasks.find(t => t.id === id);
  if (!existing) return null;

  const merged = { ...existing, ...updates };
  await db.upsertTask({
    id,
    title: merged.title,
    detail: merged.detail,
    project: merged.project,
    priority: merged.priority,
    status: merged.status,
    due_date: merged.due_date,
    source: merged.source || "manual",
    source_id: merged.source_id,
    assigned_by: merged.assigned_by,
    completed_at: merged.completed_at,
  });
  return merged;
}

async function completeTask(id, { by = "system", note = "" } = {}) {
  return updateTask(id, { status: "done", completed_at: now() }, by, note);
}

async function postponeTask(id, { by = "system", note = "" } = {}) {
  return updateTask(id, { status: "pending" }, by, note);
}

// --- Query helpers ---

async function findTasksByProject(project) {
  const db = getDb();
  return db.getTasks({ project, status: null });
}

async function getTodaysTasks() {
  const db = getDb();
  const client = db.getClient();
  const today = todayStr();
  const result = await client.execute({
    sql: `SELECT * FROM tasks
          WHERE status IN ('pending', 'in_progress')
          ORDER BY
            CASE WHEN due_date IS NOT NULL AND due_date <= ? THEN 0 ELSE 1 END,
            CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
            created_at DESC`,
    args: [today],
  });
  return result.rows;
}

async function getRecentlyCompleted(days = 1) {
  const db = getDb();
  const client = db.getClient();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const result = await client.execute({
    sql: "SELECT * FROM tasks WHERE status = 'done' AND completed_at >= ? ORDER BY completed_at DESC",
    args: [cutoffStr],
  });
  return result.rows;
}

async function getAllOpen() {
  const db = getDb();
  const client = db.getClient();
  // "open" (旧tasks.json形式) と "pending" (新DB形式) の両方を対応
  const result = await client.execute({
    sql: "SELECT * FROM tasks WHERE status IN ('pending', 'open', 'in_progress') ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC",
    args: [],
  });
  return result.rows;
}

// --- Migration: tasks.json → DB ---

async function migrateFromJson() {
  if (!fs.existsSync(TASKS_FILE)) {
    console.log("[task-store] tasks.json not found, skip migration");
    return 0;
  }

  const db = getDb();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8"));
  } catch (e) {
    console.error("[task-store] tasks.json parse error:", e.message);
    return 0;
  }

  const tasks = data.tasks || [];
  let migrated = 0;

  for (const t of tasks) {
    // 既存チェック
    const client = db.getClient();
    const existing = await client.execute({ sql: "SELECT id FROM tasks WHERE id = ?", args: [t.id] });
    if (existing.rows.length > 0) continue;

    await db.upsertTask({
      id: t.id,
      title: t.title,
      detail: t.sourceDetail || null,
      project: t.project || "その他",
      priority: t.priority || "medium",
      status: t.status === "done" ? "done" : t.status === "open" ? "pending" : (t.status || "pending"),
      due_date: t.dueDate || null,
      source: t.source || "migration",
      source_id: t.sourceDetail || null,
      assigned_by: t.source || null,
      completed_at: t.completedAt || null,
    });
    migrated++;
  }

  if (migrated > 0) {
    console.log(`[task-store] Migrated ${migrated} tasks from tasks.json to DB`);
  }
  return migrated;
}

// --- JSON export (バックアップ用) ---

async function exportToJson() {
  const db = getDb();
  const allTasks = await db.getTasks({ limit: 500 });
  const data = {
    version: 2,
    lastUpdated: now(),
    source: "unified-db",
    tasks: allTasks,
  };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
  return allTasks.length;
}

// --- Exports ---
module.exports = {
  addTask,
  updateTask,
  completeTask,
  postponeTask,
  findTasksByProject,
  getTodaysTasks,
  getRecentlyCompleted,
  getAllOpen,
  migrateFromJson,
  exportToJson,
  genId,
  todayStr,
  TASKS_FILE,
};

// --- CLI mode ---
if (require.main === module) {
  const cmd = process.argv[2];

  (async () => {
    // DB初期化
    const db = getDb();
    await db.initSchema();

    if (cmd === "get-today") {
      console.log(JSON.stringify(await getTodaysTasks(), null, 2));
    } else if (cmd === "get-all") {
      const tasks = await db.getTasks({ limit: 200 });
      console.log(JSON.stringify(tasks, null, 2));
    } else if (cmd === "get-open") {
      console.log(JSON.stringify(await getAllOpen(), null, 2));
    } else if (cmd === "complete") {
      const id = process.argv[3];
      const by = process.argv[4] || "cli";
      const note = process.argv[5] || "";
      const result = await completeTask(id, { by, note });
      console.log(result ? `Completed: ${result.title}` : `Task not found: ${id}`);
    } else if (cmd === "add") {
      const json = process.argv[3];
      try {
        const result = await addTask(JSON.parse(json));
        console.log(`Added: ${result.id} - ${result.title}`);
      } catch (e) {
        console.error("Invalid JSON:", e.message);
      }
    } else if (cmd === "migrate") {
      const count = await migrateFromJson();
      console.log(`Migration complete: ${count} tasks imported`);
    } else {
      console.log("Usage: node task-store.js [get-today|get-all|get-open|complete <id>|add <json>|migrate]");
    }
  })().catch(e => console.error(e));
}
