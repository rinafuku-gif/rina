/**
 * task-sync.js — タスク双方向同期モジュール
 *
 * 同期対象:
 *   1. Obsidian タスク一覧.md（マスター）
 *   2. Obsidian ダッシュボード.md
 *   3. Obsidian 各事業ページ（04_事業/）
 *   4. deadlines.json
 *   5. unified.db (tasksテーブル)
 *   6. tasks.json（バックアップ）
 *
 * CLI:
 *   node task-sync.js sync             全箇所の差分を検出して同期
 *   node task-sync.js complete "タスク名"  指定タスクを全箇所で完了に
 *   node task-sync.js uncomplete "タスク名"  指定タスクを全箇所で未完了に
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// --- Paths ---
const REPO_DIR = path.join(__dirname, "..");
const VAULT_DIR = path.join(
  os.homedir(),
  "Library", "Mobile Documents", "iCloud~md~obsidian",
  "Documents", "obsidian-vault"
);
const TASK_LIST_FILE = path.join(VAULT_DIR, "02_プロジェクト", "タスク一覧.md");
const DASHBOARD_FILE = path.join(VAULT_DIR, "ダッシュボード.md");
const BUSINESS_DIR = path.join(VAULT_DIR, "04_事業");
const DEADLINES_FILE = path.join(REPO_DIR, "data", "deadlines.json");
const TASKS_JSON_FILE = path.join(REPO_DIR, "data", "tasks.json");
const LOG_FILE = path.join(REPO_DIR, "logs", "task-sync.log");

// Sync lock to prevent loops
let _syncing = false;

// DB client (lazy singleton)
let _dbClient = null;
function getDbClient() {
  if (!_dbClient) {
    const dbPath = path.join(REPO_DIR, "data", "unified.db");
    if (!fs.existsSync(dbPath)) return null;
    const { createClient } = require("@libsql/client");
    _dbClient = createClient({ url: `file:${dbPath}` });
  }
  return _dbClient;
}

// --- Logging ---
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.error(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// --- Safe file I/O ---
function safeRead(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    log(`Read error ${filePath}: ${e.message}`);
    return null;
  }
}

function safeWrite(filePath, content) {
  try {
    const tmpPath = filePath + ".tmp." + crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (e) {
    log(`Write error ${filePath}: ${e.message}`);
    return false;
  }
}

// --- Task name matching ---
function normalizeTitle(title) {
  return title
    .replace(/\[\[.*?\]\]/g, "")  // Obsidianリンク
    .replace(/\*\*([^*]+)\*\*/g, "$1") // 太字
    .replace(/（.*?）/g, "") // 全角括弧の補足
    .replace(/\(.*?\)/g, "") // 半角括弧の補足
    .trim();
}

function titlesMatch(a, b) {
  const na = normalizeTitle(a).toLowerCase();
  const nb = normalizeTitle(b).toLowerCase();
  if (na === nb) return true;
  // 15文字以上の部分一致
  if (na.length >= 15 && nb.includes(na.slice(0, 15))) return true;
  if (nb.length >= 15 && na.includes(nb.slice(0, 15))) return true;
  // 短いタイトルは10文字で判定
  if (na.length >= 10 && nb.includes(na.slice(0, 10))) return true;
  if (nb.length >= 10 && na.includes(nb.slice(0, 10))) return true;
  // キーワード方式: 意味のある単語を抽出して3つ以上一致すればマッチ
  const extractWords = (s) => s.replace(/[:\s・、。（）()【】「」\/\-]/g, " ").split(/\s+/).filter(w => w.length >= 2);
  const wordsA = extractWords(na);
  const wordsB = extractWords(nb);
  if (wordsA.length >= 2 && wordsB.length >= 2) {
    const common = wordsA.filter(w => wordsB.some(wb => wb.includes(w) || w.includes(wb)));
    if (common.length >= 2 && common.length >= Math.min(wordsA.length, wordsB.length) * 0.5) return true;
  }
  return false;
}

// --- Parse Obsidian tasks ---
function parseObsidianTasks(content) {
  const tasks = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const doneMatch = lines[i].match(/^- \[x\] (.+)/i);
    const openMatch = lines[i].match(/^- \[ \] (.+)/);
    if (doneMatch) {
      tasks.push({ line: i, title: doneMatch[1], done: true, raw: lines[i] });
    } else if (openMatch) {
      tasks.push({ line: i, title: openMatch[1], done: false, raw: lines[i] });
    }
  }
  return tasks;
}

// --- Update a single Obsidian file ---
function updateObsidianFile(filePath, taskTitle, newDone) {
  const content = safeRead(filePath);
  if (!content) return false;

  const lines = content.split("\n");
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const isChecked = lines[i].match(/^- \[x\] /i);
    const isUnchecked = lines[i].match(/^- \[ \] /);

    if (!isChecked && !isUnchecked) continue;

    const lineTitle = lines[i].replace(/^- \[[ x]\] /i, "");
    if (!titlesMatch(taskTitle, lineTitle)) continue;

    if (newDone && isUnchecked) {
      lines[i] = lines[i].replace("- [ ] ", "- [x] ");
      changed = true;
      log(`  ✓ ${path.basename(filePath)}: checked "${lineTitle.slice(0, 40)}..."`);
    } else if (!newDone && isChecked) {
      lines[i] = lines[i].replace(/- \[x\] /i, "- [ ] ");
      changed = true;
      log(`  ○ ${path.basename(filePath)}: unchecked "${lineTitle.slice(0, 40)}..."`);
    }
    break; // 最初の一致のみ
  }

  if (changed) {
    // 最終更新日を更新
    const today = new Date().toISOString().split("T")[0];
    const updated = lines.join("\n").replace(
      /最終更新: \d{4}-\d{2}-\d{2}/,
      `最終更新: ${today}`
    );
    return safeWrite(filePath, updated);
  }
  return false;
}

// --- Update deadlines.json ---
function updateDeadline(taskTitle, newDone) {
  const content = safeRead(DEADLINES_FILE);
  if (!content) return false;

  try {
    const data = JSON.parse(content);
    let changed = false;

    for (const dl of data.deadlines) {
      if (titlesMatch(taskTitle, dl.title)) {
        const newStatus = newDone ? "完了" : "未着手";
        if (dl.status !== newStatus) {
          dl.status = newStatus;
          changed = true;
          log(`  ✓ deadlines.json: "${dl.title}" → ${newStatus}`);
        }
        break;
      }
    }

    if (changed) {
      return safeWrite(DEADLINES_FILE, JSON.stringify(data, null, 2) + "\n");
    }
  } catch (e) {
    log(`  deadlines.json parse error: ${e.message}`);
  }
  return false;
}

// --- Update unified.db (async, libSQL) ---
async function updateUnifiedDb(taskTitle, newDone) {
  try {
    const db = getDbClient();
    if (!db) return false;

    // 検索対象: 完了時はopenのみ、解除時はdoneのみ
    const searchStatus = newDone ? "open" : "done";
    const result = await db.execute({
      sql: "SELECT id, title, status FROM tasks WHERE status = ?",
      args: [searchStatus],
    });

    for (const row of result.rows) {
      if (titlesMatch(taskTitle, row.title)) {
        const newStatus = newDone ? "done" : "open";
        const completedAt = newDone ? new Date().toISOString() : null;
        await db.execute({
          sql: "UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?",
          args: [newStatus, completedAt, row.id],
        });
        log(`  ✓ unified.db: "${row.title}" → ${newStatus}`);
        return true;
      }
    }
  } catch (e) {
    log(`  unified.db error: ${e.message}`);
  }
  return false;
}

// --- Update tasks.json ---
function updateTasksJson(taskTitle, newDone) {
  const content = safeRead(TASKS_JSON_FILE);
  if (!content) return false;

  try {
    const data = JSON.parse(content);
    let changed = false;

    for (const task of (data.tasks || [])) {
      if (titlesMatch(taskTitle, task.title)) {
        const newStatus = newDone ? "done" : "open";
        if (task.status !== newStatus) {
          task.status = newStatus;
          task.completedAt = newDone ? new Date().toISOString() : null;
          task.updatedAt = new Date().toISOString();
          changed = true;
          log(`  ✓ tasks.json: "${task.title}" → ${newStatus}`);
        }
        break;
      }
    }

    if (changed) {
      data.lastUpdated = new Date().toISOString();
      return safeWrite(TASKS_JSON_FILE, JSON.stringify(data, null, 2));
    }
  } catch (e) {
    log(`  tasks.json parse error: ${e.message}`);
  }
  return false;
}

// --- Propagate a single task state to all targets ---
async function propagateTaskState(taskTitle, newDone, sourceFile) {
  log(`Propagating: "${normalizeTitle(taskTitle).slice(0, 50)}" → ${newDone ? "完了" : "未完了"} (from ${path.basename(sourceFile || "unknown")})`);

  // 1. タスク一覧.md（sourceでなければ）
  if (sourceFile !== TASK_LIST_FILE) {
    updateObsidianFile(TASK_LIST_FILE, taskTitle, newDone);
  }

  // 2. ダッシュボード.md
  if (sourceFile !== DASHBOARD_FILE) {
    updateObsidianFile(DASHBOARD_FILE, taskTitle, newDone);
  }

  // 3. 各事業ページ
  if (fs.existsSync(BUSINESS_DIR)) {
    try {
      const files = fs.readdirSync(BUSINESS_DIR).filter(f => f.endsWith(".md"));
      for (const file of files) {
        const filePath = path.join(BUSINESS_DIR, file);
        if (sourceFile !== filePath) {
          updateObsidianFile(filePath, taskTitle, newDone);
        }
      }
    } catch {}
  }

  // 4. deadlines.json
  updateDeadline(taskTitle, newDone);

  // 5. unified.db
  await updateUnifiedDb(taskTitle, newDone);

  // 6. tasks.json
  updateTasksJson(taskTitle, newDone);
}

// --- Diff-based sync: compare タスク一覧.md snapshot ---
const SNAPSHOT_FILE = path.join(REPO_DIR, "data", ".task-list-snapshot.json");

function loadSnapshot() {
  const content = safeRead(SNAPSHOT_FILE);
  if (!content) return {};
  try { return JSON.parse(content); } catch { return {}; }
}

function saveSnapshot(taskMap) {
  safeWrite(SNAPSHOT_FILE, JSON.stringify(taskMap, null, 2));
}

function buildTaskMap(content) {
  const tasks = parseObsidianTasks(content);
  const map = {};
  for (const t of tasks) {
    const key = normalizeTitle(t.title).slice(0, 50);
    map[key] = { done: t.done, title: t.title };
  }
  return map;
}

async function syncFromTaskList() {
  if (_syncing) return;
  _syncing = true;

  try {
    const content = safeRead(TASK_LIST_FILE);
    if (!content) return;

    const current = buildTaskMap(content);
    const previous = loadSnapshot();

    let changes = 0;
    for (const [key, val] of Object.entries(current)) {
      const prev = previous[key];
      if (prev && prev.done !== val.done) {
        log(`Change detected: "${key}" ${prev.done ? "完了→未完了" : "未完了→完了"}`);
        await propagateTaskState(val.title, val.done, TASK_LIST_FILE);
        changes++;
      }
    }

    // 新しいスナップショットを保存
    saveSnapshot(current);

    if (changes > 0) {
      log(`Sync complete: ${changes} change(s) propagated`);
    }
  } catch (e) {
    log(`Sync error: ${e.message}`);
  } finally {
    _syncing = false;
  }
}

// --- Sync from unified.db → Obsidian ---
async function syncFromDb() {
  if (_syncing) return;
  _syncing = true;

  try {
    const db = getDbClient();
    if (!db) return;

    const result = await db.execute("SELECT title, status FROM tasks");
    const rows = result.rows;

    const content = safeRead(TASK_LIST_FILE);
    if (!content) return;

    const obsidianTasks = parseObsidianTasks(content);
    let changes = 0;

    for (const row of rows) {
      const dbDone = row.status === "done";
      for (const ot of obsidianTasks) {
        if (titlesMatch(row.title, ot.title) && ot.done !== dbDone) {
          log(`DB→Obsidian: "${row.title.slice(0, 40)}" ${dbDone ? "→完了" : "→未完了"}`);
          updateObsidianFile(TASK_LIST_FILE, ot.title, dbDone);
          updateObsidianFile(DASHBOARD_FILE, ot.title, dbDone);
          changes++;
          break;
        }
      }
    }

    if (changes > 0) {
      // スナップショット更新
      const updatedContent = safeRead(TASK_LIST_FILE);
      if (updatedContent) saveSnapshot(buildTaskMap(updatedContent));
      log(`DB sync: ${changes} change(s)`);
    }
  } catch (e) {
    log(`DB sync error: ${e.message}`);
  } finally {
    _syncing = false;
  }
}

// --- Full sync (both directions) ---
async function fullSync() {
  log("=== Full sync started ===");
  // 1. Obsidian → all
  await syncFromTaskList();
  // 2. DB → Obsidian
  await syncFromDb();
  log("=== Full sync finished ===");
}

// --- Exports ---
module.exports = {
  propagateTaskState,
  syncFromTaskList,
  syncFromDb,
  fullSync,
  parseObsidianTasks,
  titlesMatch,
  normalizeTitle,
  TASK_LIST_FILE,
  DASHBOARD_FILE,
  BUSINESS_DIR,
  _isSyncing: () => _syncing,
};

// --- CLI ---
if (require.main === module) {
  const cmd = process.argv[2];
  const arg = process.argv[3];

  switch (cmd) {
    case "sync":
      fullSync().catch(e => { console.error(e); process.exit(1); });
      break;
    case "complete":
      if (!arg) { console.error('Usage: node task-sync.js complete "タスク名"'); process.exit(1); }
      propagateTaskState(arg, true, null).catch(e => { console.error(e); process.exit(1); });
      break;
    case "uncomplete":
      if (!arg) { console.error('Usage: node task-sync.js uncomplete "タスク名"'); process.exit(1); }
      propagateTaskState(arg, false, null).catch(e => { console.error(e); process.exit(1); });
      break;
    default:
      console.log(`task-sync.js — タスク双方向同期

Usage:
  node task-sync.js sync              全箇所の差分を検出して同期
  node task-sync.js complete "名前"    指定タスクを全箇所で完了に
  node task-sync.js uncomplete "名前"  指定タスクを全箇所で未完了に
`);
  }
}
