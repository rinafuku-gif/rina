/**
 * update-obsidian-dashboard.js — 週次レビュー用Obsidianダッシュボード更新
 *
 * weekly-review.sh の最後に呼び出される。
 * roadmap-tasks.json（来週のWeek）+ タスクハブ（来週のdue・直近完了）を
 * マージしてダッシュボードの「今週やること」と「完了（直近7日）」を更新する。
 *
 * (2026-08-11: Notion Task DB直読みから正本=タスクハブ(task_store)参照へ移行。
 *  Notionはタスク管理から降格済み。NOTION_API_KEY はこのファイルでは読まなくなったが、
 *  他スクリプトが使用中のため .env からは削除しない)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

// --- パス定義 ---
const REPO_DIR = path.join(__dirname, "..");
const ROADMAP_FILE = path.join(REPO_DIR, "data", "roadmap-tasks.json");
const OBSIDIAN_BASE = path.join(
  os.homedir(),
  "Library",
  "Mobile Documents",
  "iCloud~md~obsidian",
  "Documents",
  "obsidian-vault"
);
const DASHBOARD_FILE = path.join(OBSIDIAN_BASE, "ダッシュボード.md");

// --- タスクハブ(task_store)の場所 ---
const HUB_SCRIPTS_DIR = "/Users/ocmm/agents/ceo/scripts";

// --- ビジネスタグ（title/contextの部分一致でビジネスを推定する） ---
const BUSINESS_TAGS = [
  "三十日珈琲", "えんがわ", "となりにとまる", "SATOYAMA AI BASE",
  "Basecamp Torisawa", "蔵サウナ", "地域おこし協力隊",
];

// --- 日付ユーティリティ ---
function todayStr() {
  const d = new Date();
  const jst = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, "0")}-${String(jst.getDate()).padStart(2, "0")}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00+09:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatMD(dateStr) {
  if (!dateStr) return "";
  const [, m, d] = dateStr.split("-");
  return `${parseInt(m)}/${parseInt(d)}`;
}

// --- タスクハブ取得（来週 + 直近完了） ---
function fetchHubTasks(nextWeekStart, nextWeekEnd) {
  const raw = execSync("python3 -m task_store list", {
    cwd: HUB_SCRIPTS_DIR,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const allTasks = JSON.parse(raw);

  const today = todayStr();
  const sevenDaysAgo = addDays(today, -7);

  // 来週の未完了タスク（due が来週範囲内・state が done/blocked 以外）
  const upcoming = allTasks.filter((t) => {
    if (t.state === "done" || t.state === "blocked") return false;
    if (!t.due) return false;
    return t.due >= nextWeekStart && t.due <= nextWeekEnd;
  });

  // 直近7日に完了したタスク（state=done・last_activity_at が7日以内）
  const done = allTasks.filter((t) => {
    if (t.state !== "done") return false;
    if (!t.last_activity_at) return false;
    return t.last_activity_at.slice(0, 10) >= sevenDaysAgo;
  });

  return { upcoming, done };
}

// --- タスクハブのタスクから情報を抽出 ---
function parseHubTask(task) {
  const title = task.title || "";
  if (!title) return null;

  const actionDate = task.due || null;

  // タスクハブにはNotionのような構造化タグが無いため、
  // title + context の部分一致でビジネスを推定する
  const searchText = `${task.context || ""} ${title}`;
  const bizTags = BUSINESS_TAGS.filter((tag) => searchText.includes(tag));
  const business = bizTags.join("・") || "";

  return { title, actionDate, business };
}

// --- 重複排除（先頭15文字一致） ---
function deduplicateTasks(tasks) {
  const seen = new Set();
  return tasks.filter(t => {
    const key = t.title.slice(0, 15);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- iCloudファイル読み込み（リトライ付き） ---
function readWithRetry(filePath, retries = 3, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      // iCloudダウンロード
      try {
        execSync(`brctl download "${filePath}"`, { stdio: "ignore" });
      } catch (_) {
        // brctl失敗は無視
      }
      return fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      if (i < retries - 1) {
        const start = Date.now();
        while (Date.now() - start < delayMs) {}
      } else {
        throw err;
      }
    }
  }
}

// --- メイン ---
async function main() {
  const today = todayStr();

  // 来週の範囲を計算（日曜実行を前提: +1〜+7日が来週月〜日）
  const nextWeekStart = addDays(today, 1);
  const nextWeekEnd = addDays(today, 7);

  console.log(`[update-obsidian-dashboard] 来週: ${nextWeekStart} 〜 ${nextWeekEnd}`);

  // タスクハブ取得
  let hubUpcoming = [];
  let hubDone = [];
  try {
    const result = fetchHubTasks(nextWeekStart, nextWeekEnd);
    hubUpcoming = result.upcoming.map(parseHubTask).filter(Boolean);
    hubDone = result.done.map(parseHubTask).filter(Boolean);
    console.log(`[update-obsidian-dashboard] タスクハブ: 来週${hubUpcoming.length}件, 完了${hubDone.length}件`);
  } catch (err) {
    console.error("[update-obsidian-dashboard] タスクハブ取得エラー:", err.message);
  }

  // roadmap-tasks.json から来週のタスクを取得
  let roadmapUpcoming = [];
  if (fs.existsSync(ROADMAP_FILE)) {
    try {
      const roadmapData = JSON.parse(fs.readFileSync(ROADMAP_FILE, "utf-8"));
      const weeks = roadmapData.weeks || [];

      for (const week of weeks) {
        const weekStart = week.start;
        const weekEnd = week.end;
        if (!weekStart || !weekEnd) continue;

        // 来週の範囲と重なるWeekを探す
        if (weekEnd >= nextWeekStart && weekStart <= nextWeekEnd) {
          for (const task of (week.tasks || [])) {
            roadmapUpcoming.push({
              title: task.title || task.name || String(task),
              actionDate: task.dueDate || task.due_date || null,
              business: task.business || task.category || "",
            });
          }
        }
      }
      console.log(`[update-obsidian-dashboard] ロードマップ: 来週${roadmapUpcoming.length}件`);
    } catch (err) {
      console.error("[update-obsidian-dashboard] roadmap-tasks.json読み込みエラー:", err.message);
    }
  }

  // マージ＋重複排除
  const allUpcoming = deduplicateTasks([...hubUpcoming, ...roadmapUpcoming]);

  // 来週タスクのMarkdown行を生成
  const upcomingLines = allUpcoming.map(t => {
    const dateSuffix = t.actionDate ? `（${formatMD(t.actionDate)}）` : "";
    const prefix = t.business ? `**${t.business}**: ` : "";
    return `- [ ] ${prefix}${t.title}${dateSuffix}`;
  });

  // 完了タスクのMarkdown行を生成
  const doneLines = hubDone.map(t => {
    const prefix = t.business ? `**${t.business}**: ` : "";
    return `- [x] ${prefix}${t.title}`;
  });

  // ダッシュボード読み込み
  let content;
  try {
    content = readWithRetry(DASHBOARD_FILE);
  } catch (err) {
    console.error("[update-obsidian-dashboard] ダッシュボード読み込みエラー:", err.message);
    process.exit(1);
  }

  // 「今週やること」セクション置換
  // パターン: "### 今週やること\n" から次の "###" または "---" または "## " まで
  const upcomingSection = upcomingLines.length > 0
    ? upcomingLines.join("\n")
    : "- （来週の予定はまだありません）";

  content = content.replace(
    /(### 今週やること\n)([\s\S]*?)(?=\n###|\n##|\n---)/,
    `$1\n${upcomingSection}\n`
  );

  // 「完了（直近7日）」セクション置換
  const doneSection = doneLines.length > 0
    ? doneLines.join("\n")
    : "- （完了タスクなし）";

  content = content.replace(
    /(### 完了（直近7日）\n)([\s\S]*?)(?=\n###|\n##|\n---)/,
    `$1\n${doneSection}\n`
  );

  // 最終更新日を更新
  content = content.replace(
    /最終更新: .+/,
    `最終更新: ${today} （週次レビュー自動更新）`
  );

  // 書き戻し（リトライ付き）
  let written = false;
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(DASHBOARD_FILE, content, "utf-8");
      written = true;
      break;
    } catch (err) {
      if (i < 2) {
        const start = Date.now();
        while (Date.now() - start < 2000) {}
      } else {
        throw err;
      }
    }
  }

  if (written) {
    console.log(`[update-obsidian-dashboard] ダッシュボード更新完了: ${today}`);
  }
}

main().catch(err => {
  console.error("[update-obsidian-dashboard] 致命的エラー:", err.message);
  process.exit(1);
});
