#!/bin/bash
# 自律型朝ブリーフィング実行スクリプト（openclaw版）
# Mac mini の launchd から毎朝7:00に実行
# Claude Code が自律的にブリーフィングを生成 → LINE + PWA Push で配信
#
# 既存の morning-briefing.sh をベースに、Mac mini 環境向けに最適化
# - パスを環境変数で制御（Mac mini のユーザー名が異なる場合に対応）
# - Google Calendar MCP 経由でカレンダー情報を取得

set -uo pipefail

# --- パス解決 ---
# OPENCLAW_REPO_DIR を設定していない場合はデフォルトパスを使用
REPO_DIR="${OPENCLAW_REPO_DIR:-/Users/Inaryo/rina}"
SCRIPT_DIR="$REPO_DIR/scripts"
LOG_DIR="$REPO_DIR/logs"

mkdir -p "$LOG_DIR"

exec >> "$LOG_DIR/briefing-stdout.log" 2>> "$LOG_DIR/briefing-stderr.log"

echo ""
echo "=== [openclaw] Briefing started at $(date '+%Y-%m-%d %H:%M:%S') ==="

# --- DRY_RUN モード ---
# 使い方: DRY_RUN=1 bash scripts/openclaw-morning-briefing.sh
DRY_RUN="${DRY_RUN:-0}"
if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY_RUN] LINE/Push送信はスキップされます"
fi

# --- 環境変数の読み込み ---
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
unset CLAUDECODE 2>/dev/null || true

if [ -f "$REPO_DIR/.env" ]; then
  source "$REPO_DIR/.env"
else
  echo "ERROR: .env not found at $REPO_DIR/.env"
  exit 1
fi

# --- 重複実行防止（アトミックなロック） ---
LOCK_FILE="$LOG_DIR/.briefing-lock"
TODAY=$(date '+%Y-%m-%d')

if [ -f "$LOCK_FILE" ]; then
  LOCK_DATE=$(cat "$LOCK_FILE" 2>/dev/null | tr -d '[:space:]')
  if [ "$LOCK_DATE" = "$TODAY" ]; then
    echo "Already sent today ($TODAY), skipping."
    exit 0
  fi
fi

# ロック取得
echo "$TODAY" > "$LOCK_FILE"
sleep 1
LOCK_VERIFY=$(cat "$LOCK_FILE" 2>/dev/null | tr -d '[:space:]')
if [ "$LOCK_VERIFY" != "$TODAY" ]; then
  echo "Lock file was overwritten by another process, aborting."
  exit 1
fi

# --- Airbnb同期 ---
echo "Syncing Airbnb bookings..."
curl -s -X POST http://localhost:3100/api/sync-airbnb-bookings \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$SHIRATAMA_API_TOKEN\"}" \
  && echo " -> sync OK" \
  || echo " -> sync failed (server may be down)"
sleep 3

# --- AIスキャン（ブリーフィング + カレンダー提案 + タスク更新） ---
echo "Running daily scan..."
BRIEFING=$("$SCRIPT_DIR/daily-scan.sh" 2>>"$LOG_DIR/daily-scan-debug.log")
SCAN_EXIT=$?

if [ $SCAN_EXIT -ne 0 ] || [ -z "$BRIEFING" ]; then
  echo "daily-scan failed (exit=$SCAN_EXIT), using fallback"
  BRIEFING="おはよう、Ryo。

今朝のブリーフィング生成に失敗しました。
手動で確認してください：
- Google Calendar の予定
- しらたまPWA のタスク一覧"
fi

echo "Briefing ready (${#BRIEFING} chars)"

# --- LINE送信（5000文字制限対応） ---
if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY_RUN] LINE送信スキップ (${#BRIEFING} chars)"
else
  echo "Sending via LINE..."
  if [ ${#BRIEFING} -le 5000 ]; then
    curl -s -X POST https://api.line.me/v2/bot/message/push \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
      -d "$(jq -n --arg to "$LINE_USER_ID" --arg text "$BRIEFING" '{
        to: $to,
        messages: [{type: "text", text: $text}]
      }')"
  else
    PART1="${BRIEFING:0:5000}"
    PART2="${BRIEFING:5000}"
    curl -s -X POST https://api.line.me/v2/bot/message/push \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
      -d "$(jq -n --arg to "$LINE_USER_ID" --arg t1 "$PART1" --arg t2 "$PART2" '{
        to: $to,
        messages: [{type: "text", text: $t1}, {type: "text", text: $t2}]
      }')"
  fi
  echo " -> LINE sent"
fi

# --- PWA Push通知 ---
if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY_RUN] PWA Push送信スキップ"
else
  echo "Sending PWA push..."
  SHORT_BODY=$(echo "$BRIEFING" | head -5 | cut -c1-200)
  curl -s -X POST http://localhost:3100/api/push-briefing \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg text "$SHORT_BODY" --arg token "$SHIRATAMA_API_TOKEN" '{
      token: $token,
      title: "おはようブリーフィング",
      body: $text
    }')" \
    && echo " -> push OK" \
    || echo " -> push failed"
fi

echo "=== [openclaw] Briefing completed at $(date '+%Y-%m-%d %H:%M:%S') ==="
