/**
 * migrate-claude-tasks.js — CLAUDE.md + deadlines.json → tasks.json 一括移行
 * 一度だけ実行する。
 */

const fs = require("fs");
const path = require("path");
const { addTask, loadTasks, saveTasks, genId } = require("./task-store");

const REPO_DIR = path.join(__dirname, "..");
const CLAUDE_MD = path.join(REPO_DIR, "CLAUDE.md");
const DEADLINES_FILE = path.join(REPO_DIR, "data", "deadlines.json");

// プロジェクト名のマッピング
const PROJECT_MAP = {
  "蔵サウナPM": "蔵サウナ",
  "蔵サウナPM — 契約書・残タスク": "蔵サウナ",
  "蔵サウナPM — 次のアクション": "蔵サウナ",
  "三十日珈琲": "三十日珈琲",
  "鳥沢物件（となりにとまる）— GW前オープン目標": "鳥沢物件",
  "直近": "直近",
  "今月中に進めたい": "SATOYAMA AI BASE",
  "しらたま財務ダッシュボード構想（次セッションで設計開始）": "しらたまPWA",
  "中長期": "中長期",
};

// タスクのタイプ推定
const PHYSICAL_KEYWORDS = ["署名", "発送", "保健所", "郵便局", "買い出し", "撮影", "MTG", "打ち合わせ", "電気工事", "塗装", "取付", "清掃", "内装", "設置", "確認・署名", "オープン", "立会"];
const DIGITAL_KEYWORDS = ["実装", "設計", "デプロイ", "リポジトリ", "コンテンツ", "ダッシュボード", "リスティング作成", "エクスポート", "自動化", "アップデート"];

function guessType(title) {
  const lower = title;
  if (PHYSICAL_KEYWORDS.some(kw => lower.includes(kw))) return "physical";
  if (DIGITAL_KEYWORDS.some(kw => lower.includes(kw))) return "digital";
  return "mixed";
}

// 優先度推定
function guessPriority(title, sectionTitle) {
  if (sectionTitle.includes("直近")) return "high";
  if (title.includes("期限:") && title.includes("3月")) return "high";
  if (sectionTitle.includes("中長期")) return "low";
  if (sectionTitle.includes("財務ダッシュボード")) return "low";
  return "medium";
}

// 期限抽出
function extractDueDate(title) {
  // "期限: 3月中" → 2026-03-31
  if (title.includes("期限: 3月中") || title.includes("目標: 2026年3月中")) return "2026-03-31";
  // "3/20", "3/24" 形式
  const dateMatch = title.match(/(\d{1,2})\/(\d{1,2})/);
  if (dateMatch) return `2026-${String(dateMatch[1]).padStart(2, "0")}-${String(dateMatch[2]).padStart(2, "0")}`;
  // "4/1-2" 形式
  const rangeMatch = title.match(/(\d{1,2})\/(\d{1,2})-/);
  if (rangeMatch) return `2026-${String(rangeMatch[1]).padStart(2, "0")}-${String(rangeMatch[2]).padStart(2, "0")}`;
  return null;
}

// --- CLAUDE.md パース ---
function parseClaudeMdTasks() {
  const content = fs.readFileSync(CLAUDE_MD, "utf-8");
  const sections = [];
  let currentSection = null;
  let inTaskSection = false;

  for (const line of content.split("\n")) {
    if (line.startsWith("### 現在のタスク")) { inTaskSection = true; continue; }
    if (line.startsWith("### 完了タスク")) { inTaskSection = false; continue; }
    if (!inTaskSection) continue;

    if (line.startsWith("####")) {
      currentSection = { title: line.replace(/^#+\s*/, ""), tasks: [] };
      sections.push(currentSection);
      continue;
    }
    const todoMatch = line.match(/^- \[ \] (.+)/);
    const doneMatch = line.match(/^- \[x\] (.+)/);
    if (todoMatch && currentSection) currentSection.tasks.push({ text: todoMatch[1], done: false });
    if (doneMatch && currentSection) currentSection.tasks.push({ text: doneMatch[1], done: true });
  }
  return sections;
}

// --- deadlines.json パース ---
function parseDeadlines() {
  try {
    const data = JSON.parse(fs.readFileSync(DEADLINES_FILE, "utf-8"));
    return data.deadlines || [];
  } catch {
    return [];
  }
}

// --- 実行 ---
function migrate() {
  console.log("=== CLAUDE.md + deadlines.json → tasks.json 移行開始 ===\n");

  // 既存データがあればバックアップ
  const tasksFile = path.join(REPO_DIR, "data", "tasks.json");
  if (fs.existsSync(tasksFile)) {
    const backup = tasksFile + ".backup-" + Date.now();
    fs.copyFileSync(tasksFile, backup);
    console.log(`既存ファイルをバックアップ: ${backup}`);
  }

  // 初期化
  const data = { version: 1, lastUpdated: new Date().toISOString(), tasks: [], completedArchive: [] };
  saveTasks(data);

  // 1. CLAUDE.md からタスク移行
  const sections = parseClaudeMdTasks();
  let migrated = 0;
  const titleSet = new Set(); // 重複防止

  for (const section of sections) {
    const project = PROJECT_MAP[section.title] || section.title;
    for (const task of section.tasks) {
      if (titleSet.has(task.text)) continue;
      titleSet.add(task.text);

      const t = addTask({
        title: task.text,
        project,
        priority: guessPriority(task.text, section.title),
        type: guessType(task.text),
        dueDate: extractDueDate(task.text),
        source: "migration",
        sourceDetail: `CLAUDE.md / ${section.title}`,
      });

      // 既に完了のものはステータス更新
      if (task.done) {
        const d = loadTasks();
        const found = d.tasks.find(x => x.id === t.id);
        if (found) {
          found.status = "done";
          found.completedAt = new Date().toISOString();
          found.history.push({ timestamp: new Date().toISOString(), action: "completed", by: "migration", note: "CLAUDE.mdで[x]だったタスク" });
          saveTasks(d);
        }
      }
      migrated++;
    }
  }
  console.log(`CLAUDE.md から ${migrated} タスクを移行`);

  // 2. deadlines.json からタスク移行（重複チェック付き）
  const deadlines = parseDeadlines();
  let dlMigrated = 0;

  for (const dl of deadlines) {
    // タイトルが既存タスクと重複しないかチェック
    const existing = loadTasks().tasks.find(t => t.title.includes(dl.title) || dl.title.includes(t.title));
    if (existing) {
      // 期限だけ更新
      if (dl.date && !existing.dueDate) {
        const d = loadTasks();
        const found = d.tasks.find(t => t.id === existing.id);
        if (found) { found.dueDate = dl.date; saveTasks(d); }
      }
      continue;
    }

    const t = addTask({
      title: dl.title,
      project: dl.business || "その他",
      priority: dl.date && dl.date <= "2026-03-31" ? "high" : "medium",
      type: guessType(dl.title),
      dueDate: dl.date || null,
      source: "migration",
      sourceDetail: `deadlines.json / ${dl.category}`,
    });

    if (dl.status === "完了") {
      const d = loadTasks();
      const found = d.tasks.find(x => x.id === t.id);
      if (found) {
        found.status = "done";
        found.completedAt = new Date().toISOString();
        found.history.push({ timestamp: new Date().toISOString(), action: "completed", by: "migration", note: dl.notes || "" });
        saveTasks(d);
      }
    }
    dlMigrated++;
  }
  console.log(`deadlines.json から ${dlMigrated} タスクを追加移行`);

  // 結果表示
  const final = loadTasks();
  const open = final.tasks.filter(t => t.status !== "done").length;
  const done = final.tasks.filter(t => t.status === "done").length;
  console.log(`\n=== 移行完了 ===`);
  console.log(`合計: ${final.tasks.length} タスク（未完了: ${open}, 完了: ${done}）`);
  console.log(`ファイル: ${tasksFile}`);
}

migrate();
