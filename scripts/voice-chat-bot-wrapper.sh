#!/bin/bash
set -eu

PIDFILE=/tmp/voice-chat-bot.pid
COUNT_FILE=/tmp/voice-chat-bot.crash_count
LAST_FILE=/tmp/voice-chat-bot.crash_last
PYTHON_BIN=/opt/homebrew/bin/python3.13
BOT_SCRIPT=/Users/ocmm/rina/scripts/voice-chat-bot.py
DISCORD_POST=/Users/ocmm/rina/scripts/discord-post.sh

# (1) 多重起動防止
if [ -f "$PIDFILE" ]; then
    OLD=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
        echo "[wrapper] already running (PID $OLD), exiting" >&2
        exit 0
    fi
    rm -f "$PIDFILE"
fi

# (2) クラッシュループ抑制
NOW=$(date +%s)
LAST=$(cat "$LAST_FILE" 2>/dev/null || echo 0)
COUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
if [ $((NOW - LAST)) -gt 180 ]; then
    COUNT=0
fi
if [ "$COUNT" -ge 5 ]; then
    if [ "${VOICE_BOT_TEST_MODE:-0}" != "1" ]; then
        "$DISCORD_POST" general '**[Voice Bot]** ⚠️ クラッシュループ検知（5分以内に5回連続クラッシュ）。自動再起動を停止しました。手動で `launchctl unload && launchctl load ~/Library/LaunchAgents/com.rina.voice-chat-bot.plist` してください。' || true
    else
        echo "[wrapper] TEST_MODE: skipping Discord notification" >&2
    fi
    rm -f "$PIDFILE" "$COUNT_FILE" "$LAST_FILE"
    exit 0
fi

# カウンタ更新・PIDファイル書き込み
echo $((COUNT + 1)) > "$COUNT_FILE"
echo "$NOW" > "$LAST_FILE"
echo $$ > "$PIDFILE"

# PIDファイルをクリーンアップするトラップ
cleanup() {
    rm -f "$PIDFILE"
}
trap cleanup EXIT

# (3) 本体起動
# テスト用: VOICE_BOT_TEST_MODE=1 ならクラッシュ模擬（exit 1）
if [ "${VOICE_BOT_TEST_MODE:-0}" = "1" ]; then
    echo "[wrapper] TEST_MODE: simulating crash" >&2
    sleep 1
    exit 1
fi

# bot を子プロセスで起動して wait
# exec ではなく & + wait にした理由:
#   本体起動後に本体のPIDをPIDファイルに書き直すため。
#   exec だと wrapper PID のままになり、外部から kill -0 で本体プロセスを確認しづらい。
"$PYTHON_BIN" "$BOT_SCRIPT" &
CHILD=$!
echo "$CHILD" > "$PIDFILE"  # wrapper PID を本体 PID で上書き

# launchctl kickstart -k は wrapper に SIGTERM 送るが、
# wait で background 子プロセスを待ってる場合、子は孤児として残る。
# trap で TERM/INT を受けたら子プロセスも明示的に kill する（再発防止 2026-05-07）
trap 'kill -TERM "$CHILD" 2>/dev/null; wait "$CHILD"' TERM INT

wait "$CHILD"
RC=$?

# bot が正常終了（unload や手動停止）ならカウンタをリセット
if [ "$RC" -eq 0 ]; then
    rm -f "$COUNT_FILE" "$LAST_FILE"
fi

exit "$RC"
