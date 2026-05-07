#!/bin/bash
# voice-bot-daily-summary.sh — Voice Bot の日次サマリーを Discord #dev-log に投稿する
# 毎日 23:30 (JST) に launchd から実行される
#
# 集計対象: /Users/ocmm/rina/logs/voice-chat-bot.log
#   ログにタイムスタンプが含まれないため、現ファイルを全量集計して
#   「当日のサマリー」として投稿する。

set -uo pipefail

LOG_FILE="/Users/ocmm/rina/logs/voice-chat-bot.log"
DISCORD_POST="/Users/ocmm/rina/scripts/discord-post.sh"
CHANNEL="dev-log"
DATE_STR=$(date "+%Y-%m-%d")

# テストモード:
# - LIVE=1 が指定されたとき（launchd 経由）のみ本番投稿
# - それ以外（手動実行）は [TEST] プレフィックス付きで投稿（誤って本番チャンネルを汚さないため）
LIVE_MODE="${LIVE:-0}"
if [ "$LIVE_MODE" = "1" ]; then
    TEST_MODE=0
else
    TEST_MODE=1
fi

# ログファイルが存在しない場合は終了
if [ ! -f "$LOG_FILE" ]; then
    echo "[voice-bot-daily-summary] ログファイルが見つかりません: $LOG_FILE" >&2
    exit 0
fi

# --- 集計処理 ---
# grep -c はマッチ0件で exit 1 を返すため || true で無視する

# ターン数 (first_text_token の行数 = 1ターン)
TURN_COUNT=$(grep -c "\[Latency\] first_text_token" "$LOG_FILE" 2>/dev/null || true)
TURN_COUNT=${TURN_COUNT:-0}

# first_text_token の秒数リスト (数値のみ抽出)
FTT_VALUES=$(grep "\[Latency\] first_text_token" "$LOG_FILE" 2>/dev/null \
    | grep -oE "[0-9]+\.[0-9]+s" \
    | grep -oE "[0-9]+\.[0-9]+" \
    2>/dev/null || true)

# STT秒数リスト
STT_VALUES=$(grep "\[Latency\] STT:" "$LOG_FILE" 2>/dev/null \
    | grep -oE "STT: [0-9]+\.[0-9]+s" \
    | grep -oE "[0-9]+\.[0-9]+" \
    2>/dev/null || true)

# その他カウント (0件で exit 1 する grep -c を || true で保護)
STT_FAIL_COUNT=$(grep -c "asking Ryo to repeat" "$LOG_FILE" 2>/dev/null || true)
STT_FAIL_COUNT=${STT_FAIL_COUNT:-0}
HANG_COUNT=$(grep -c "\[Claude\] HANG detected" "$LOG_FILE" 2>/dev/null || true)
HANG_COUNT=${HANG_COUNT:-0}
WRAPPER_BLOCK_COUNT=$(grep -c "\[wrapper\] already running" "$LOG_FILE" 2>/dev/null || true)
WRAPPER_BLOCK_COUNT=${WRAPPER_BLOCK_COUNT:-0}
CRASH_LOOP_COUNT=$(grep -c "クラッシュループ検知" "$LOG_FILE" 2>/dev/null || true)
CRASH_LOOP_COUNT=${CRASH_LOOP_COUNT:-0}

# awk で avg / p95 / max を計算 — 結果は "avg p95 max" の1行
calc_stats() {
    local values="$1"
    if [ -z "$values" ]; then
        printf "0.0 0.0 0.0"
        return
    fi
    printf '%s\n' "$values" | awk '
    /^[0-9]/ {
        n++
        vals[n] = $1 + 0
        sum += $1 + 0
        if ($1 + 0 > max) max = $1 + 0
    }
    END {
        if (n == 0) {
            printf "0.0 0.0 0.0"
            exit
        }
        avg = sum / n

        # バブルソート (p95算出用)
        for (i = 1; i <= n; i++) {
            for (j = i + 1; j <= n; j++) {
                if (vals[i] > vals[j]) {
                    tmp = vals[i]; vals[i] = vals[j]; vals[j] = tmp
                }
            }
        }

        # p95 インデックス (最低1)
        p95_idx = int(n * 0.95 + 0.5)
        if (p95_idx < 1) p95_idx = 1
        if (p95_idx > n) p95_idx = n

        printf "%.1f %.1f %.1f", avg, vals[p95_idx], max
    }'
}

# first_text_token 統計
FTT_STATS=$(calc_stats "$FTT_VALUES")
FTT_AVG=$(echo "$FTT_STATS" | awk '{print $1}')
FTT_P95=$(echo "$FTT_STATS" | awk '{print $2}')
FTT_MAX=$(echo "$FTT_STATS" | awk '{print $3}')

# STT 平均
STT_STATS=$(calc_stats "$STT_VALUES")
STT_AVG=$(echo "$STT_STATS" | awk '{print $1}')

# --- メッセージ組み立て ---

if [ "${TURN_COUNT:-0}" -eq 0 ]; then
    MESSAGE="**[Voice Bot Daily Summary]** ${DATE_STR}
使用なし（ターン数: 0）"
else
    MESSAGE="**[Voice Bot Daily Summary]** ${DATE_STR}
ターン数: ${TURN_COUNT}
first_text_token: avg ${FTT_AVG}s / p95 ${FTT_P95}s / max ${FTT_MAX}s
STT 平均: ${STT_AVG}s / 認識失敗: ${STT_FAIL_COUNT}回
ハング検知: ${HANG_COUNT}回 / 多重起動防止: ${WRAPPER_BLOCK_COUNT}回 / クラッシュループ: ${CRASH_LOOP_COUNT}回"
fi

# テストモードはプレフィックスを付ける
if [ "$TEST_MODE" = "1" ]; then
    MESSAGE="[TEST] ${MESSAGE}"
fi

echo "[voice-bot-daily-summary] 投稿するメッセージ:" >&2
echo "$MESSAGE" >&2

# Discord 投稿
"$DISCORD_POST" "$CHANNEL" "$MESSAGE"

echo "[voice-bot-daily-summary] 完了 ($DATE_STR)" >&2
