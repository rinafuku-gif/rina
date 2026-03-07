#!/bin/bash
# LINE Bot 起動スクリプト
# 1. Webhook サーバーを起動
# 2. Cloudflare Tunnel を起動
# 3. 新しい Tunnel URL を LINE で通知

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$REPO_DIR/logs"

source "$REPO_DIR/.env"

# 既存プロセスを停止
pkill -f "line-webhook-server.js" 2>/dev/null || true
pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 1

# Webhook サーバーをバックグラウンドで起動
echo "[$(date)] Starting webhook server..."
node "$SCRIPT_DIR/line-webhook-server.js" >> "$LOG_DIR/line-bot-stdout.log" 2>> "$LOG_DIR/line-bot-stderr.log" &
WEBHOOK_PID=$!
echo "[$(date)] Webhook server PID: $WEBHOOK_PID"
sleep 2

# Cloudflare Tunnel をバックグラウンドで起動し、URL を取得
echo "[$(date)] Starting Cloudflare Tunnel..."
TUNNEL_LOG="$LOG_DIR/cloudflared.log"
: > "$TUNNEL_LOG"
cloudflared tunnel --url http://localhost:3100 >> "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
echo "[$(date)] Tunnel PID: $TUNNEL_PID"

# Tunnel URL が出るまで待機（最大30秒）
TUNNEL_URL=""
for i in $(seq 1 30); do
  sleep 1
  TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
done

if [ -z "$TUNNEL_URL" ]; then
  echo "[$(date)] ERROR: Failed to get Tunnel URL after 30 seconds"
  cat "$TUNNEL_LOG"
  exit 1
fi

WEBHOOK_URL="${TUNNEL_URL}/webhook"
echo "[$(date)] Tunnel URL: $TUNNEL_URL"
echo "[$(date)] Webhook URL: $WEBHOOK_URL"

# 前回の URL と比較して、変わっていたら LINE で通知
PREV_URL_FILE="$LOG_DIR/last-tunnel-url.txt"
PREV_URL=$(cat "$PREV_URL_FILE" 2>/dev/null || true)

if [ "$WEBHOOK_URL" != "$PREV_URL" ]; then
  echo "[$(date)] Tunnel URL changed. Notifying via LINE..."
  curl -s -X POST https://api.line.me/v2/bot/message/push \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
    -d "$(cat <<ENDJSON
{
  "to": "$LINE_USER_ID",
  "messages": [{
    "type": "text",
    "text": "LINE Bot が起動しました。\n\nWebhook URL が更新されました。LINE Developers コンソールで以下のURLに変更してください:\n\n$WEBHOOK_URL"
  }]
}
ENDJSON
)"
  echo "$WEBHOOK_URL" > "$PREV_URL_FILE"

  # Vercel 秘書しらたまの環境変数を自動更新
  echo "[$(date)] Updating Vercel env var (NEXT_PUBLIC_BACKEND_URL)..."
  VERCEL_CMD="npx vercel"
  VERCEL_PROJECT_DIR="$HOME/hisho-shiratama"
  if [ -d "$VERCEL_PROJECT_DIR/.vercel" ]; then
    cd "$VERCEL_PROJECT_DIR"
    # 既存の変数を削除して再設定
    $VERCEL_CMD env rm NEXT_PUBLIC_BACKEND_URL production --yes 2>/dev/null || true
    printf "%s" "$TUNNEL_URL" | $VERCEL_CMD env add NEXT_PUBLIC_BACKEND_URL production 2>/dev/null
    if [ $? -eq 0 ]; then
      echo "[$(date)] Vercel env updated. Triggering redeploy..."
      $VERCEL_CMD deploy --prod --yes 2>/dev/null &
      echo "[$(date)] Vercel redeploy triggered in background."
    else
      echo "[$(date)] WARNING: Failed to update Vercel env var."
    fi
    cd "$REPO_DIR"
  else
    echo "[$(date)] WARNING: Vercel project not found at $VERCEL_PROJECT_DIR"
  fi
else
  echo "[$(date)] Tunnel URL unchanged. No notification needed."
fi

echo "[$(date)] LINE Bot is running. PIDs: webhook=$WEBHOOK_PID, tunnel=$TUNNEL_PID"
echo "$WEBHOOK_PID" > "$LOG_DIR/webhook.pid"
echo "$TUNNEL_PID" > "$LOG_DIR/tunnel.pid"
