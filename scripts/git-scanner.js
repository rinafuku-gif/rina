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
  { path: "/Users/ocmm/rina", project: "rina", aliases: ["rina", "AI秘書", "ブリーフィング", "LINE"] },
  { path: "/Users/ocmm/hisho-shiratama", project: "しらたまPWA", aliases: ["しらたま", "PWA", "秘書"] },
  { path: "/Users/ocmm/satoyama-ai-base", project: "SATOYAMA AI BASE", aliases: ["SATOYAMA", "DX", "スクール"] },
  { path: "/Users/ocmm/misoca-coffee", project: "三十日珈琲", aliases: ["misoca", "珈琲", "コーヒー"] },
  { path: "/Users/ocmm/fate-decoder", project: "CoreCompass", aliases: ["fate", "占術", "CoreCompass"] },
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
// バグ③修正: taskStore.getAllOpen() は async (task-store.js:132) だが、旧コードは
// await せずに呼んでいたため openTasks が Promise のまま for...of に渡り
// "TypeError: openTasks is not iterable" で毎回クラッシュしていた（KeepAliveで再起動ループ化）。
// scanAllRepos 自体を async 化し、呼び出し元(setInterval/setTimeout)からの
// 未捕捉rejectionでプロセスが落ちないよう全体を try/catch で包む。
//
// 併せて発見: 旧コードは taskStore.loadTasks() / taskStore.saveTasks() を呼んでいたが、
// task-store.js は既にJSON直書き方式からDB(unified.db)方式へ移行済みで、この2関数は
// もう存在しない（module.exportsに無い）。await修正だけではこの呼び出しで
// "taskStore.loadTasks is not a function" として同種のクラッシュが再発するため、
// 現行の非同期DB API (taskStore.updateTask) に置き換える。
// なお relatedCommits / history フィールドは現行DBスキーマ(tasks table)に存在しない
// カラムのため、これらへの追記はここでは行わない（元々DBには永続化されていなかった）。
async function scanAllRepos() {
  try {
    const state = loadState();
    const processedSet = new Set(state.processedCommits || []);
    const openTasks = await taskStore.getAllOpen();

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
            // 完了判定
            if (isCompletionCommit(commit.message) && score >= 4) {
              // 完了キーワード + 高スコア → 自動完了
              await taskStore.updateTask(
                task.id,
                { status: "done", completed_at: new Date().toISOString() },
                "git-scanner",
                `${repo.project}: ${commit.message} (${commit.hash.slice(0, 7)})`
              );
              console.log(`[git-scanner] Auto-completed: "${task.title}" via commit ${commit.hash.slice(0, 7)}`);
              updatedTasks++;
            } else if (task.status === "open" || task.status === "pending") {
              // 進行中に更新（"open"=旧形式, "pending"=現行DB形式の両方を対応）
              await taskStore.updateTask(
                task.id,
                { status: "in_progress" },
                "git-scanner",
                `進行中: ${repo.project}: ${commit.message} (${commit.hash.slice(0, 7)})`
              );
              console.log(`[git-scanner] In progress: "${task.title}" via commit ${commit.hash.slice(0, 7)}`);
              updatedTasks++;
            }
          }
        }
      }
    }

    // State更新（最新500件だけ保持）
    state.processedCommits = [...(state.processedCommits || []), ...newProcessed].slice(-500);
    state.lastScan = new Date().toISOString();
    saveState(state);

    // 古い完了タスクのアーカイブ（未実装の場合はスキップ）
    if (typeof taskStore.archiveOldCompleted === "function") {
      await taskStore.archiveOldCompleted(30);
    }

    if (totalCommits > 0) {
      console.log(`[git-scanner] Scanned ${totalCommits} new commits across ${REPOS.length} repos, updated ${updatedTasks} tasks`);
    }

    return { scanned: totalCommits, updated: updatedTasks };
  } catch (e) {
    // 想定外のエラーでもプロセスをクラッシュさせない（土台のクラッシュループ再発防止）
    console.error("[git-scanner] scanAllRepos error:", e.message);
    return { scanned: 0, updated: 0, error: e.message };
  }
}

module.exports = { scanAllRepos, REPOS };

// CLI mode
if (require.main === module) {
  console.log("Running git scanner...");
  scanAllRepos().then(result => {
    console.log(`Done: ${result.scanned} commits scanned, ${result.updated} tasks updated`);
  });
}
