#!/bin/bash
# voice-bot-daily-summary.sh — Voice Bot の日次サマリーを Discord #dev-log に投稿する
# 毎日 23:30 (JST) に launchd から実行される
#
# 集計対象: /Users/ocmm/rina/logs/voice-chat-bot.log
#   ログにタイムスタンプが含まれないため、現ファイルを全量集計して
#   「当日のサマリー」として投稿する。
#
# 【2026-06-06 変更】異常検知時のみ Discord 投稿、平常時はスキップ
# 異常の定義（以下いずれか1つでも該当したら投稿）:
#   - HANG_COUNT      > 0     （ハング検知）
#   - CRASH_LOOP_COUNT > 0    （クラッシュループ検知）
#   - STT_FAIL_COUNT  > 0     （認識失敗：asking Ryo to repeat）
#   - FTT_P95         >= 35.0 （応答遅延 p95 閾値 35s ← コメントで調整可能）
# 閾値を変更する場合は ALERT_THRESHOLD_P95 の値を書き換える
ALERT_THRESHOLD_P95=35.0

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

# 【2026-06-09 修正】集計範囲を「最後のボット起動マーカー以降」に限定する。
# ログはローテーションなしで全量 append されるため、過去セッションの HANG 等が
# 毎晩カウントされ誤検知が続いていた。起動マーカー以降のみ見ることで
# 現行セッションのメトリクスだけを集計する。
#
# 起動マーカー: "[Bot] Starting voice chat bot"
# マーカーが1つも存在しない場合（ログ内容が想定外）は全量を使い警告を出す。
LIVE_LOG=$(awk '/\[Bot\] Starting voice chat bot/{buf=""; found=1} found{buf=buf $0 ORS} END{printf "%s", buf}' \
    "$LOG_FILE" 2>/dev/null || true)
if [ -z "$LIVE_LOG" ]; then
    echo "[voice-bot-daily-summary] WARNING: 起動マーカーが見つかりません。ログ全量で集計します。" >&2
    LIVE_LOG=$(cat "$LOG_FILE")
fi

# ターン数 (first_text_token の行数 = 1ターン)
TURN_COUNT=$(printf '%s' "$LIVE_LOG" | grep -c "\[Latency\] first_text_token" 2>/dev/null || true)
TURN_COUNT=${TURN_COUNT:-0}

# first_text_token の秒数リスト (数値のみ抽出)
FTT_VALUES=$(printf '%s' "$LIVE_LOG" | grep "\[Latency\] first_text_token" 2>/dev/null \
    | grep -oE "[0-9]+\.[0-9]+s" \
    | grep -oE "[0-9]+\.[0-9]+" \
    2>/dev/null || true)

# STT秒数リスト
STT_VALUES=$(printf '%s' "$LIVE_LOG" | grep "\[Latency\] STT:" 2>/dev/null \
    | grep -oE "STT: [0-9]+\.[0-9]+s" \
    | grep -oE "[0-9]+\.[0-9]+" \
    2>/dev/null || true)

# その他カウント (0件で exit 1 する grep -c を || true で保護)
STT_FAIL_COUNT=$(printf '%s' "$LIVE_LOG" | grep -c "asking Ryo to repeat" 2>/dev/null || true)
STT_FAIL_COUNT=${STT_FAIL_COUNT:-0}
HANG_COUNT=$(printf '%s' "$LIVE_LOG" | grep -c "\[Claude\] HANG detected" 2>/dev/null || true)
HANG_COUNT=${HANG_COUNT:-0}
WRAPPER_BLOCK_COUNT=$(printf '%s' "$LIVE_LOG" | grep -c "\[wrapper\] already running" 2>/dev/null || true)
WRAPPER_BLOCK_COUNT=${WRAPPER_BLOCK_COUNT:-0}
CRASH_LOOP_COUNT=$(printf '%s' "$LIVE_LOG" | grep -c "クラッシュループ検知" 2>/dev/null || true)
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

# --- 異常判定 ---
# bc で浮動小数点比較（FTT_P95 >= ALERT_THRESHOLD_P95）
P95_ALERT=0
if [ -n "$FTT_P95" ] && [ "$FTT_P95" != "0.0" ]; then
    P95_ALERT=$(echo "$FTT_P95 >= $ALERT_THRESHOLD_P95" | bc -l 2>/dev/null || echo 0)
fi

ANOMALY=0
ANOMALY_REASONS=""
if [ "${HANG_COUNT:-0}" -gt 0 ]; then
    ANOMALY=1
    ANOMALY_REASONS="${ANOMALY_REASONS} ハング検知:${HANG_COUNT}回"
fi
if [ "${CRASH_LOOP_COUNT:-0}" -gt 0 ]; then
    ANOMALY=1
    ANOMALY_REASONS="${ANOMALY_REASONS} クラッシュループ:${CRASH_LOOP_COUNT}回"
fi
if [ "${STT_FAIL_COUNT:-0}" -gt 0 ]; then
    ANOMALY=1
    ANOMALY_REASONS="${ANOMALY_REASONS} 認識失敗:${STT_FAIL_COUNT}回"
fi
if [ "${P95_ALERT:-0}" = "1" ]; then
    ANOMALY=1
    ANOMALY_REASONS="${ANOMALY_REASONS} 応答遅延p95:${FTT_P95}s(閾値${ALERT_THRESHOLD_P95}s超)"
fi

# 平常時はスキップ（ログ出力のみ）
if [ "$ANOMALY" = "0" ]; then
    echo "[voice-bot-daily-summary] 平常 — Discord投稿スキップ ($DATE_STR / ターン数:${TURN_COUNT})" >&2
    exit 0
fi

# --- 異常時メッセージ組み立て ---
MESSAGE="**[Voice Bot 異常検知]** ${DATE_STR}
異常:${ANOMALY_REASONS}
ターン数: ${TURN_COUNT}
first_text_token: avg ${FTT_AVG}s / p95 ${FTT_P95}s / max ${FTT_MAX}s
STT 平均: ${STT_AVG}s / 認識失敗: ${STT_FAIL_COUNT}回
ハング検知: ${HANG_COUNT}回 / 多重起動防止: ${WRAPPER_BLOCK_COUNT}回 / クラッシュループ: ${CRASH_LOOP_COUNT}回"

# テストモードはプレフィックスを付ける
if [ "$TEST_MODE" = "1" ]; then
    MESSAGE="[TEST] ${MESSAGE}"
fi

echo "[voice-bot-daily-summary] 異常検知 → Discord投稿:${ANOMALY_REASONS}" >&2
echo "$MESSAGE" >&2

# Discord 投稿
"$DISCORD_POST" "$CHANNEL" "$MESSAGE"

echo "[voice-bot-daily-summary] 完了 ($DATE_STR)" >&2
