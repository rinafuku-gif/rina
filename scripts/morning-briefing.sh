#!/bin/bash
# 朝ブリーフィング自動配信スクリプト
# cron/launchd から毎朝実行し、Claude Code でブリーフィングを生成 → LINEに送信

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$REPO_DIR/logs"

# ログを追記式にリダイレクト（launchd の StandardOutPath は上書き式のため）
exec >> "$LOG_DIR/briefing-stdout.log" 2>> "$LOG_DIR/briefing-stderr.log"

echo "=== Briefing started at $(date '+%Y-%m-%d %H:%M:%S') ==="

# launchd ではシェルプロファイルが読み込まれないため PATH を明示的に設定
export PATH="/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Claude Code セッション内からの手動実行にも対応
unset CLAUDECODE 2>/dev/null || true

# .env から環境変数を読み込み
source "$REPO_DIR/.env"

# Airbnb予約メール→カレンダー同期（ブリーフィング前に実行）
echo "Syncing Airbnb bookings..."
curl -s -X POST http://localhost:3100/api/sync-airbnb-bookings \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$SHIRATAMA_API_TOKEN\"}" || echo "Booking sync failed (server may be down)"
sleep 3

# Claude Code でブリーフィング生成（5分タイムアウト）
# macOS には timeout コマンドがないため、バックグラウンド + wait で実装
BRIEFING_FILE=$(mktemp)
(cd "$REPO_DIR" && claude -p --dangerously-skip-permissions "
あなたはRyoの専属AI秘書です。以下の手順で今日の朝ブリーフィングを作成してください。

1. Google Calendarで今日の全カレンダーの予定を確認
2. CLAUDE.mdのタスク管理セクションから期日が近いタスクを抽出
3. logs/daily/の最新ログから継続事項を確認

以下のフォーマットでブリーフィングを作成してください。LINEで読みやすいように、簡潔に。

---
おはよう、Ryo。

【今日の予定】
- 時間: 内容

【直近のタスク・期日】
- タスク内容（期日）

【ひとこと】
今日のアドバイスや注意点を一言
---

4. docs/kura-sauna/day-use-sauna-pricing-research.md を確認し、日帰り蔵サウナの料金リサーチ結果を【共有事項】として簡潔に要約して含める（このファイルが存在する場合のみ）

重要: 出力はブリーフィング本文のみ。余計な説明は不要。
" > "$BRIEFING_FILE") &
CLAUDE_PID=$!

# 5分待って終了しなければ強制終了
WAIT_SECONDS=300
while [ $WAIT_SECONDS -gt 0 ]; do
  if ! kill -0 $CLAUDE_PID 2>/dev/null; then
    break
  fi
  sleep 5
  WAIT_SECONDS=$((WAIT_SECONDS - 5))
done

if kill -0 $CLAUDE_PID 2>/dev/null; then
  echo "Claude timed out after 300s, killing process"
  kill $CLAUDE_PID 2>/dev/null
  sleep 2
  kill -9 $CLAUDE_PID 2>/dev/null
fi

BRIEFING=$(cat "$BRIEFING_FILE" 2>/dev/null)
rm -f "$BRIEFING_FILE"

# タイムアウトや失敗時のフォールバック
if [ -z "$BRIEFING" ]; then
  echo "Claude failed or timed out, sending fallback briefing"
  BRIEFING="おはよう、Ryo。

今朝のブリーフィング生成に失敗しました。
claude -p がタイムアウトした可能性があります。

手動で確認してください：
- Google Calendar の予定
- CLAUDE.md のタスク一覧"
fi

# LINE Messaging API でプッシュ送信
curl -s -X POST https://api.line.me/v2/bot/message/push \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
  -d "$(jq -n --arg to "$LINE_USER_ID" --arg text "$BRIEFING" '{
    to: $to,
    messages: [{type: "text", text: $text}]
  }')"

echo "Briefing sent at $(date '+%Y-%m-%d %H:%M:%S')"
