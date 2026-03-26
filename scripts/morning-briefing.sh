#!/bin/bash
# 朝ブリーフィング自動配信スクリプト
# launchd から毎朝実行
# daily-scan.sh でAI分析 → ブリーフィングをLINE + PWA Pushで送信

set -uo pipefail

# --- パス解決（常にメインリポジトリを参照。worktreeからの実行を防止） ---
MAIN_REPO="/Users/ocmm/rina"
SCRIPT_DIR="$MAIN_REPO/scripts"
REPO_DIR="$MAIN_REPO"
LOG_DIR="$REPO_DIR/logs"

exec >> "$LOG_DIR/briefing-stdout.log" 2>> "$LOG_DIR/briefing-stderr.log"

echo ""
echo "=== Briefing started at $(date '+%Y-%m-%d %H:%M:%S') ==="

# --- DRY_RUN モード（テスト実行時はLINE/Push送信をスキップ） ---
# 使い方: DRY_RUN=1 ./scripts/morning-briefing.sh
DRY_RUN="${DRY_RUN:-0}"
if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY_RUN] LINE/Push送信はスキップされます"
fi

export PATH="/Users/ocmm/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
unset CLAUDECODE 2>/dev/null || true
source "$REPO_DIR/.env"

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

# ロック取得: 書き込み後に再度確認（レースコンディション対策）
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

# --- Discord送信（2000文字制限対応） ---
DISCORD_BOT_TOKEN=$(grep '^DISCORD_BOT_TOKEN=' "$HOME/.claude/channels/discord/.env" 2>/dev/null | cut -d= -f2)
DISCORD_CHANNEL_ID="1485836971191566488"

if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY_RUN] Discord送信スキップ (${#BRIEFING} chars)"
elif [ -z "$DISCORD_BOT_TOKEN" ]; then
  echo "ERROR: DISCORD_BOT_TOKEN not found"
else
  echo "Sending via Discord..."
  # 2000文字ずつ分割送信
  REMAINING="$BRIEFING"
  while [ ${#REMAINING} -gt 0 ]; do
    CHUNK="${REMAINING:0:2000}"
    REMAINING="${REMAINING:2000}"
    curl -s -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID/messages" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
      -d "$(jq -n --arg text "$CHUNK" '{content: $text}')"
    [ ${#REMAINING} -gt 0 ] && sleep 1
  done
  echo " -> Discord sent"
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

echo "=== Briefing completed at $(date '+%Y-%m-%d %H:%M:%S') ==="
