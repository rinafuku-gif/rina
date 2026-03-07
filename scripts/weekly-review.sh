#!/bin/bash
# 週次レビュー自動生成 — 毎週日曜 20:00 に実行
# claude -p でレビュー生成 → curl で LINE Push 送信

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$REPO_DIR/logs"

# ログを追記式にリダイレクト（launchd の StandardOutPath は上書き式のため）
exec >> "$LOG_DIR/weekly-review-stdout.log" 2>> "$LOG_DIR/weekly-review-stderr.log"

echo "=== Weekly review started at $(date '+%Y-%m-%d %H:%M:%S') ==="

# launchd ではシェルプロファイルが読み込まれないため PATH を明示的に設定
export PATH="/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Claude Code セッション内からの手動実行にも対応
unset CLAUDECODE 2>/dev/null || true

# .env から環境変数を読み込み
source "$REPO_DIR/.env"

TODAY=$(date +%Y-%m-%d)
WEEK_AGO=$(date -v-7d +%Y-%m-%d)

# 今週のデータを収集
WEEKLY_DATA=""

# 1. チャット履歴の要約（今週分）
if [ -f "$LOG_DIR/.chat-history.json" ]; then
  CHAT_COUNT=$(python3 -c "
import json, sys
from datetime import datetime, timedelta
with open('$LOG_DIR/.chat-history.json') as f:
    data = json.load(f)
week_ago = datetime.now() - timedelta(days=7)
count = sum(1 for e in data if datetime.fromisoformat(e['timestamp'].replace('Z','+00:00')).replace(tzinfo=None) > week_ago)
print(count)
" 2>/dev/null || echo "0")
  WEEKLY_DATA="${WEEKLY_DATA}
## チャット利用: ${CHAT_COUNT}件（今週）"
fi

# 2. 体調記録
if [ -f "$LOG_DIR/condition.json" ]; then
  CONDITION_DATA=$(python3 -c "
import json, sys
from datetime import datetime, timedelta
with open('$LOG_DIR/condition.json') as f:
    data = json.load(f)
week_ago = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
entries = [e for e in data if e['date'] >= week_ago]
if entries:
    avg = sum(e['score'] for e in entries) / len(entries)
    print(f'記録{len(entries)}日間 / 平均: {avg:.1f}')
else:
    print('記録なし')
" 2>/dev/null || echo "記録なし")
  WEEKLY_DATA="${WEEKLY_DATA}
## 体調: ${CONDITION_DATA}"
fi

# 3. 期間情報
WEEKLY_DATA="${WEEKLY_DATA}
## 期間: ${WEEK_AGO} 〜 ${TODAY}"

# 4. CLAUDE.mdのタスクセクションを取得
TASKS=$(sed -n '/### 現在のタスク/,/### 完了タスク/p' "$REPO_DIR/CLAUDE.md" | head -60)
COMPLETED=$(sed -n '/### 完了タスク/,/## アシスタント/p' "$REPO_DIR/CLAUDE.md" | head -30)

# プロンプトをファイル経由で渡す（シェル特殊文字対策）
PROMPT_FILE="$LOG_DIR/.weekly-review-prompt.txt"
cat > "$PROMPT_FILE" << PROMPT_EOF
あなたはRyoの専属AI秘書「しらたま」です。
今週（${WEEK_AGO}〜${TODAY}）の週次レビューを作成してください。

以下のデータを元に、LINEメッセージとして送信できる形式でまとめてください。

${WEEKLY_DATA}

## 現在のタスク状況
${TASKS}

## 完了タスク
${COMPLETED}

以下のフォーマットで出力してください（LINE用なのでMarkdownは使わない、絵文字OK）:

📊 週次レビュー（${WEEK_AGO}〜${TODAY}）

🎯 今週やったこと
- （完了タスクや活動をリストアップ）

📋 残タスク（優先度順）
- （来週やるべきことを3-5個）

💰 今週の経費（わかる範囲で）

❤️ 体調（記録があれば）

💡 来週のアドバイス
- （タスクの状況やスケジュールを踏まえた一言）

簡潔に、LINEで読みやすい長さでお願いします。
重要: 出力はレビュー本文のみ。余計な説明は不要。
PROMPT_EOF

# claude -p でレビュー生成
REVIEW=$(cd "$REPO_DIR" && cat "$PROMPT_FILE" | claude -p 2>>"$LOG_DIR/weekly-review-stderr.log")

if [ -z "$REVIEW" ]; then
  echo "[$(date)] Weekly review generation failed" >> "$LOG_DIR/weekly-review-stderr.log"
  exit 1
fi

# LINE Push で送信（jq でJSON安全にエスケープ）
curl -s -X POST https://api.line.me/v2/bot/message/push \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
  -d "$(jq -n --arg to "$LINE_USER_ID" --arg text "${REVIEW:0:4999}" '{
    to: $to,
    messages: [{type: "text", text: $text}]
  }')"

# ログ保存
echo "$REVIEW" > "$LOG_DIR/weekly-review-${TODAY}.md"
echo "Weekly review sent at $(date '+%Y-%m-%d %H:%M:%S')"
