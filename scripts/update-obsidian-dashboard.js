/**
 * update-obsidian-dashboard.js — 週次レビュー用Obsidianダッシュボード更新
 *
 * weekly-review.sh の最後に呼び出される。
 * roadmap-tasks.json（来週のWeek）+ Notion Task DB（来週の行動予定日）を
 * マージしてダッシュボードの「今週やること」と「完了（直近7日）」を更新する。
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
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

// --- 環境変数の読み込み ---
const envContent = fs.readFileSync(path.join(REPO_DIR, ".env"), "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

// --- Notion DB ID ---
const NOTION_TASK_DB = "500a3ff0900d4933ba83b511102f6779";

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

// --- Notion API ---
function notionApiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: "api.notion.com",
      path: `/v1/${endpoint}`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NOTION_API_KEY}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
        "Content-Length": Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          reject(new Error(`Notion API ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// --- Notionタスク取得（来週 + 直近完了） ---
async function fetchNotionTasks(nextWeekStart, nextWeekEnd) {
  if (!env.NOTION_API_KEY) throw new Error("NOTION_API_KEY not set");

  const today = todayStr();
  const sevenDaysAgo = addDays(today, -7);

  // 来週の未完了タスク
  const upcomingResult = await notionApiPost(`databases/${NOTION_TASK_DB}/query`, {
    page_size: 100,
    filter: {
      and: [
        {
          property: "行動予定日",
          date: { on_or_after: nextWeekStart },
        },
        {
          property: "行動予定日",
          date: { on_or_before: nextWeekEnd },
        },
        {
          property: "GTD",
          status: { does_not_equal: "完了" },
        },
        {
          property: "GTD",
          status: { does_not_equal: "ゴミ箱" },
        },
        {
          property: "GTD",
          status: { does_not_equal: "資料" },
        },
        {
          property: "GTD",
          status: { does_not_equal: "できなかった" },
        },
        {
          property: "GTD",
          status: { does_not_equal: "いつかやるかも" },
        },
      ],
    },
  });

  // 直近7日に完了したタスク
  const doneResult = await notionApiPost(`databases/${NOTION_TASK_DB}/query`, {
    page_size: 50,
    filter: {
      and: [
        {
          property: "GTD",
          status: { equals: "完了" },
        },
        {
          timestamp: "last_edited_time",
          last_edited_time: { on_or_after: sevenDaysAgo + "T00:00:00+09:00" },
        },
      ],
    },
  });

  return {
    upcoming: upcomingResult.results || [],
    done: doneResult.results || [],
  };
}

// --- Notionページからタスク情報を抽出 ---
function parseNotionTask(page) {
  const props = page.properties || {};

  let title = "";
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop.type === "title" && prop.title && prop.title.length > 0) {
      title = prop.title.map(t => t.plain_text).join("").trim();
      break;
    }
  }
  if (!title) return null;

  const actionDate = props["行動予定日"]?.date?.start || null;
  const tags = (props["タグ"]?.multi_select || []).map(t => t.name);

  const BUSINESS_TAGS = new Set([
    "三十日珈琲", "えんがわ", "となりにとまる", "SATOYAMA AI BASE",
    "Basecamp Torisawa", "蔵サウナ", "地域おこし協力隊",
  ]);
  const bizTags = tags.filter(t => BUSINESS_TAGS.has(t));
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

  // Notionタスク取得
  let notionUpcoming = [];
  let notionDone = [];
  try {
    const result = await fetchNotionTasks(nextWeekStart, nextWeekEnd);
    notionUpcoming = result.upcoming.map(parseNotionTask).filter(Boolean);
    notionDone = result.done.map(parseNotionTask).filter(Boolean);
    console.log(`[update-obsidian-dashboard] Notion: 来週${notionUpcoming.length}件, 完了${notionDone.length}件`);
  } catch (err) {
    console.error("[update-obsidian-dashboard] Notion取得エラー:", err.message);
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
  const allUpcoming = deduplicateTasks([...notionUpcoming, ...roadmapUpcoming]);

  // 来週タスクのMarkdown行を生成
  const upcomingLines = allUpcoming.map(t => {
    const dateSuffix = t.actionDate ? `（${formatMD(t.actionDate)}）` : "";
    const prefix = t.business ? `**${t.business}**: ` : "";
    return `- [ ] ${prefix}${t.title}${dateSuffix}`;
  });

  // 完了タスクのMarkdown行を生成
  const doneLines = notionDone.map(t => {
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
