#!/bin/bash
# LINE Bot 停止スクリプト
pkill -f "line-webhook-server.js" 2>/dev/null && echo "Webhook server stopped" || echo "Webhook server not running"
pkill -f "cloudflared tunnel" 2>/dev/null && echo "Cloudflare Tunnel stopped" || echo "Tunnel not running"
