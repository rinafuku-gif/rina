#!/bin/bash
# start-voice-bot.sh — VOICEVOX Engine + Discord Voice Bot 起動スクリプト

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
VOICEVOX_DIR="$REPO_DIR/vendor/voicevox"
VOICEVOX_LOG="$REPO_DIR/logs/voicevox-engine.log"
VOICE_BOT_LOG="$REPO_DIR/logs/voice-chat-bot.log"
PYTHON="/opt/homebrew/bin/python3.13"

# VOICEVOX Engine が起動していなければ起動
if ! curl -s "http://127.0.0.1:50021/speakers" > /dev/null 2>&1; then
    echo "[start] Starting VOICEVOX Engine..."
    if [ -x "$VOICEVOX_DIR/run" ]; then
        nohup "$VOICEVOX_DIR/run" --host 127.0.0.1 --port 50021 > "$VOICEVOX_LOG" 2>&1 &
        echo "[start] VOICEVOX PID: $!"
        # 起動待ち
        for i in $(seq 1 30); do
            if curl -s "http://127.0.0.1:50021/speakers" > /dev/null 2>&1; then
                echo "[start] VOICEVOX Engine ready"
                break
            fi
            sleep 1
        done
    else
        echo "[start] ERROR: VOICEVOX binary not found at $VOICEVOX_DIR/run"
        echo "[start] Please install VOICEVOX first"
        exit 1
    fi
else
    echo "[start] VOICEVOX Engine already running"
fi

# Voice Bot 起動
echo "[start] Starting Discord Voice Bot..."
cd "$REPO_DIR"
export PYTHONUNBUFFERED=1
exec "$PYTHON" "$SCRIPT_DIR/voice-chat-bot.py" 2>&1 | tee "$VOICE_BOT_LOG"
