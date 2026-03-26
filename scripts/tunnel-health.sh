#!/bin/bash
# Cloudflare Tunnel ヘルスチェック & 自動復旧
# 5分ごとにlaunchdで実行

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$REPO_DIR/logs"
LOG_FILE="$LOG_DIR/tunnel-health.log"
MAX_LOG_LINES=500
# 再起動直後のフラッピング防止用ロックファイル（再起動後3分間は再チェックしない）
LOCK_FILE="$LOG_DIR/.tunnel-restart.lock"
LOCK_TTL=330  # 秒（チェック間隔300秒+マージン30秒）

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
  # ログのローテーション
  if [ "$(wc -l < "$LOG_FILE" 2>/dev/null)" -gt "$MAX_LOG_LINES" ]; then
    tail -n 200 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
}

# ロックファイルが新しい場合はスキップ（再起動直後のフラッピング防止）
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
  if [ "$LOCK_AGE" -lt "$LOCK_TTL" ]; then
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi

# ローカルサーバーが動いているか確認
if ! curl -sf -o /dev/null http://localhost:3100/api/sns-drafts 2>/dev/null; then
  log "ERROR: Local server not running. Restarting..."
  "$SCRIPT_DIR/start-line-bot.sh" >> "$LOG_FILE" 2>&1
  touch "$LOCK_FILE"
  exit 0
fi

# cloudflaredプロセスが動いているか確認
if ! pgrep -f "cloudflared tunnel" > /dev/null 2>&1; then
  log "ERROR: cloudflared not running. Starting tunnel..."
  cloudflared tunnel cleanup rina-api >> "$LOG_FILE" 2>&1 || true
  sleep 1
  cloudflared tunnel run rina-api >> "$LOG_DIR/cloudflared.log" 2>&1 &
  touch "$LOCK_FILE"
  log "OK: cloudflared started (PID: $!)"
  exit 0
fi

# トンネル経由でチェック（5回試行、間隔を長めに）
TUNNEL_OK=false
for i in 1 2 3 4 5; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 https://api.tonari2tomaru.com/api/sns-drafts 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    TUNNEL_OK=true
    break
  fi
  sleep 5
done

if [ "$TUNNEL_OK" = true ]; then
  # 正常 → 失敗カウンターをリセット
  rm -f "$LOG_DIR/.tunnel-fail-count"
  exit 0
fi

# 連続失敗カウンター
FAIL_COUNT_FILE="$LOG_DIR/.tunnel-fail-count"
FAIL_COUNT=0
if [ -f "$FAIL_COUNT_FILE" ]; then
  FAIL_COUNT=$(cat "$FAIL_COUNT_FILE" 2>/dev/null || echo 0)
fi
FAIL_COUNT=$((FAIL_COUNT + 1))
echo "$FAIL_COUNT" > "$FAIL_COUNT_FILE"

# cloudflaredプロセスが動いている場合
if pgrep -f "cloudflared tunnel" > /dev/null 2>&1; then
  if [ "$FAIL_COUNT" -ge 3 ]; then
    # 3回連続失敗 → プロセスは生きてるが応答しない → 強制再起動
    log "WARN: Tunnel unresponsive for $FAIL_COUNT cycles. Force restarting cloudflared..."
    pkill -f "cloudflared tunnel" 2>/dev/null || true
    sleep 2
    cloudflared tunnel cleanup rina-api >> "$LOG_FILE" 2>&1 || true
    sleep 1
    cloudflared tunnel run rina-api >> "$LOG_DIR/cloudflared.log" 2>&1 &
    touch "$LOCK_FILE"
    echo "0" > "$FAIL_COUNT_FILE"
    log "OK: cloudflared force-restarted (PID: $!)"
    exit 0
  else
    log "INFO: Tunnel returning $STATUS but cloudflared running. Fail count: $FAIL_COUNT/3"
    exit 0
  fi
fi

log "WARN: Tunnel returning $STATUS and cloudflared not running. Restarting..."
echo "0" > "$FAIL_COUNT_FILE"

# 古いコネクタをクリーンアップ
cloudflared tunnel cleanup rina-api >> "$LOG_FILE" 2>&1

# cloudflaredを再起動
cloudflared tunnel run rina-api >> "$LOG_DIR/cloudflared.log" 2>&1 &
touch "$LOCK_FILE"
sleep 10

# 再起動後の確認
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 https://api.tonari2tomaru.com/api/sns-drafts 2>/dev/null)
if [ "$STATUS" = "200" ]; then
  log "OK: Tunnel recovered after restart"
else
  log "INFO: Tunnel status=$STATUS after restart (still connecting, will recheck next cycle)"
fi
