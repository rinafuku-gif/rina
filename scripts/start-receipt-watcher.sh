#!/bin/bash
# receipt-watcher 起動スクリプト
# LaunchAgentではなくこのスクリプトで起動する（Drive File Providerのアクセス権限のため）

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$REPO_DIR/logs"

# 既存プロセスを停止
pkill -f "receipt-watcher.js" 2>/dev/null || true
sleep 1

# LaunchAgentが残っていたら停止
launchctl bootout gui/$(id -u)/com.rina.receipt-watcher 2>/dev/null || true

echo "[$(date)] Starting receipt-watcher..."
cd "$REPO_DIR"
nohup node "$SCRIPT_DIR/receipt-watcher.js" >> "$LOG_DIR/receipt-watcher-stdout.log" 2>> "$LOG_DIR/receipt-watcher-stderr.log" &
WATCHER_PID=$!
echo "[$(date)] receipt-watcher PID: $WATCHER_PID"
echo "$WATCHER_PID" > "$LOG_DIR/receipt-watcher.pid"
