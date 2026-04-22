#!/bin/bash
# voice-pipeline.sh — 音声ファイル → 文字起こし → SNS生成 → Discord通知 → Obsidian保存
# フロー: Google Drive監視 → mlx-whisper文字起こし → claude SNS生成 → Discord → Obsidian → アーカイブ

set -uo pipefail

# --- パス定義 ---
VOICE_DIR="/Users/Inaryo/Library/Mobile Documents/com~apple~CloudDocs/音声メモ"
ARCHIVE_DIR="${VOICE_DIR}/処理済み"
OBSIDIAN_VOICE_DIR="/Users/Inaryo/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-vault/05_リソース/音声ジャーナリング"
LOG_DIR="/Users/Inaryo/rina/logs"
LOG_FILE="${LOG_DIR}/voice-pipeline.log"
PROCESSED_LIST="${LOG_DIR}/.processed-voice-files"
VENV_PYTHON="/Users/Inaryo/rina/venv/bin/python3"
CLAUDE_PATH="/Users/Inaryo/.local/bin/claude"
DISCORD_ENV="/Users/Inaryo/.claude/channels/discord/.env"
DISCORD_CHANNEL_ID="1486662866026364928"

export PATH="/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export HOME="/Users/Inaryo"

# --- ログ関数 ---
log() {
  local level="$1"
  local msg="$2"
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[${ts}] [${level}] ${msg}" | tee -a "${LOG_FILE}"
}

# --- 初期化 ---
mkdir -p "${LOG_DIR}" "${ARCHIVE_DIR}"
mkdir -p "${OBSIDIAN_VOICE_DIR}/原文" "${OBSIDIAN_VOICE_DIR}/要約"
touch "${PROCESSED_LIST}"

# --- ファイルが処理済みか確認 ---
is_processed() {
  local filepath="$1"
  grep -qxF "${filepath}" "${PROCESSED_LIST}" 2>/dev/null
}

# --- 処理済みとして記録 ---
mark_processed() {
  local filepath="$1"
  echo "${filepath}" >> "${PROCESSED_LIST}"
}

# --- iCloudファイルをローカルにダウンロード＆安定待ち ---
wait_for_stable() {
  local filepath="$1"

  # iCloudオンデマンドファイルを強制ダウンロード
  if command -v brctl >/dev/null 2>&1; then
    brctl download "${filepath}" 2>/dev/null
  fi

  # ローカルコピーを作ってから処理（iCloudロック回避）
  local tmpfile="${LOG_DIR}/.tmp_audio_$(date +%s).wav"
  local attempts=0
  while [ ${attempts} -lt 12 ]; do
    if cp "${filepath}" "${tmpfile}" 2>/dev/null; then
      local fsize
      fsize=$(stat -f%z "${tmpfile}" 2>/dev/null || echo 0)
      if [ "${fsize}" -gt 0 ]; then
        echo "${tmpfile}"
        return 0
      fi
      rm -f "${tmpfile}"
    fi
    attempts=$((attempts + 1))
    log "INFO" "iCloud同期待ち... (${attempts}/12)"
    sleep 5
  done
  rm -f "${tmpfile}"
  return 1
}

# --- ファイル名からトピック名を生成 ---
make_topic_from_text() {
  local text="$1"
  # 冒頭30文字を取得、ファイル名不可文字を除去
  echo "${text}" | head -c 60 | tr -d '[:punct:]' | tr '/' '-' | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-30 | sed 's/ *$//'
}

# --- Discord送信（2000文字チャンク分割対応） ---
send_discord() {
  local message="$1"
  local bot_token=""

  if [ -f "${DISCORD_ENV}" ]; then
    bot_token=$(grep '^DISCORD_BOT_TOKEN=' "${DISCORD_ENV}" | cut -d= -f2)
  fi

  if [ -z "${bot_token}" ]; then
    log "ERROR" "DISCORD_BOT_TOKEN が見つかりません: ${DISCORD_ENV}"
    return 1
  fi

  local remaining="${message}"
  local sent=0

  while [ ${#remaining} -gt 0 ]; do
    local chunk="${remaining:0:2000}"
    remaining="${remaining:2000}"

    local response
    response=$(curl -s -w "\n%{http_code}" -X POST \
      "https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bot ${bot_token}" \
      -d "$(python3 -c "import json,sys; print(json.dumps({'content': sys.argv[1]}))" "${chunk}")" 2>/dev/null)

    local http_code
    http_code=$(echo "${response}" | tail -1)

    if [ "${http_code}" = "200" ] || [ "${http_code}" = "201" ]; then
      sent=$((sent + 1))
    else
      log "WARN" "Discord送信失敗 HTTP=${http_code}"
    fi

    [ ${#remaining} -gt 0 ] && sleep 1
  done

  [ "${sent}" -gt 0 ] && return 0 || return 1
}

# --- 1ファイルを処理するメイン関数 ---
process_file() {
  local audio_file="$1"
  local filename
  filename=$(basename "${audio_file}")
  local today
  today=$(date '+%Y-%m-%d')

  log "INFO" "処理開始: ${filename}"

  # 1. iCloudからローカルコピーを取得（ロック回避）
  local local_copy
  local_copy=$(wait_for_stable "${audio_file}")
  if [ -z "${local_copy}" ] || [ ! -f "${local_copy}" ]; then
    log "WARN" "ファイル取得失敗（iCloud同期未完了？）: ${filename}"
    return 1
  fi

  # 2. mlx-whisper で文字起こし（ローカルコピーを使用）
  log "INFO" "文字起こし開始: ${filename}"
  local transcribed=""
  transcribed=$(${VENV_PYTHON} -c "
import mlx_whisper, sys
try:
    result = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo='mlx-community/whisper-large-v3-turbo')
    print(result['text'])
except Exception as e:
    print(f'ERROR: {e}', file=sys.stderr)
    sys.exit(1)
" "${local_copy}" 2>>"${LOG_FILE}")

  local whisper_exit=$?
  rm -f "${local_copy}"
  if [ ${whisper_exit} -ne 0 ] || [ -z "${transcribed}" ]; then
    log "ERROR" "文字起こし失敗: ${filename}"
    return 1
  fi

  log "INFO" "文字起こし完了: ${#transcribed}文字"

  # 2.5. タスクマーカー検出 → Notion投入ルート
  if echo "${transcribed}" | head -c 200 | grep -qE '^[[:space:]]*(タスク|ToDo|TODO|todo|やること|やる事|task|Task|TASK)[[:space:]]*[:：]'; then
    log "INFO" "タスクマーカー検出 — Notion投入"
    local inject_script="$(dirname "$0")/notion-task-inject.js"
    local inject_result
    if inject_result=$(node "${inject_script}" "${transcribed}" 2>>"${LOG_FILE}"); then
      log "INFO" "Notion投入成功: ${inject_result}"
      # 音声原文だけObsidianに残す（SNS生成はスキップ）
      local task_topic
      task_topic=$(echo "${transcribed}" | head -1 | sed 's/[:：].*$//' | head -c 30)
      mkdir -p "${OBSIDIAN_VOICE_DIR}/タスク入力"
      local task_raw="${OBSIDIAN_VOICE_DIR}/タスク入力/${today}_$(date +%H%M%S)_${task_topic}.md"
      cat > "${task_raw}" << TASK_RAW
---
date: ${today}
source: 音声メモ（タスク）
file: ${filename}
type: タスク入力
---

# Notionタスク投入

\`\`\`json
${inject_result}
\`\`\`

## 原文

${transcribed}
TASK_RAW
      mark_processed "${audio_file}"
      mv "${audio_file}" "${ARCHIVE_DIR}/" 2>/dev/null
      log "INFO" "タスク処理完了: ${filename}"
      return 0
    else
      log "ERROR" "Notion投入失敗 — SNSルートにフォールバック"
    fi
  fi

  # 3. トピック名生成
  local topic
  topic=$(make_topic_from_text "${transcribed}")
  [ -z "${topic}" ] && topic="音声メモ"

  # 4. Obsidianに原文保存
  local obsidian_raw="${OBSIDIAN_VOICE_DIR}/原文/${today}_${topic}.md"
  cat > "${obsidian_raw}" << OBSIDIAN_RAW
---
date: ${today}
source: 音声メモ
file: ${filename}
type: 音声文字起こし
---

# ${topic}

${transcribed}
OBSIDIAN_RAW

  log "INFO" "Obsidian原文保存: ${obsidian_raw}"

  # 5. Claude Code で SNS3種生成
  log "INFO" "SNS生成開始 (claude -p)"

  local sns_prompt
  sns_prompt=$(cat << PROMPT
以下の音声文字起こしテキストから、3種類のSNS投稿案を生成してください。

【出力形式】JSON（他は何も出力しないこと）
{
  "topic": "トピック名（10字以内）",
  "note": "note記事本文（1500字以内）",
  "instagram": "Instagram投稿文（300字以内、ハッシュタグ5個含む）",
  "x": "X投稿（140字以内）"
}

【Ryoの文体の特徴（必ず再現する）】
- 言い切らない。「〜な気がする」「〜かもしれない」「〜なんですよね」で終わる
- 括弧で補足を入れる（本当に）（まだ全然だけど）
- 思考の流れがそのまま見える。整理しすぎない
- 不完全な構造。きれいにまとめない
- 自虐や正直さが入る。「正直わからないけど」「大したことじゃないんですが」
- 「。」で終わる断定文を連続させない

【note記事のルール】
- noteでウケる文体で書く。一次情報・体験の記録として書く
- 冒頭で「何の話か」を1行で伝える（深津フォーマット）
- 本文は体験→気づき→考えたことの順。教える口調ではなく、考えている過程を見せる
- 「〜だと思う」「〜してみた」など、等身大の語り口
- 改行を多めに入れて読みやすく。1段落3行以内
- まとめは「結論」ではなく「今思っていること」で締める
- AIが書いた感じの整いすぎた文章は絶対にNG

【共通ルール】
- フィラー（えー、あのー、えっと）は自然に除去する
- 事業名が出たら、そのブランドのトーンに合わせる
- 事実確認できない数字や固有情報は入れない
- instagram: 改行多め、読みやすく、ハッシュタグは末尾にまとめる
- x: 体験ベースで書く。言い切り型OK（Xは短いので）

【文字起こしテキスト】
${transcribed}
PROMPT
)

  local sns_result=""
  sns_result=$(echo "${sns_prompt}" | "${CLAUDE_PATH}" -p --dangerously-skip-permissions 2>>"${LOG_FILE}")
  local claude_exit=$?

  if [ ${claude_exit} -ne 0 ] || [ -z "${sns_result}" ]; then
    log "ERROR" "claude -p 失敗 (exit=${claude_exit})"
    return 1
  fi

  # JSONを抽出
  local sns_json=""
  sns_json=$(echo "${sns_result}" | python3 -c "
import sys, json, re
raw = sys.stdin.read()
# コードブロック内を優先
m = re.search(r'\`\`\`(?:json)?\s*\n(.*?)\n?\s*\`\`\`', raw, re.DOTALL)
candidate = m.group(1) if m else raw.strip()
try:
    data = json.loads(candidate)
    print(json.dumps(data, ensure_ascii=False, indent=2))
except Exception as e:
    print('', end='')
" 2>/dev/null)

  if [ -z "${sns_json}" ]; then
    log "WARN" "JSON解析失敗、rawテキストをそのまま使用"
    sns_json="{}"
  fi

  # topic取得（JSON内のtopicがあれば上書き）
  local sns_topic
  sns_topic=$(echo "${sns_json}" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get('topic', ''))
except: print('')
" 2>/dev/null)
  [ -n "${sns_topic}" ] && topic="${sns_topic}"

  log "INFO" "SNS生成完了: topic=${topic}"

  # 6. Discord #sns-drafts に通知
  local note_text instagram_text x_text
  note_text=$(echo "${sns_json}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('note','（生成失敗）'))" 2>/dev/null)
  instagram_text=$(echo "${sns_json}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('instagram','（生成失敗）'))" 2>/dev/null)
  x_text=$(echo "${sns_json}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('x','（生成失敗）'))" 2>/dev/null)

  local discord_msg
  discord_msg="**音声メモ → SNS投稿案** (${today})
トピック: **${topic}**
元ファイル: \`${filename}\`

---

**note（最大1500字）**
${note_text}"

  send_discord "${discord_msg}" && log "INFO" "Discord送信完了 (note)" || log "WARN" "Discord送信失敗 (note)"
  sleep 1

  send_discord "**Instagram投稿案**
${instagram_text}" && log "INFO" "Discord送信完了 (instagram)" || log "WARN" "Discord送信失敗 (instagram)"
  sleep 1

  send_discord "**X（Twitter）投稿案**
${x_text}" && log "INFO" "Discord送信完了 (x)" || log "WARN" "Discord送信失敗 (x)"

  # 7. Obsidianに要約保存
  local obsidian_summary="${OBSIDIAN_VOICE_DIR}/要約/${today}_${topic}_要約.md"
  cat > "${obsidian_summary}" << OBSIDIAN_SUMMARY
---
date: ${today}
source: 音声メモ
file: ${filename}
type: SNS投稿案
raw: [[${today}_${topic}]]
---

# ${topic} — 投稿案

## note

${note_text}

---

## Instagram

${instagram_text}

---

## X

${x_text}
OBSIDIAN_SUMMARY

  log "INFO" "Obsidian要約保存: ${obsidian_summary}"

  # 8. 処理済みファイルをアーカイブ
  local archive_dest="${ARCHIVE_DIR}/${today}_${filename}"
  mv "${audio_file}" "${archive_dest}" && log "INFO" "アーカイブ完了: ${archive_dest}" || log "WARN" "アーカイブ失敗: ${audio_file}"

  # 9. 処理済みとして記録
  mark_processed "${audio_file}"

  log "INFO" "処理完了: ${filename} → topic=${topic}"
  return 0
}

# --- 新規ファイルをスキャンして処理 ---
scan_and_process() {
  local found=0
  while IFS= read -r -d '' audio_file; do
    if is_processed "${audio_file}"; then
      continue
    fi
    found=1
    process_file "${audio_file}" || log "ERROR" "処理失敗: ${audio_file}"
  done < <(find "${VOICE_DIR}" -maxdepth 1 \( -name "*.m4a" -o -name "*.mp3" -o -name "*.wav" -o -name "*.caf" -o -name "*.mp4" \) -print0 2>/dev/null)

  return 0
}

# --- メイン: fswatch or ポーリング ---
log "INFO" "voice-pipeline 起動"
log "INFO" "監視対象: ${VOICE_DIR}"

# 起動時に既存ファイルをスキャン
scan_and_process

if command -v fswatch >/dev/null 2>&1; then
  log "INFO" "fswatch モードで監視開始"
  fswatch -0 --event Created --event Renamed --event MovedTo \
    --include '\.m4a$' --include '\.mp3$' --include '\.wav$' --include '\.caf$' --include '\.mp4$' \
    --exclude '/処理済み/' \
    "${VOICE_DIR}" | while IFS= read -r -d '' event_file; do

    log "INFO" "fswatch イベント検知: ${event_file}"

    # 「処理済み」サブフォルダへの移動イベントは無視
    if echo "${event_file}" | grep -q '処理済み'; then
      continue
    fi

    # 対象拡張子のみ処理
    case "${event_file}" in
      *.m4a|*.mp3|*.wav|*.caf|*.mp4)
        if ! is_processed "${event_file}"; then
          process_file "${event_file}" || log "ERROR" "処理失敗: ${event_file}"
        fi
        ;;
    esac
  done
else
  # フォールバック: 30秒間隔ポーリング
  log "WARN" "fswatch が見つかりません。ポーリングモードで監視します（30秒間隔）"
  while true; do
    scan_and_process
    sleep 30
  done
fi
