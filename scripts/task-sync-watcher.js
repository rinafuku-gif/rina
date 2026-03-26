/**
 * task-sync-watcher.js — タスク同期のファイル監視デーモン
 *
 * Obsidianのタスク一覧.mdを監視し、変更があれば全箇所に同期する。
 * unified.dbの変更も5分ごとにポーリングで検出。
 *
 * 起動: node task-sync-watcher.js
 * 停止: Ctrl+C or kill
 * launchd: com.rina.task-sync.plist
 */

const fs = require("fs");
const path = require("path");
const { fullSync, syncFromTaskList, syncFromDb, TASK_LIST_FILE } = require("./task-sync");

const REPO_DIR = path.join(__dirname, "..");
const LOG_FILE = path.join(REPO_DIR, "logs", "task-sync.log");
const PID_FILE = path.join(REPO_DIR, "data", ".task-sync.pid");

// --- Config ---
const DEBOUNCE_MS = 3000;       // iCloud同期の遅延を考慮（3秒）
const DB_POLL_INTERVAL = 300000; // DB→Obsidian方向のポーリング間隔（5分）

// --- Logging ---
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [watcher] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// --- Debounce ---
let debounceTimer = null;

function debouncedSync() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    log("File change detected, syncing...");
    await syncFromTaskList().catch(e => log(`Sync error: ${e.message}`));
  }, DEBOUNCE_MS);
}

// --- File watcher ---
let watcher = null;

function startWatching() {
  const watchDir = path.dirname(TASK_LIST_FILE);
  const watchFile = path.basename(TASK_LIST_FILE);

  if (!fs.existsSync(watchDir)) {
    log(`Watch directory not found: ${watchDir}`);
    log("Will retry in 60 seconds...");
    setTimeout(startWatching, 60000);
    return;
  }

  try {
    // ディレクトリを監視（iCloudはファイル直接監視が不安定なため）
    watcher = fs.watch(watchDir, { persistent: true }, (eventType, filename) => {
      if (filename === watchFile) {
        debouncedSync();
      }
    });

    watcher.on("error", (err) => {
      log(`Watcher error: ${err.message}`);
      // 再接続
      setTimeout(() => {
        if (watcher) { try { watcher.close(); } catch {} }
        startWatching();
      }, 5000);
    });

    log(`Watching: ${TASK_LIST_FILE}`);
  } catch (e) {
    log(`Failed to start watcher: ${e.message}`);
    setTimeout(startWatching, 60000);
  }
}

// --- DB polling ---
let dbPollTimer = null;

function startDbPolling() {
  dbPollTimer = setInterval(async () => {
    log("DB poll: checking unified.db for changes...");
    await syncFromDb().catch(e => log(`DB sync error: ${e.message}`));
  }, DB_POLL_INTERVAL);

  log(`DB polling started (every ${DB_POLL_INTERVAL / 1000}s)`);
}

// --- PID file ---
function writePid() {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {}
}

function removePid() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch {}
}

// --- Graceful shutdown ---
function shutdown(signal) {
  log(`Received ${signal}, shutting down...`);
  if (watcher) { try { watcher.close(); } catch {} }
  if (dbPollTimer) clearInterval(dbPollTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  removePid();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (e) => {
  log(`Uncaught exception: ${e.message}`);
  // 致命的でなければ続行
});

// --- Main ---
log("=== task-sync-watcher starting ===");
writePid();

// 起動時に一回フル同期
fullSync().catch(e => log(`Initial sync error: ${e.message}`));

// ファイル監視開始
startWatching();

// DBポーリング開始
startDbPolling();

log("Watcher is running. Press Ctrl+C to stop.");
