#!/bin/bash
# @critical: launchd com.openclaw.weekly-review から毎週日曜20:00実行
# @stops-if-deleted: 週次レビュー（ロードマップ進捗・Notionタスク状況）がDiscord #notifications に届かなくなる
# @depends: update-obsidian-dashboard.js
# 週次レビュー自動生成 — 毎週日曜 20:00 に実行
# roadmap-tasks.json + Notion Task DB → Discord #notifications に送信
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

# --- Notion Task DBから今週完了タスクを取得 ---
NOTION_DONE=$(node - "$WEEK_START" "$TODAY" << 'JSEOF'
const https = require("https");
const fs = require("fs");
const path = require("path");

const REPO_DIR = path.join(__dirname, "..", "..");
const envContent = fs.readFileSync(path.join("/Users/ocmm/rina", ".env"), "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const m = line.match(/^([^=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}

const [,, weekStart, weekEnd] = process.argv;

function notionPost(endpoint, body) {
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
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          reject(new Error(`Notion ${res.statusCode}: ${data.slice(0,200)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function main() {
  const result = await notionPost("databases/500a3ff0900d4933ba83b511102f6779/query", {
    page_size: 100,
    filter: {
      and: [
        { property: "GTD", status: { equals: "完了" } },
        {
          timestamp: "last_edited_time",
          last_edited_time: { on_or_after: weekStart + "T00:00:00+09:00" },
        },
        {
          timestamp: "last_edited_time",
          last_edited_time: { on_or_before: weekEnd + "T23:59:59+09:00" },
        },
      ],
    },
  });

  const pages = result.results || [];
  for (const page of pages) {
    const props = page.properties || {};
    let title = "";
    for (const key of Object.keys(props)) {
      const prop = props[key];
      if (prop.type === "title" && prop.title && prop.title.length > 0) {
        title = prop.title.map(t => t.plain_text).join("").trim();
        break;
      }
    }
    if (title) process.stdout.write(title + "\n");
  }
}

main().catch(err => {
  process.stderr.write("Notion error: " + err.message + "\n");
  process.exit(0); // エラーでも続行
});
JSEOF
2>/dev/null || true)

# --- 今週のロードマップタスク数と完了数を集計 ---
TOTAL_TASKS=0
if [ -n "$ROADMAP_THIS_WEEK" ]; then
  TOTAL_TASKS=$(echo "$ROADMAP_THIS_WEEK" | grep -c . || echo 0)
fi

DONE_TASKS=0
DONE_TITLES=""
if [ -n "$NOTION_DONE" ]; then
  DONE_TASKS=$(echo "$NOTION_DONE" | grep -c . || echo 0)
  DONE_TITLES="$NOTION_DONE"
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

# --- Discord Bot Token 送信 ---
DISCORD_BOT_TOKEN=$(grep '^DISCORD_BOT_TOKEN=' "$HOME/.claude/channels/discord/.env" 2>/dev/null | cut -d= -f2)
DISCORD_CHANNEL_ID="1486651097157472307"  # #notifications

if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: DISCORD_BOT_TOKEN が未設定です"
  exit 1
fi

# 2000文字ずつ分割送信
REMAINING="$DISCORD_MESSAGE"
SEND_OK=true
while [ ${#REMAINING} -gt 0 ]; do
  CHUNK="${REMAINING:0:2000}"
  REMAINING="${REMAINING:2000}"
  RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -d "$(jq -n --arg text "$CHUNK" '{content: $text}')")
  if [ "$RESPONSE" != "200" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Discord送信失敗 (HTTP $RESPONSE)"
    SEND_OK=false
    break
  fi
  [ ${#REMAINING} -gt 0 ] && sleep 1
done

if [ "$SEND_OK" = true ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Discord送信成功"
else
  exit 1
fi

# ログ保存
echo -e "$DISCORD_MESSAGE" > "$LOG_DIR/weekly-review-${TODAY}.md"

# --- Obsidianダッシュボード更新 ---
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Obsidianダッシュボード更新中..."
node "$SCRIPT_DIR/update-obsidian-dashboard.js" 2>> "$LOG_DIR/weekly-review-stderr.log" || {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Obsidian更新エラー（週次レビュー本体は成功済み）"
}

echo "=== Weekly review completed at $(date '+%Y-%m-%d %H:%M:%S') ==="
