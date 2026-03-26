/**
 * task-updater.js — タスク状態の自動更新
 *
 * 使い方:
 *   node task-updater.js complete "タスク名（部分一致）"
 *   node task-updater.js add --section "今週" --owner "AI" --project "三十日珈琲" "タスク名"
 *   node task-updater.js deadline --id "misoca-web-launch" --date "2026-04-05"
 *   node task-updater.js move "タスク名" --to "今週"
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// --- Paths ---
const OBSIDIAN_TASKS = path.join(
  os.homedir(),
  "Library", "Mobile Documents", "iCloud~md~obsidian",
  "Documents", "obsidian-vault", "02_プロジェクト", "タスク一覧.md"
);
const OBSIDIAN_DASHBOARD = path.join(
  os.homedir(),
  "Library", "Mobile Documents", "iCloud~md~obsidian",
  "Documents", "obsidian-vault", "ダッシュボード.md"
);
const DEADLINES_FILE = path.join(__dirname, "..", "data", "deadlines.json");

// --- Safe file write (temp + rename) ---
function safeWrite(filePath, content) {
  const tmpPath = filePath + ".tmp." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

// --- Read file safely ---
function safeRead(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`[task-updater] File not found: ${filePath}`);
    return null;
  }
  return fs.readFileSync(filePath, "utf-8");
}

// --- Section name mapping ---
const SECTION_MAP = {
  "今週": "## 今週やること",
  "今月": "## 今月やること",
  "それ以降": "## それ以降",
};

const OWNER_MAP = {
  "Ryo": "### Ryoがやること",
  "AI": "### AIチームがやること",
};

// --- Parse args ---
function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const result = { command, positional: [], flags: {} };

  let i = 1;
  while (i < args.length) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
      result.flags[key] = val;
      i += val === true ? 1 : 2;
    } else {
      result.positional.push(args[i]);
      i++;
    }
  }

  return result;
}

// --- Command: complete ---
function cmdComplete(taskName) {
  if (!taskName) {
    console.error("Usage: node task-updater.js complete \"タスク名\"");
    process.exit(1);
  }

  let changed = false;

  // 1. Update Obsidian tasks
  const tasksContent = safeRead(OBSIDIAN_TASKS);
  if (tasksContent) {
    const lines = tasksContent.split("\n");
    let updated = false;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/^- \[ \] /) && lines[i].includes(taskName)) {
        lines[i] = lines[i].replace("- [ ] ", "- [x] ");
        console.log(`[task-updater] Completed in タスク一覧: ${lines[i].trim()}`);
        updated = true;
        break; // 最初の一致のみ
      }
    }

    if (updated) {
      // 最終更新日を今日に
      const today = new Date().toISOString().split("T")[0];
      const updatedContent = lines.join("\n").replace(
        /最終更新: \d{4}-\d{2}-\d{2}/,
        `最終更新: ${today}`
      );
      safeWrite(OBSIDIAN_TASKS, updatedContent);
      changed = true;
    } else {
      console.log(`[task-updater] Task not found in タスク一覧: "${taskName}"`);
    }
  }

  // 2. Update deadlines.json (title partial match → status: 完了)
  const dlContent = safeRead(DEADLINES_FILE);
  if (dlContent) {
    try {
      const dlData = JSON.parse(dlContent);
      let dlUpdated = false;

      for (const dl of dlData.deadlines) {
        if (dl.status !== "完了" && dl.title.includes(taskName)) {
          dl.status = "完了";
          console.log(`[task-updater] Completed in deadlines.json: ${dl.title}`);
          dlUpdated = true;
          break;
        }
      }

      if (dlUpdated) {
        safeWrite(DEADLINES_FILE, JSON.stringify(dlData, null, 2) + "\n");
        changed = true;
      }
    } catch (e) {
      console.error(`[task-updater] deadlines.json parse error: ${e.message}`);
    }
  }

  // 3. Sync dashboard if task was in 今週
  if (changed) {
    syncDashboard();
  }

  if (!changed) {
    console.log(`[task-updater] No changes made for: "${taskName}"`);
  }
}

// --- Command: add ---
function cmdAdd(taskName, flags) {
  if (!taskName) {
    console.error('Usage: node task-updater.js add --section "今週" --owner "AI" --project "プロジェクト名" "タスク名"');
    process.exit(1);
  }

  const sectionKey = flags.section || "今週";
  const ownerKey = flags.owner || "AI";
  const project = flags.project || "";

  const sectionHeader = SECTION_MAP[sectionKey];
  const ownerHeader = OWNER_MAP[ownerKey];

  if (!sectionHeader || !ownerHeader) {
    console.error(`[task-updater] Invalid section "${sectionKey}" or owner "${ownerKey}"`);
    console.error(`  Sections: ${Object.keys(SECTION_MAP).join(", ")}`);
    console.error(`  Owners: ${Object.keys(OWNER_MAP).join(", ")}`);
    process.exit(1);
  }

  const tasksContent = safeRead(OBSIDIAN_TASKS);
  if (!tasksContent) process.exit(1);

  const projectLink = project ? ` [[${project}]]` : "";
  const newTask = `- [ ] ${taskName}${projectLink}`;

  const lines = tasksContent.split("\n");
  let inSection = false;
  let inOwner = false;
  let insertIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(sectionHeader)) {
      inSection = true;
      continue;
    }
    // 別のセクションに入ったら終了
    if (inSection && lines[i].startsWith("## ") && !lines[i].startsWith(sectionHeader)) {
      break;
    }
    if (inSection && lines[i].startsWith(ownerHeader)) {
      inOwner = true;
      continue;
    }
    // 別のオーナーセクション or セパレータに到達
    if (inOwner && (lines[i].startsWith("### ") || lines[i] === "---")) {
      insertIdx = i;
      break;
    }
    // タスク行の最後を追跡
    if (inOwner && lines[i].match(/^- \[[ x]\] /)) {
      insertIdx = i + 1;
    }
  }

  if (insertIdx === -1) {
    console.error(`[task-updater] Could not find insertion point for section="${sectionKey}" owner="${ownerKey}"`);
    process.exit(1);
  }

  lines.splice(insertIdx, 0, newTask);

  const today = new Date().toISOString().split("T")[0];
  const updatedContent = lines.join("\n").replace(
    /最終更新: \d{4}-\d{2}-\d{2}/,
    `最終更新: ${today}`
  );
  safeWrite(OBSIDIAN_TASKS, updatedContent);
  console.log(`[task-updater] Added to ${sectionKey}/${ownerKey}: ${newTask}`);

  if (sectionKey === "今週") {
    syncDashboard();
  }
}

// --- Command: deadline ---
function cmdDeadline(flags) {
  const id = flags.id;
  const newDate = flags.date;

  if (!id || !newDate) {
    console.error('Usage: node task-updater.js deadline --id "deadline-id" --date "2026-04-05"');
    process.exit(1);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    console.error(`[task-updater] Invalid date format: "${newDate}" (expected YYYY-MM-DD)`);
    process.exit(1);
  }

  const dlContent = safeRead(DEADLINES_FILE);
  if (!dlContent) process.exit(1);

  try {
    const dlData = JSON.parse(dlContent);
    const dl = dlData.deadlines.find(d => d.id === id);

    if (!dl) {
      console.error(`[task-updater] Deadline not found: "${id}"`);
      console.error(`  Available IDs: ${dlData.deadlines.map(d => d.id).join(", ")}`);
      process.exit(1);
    }

    const oldDate = dl.date;
    dl.date = newDate;
    safeWrite(DEADLINES_FILE, JSON.stringify(dlData, null, 2) + "\n");
    console.log(`[task-updater] Deadline updated: ${dl.title} (${oldDate} → ${newDate})`);
  } catch (e) {
    console.error(`[task-updater] deadlines.json parse error: ${e.message}`);
    process.exit(1);
  }
}

// --- Command: move ---
function cmdMove(taskName, flags) {
  const toSection = flags.to;

  if (!taskName || !toSection) {
    console.error('Usage: node task-updater.js move "タスク名" --to "今月"');
    process.exit(1);
  }

  const targetHeader = SECTION_MAP[toSection];
  if (!targetHeader) {
    console.error(`[task-updater] Invalid section: "${toSection}"`);
    console.error(`  Available: ${Object.keys(SECTION_MAP).join(", ")}`);
    process.exit(1);
  }

  const tasksContent = safeRead(OBSIDIAN_TASKS);
  if (!tasksContent) process.exit(1);

  const lines = tasksContent.split("\n");

  // 1. Find and remove the task
  let removedLine = null;
  let removedOwner = null;
  let currentOwner = null;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("### Ryoがやること")) currentOwner = "Ryo";
    if (lines[i].startsWith("### AIチームがやること")) currentOwner = "AI";

    if (lines[i].match(/^- \[ \] /) && lines[i].includes(taskName)) {
      removedLine = lines[i];
      removedOwner = currentOwner || "AI";
      lines.splice(i, 1);
      console.log(`[task-updater] Removed from current section: ${removedLine.trim()}`);
      break;
    }
  }

  if (!removedLine) {
    console.error(`[task-updater] Task not found: "${taskName}"`);
    process.exit(1);
  }

  // 2. Find insertion point in target section
  const ownerHeader = OWNER_MAP[removedOwner];
  let inSection = false;
  let inOwner = false;
  let insertIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(targetHeader)) {
      inSection = true;
      continue;
    }
    if (inSection && lines[i].startsWith("## ") && !lines[i].startsWith(targetHeader)) {
      // セクション末尾（ownerが見つからなかった場合）
      if (insertIdx === -1) insertIdx = i;
      break;
    }
    if (inSection && lines[i].startsWith(ownerHeader)) {
      inOwner = true;
      continue;
    }
    if (inOwner && (lines[i].startsWith("### ") || lines[i] === "---")) {
      insertIdx = i;
      break;
    }
    if (inOwner && lines[i].match(/^- \[[ x]\] /)) {
      insertIdx = i + 1;
    }
  }

  if (insertIdx === -1) {
    // ファイル末尾に追加（フォールバック）
    insertIdx = lines.length;
  }

  lines.splice(insertIdx, 0, removedLine);

  const today = new Date().toISOString().split("T")[0];
  const updatedContent = lines.join("\n").replace(
    /最終更新: \d{4}-\d{2}-\d{2}/,
    `最終更新: ${today}`
  );
  safeWrite(OBSIDIAN_TASKS, updatedContent);
  console.log(`[task-updater] Moved to ${toSection}: ${removedLine.trim()}`);

  // 今週セクションが変わったらダッシュボード更新
  if (toSection === "今週") {
    syncDashboard();
  }
}

// --- Dashboard sync ---
function syncDashboard() {
  const tasksContent = safeRead(OBSIDIAN_TASKS);
  const dashContent = safeRead(OBSIDIAN_DASHBOARD);
  if (!tasksContent || !dashContent) return;

  try {
    // タスク一覧の「今週やること」セクションから未完了タスクを抽出
    const lines = tasksContent.split("\n");
    let inThisWeek = false;
    const weekTasks = [];

    for (const line of lines) {
      if (line.startsWith("## 今週やること")) {
        inThisWeek = true;
        continue;
      }
      if (inThisWeek && line.startsWith("## ")) {
        break;
      }
      if (inThisWeek && line.match(/^- \[ \] /)) {
        weekTasks.push(line);
      }
      // 完了済みも含める（ダッシュボードでチェック済みとして見せる）
      if (inThisWeek && line.match(/^- \[x\] /i)) {
        weekTasks.push(line);
      }
    }

    // ダッシュボードの「直近のタスク」セクションを更新
    const dashLines = dashContent.split("\n");
    let sectionStart = -1;
    let sectionEnd = -1;

    for (let i = 0; i < dashLines.length; i++) {
      if (dashLines[i].startsWith("## 直近のタスク")) {
        sectionStart = i;
        continue;
      }
      if (sectionStart !== -1 && dashLines[i].startsWith("## ")) {
        sectionEnd = i;
        break;
      }
    }

    if (sectionStart === -1) {
      console.log("[task-updater] Dashboard: '直近のタスク' section not found, skipping");
      return;
    }
    if (sectionEnd === -1) sectionEnd = dashLines.length;

    // 新しいセクションを構築（最大8件）
    const displayTasks = weekTasks.slice(0, 8);
    const newSection = [
      "## 直近のタスク（今週）",
      "",
      ...displayTasks,
      "",
      "→ 全タスク: [[タスク一覧]]",
      "",
    ];

    dashLines.splice(sectionStart, sectionEnd - sectionStart, ...newSection);

    // 最終更新日
    const today = new Date().toISOString().split("T")[0];
    const updatedDash = dashLines.join("\n").replace(
      /最終更新: \d{4}-\d{2}-\d{2}/,
      `最終更新: ${today}`
    );
    safeWrite(OBSIDIAN_DASHBOARD, updatedDash);
    console.log(`[task-updater] Dashboard synced (${displayTasks.length} tasks)`);
  } catch (e) {
    console.error(`[task-updater] Dashboard sync error: ${e.message}`);
  }
}

// --- Main ---
const { command, positional, flags } = parseArgs(process.argv);

switch (command) {
  case "complete":
    cmdComplete(positional[0]);
    break;
  case "add":
    cmdAdd(positional[0], flags);
    break;
  case "deadline":
    cmdDeadline(flags);
    break;
  case "move":
    cmdMove(positional[0], flags);
    break;
  default:
    console.log(`task-updater.js — タスク状態の自動更新

Usage:
  node task-updater.js complete "タスク名"          タスクを完了にする
  node task-updater.js add [options] "タスク名"      タスクを追加する
  node task-updater.js deadline --id ID --date DATE  期日を変更する
  node task-updater.js move "タスク名" --to SECTION  セクションを移動する

Options (add):
  --section  今週 | 今月 | それ以降  (default: 今週)
  --owner    Ryo | AI              (default: AI)
  --project  プロジェクト名         (Obsidianリンクに使用)

Examples:
  node task-updater.js complete "EC購入フロー"
  node task-updater.js add --section "今週" --owner "AI" --project "三十日珈琲" "予約システムのLINE連携"
  node task-updater.js deadline --id "misoca-web-launch" --date "2026-04-05"
  node task-updater.js move "SATOYAMA: モニター募集" --to "今週"
`);
    break;
}
