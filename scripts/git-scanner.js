/**
 * git-scanner.js — 全プロジェクトのgitコミットを定期スキャンし、タスク進捗を自動検知
 *
 * 30分ごとに実行。コミットメッセージとファイル変更からタスクの進行・完了を推測。
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const taskStore = require("./task-store");

const STATE_FILE = path.join(__dirname, "..", "data", ".git-scanner-state.json");

// 監視対象リポジトリ
const REPOS = [
  { path: "/Users/Inaryo/rina", project: "rina", aliases: ["rina", "AI秘書", "ブリーフィング", "LINE"] },
  { path: "/Users/Inaryo/hisho-shiratama", project: "しらたまPWA", aliases: ["しらたま", "PWA", "秘書"] },
  { path: "/Users/Inaryo/satoyama-ai-base", project: "SATOYAMA AI BASE", aliases: ["SATOYAMA", "DX", "スクール"] },
  { path: "/Users/Inaryo/misoca-coffee", project: "三十日珈琲", aliases: ["misoca", "珈琲", "コーヒー"] },
  { path: "/Users/Inaryo/fate-decoder", project: "CoreCompass", aliases: ["fate", "占術", "CoreCompass"] },
];

// 完了を示すキーワード
const COMPLETION_KEYWORDS = ["完了", "done", "fix", "close", "修正完了", "実装完了", "デプロイ完了", "削除", "removed"];

// --- State management ---
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { lastScan: null, processedCommits: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Git operations ---
function getRecentCommits(repoPath, sinceMinutes = 35) {
  try {
    const since = `${sinceMinutes} minutes ago`;
    const output = execSync(
      `cd "${repoPath}" && git log --since="${since}" --format="%H|%s|%ai" --name-only 2>/dev/null`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();

    if (!output) return [];

    const commits = [];
    let current = null;

    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length >= 3 && parts[0].length === 40) {
        // New commit line: hash|message|date
        current = { hash: parts[0], message: parts[1], date: parts[2], files: [] };
        commits.push(current);
      } else if (line.trim() && current) {
        current.files.push(line.trim());
      }
    }
    return commits;
  } catch {
    return [];
  }
}

// --- Matching logic ---
function tokenize(text) {
  // 日本語テキストをトークンに分割（簡易的）
  return text
    .replace(/[（）()「」『』【】、。・：→\-_/\\]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

function scoreMatch(task, commit, repoProject) {
  let score = 0;
  const commitTokens = tokenize(commit.message.toLowerCase());
  const taskTokens = tokenize(task.title.toLowerCase());

  // プロジェクト一致: +2
  if (task.project === repoProject || task.project.includes(repoProject) || repoProject.includes(task.project)) {
    score += 2;
  }

  // キーワード一致: 各+1
  for (const tt of taskTokens) {
    if (commitTokens.some(ct => ct.includes(tt) || tt.includes(ct))) {
      score += 1;
    }
  }

  // コミットメッセージにタスクタイトルの一部が直接含まれる: +2
  const taskTitle = task.title.toLowerCase();
  const commitMsg = commit.message.toLowerCase();
  if (commitMsg.includes(taskTitle.slice(0, 10)) || taskTitle.includes(commitMsg.slice(0, 15))) {
    score += 2;
  }

  return score;
}

function isCompletionCommit(message) {
  const lower = message.toLowerCase();
  return COMPLETION_KEYWORDS.some(kw => lower.includes(kw));
}

// --- Main scan ---
function scanAllRepos() {
  const state = loadState();
  const processedSet = new Set(state.processedCommits || []);
  const openTasks = taskStore.getAllOpen();

  if (openTasks.length === 0) {
    state.lastScan = new Date().toISOString();
    saveState(state);
    return { scanned: 0, updated: 0 };
  }

  let totalCommits = 0;
  let updatedTasks = 0;
  const newProcessed = [];

  for (const repo of REPOS) {
    if (!fs.existsSync(repo.path)) continue;

    const commits = getRecentCommits(repo.path);
    for (const commit of commits) {
      if (processedSet.has(commit.hash)) continue;
      newProcessed.push(commit.hash);
      totalCommits++;

      // 各タスクとのマッチングスコアを計算
      for (const task of openTasks) {
        const score = scoreMatch(task, commit, repo.project);

        if (score >= 3) {
          // タスクに関連コミットを追加
          const data = taskStore.loadTasks();
          const t = data.tasks.find(x => x.id === task.id);
          if (!t) continue;

          if (!t.relatedCommits) t.relatedCommits = [];
          if (!t.relatedCommits.includes(commit.hash)) {
            t.relatedCommits.push(commit.hash);
          }

          // 完了判定
          if (isCompletionCommit(commit.message) && score >= 4) {
            // 完了キーワード + 高スコア → 自動完了
            t.status = "done";
            t.completedAt = new Date().toISOString();
            t.updatedAt = new Date().toISOString();
            t.history.push({
              timestamp: new Date().toISOString(),
              action: "completed",
              by: "git-scanner",
              note: `${repo.project}: ${commit.message} (${commit.hash.slice(0, 7)})`,
            });
            console.log(`[git-scanner] Auto-completed: "${t.title}" via commit ${commit.hash.slice(0, 7)}`);
            updatedTasks++;
          } else if (t.status === "open") {
            // 進行中に更新
            t.status = "in_progress";
            t.updatedAt = new Date().toISOString();
            t.history.push({
              timestamp: new Date().toISOString(),
              action: "updated",
              by: "git-scanner",
              note: `進行中: ${repo.project}: ${commit.message} (${commit.hash.slice(0, 7)})`,
            });
            console.log(`[git-scanner] In progress: "${t.title}" via commit ${commit.hash.slice(0, 7)}`);
            updatedTasks++;
          }

          taskStore.saveTasks(data);
        }
      }
    }
  }

  // State更新（最新500件だけ保持）
  state.processedCommits = [...(state.processedCommits || []), ...newProcessed].slice(-500);
  state.lastScan = new Date().toISOString();
  saveState(state);

  // 古い完了タスクのアーカイブ
  taskStore.archiveOldCompleted(30);

  if (totalCommits > 0) {
    console.log(`[git-scanner] Scanned ${totalCommits} new commits across ${REPOS.length} repos, updated ${updatedTasks} tasks`);
  }

  return { scanned: totalCommits, updated: updatedTasks };
}

module.exports = { scanAllRepos, REPOS };

// CLI mode
if (require.main === module) {
  console.log("Running git scanner...");
  const result = scanAllRepos();
  console.log(`Done: ${result.scanned} commits scanned, ${result.updated} tasks updated`);
}
