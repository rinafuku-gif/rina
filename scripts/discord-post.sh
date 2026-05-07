#!/bin/bash
# discord-post.sh — Discordチャンネルにメッセージを投稿する汎用スクリプト
# 使い方:
#   discord-post.sh dev-log "デプロイ完了: satoyama-ai-base v1.2.3"
#   discord-post.sh audit "レビュー結果: LGTM (4/4/3/4)"
#   discord-post.sh reports "タスク完了: リール動画生成パイプライン"
#   discord-post.sh <channel_id> "直接ID指定も可能"

set -o pipefail

DISCORD_BOT_TOKEN=$(grep '^DISCORD_BOT_TOKEN=' "$HOME/.claude/channels/discord/.env" 2>/dev/null | cut -d= -f2)

if [ -z "$DISCORD_BOT_TOKEN" ]; then
  echo "Error: DISCORD_BOT_TOKEN not found" >&2
  exit 1
fi

# チャンネル名 → ID マッピング（bash 3.2互換）
resolve_channel() {
  case "$1" in
    dev-log)       echo "1486651108222046228" ;;
    audit)         echo "1486651109744578570" ;;
    reports)       echo "1486651098755371088" ;;
    notifications) echo "1486651097157472307" ;;
    general)       echo "1486651095580282942" ;;
    ai-news)       echo "1487033122888613939" ;;
    sns-drafts)    echo "1486662866026364928" ;;
    finance)       echo "1487350270630297701" ;;
    trading)       echo "1491998794487693343" ;;
    *)             echo "$1" ;;  # IDがそのまま渡された場合
  esac
}

CHANNEL_ARG="${1:-}"
MESSAGE="${2:-}"

if [ -z "$CHANNEL_ARG" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: discord-post.sh <channel-name|channel-id> <message>" >&2
  echo "Channels: dev-log audit reports notifications general ai-news sns-drafts finance trading" >&2
  exit 1
fi

CHANNEL_ID=$(resolve_channel "$CHANNEL_ARG")

# 2000文字制限対応
REMAINING="$MESSAGE"
while [ ${#REMAINING} -gt 0 ]; do
  CHUNK="${REMAINING:0:2000}"
  REMAINING="${REMAINING:2000}"
  curl -sf -X POST "https://discord.com/api/v10/channels/$CHANNEL_ID/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -H "User-Agent: DiscordBot (https://github.com/inaryo1024/voice-chat-bot, 1.0)" \
    -d "$(jq -n --arg text "$CHUNK" '{content: $text}')" > /dev/null
  [ ${#REMAINING} -gt 0 ] && sleep 1
done

exit 0
