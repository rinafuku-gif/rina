#!/usr/bin/env node
/**
 * notion-sync-pull.js — Notion Task DB 片方向pull同期
 *
 * Notion Task DB を正本とし、以下に反映:
 *   1. ~/rina/data/deadlines.json（アクティブタスク）
 *   2. ~/rina/data/unified.db tasksテーブル（upsert）
 *
 * GTD矛盾スキャン:
 *   日次で1回、いつかやるかも+期日あり / 日付指定で7日以内 / 期限超過 を検出し
 *   Discord に通知（~/rina/logs/.gtd-scan-sent-YYYY-MM-DD でべき等性保証）
 *
 * Usage: node notion-sync-pull.js [--dry-run] [--no-discord]
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { execSync } = require("child_process");

// ---- Paths ----
const HOME = os.homedir();
const RINA_DIR = path.join(HOME, "rina");
const ENV_FILE = path.join(RINA_DIR, ".env");
const DATA_DIR = path.join(RINA_DIR, "data");
const LOG_DIR = path.join(RINA_DIR, "logs");
const DEADLINES_FILE = path.join(DATA_DIR, "deadlines.json");
const UNIFIED_DB = path.join(DATA_DIR, "unified.db");
const LOG_FILE = path.join(LOG_DIR, "notion-sync-pull.log");
const LOCK_FILE = path.join(LOG_DIR, ".notion-sync-pull.lock");

const DATABASE_ID = "500a3ff0-900d-4933-ba83-b511102f6779";
const ARGV = new Set(process.argv.slice(2));
const DRY_RUN = ARGV.has("--dry-run");
const NO_DISCORD = ARGV.has("--no-discord");

// ---- Env loading ----
function loadEnv() {
  const env = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const ENV = loadEnv();
// しらたま専用integration secretを優先。フォールバックで共有キー
const NOTION_API_KEY =
  ENV.SHIRATAMA_NOTION_API_KEY || process.env.SHIRATAMA_NOTION_API_KEY ||
  ENV.NOTION_API_KEY || process.env.NOTION_API_KEY;
if (!NOTION_API_KEY) {
  console.error("SHIRATAMA_NOTION_API_KEY (or NOTION_API_KEY) not found");
  process.exit(1);
}
const DISCORD_CHANNEL_ID = "1486651097157472307"; // #notifications

// ---- Logging ----
fs.mkdirSync(LOG_DIR, { recursive: true });
// cron invokes this with ">> LOG_FILE 2>&1", so stdout is captured.
// Manual runs print to terminal. We write to file directly only when stdout is a TTY.
const _logToFile = process.stdout.isTTY;
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (_logToFile) fs.appendFileSync(LOG_FILE, line + "\n");
}

// ---- Lock ----
if (fs.existsSync(LOCK_FILE)) {
  const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
  if (age < 4 * 60 * 1000) {
    log("Another run in progress, skipping");
    process.exit(0);
  }
  fs.unlinkSync(LOCK_FILE);
}
fs.writeFileSync(LOCK_FILE, String(process.pid));
process.on("exit", () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });

// ---- Notion API ----
function notionRequest(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = https.request({
      hostname: "api.notion.com",
      path: pathname,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(buf);
          if (res.statusCode >= 400) reject(new Error(`Notion ${res.statusCode}: ${buf.slice(0, 300)}`));
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function fetchAllTasks() {
  const all = [];
  let cursor = undefined;
  while (true) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notionRequest(`/v1/databases/${DATABASE_ID}/query`, body);
    all.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return all;
}

// ---- Property extraction ----
function extract(page) {
  const p = page.properties || {};
  const title = p["タスク名"]?.title?.map((t) => t.plain_text).join("") || "";
  const gtd = p["GTD"]?.status?.name || null;
  const dateStart = p["行動予定日"]?.date?.start || null;
  const tags = (p["タグ"]?.multi_select || []).map((t) => t.name);
  const category = p["カテゴリ"]?.select?.name || null;
  const priority = p["優先度"]?.select?.name || null;
  const assignee = p["担当者"]?.select?.name || null;
  return {
    id: page.id.replace(/-/g, ""),
    raw_id: page.id,
    title,
    gtd,
    date: dateStart,
    tags,
    project: tags[0] || null,
    category,
    priority,
    assignee,
    last_edited: page.last_edited_time,
    created: page.created_time,
    url: page.url,
  };
}

// ---- Formatting helpers ----
function today() { return new Date().toISOString().slice(0, 10); }
function daysBetween(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate + "T00:00:00+09:00");
  const t = new Date(today() + "T00:00:00+09:00");
  return Math.round((d - t) / 86400000);
}
function fmtMD(isoDate) {
  if (!isoDate) return "";
  const [_, m, d] = isoDate.split("-");
  return `${parseInt(m)}/${parseInt(d)}`;
}

// ---- Grouping ----
function groupTasks(tasks) {
  const overdue = [];
  const thisWeek = [];
  const inProgress = [];
  const recentDone = [];
  const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  for (const t of tasks) {
    if (t.gtd === "完了" && t.last_edited >= sevenAgo) {
      recentDone.push(t);
      continue;
    }
    if (t.gtd === "進行中") {
      inProgress.push(t);
      continue;
    }
    if (["次にやること", "日付指定"].includes(t.gtd) && t.date) {
      const d = daysBetween(t.date);
      if (d < 0) overdue.push(t);
      else if (d <= 7) thisWeek.push(t);
    }
  }
  const byDate = (a, b) => (a.date || "").localeCompare(b.date || "");
  overdue.sort(byDate);
  thisWeek.sort(byDate);
  inProgress.sort((a, b) => a.last_edited.localeCompare(b.last_edited));
  recentDone.sort((a, b) => b.last_edited.localeCompare(a.last_edited));
  return { overdue, thisWeek, inProgress, recentDone };
}

// ---- deadlines.json write ----
// hisho-shiratama の Deadline interface に準拠:
//   id, title, date, category, business, status, checklist, notes
function writeDeadlines(tasks) {
  const active = tasks
    .filter((t) => !["完了", "資料", "ゴミ箱", "できなかった"].includes(t.gtd))
    .filter((t) => t.date) // 期日なしのタスクは deadlines には含めない（Inbox/いつかやるかもは除外）
    .map((t) => ({
      id: t.id,
      title: t.title,
      date: t.date,
      category: t.category || "",
      business: t.project || "",
      status: t.gtd === "完了" ? "完了" : "進行中",
      checklist: [],
      notes: "",
      // Notion由来の拡張情報（PWA型定義には含まれないが参照可能）
      _gtd: t.gtd,
      _priority: t.priority,
      _notion_url: t.url,
    }));
  atomicWrite(DEADLINES_FILE, JSON.stringify({ deadlines: active, generated_at: new Date().toISOString() }, null, 2));
}

// ---- unified.db upsert ----
function upsertUnifiedDb(tasks) {
  if (DRY_RUN) { log(`DRY: would upsert ${tasks.length} tasks to unified.db`); return; }
  if (!fs.existsSync(UNIFIED_DB)) {
    log(`unified.db not found: ${UNIFIED_DB}`);
    return;
  }
  const sqlStatements = [];
  sqlStatements.push("BEGIN;");
  sqlStatements.push("DELETE FROM tasks WHERE source = 'notion';");
  for (const t of tasks) {
    if (["ゴミ箱"].includes(t.gtd)) continue;
    const esc = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
    const statusMap = {
      "完了": "completed",
      "進行中": "in_progress",
      "次にやること": "pending",
      "日付指定": "pending",
      "Inbox": "pending",
      "いつかやるかも": "someday",
      "できなかった": "failed",
      "資料": "reference",
    };
    const status = statusMap[t.gtd] || "pending";
    const priorityMap = { "高": "high", "中": "medium", "低": "low" };
    const priority = priorityMap[t.priority] || "medium";
    sqlStatements.push(
      `INSERT OR REPLACE INTO tasks (id, title, project, priority, status, due_date, source, source_id) VALUES (` +
      `${esc("notion_" + t.id)}, ${esc(t.title)}, ${esc(t.project)}, ${esc(priority)}, ${esc(status)}, ${esc(t.date)}, 'notion', ${esc(t.id)});`
    );
  }
  sqlStatements.push("COMMIT;");
  const sqlFile = path.join(LOG_DIR, ".notion-sync-upsert.sql");
  fs.writeFileSync(sqlFile, sqlStatements.join("\n"));
  try {
    execSync(`sqlite3 "${UNIFIED_DB}" < "${sqlFile}"`, { stdio: "pipe" });
  } finally {
    fs.unlinkSync(sqlFile);
  }
}

// ---- Atomic file write ----
function atomicWrite(filepath, content) {
  if (DRY_RUN) { log(`DRY: would write ${filepath} (${content.length} bytes)`); return; }
  const tmp = filepath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filepath);
}

// ---- GTD矛盾スキャン ----
function scanInconsistencies(tasks) {
  const issues = { staleMaybe: [], shouldPromote: [], overdue: [] };
  for (const t of tasks) {
    if (t.gtd === "いつかやるかも" && t.date) issues.staleMaybe.push(t);
    if (t.gtd === "日付指定" && t.date && daysBetween(t.date) <= 7 && daysBetween(t.date) >= 0) issues.shouldPromote.push(t);
    if (t.gtd === "次にやること" && t.date && daysBetween(t.date) < 0) issues.overdue.push(t);
  }
  return issues;
}

async function sendDiscordIfNeeded(issues) {
  const total = issues.staleMaybe.length + issues.shouldPromote.length + issues.overdue.length;
  if (total === 0) return;
  const sentFlag = path.join(LOG_DIR, `.gtd-scan-sent-${today()}`);
  if (fs.existsSync(sentFlag)) { log(`GTD scan already sent today (${total} issues)`); return; }
  if (NO_DISCORD || DRY_RUN) { log(`DRY/NO_DISCORD: would send GTD scan (${total} issues)`); return; }

  const discordEnv = path.join(HOME, ".claude", "channels", "discord", ".env");
  if (!fs.existsSync(discordEnv)) { log("Discord env not found, skipping notification"); return; }
  const discEnv = {};
  for (const line of fs.readFileSync(discordEnv, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) discEnv[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const token = discEnv.DISCORD_BOT_TOKEN || discEnv.DISCORD_TOKEN;
  if (!token) { log("Discord token not found"); return; }

  const fmtList = (list, prefix) => list.slice(0, 10).map((t) => {
    const dateStr = t.date ? `(${fmtMD(t.date)})` : "";
    return `- ${prefix} **[${t.project || "？"}]** ${t.title} ${dateStr}`;
  }).join("\n");
  const parts = [];
  parts.push("🔄 **GTD矛盾スキャン** — 日次");
  if (issues.overdue.length) parts.push(`\n🔴 **期限超過** (${issues.overdue.length})\n` + fmtList(issues.overdue, "🔴"));
  if (issues.shouldPromote.length) parts.push(`\n🟡 **昇格候補（期日≤7日、日付指定→次にやること）** (${issues.shouldPromote.length})\n` + fmtList(issues.shouldPromote, "🟡"));
  if (issues.staleMaybe.length) parts.push(`\n⚠️ **期日あり＋いつかやるかも（矛盾）** (${issues.staleMaybe.length})\n` + fmtList(issues.staleMaybe, "⚠️"));
  parts.push("\nNotionで修正してください。5分後の次回同期に反映されます。");
  const content = parts.join("\n");

  await new Promise((resolve, reject) => {
    const body = JSON.stringify({ content });
    const req = https.request({
      hostname: "discord.com",
      path: `/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`,
      method: "POST",
      headers: {
        "Authorization": `Bot ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => {
        if (res.statusCode >= 400) reject(new Error(`Discord ${res.statusCode}: ${buf.slice(0, 200)}`));
        else resolve();
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  fs.writeFileSync(sentFlag, new Date().toISOString());
  log(`GTD scan notified to Discord (${total} issues)`);
}

// ---- Main ----
(async () => {
  const t0 = Date.now();
  try {
    log(`--- sync start ${DRY_RUN ? "(dry-run)" : ""} ---`);
    const rawPages = await fetchAllTasks();
    const tasks = rawPages.map(extract);
    const active = tasks.filter((t) => !["完了", "資料", "ゴミ箱", "できなかった"].includes(t.gtd));
    const groups = groupTasks(tasks);

    const issues = scanInconsistencies(tasks);

    writeDeadlines(tasks);
    upsertUnifiedDb(tasks);

    await sendDiscordIfNeeded(issues);

    log(`sync done: total=${tasks.length} active=${active.length} overdue=${groups.overdue.length} thisWeek=${groups.thisWeek.length} inProgress=${groups.inProgress.length} issues=${issues.staleMaybe.length + issues.shouldPromote.length + issues.overdue.length} took=${Date.now() - t0}ms`);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
})();
