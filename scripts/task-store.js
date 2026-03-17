/**
 * task-store.js — しらたまタスク管理の単一データソース
 *
 * tasks.json を読み書きするモジュール。
 * line-webhook-server.js, git-scanner.js, daily-scan.sh から共用。
 *
 * CLI:
 *   node task-store.js get-today
 *   node task-store.js get-all
 *   node task-store.js complete <id> <by> <note>
 *   node task-store.js add <json>
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const TASKS_FILE = path.join(DATA_DIR, "tasks.json");

// --- In-memory cache ---
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 5000; // 5s

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

// --- Core CRUD ---

function loadTasks() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8"));
  } catch {
    _cache = { version: 1, lastUpdated: now(), tasks: [], completedArchive: [] };
  }
  _cacheTime = Date.now();
  return _cache;
}

function saveTasks(data) {
  data.lastUpdated = now();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
  _cache = data;
  _cacheTime = Date.now();
}

function addTask({ title, project, priority = "medium", type = "mixed", dueDate = null, source = "manual", sourceDetail = "" }) {
  const data = loadTasks();
  const task = {
    id: genId(),
    title,
    project: project || "その他",
    status: "open",
    priority,
    type,
    dueDate,
    createdAt: now(),
    updatedAt: now(),
    completedAt: null,
    source,
    sourceDetail,
    history: [{ timestamp: now(), action: "created", by: source, note: sourceDetail }],
    tags: [],
    relatedCommits: [],
    calendarEventId: null,
  };
  data.tasks.push(task);
  saveTasks(data);
  return task;
}

function updateTask(id, updates, by = "system", note = "") {
  const data = loadTasks();
  const task = data.tasks.find(t => t.id === id);
  if (!task) return null;

  for (const [key, val] of Object.entries(updates)) {
    if (key !== "id" && key !== "history") task[key] = val;
  }
  task.updatedAt = now();
  task.history.push({ timestamp: now(), action: "updated", by, note: note || JSON.stringify(updates) });
  saveTasks(data);
  return task;
}

function completeTask(id, { by = "system", note = "" } = {}) {
  const data = loadTasks();
  const task = data.tasks.find(t => t.id === id);
  if (!task) return null;

  task.status = "done";
  task.completedAt = now();
  task.updatedAt = now();
  task.history.push({ timestamp: now(), action: "completed", by, note });
  saveTasks(data);
  return task;
}

function postponeTask(id, { by = "system", note = "" } = {}) {
  return updateTask(id, { status: "open" }, by, note || "延期");
}

// --- Query helpers ---

function findTasksByProject(project) {
  const data = loadTasks();
  return data.tasks.filter(t => t.project === project && t.status !== "done");
}

function findTasksByKeywords(keywords) {
  const data = loadTasks();
  return data.tasks.filter(t => {
    if (t.status === "done") return false;
    const title = t.title.toLowerCase();
    return keywords.some(kw => title.includes(kw.toLowerCase()));
  });
}

function findTaskByTitle(titleFragment) {
  const data = loadTasks();
  return data.tasks.find(t => t.status !== "done" && t.title.includes(titleFragment));
}

function getTodaysTasks() {
  const data = loadTasks();
  const today = todayStr();
  const open = data.tasks.filter(t => t.status === "open" || t.status === "in_progress");

  // Sort: priority (high > medium > low), then due date (overdue first, then today, then future)
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return open.sort((a, b) => {
    // Due today or overdue first
    const aOverdue = a.dueDate && a.dueDate <= today ? -1 : 0;
    const bOverdue = b.dueDate && b.dueDate <= today ? -1 : 0;
    if (aOverdue !== bOverdue) return aOverdue - bOverdue;
    // Then priority
    return (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1);
  });
}

function getRecentlyCompleted(days = 1) {
  const data = loadTasks();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString();

  return data.tasks.filter(t => t.status === "done" && t.completedAt && t.completedAt >= cutoffStr);
}

function getAllOpen() {
  const data = loadTasks();
  return data.tasks.filter(t => t.status === "open" || t.status === "in_progress");
}

// --- Maintenance ---

function archiveOldCompleted(daysOld = 30) {
  const data = loadTasks();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysOld);
  const cutoffStr = cutoff.toISOString();

  const toArchive = data.tasks.filter(t => t.status === "done" && t.completedAt && t.completedAt < cutoffStr);
  if (toArchive.length === 0) return 0;

  data.completedArchive.push(...toArchive);
  data.tasks = data.tasks.filter(t => !toArchive.includes(t));
  // Keep archive manageable (max 200)
  if (data.completedArchive.length > 200) {
    data.completedArchive = data.completedArchive.slice(-200);
  }
  saveTasks(data);
  return toArchive.length;
}

// --- Exports ---
module.exports = {
  loadTasks,
  saveTasks,
  addTask,
  updateTask,
  completeTask,
  postponeTask,
  findTasksByProject,
  findTasksByKeywords,
  findTaskByTitle,
  getTodaysTasks,
  getRecentlyCompleted,
  getAllOpen,
  archiveOldCompleted,
  genId,
  todayStr,
  TASKS_FILE,
};

// --- CLI mode ---
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "get-today") {
    console.log(JSON.stringify(getTodaysTasks(), null, 2));
  } else if (cmd === "get-all") {
    console.log(JSON.stringify(loadTasks(), null, 2));
  } else if (cmd === "get-open") {
    console.log(JSON.stringify(getAllOpen(), null, 2));
  } else if (cmd === "complete") {
    const id = process.argv[3];
    const by = process.argv[4] || "cli";
    const note = process.argv[5] || "";
    const result = completeTask(id, { by, note });
    console.log(result ? `Completed: ${result.title}` : `Task not found: ${id}`);
  } else if (cmd === "add") {
    const json = process.argv[3];
    try {
      const result = addTask(JSON.parse(json));
      console.log(`Added: ${result.id} - ${result.title}`);
    } catch (e) {
      console.error("Invalid JSON:", e.message);
    }
  } else {
    console.log("Usage: node task-store.js [get-today|get-all|get-open|complete <id>|add <json>]");
  }
}
