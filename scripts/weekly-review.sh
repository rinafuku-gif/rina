#!/bin/bash
# @critical: launchd com.openclaw.weekly-review から毎週日曜20:00実行
# @stops-if-deleted: 週次のObsidianダッシュボード更新（update-obsidian-dashboard.js）が止まる
# @depends: update-obsidian-dashboard.js
# 週次レビュー自動生成 — 毎週日曜 20:00 に実行
# roadmap-tasks.json + タスクハブ(hub/events.jsonl) からロードマップ集計・ログ保存
# （2026-08-07 Ryo判断でDiscord通知は無効化。ロードマップ集計はログにのみ残す）
# （2026-08-11 完了タスク取得をNotion Task DB直読みからタスクハブ(task_store)参照へ移行）
# 最後に update-obsidian-dashboard.js でObsidianダッシュボードを更新

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$REPO_DIR/logs"
DATA_DIR="$REPO_DIR/data"

# ログを追記式にリダイレクト
exec >> "$LOG_DIR/weekly-review-stdout.log" 2>> "$LOG_DIR/weekly-review-stderr.log"

echo "=== Weekly review started at $(date '+%Y-%m-%d %H:%M:%S') ==="

# launchd では PATH が限定されるため明示的に設定
export PATH="/Users/ocmm/.local/bin:/Users/ocmm/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Claude Code セッション内からの手動実行にも対応
unset CLAUDECODE 2>/dev/null || true

# .env から環境変数を読み込み
source "$REPO_DIR/.env"

# --- 日付計算 ---
TODAY=$(date +%Y-%m-%d)
WEEK_AGO=$(date -v-7d +%Y-%m-%d)
# 今日（日曜）の曜日を確認: 0=Sun ... 6=Sat
# 今週: 6日前（月曜）〜今日（日曜）
WEEK_START=$(date -v-6d +%Y-%m-%d)
WEEK_END="$TODAY"
# 来週: 明日（月曜）〜7日後（日曜）
NEXT_WEEK_START=$(date -v+1d +%Y-%m-%d)
NEXT_WEEK_END=$(date -v+7d +%Y-%m-%d)

# 月・日フォーマット（M/D）
fmt_md() {
  local d="$1"
  local month day
  month=$(echo "$d" | awk -F'-' '{print $2+0}')
  day=$(echo "$d" | awk -F'-' '{print $3+0}')
  echo "${month}/${day}"
}

WEEK_START_FMT=$(fmt_md "$WEEK_START")
WEEK_END_FMT=$(fmt_md "$WEEK_END")

# --- ロードマップデータ読み込み ---
ROADMAP_FILE="$DATA_DIR/roadmap-tasks.json"

if [ ! -f "$ROADMAP_FILE" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ロードマップデータなし: $ROADMAP_FILE"
  echo "weekly-review: ロードマップデータがありません。処理を終了します。"
  exit 0
fi

# --- 今週のWeek番号を判定 ---
CURRENT_WEEK_NUM=$(python3 - "$TODAY" "$ROADMAP_FILE" << 'PYEOF'
import json, sys
from datetime import datetime

today = sys.argv[1]
roadmap_file = sys.argv[2]

with open(roadmap_file) as f:
    data = json.load(f)

weeks = data.get("weeks", [])
for week in weeks:
    start = week.get("start", "")
    end = week.get("end", "")
    if start <= today <= end:
        print(week.get("week", "?"))
        sys.exit(0)

print("?")
PYEOF
)

# --- 今週のタスクをロードマップから抽出 ---
ROADMAP_THIS_WEEK=$(python3 - "$TODAY" "$ROADMAP_FILE" << 'PYEOF'
import json, sys

today = sys.argv[1]
with open(sys.argv[2]) as f:
    data = json.load(f)

for week in data.get("weeks", []):
    start = week.get("start", "")
    end = week.get("end", "")
    if start <= today <= end:
        tasks = week.get("tasks", [])
        for t in tasks:
            title = t.get("title") or t.get("name") or str(t)
            due = t.get("dueDate") or t.get("due_date") or ""
            biz = t.get("business") or t.get("category") or ""
            print(f"{title}\t{due}\t{biz}")
        break
PYEOF
)

# --- 来週のタスクをロードマップから抽出 ---
ROADMAP_NEXT_WEEK=$(python3 - "$NEXT_WEEK_START" "$NEXT_WEEK_END" "$ROADMAP_FILE" << 'PYEOF'
import json, sys

next_start = sys.argv[1]
next_end = sys.argv[2]
with open(sys.argv[3]) as f:
    data = json.load(f)

for week in data.get("weeks", []):
    start = week.get("start", "")
    end = week.get("end", "")
    if end >= next_start and start <= next_end:
        tasks = week.get("tasks", [])
        for t in tasks:
            title = t.get("title") or t.get("name") or str(t)
            due = t.get("dueDate") or t.get("due_date") or ""
            biz = t.get("business") or t.get("category") or ""
            print(f"{title}\t{due}\t{biz}")
        break
PYEOF
)

# --- ロードマップの「やらないことリスト」をピックアップ ---
DONT_DO=$(python3 - "$ROADMAP_FILE" << 'PYEOF'
import json, sys, random

with open(sys.argv[1]) as f:
    data = json.load(f)

donts = data.get("not_to_do", data.get("dontDo", []))
if donts:
    item = random.choice(donts)
    print(item.get("title") or str(item))
PYEOF
)

# --- タスクハブ(hub/events.jsonl)から今週完了タスクを取得 ---
# (2026-08-11: Notion Task DB直読みから正本=タスクハブ参照へ移行。
#  Notionはタスク管理から降格済み。~/agents/ceo/scripts/task_store の list_tasks を直読みする)
HUB_DONE=$(python3 - "$WEEK_START" "$TODAY" << 'PYEOF' 2>/dev/null || true
import sys

HUB_SCRIPTS_DIR = "/Users/ocmm/agents/ceo/scripts"
if HUB_SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, HUB_SCRIPTS_DIR)

week_start, today = sys.argv[1], sys.argv[2]

try:
    from task_store.task_store import list_tasks

    for t in list_tasks(state="done"):
        activity_date = (t.last_activity_at or t.created or "")[:10]
        if week_start <= activity_date <= today:
            print(t.title)
except Exception as e:
    sys.stderr.write("task_store error: " + str(e) + "\n")
PYEOF
)

# --- 今週のロードマップタスク数と完了数を集計 ---
TOTAL_TASKS=0
if [ -n "$ROADMAP_THIS_WEEK" ]; then
  TOTAL_TASKS=$(echo "$ROADMAP_THIS_WEEK" | grep -c . || echo 0)
fi

DONE_TASKS=0
DONE_TITLES=""
if [ -n "$HUB_DONE" ]; then
  DONE_TASKS=$(echo "$HUB_DONE" | grep -c . || echo 0)
  DONE_TITLES="$HUB_DONE"
fi

# 完了率の計算
if [ "$TOTAL_TASKS" -gt 0 ]; then
  COMPLETION_RATE=$(python3 -c "print(int($DONE_TASKS / $TOTAL_TASKS * 100))" 2>/dev/null || echo "0")
else
  COMPLETION_RATE="0"
fi

# --- 未完了タスク（ロードマップにあってNotionで完了していないもの）---
INCOMPLETE_TASKS=""
if [ -n "$ROADMAP_THIS_WEEK" ]; then
  INCOMPLETE_TASKS=$(python3 - "$DONE_TITLES" << 'PYEOF'
import sys

# 完了タイトルリスト
done_raw = sys.argv[1] if len(sys.argv) > 1 else ""
done_titles = set(t.strip() for t in done_raw.split("\n") if t.strip())

# stdin からロードマップタスクを読む
import sys as _sys
for line in _sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    parts = line.split("\t")
    title = parts[0] if parts else ""
    if title and title not in done_titles:
        print(title)
PYEOF
  <<< "$ROADMAP_THIS_WEEK" 2>/dev/null || true)
fi

# --- 来週の最重要3タスクを抽出 ---
NEXT_TOP3=""
if [ -n "$ROADMAP_NEXT_WEEK" ]; then
  NEXT_TOP3=$(echo "$ROADMAP_NEXT_WEEK" | head -3)
fi

# --- 発信本数: Notion DBから「発信」タグのある完了タスクをカウント ---
# （ここでは簡易実装: 完了タスク中に「発信」「note」「Instagram」「投稿」を含むものをカウント）
PUBLISH_COUNT=0
if [ -n "$DONE_TITLES" ]; then
  PUBLISH_COUNT=$(echo "$DONE_TITLES" | grep -ciE "(発信|note|Instagram|投稿|SNS)" || echo "0")
fi

# --- Discordメッセージを組み立て ---
# jqでJSONエスケープするためにパーツを変数に格納

build_message() {
  local msg=""

  msg+="📊 今週のふりかえり（Week ${CURRENT_WEEK_NUM}: ${WEEK_START_FMT}〜${WEEK_END_FMT}）\n\n"
  msg+="**完了**: ${DONE_TASKS}/${TOTAL_TASKS}タスク（${COMPLETION_RATE}%）\n"

  # 完了タスク
  if [ -n "$DONE_TITLES" ]; then
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      msg+="✅ ${line}\n"
    done <<< "$DONE_TITLES"
  fi

  # 未完了タスク（繰り越し）
  if [ -n "$INCOMPLETE_TASKS" ]; then
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      msg+="❌ ${line} → 来週に繰り越し\n"
    done <<< "$INCOMPLETE_TASKS"
  fi

  msg+="\n**来週の最重要3つ**:\n"

  local counter=1
  if [ -n "$NEXT_TOP3" ]; then
    while IFS=$'\t' read -r title due biz; do
      [ -z "$title" ] && continue
      local due_str=""
      if [ -n "$due" ]; then
        local m d
        m=$(echo "$due" | awk -F'-' '{print $2+0}')
        d=$(echo "$due" | awk -F'-' '{print $3+0}')
        due_str="（期限: ${m}/${d}）"
      fi
      msg+="${counter}. ${title}${due_str}\n"
      counter=$((counter + 1))
    done <<< "$NEXT_TOP3"
  else
    msg+="1. （ロードマップ未設定）\n"
  fi

  msg+="\n**発信の記録**: 今週${PUBLISH_COUNT}本（目標3本）\n"

  if [ -n "$DONT_DO" ]; then
    msg+="\n💡 今週の「やらなかった」こと → ${DONT_DO}"
  fi

  echo -e "$msg"
}

DISCORD_MESSAGE=$(build_message)

# --- Discord送信は2026-08-07 Ryo判断で無効化 ---
# 週次レビューのDiscord通知自体は不要と判断。ロードマップ集計とObsidianダッシュボード更新
# （下のupdate-obsidian-dashboard.js呼び出し）は引き続き必要なため、Discord送信部分だけを止める。
# 再有効化する場合はこのブロックを元のcurl送信に戻す（git履歴参照）。
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Discord送信は無効化済み(2026-08-07)。ログのみ記録します"

# ログ保存
echo -e "$DISCORD_MESSAGE" > "$LOG_DIR/weekly-review-${TODAY}.md"

# --- Obsidianダッシュボード更新 ---
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Obsidianダッシュボード更新中..."
node "$SCRIPT_DIR/update-obsidian-dashboard.js" 2>> "$LOG_DIR/weekly-review-stderr.log" || {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Obsidian更新エラー（週次レビュー本体は成功済み）"
}

echo "=== Weekly review completed at $(date '+%Y-%m-%d %H:%M:%S') ==="
