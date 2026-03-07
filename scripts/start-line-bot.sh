#!/bin/bash
# LINE Bot 起動スクリプト
# 1. Webhook サーバーを起動
# 2. Cloudflare Named Tunnel を起動（固定URL: api.tonari2tomaru.com）

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

# Cloudflare Named Tunnel を起動（固定URL）
echo "[$(date)] Starting Cloudflare Named Tunnel..."
TUNNEL_LOG="$LOG_DIR/cloudflared.log"
: > "$TUNNEL_LOG"
cloudflared tunnel run rina-api >> "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
echo "[$(date)] Tunnel PID: $TUNNEL_PID"

WEBHOOK_URL="https://api.tonari2tomaru.com/webhook"
echo "[$(date)] Webhook URL (fixed): $WEBHOOK_URL"

echo "[$(date)] LINE Bot is running. PIDs: webhook=$WEBHOOK_PID, tunnel=$TUNNEL_PID"
echo "$WEBHOOK_PID" > "$LOG_DIR/webhook.pid"
echo "$TUNNEL_PID" > "$LOG_DIR/tunnel.pid"
