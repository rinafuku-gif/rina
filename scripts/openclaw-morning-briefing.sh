#!/bin/bash
# OpenClaw 自律型朝ブリーフィング
# Mac mini (OpenClaw) から毎朝実行
# 従来の固定テンプレートではなく、Claude が状況を判断してブリーフィング内容を自律構成する

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$REPO_DIR/logs"

exec >> "$LOG_DIR/briefing-stdout.log" 2>> "$LOG_DIR/briefing-stderr.log"

echo "=== OpenClaw Briefing started at $(date '+%Y-%m-%d %H:%M:%S') ==="

# PATH 設定（Mac mini 用 — 環境に合わせて調整）
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Claude Code セッション競合回避
unset CLAUDECODE 2>/dev/null || true

# .env 読み込み
source "$REPO_DIR/.env"

# リポジトリを最新に更新
echo "Pulling latest rina repo..."
cd "$REPO_DIR"
git pull origin main 2>/dev/null || echo "Git pull failed, continuing with local state"

# Airbnb予約メール→カレンダー同期（しらたまサーバーが動いている場合のみ）
echo "Syncing Airbnb bookings..."
curl -s --connect-timeout 5 -X POST http://localhost:3100/api/sync-airbnb-bookings \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$SHIRATAMA_API_TOKEN\"}" || echo "Booking sync skipped (server not available)"
sleep 3

TODAY=$(date '+%Y-%m-%d')
DAY_OF_WEEK=$(date '+%u')  # 1=月曜, 7=日曜

# Claude Code で自律ブリーフィング生成（7分タイムアウト — 自律判断に余裕を持たせる）
BRIEFING_FILE=$(mktemp)
(cd "$REPO_DIR" && claude -p --dangerously-skip-permissions "
あなたは OpenClaw — Ryo の自律型AIアシスタントだ。
今日は ${TODAY}（曜日番号: ${DAY_OF_WEEK} / 1=月〜7=日）。

## ミッション
Ryo に最適化された朝ブリーフィングを **自分で判断して** 生成せよ。
固定テンプレートに従うのではなく、今日の状況に応じて内容・構成・優先順位を自律的に決定する。

## 情報ソース（すべて自分で読み取ること）
1. Google Calendar — 今日〜3日先の全カレンダーの予定
2. CLAUDE.md — タスク管理セクション、事業優先順位、財務状況
3. logs/daily/ — 直近のログから継続事項・未完了事項
4. docs/ 配下 — 各事業の最新ドキュメント（必要に応じて）

## 自律判断の指針
- 今日 Ryo が **物理的にやるべきこと** を最優先で伝える（ゲスト対応、打ち合わせ、立ち会い等）
- 締め切りが近いタスクがあれば警告する
- 曜日に応じたアプローチを取る:
  - 月曜: 今週の見通しを含める
  - 金曜: 週末の予定・来週の準備事項を含める
  - それ以外: その日に集中すべきことにフォーカス
- 予約が入っている日は準備リマインドを含める
- 何もない穏やかな日なら、進めるべき中長期タスクを提案する
- 前回のログで「やる」と言っていたのに未完了のものがあれば、さりげなくリマインドする
- 不要な情報は省く。情報が少ない日は短いブリーフィングでいい

## 出力ルール
- LINEで読みやすい形式（短文、箇条書き中心）
- 冒頭の挨拶は「おはよう、Ryo。」で統一
- セクション見出しは【】で括る
- ブリーフィング本文のみ出力。余計な説明・メタコメントは一切不要
- 最大500文字を目安に（LINE で読みやすい長さ）

## 追加タスク
ブリーフィング生成後、以下も実行すること:
- logs/daily/${TODAY}.md にブリーフィング内容を記録
- 変更があれば git add → git commit → git push origin main
" > "$BRIEFING_FILE") &
CLAUDE_PID=$!

# 7分タイムアウト
WAIT_SECONDS=420
while [ $WAIT_SECONDS -gt 0 ]; do
  if ! kill -0 $CLAUDE_PID 2>/dev/null; then
    break
  fi
  sleep 5
  WAIT_SECONDS=$((WAIT_SECONDS - 5))
done

if kill -0 $CLAUDE_PID 2>/dev/null; then
  echo "Claude timed out after 420s, killing process"
  kill $CLAUDE_PID 2>/dev/null
  sleep 2
  kill -9 $CLAUDE_PID 2>/dev/null
fi

BRIEFING=$(cat "$BRIEFING_FILE" 2>/dev/null)
rm -f "$BRIEFING_FILE"

# フォールバック
if [ -z "$BRIEFING" ]; then
  echo "OpenClaw failed or timed out, sending fallback"
  BRIEFING="おはよう、Ryo。

OpenClaw のブリーフィング生成がタイムアウトしました。
Mac mini の状態を確認してください。

手動チェック:
- Google Calendar の今日の予定
- CLAUDE.md のタスク一覧"
fi

# LINE Push 送信
curl -s -X POST https://api.line.me/v2/bot/message/push \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
  -d "$(jq -n --arg to "$LINE_USER_ID" --arg text "$BRIEFING" '{
    to: $to,
    messages: [{type: "text", text: $text}]
  }')"

echo "OpenClaw Briefing sent at $(date '+%Y-%m-%d %H:%M:%S')"
