#!/bin/bash
# SNS投稿案 自動生成スクリプト
# 各アカウントのブランド設定を読み込み、claude -p で投稿案を生成
# 使い方:
#   ./sns-generate.sh                    # 全アカウント
#   ./sns-generate.sh ryosuke_ina        # 特定アカウント
#   ./sns-generate.sh --send             # 全アカウント + LINE送信
#   ./sns-generate.sh misoca_coffee --send  # 特定 + LINE送信

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
BRANDS_DIR="$REPO_DIR/config/sns-brands"
LOG_DIR="$REPO_DIR/logs"
OUTPUT_DIR="$LOG_DIR/.sns-drafts"
CLAUDE_PATH="/Users/Inaryo/.local/bin/claude"

export PATH="/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
unset CLAUDECODE 2>/dev/null || true
source "$REPO_DIR/.env"

mkdir -p "$OUTPUT_DIR"

# --- 引数パース ---
TARGET_ACCOUNT=""
SEND_LINE=false
EXTRA_CONTEXT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --send) SEND_LINE=true ;;
    --theme) shift; EXTRA_CONTEXT="テーマ指定: $1" ;;
    --context) shift; EXTRA_CONTEXT="$1" ;;
    *) TARGET_ACCOUNT="$1" ;;
  esac
  shift
done
export EXTRA_CONTEXT

# --- 季節・天気・日付コンテキスト ---
TODAY=$(date '+%Y-%m-%d')
DOW=$(date '+%A')
MONTH=$(date '+%-m')

get_season() {
  case $MONTH in
    3|4|5) echo "春" ;;
    6|7|8) echo "夏" ;;
    9|10|11) echo "秋" ;;
    12|1|2) echo "冬" ;;
  esac
}
SEASON=$(get_season)

# 二十四節気の目安
get_sekki() {
  local md=$(date '+%-m%d')
  case $md in
    2[0-3][0-9]|30[0-4]) echo "雨水" ;;
    30[5-9]|31[0-9]|320) echo "啓蟄" ;;
    32[1-9]|33[0-9]|40[0-4]) echo "春分" ;;
    40[5-9]|41[0-9]|419) echo "清明" ;;
    4[2-9][0-9]|50[0-5]) echo "穀雨" ;;
    50[6-9]|51[0-9]|52[0-1]) echo "立夏" ;;
    *) echo "" ;;
  esac
}
SEKKI=$(get_sekki)

CONTEXT_BLOCK="## 日付・季節コンテキスト
- 今日: ${TODAY} (${DOW})
- 季節: ${SEASON}
- 二十四節気: ${SEKKI:-（該当なし）}
- 山梨の気候メモ: ${SEASON}の山梨、標高300-400m地帯"

# --- アカウント一覧 ---
get_accounts() {
  if [ -n "$TARGET_ACCOUNT" ]; then
    echo "$TARGET_ACCOUNT"
  else
    # README.md からアカウント名を抽出（_template除外）
    for f in "$BRANDS_DIR"/*.md; do
      local name=$(basename "$f" .md)
      if [ "$name" != "README" ] && [ "$name" != "_template" ]; then
        echo "$name"
      fi
    done
  fi
}

# --- 1アカウント分の投稿案を生成 ---
generate_for_account() {
  local account="$1"
  local brand_file="$BRANDS_DIR/${account}.md"

  if [ ! -f "$brand_file" ]; then
    echo "Brand file not found: $brand_file" >&2
    return 1
  fi

  local brand_config
  brand_config=$(cat "$brand_file")

  # 最近の投稿案（重複防止用）
  local recent_file="$OUTPUT_DIR/${account}-latest.json"
  local recent_topics=""
  if [ -f "$recent_file" ]; then
    recent_topics=$(python3 -c "
import json, sys
try:
    data = json.load(open('$recent_file'))
    topics = [p.get('topic','') for p in data.get('posts',[])]
    print('\n'.join(topics))
except: pass
" 2>/dev/null)
  fi

  # プロンプト組み立て
  local prompt_file
  prompt_file=$(mktemp)

  # テーマ・コンテキスト追加情報
  local extra_context="${EXTRA_CONTEXT:-}"
  local photo_path="${PHOTO_PATH:-}"

  # 写真が添付されている場合、先にClaude Visionで分析
  local photo_context=""
  if [ -n "$photo_path" ] && [ -f "$photo_path" ]; then
    echo "  Analyzing photo: $photo_path" >&2
    local photo_prompt
    photo_prompt=$(mktemp)
    cat > "$photo_prompt" << PHOTO_PROMPT
この写真の内容を詳細に説明してください。以下の観点で分析してください:
- 何が写っているか（被写体、場所、人物、物）
- 雰囲気・トーン（明るい、暗い、温かい、静か等）
- 色味や光の特徴
- Instagram投稿として使う場合のポイント
写真のファイルパス: $photo_path
PHOTO_PROMPT
    photo_context=$(cd "$REPO_DIR" && cat "$photo_prompt" | "$CLAUDE_PATH" -p --dangerously-skip-permissions 2>/dev/null)
    rm -f "$photo_prompt"
    if [ -n "$photo_context" ]; then
      extra_context="${extra_context}
## 添付写真の分析結果
${photo_context}
この写真に合ったキャプションを1件目に生成すること。写真の内容を踏まえつつ、アカウントの文体で書く。"
    fi
  fi

  cat > "$prompt_file" << PROMPT_END
あなたはInstagram投稿のゴーストライター（代筆者）です。
このアカウントの「中の人」になりきって、その人が実際に書いたとしか思えないキャプションを書いてください。

## 最重要ルール: 文体の差別化

各アカウントは別の「人格」です。ブランド設定内の「参考投稿例」「文体の特徴」を最優先で参考にしてください。
- 参考投稿例があるなら、その語尾・リズム・改行パターン・言葉選びを徹底的に模倣すること
- 「AIが書いた感」を排除すること。過度に詩的・文学的な表現は避ける
- 実際の人間が書くような、ちょっとした言い淀み・日常感・不完全さを大事にする
- 「〜のかもしれない」「〜だったりする」「〜な気がする」のような曖昧な語尾は、ブランド設定で使われている場合のみ使う
- 全てのアカウントで同じ「きれいな文体」にならないこと。これが最も重要

## 避けるべき表現パターン
- 「○○の頃、□□が△△する」のような季語的な書き出しの連発
- 五感に訴える描写の過剰使用（「光」「風」「香り」を毎回使わない）
- 全投稿を内省・エッセイ調にしない（事業アカウントは情報伝達が主）
- 「ここに来れば〜がある」式のコピーライティング調の締め

${CONTEXT_BLOCK}

## ブランド設定
${brand_config}

## 最近生成した投稿のトピック（重複を避けること）
${recent_topics:-（なし — 初回生成）}

${extra_context:+## 追加コンテキスト（ユーザー指定）
$extra_context}

## 出力JSON形式（これ以外は出力しないこと）

\`\`\`json
{
  "account": "${account}",
  "generated_at": "${TODAY}",
  "posts": [
    {
      "type": "carousel|reel|single|story",
      "topic": "投稿テーマ（10字以内）",
      "caption": "実際に投稿するキャプション全文。ハッシュタグ含む",
      "visual_direction": "写真/デザインの方向性。Canvaやカメラでどう撮る/作るかの具体的な指示",
      "slide_texts": ["カルーセルの場合、各スライドのテキスト内容"],
      "content_pillar": "コンテンツの柱のうちどれに該当するか",
      "best_time": "投稿推奨時間帯（例: 平日12:00-13:00）",
      "priority": "high|medium|low",
      "alt_text": "Instagramの代替テキスト。画像の内容を具体的に説明。検索露出に影響するためキーワードを自然に含める。100字程度"
    }
  ],
  "weekly_plan_note": "今週の投稿バランスについての一言アドバイス"
}
\`\`\`

## ルール
- キャプションはそのままコピペで投稿できるクオリティで書くこと
- ブランド設定の「参考投稿例」の文体を最優先で模倣すること
- ブランド設定の「NGルール」を厳守すること
- 3件の投稿は「コンテンツの柱」からバランスよく選ぶこと
- type: そのアカウントに合った投稿形式を選ぶ
- carousel の場合は slide_texts に各スライドの内容を入れる
- single/reel の場合は slide_texts は空配列 []
- alt_text: carousel の場合は1枚目を想定した代替テキスト
- 出力は\`\`\`jsonブロック内のJSONのみ。前後に説明文を入れないこと
PROMPT_END

  # Claude実行
  local result_file
  result_file=$(mktemp)

  (cd "$REPO_DIR" && cat "$prompt_file" | "$CLAUDE_PATH" -p --dangerously-skip-permissions > "$result_file") &
  local claude_pid=$!

  # 3分タイムアウト
  local wait=180
  while [ $wait -gt 0 ]; do
    if ! kill -0 $claude_pid 2>/dev/null; then break; fi
    sleep 5
    wait=$((wait - 5))
  done
  if kill -0 $claude_pid 2>/dev/null; then
    kill $claude_pid 2>/dev/null; sleep 2; kill -9 $claude_pid 2>/dev/null
    echo "Timeout for $account" >&2
    rm -f "$result_file" "$prompt_file"
    return 1
  fi

  local raw_result
  raw_result=$(cat "$result_file" 2>/dev/null)
  rm -f "$result_file" "$prompt_file"

  if [ -z "$raw_result" ]; then
    echo "No output for $account" >&2
    return 1
  fi

  # JSON抽出
  local parsed
  parsed=$(echo "$raw_result" | python3 -c "
import sys, json, re
raw = sys.stdin.read()
m = re.search(r'\`\`\`json\s*\n(.*?)\n\s*\`\`\`', raw, re.DOTALL)
candidate = m.group(1) if m else raw.strip()
try:
    data = json.loads(candidate)
    print(json.dumps(data, ensure_ascii=False, indent=2))
except:
    print('')
" 2>/dev/null)

  if [ -z "$parsed" ]; then
    echo "Failed to parse JSON for $account" >&2
    return 1
  fi

  # 保存
  echo "$parsed" > "$OUTPUT_DIR/${account}-latest.json"
  echo "$parsed" > "$OUTPUT_DIR/${account}-${TODAY}.json"

  echo "$parsed"
}

# --- LINE送信用のサマリーを作成 ---
format_for_line() {
  local json_data="$1"
  python3 -c "
import json, sys

data = json.loads(sys.stdin.read())
account = data.get('account', '?')
posts = data.get('posts', [])
note = data.get('weekly_plan_note', '')

lines = [f'📱 @{account} 投稿案 ({len(posts)}件)']
lines.append('')

for i, p in enumerate(posts, 1):
    ptype = p.get('type', 'single')
    topic = p.get('topic', '')
    priority = p.get('priority', 'medium')
    best_time = p.get('best_time', '')
    pillar = p.get('content_pillar', '')

    pri_icon = {'high': '🔴', 'medium': '🟡', 'low': '🟢'}.get(priority, '⚪')

    lines.append(f'{pri_icon} [{i}] {topic}')
    lines.append(f'   形式: {ptype} | 柱: {pillar}')
    lines.append(f'   推奨: {best_time}')

    # キャプション冒頭3行
    caption = p.get('caption', '')
    cap_lines = caption.split('\n')[:3]
    preview = '\n   '.join(cap_lines)
    lines.append(f'   ---')
    lines.append(f'   {preview}')
    if len(caption.split('\n')) > 3:
        lines.append(f'   ...(続きはしらたまで確認)')
    lines.append('')

if note:
    lines.append(f'💡 {note}')

print('\n'.join(lines))
" <<< "$json_data"
}

# --- メイン処理 ---
echo "=== SNS Generate started at $(date '+%Y-%m-%d %H:%M:%S') ===" >&2

ALL_RESULTS=""
ALL_LINE_MSG=""

for account in $(get_accounts); do
  echo "Generating for @${account}..." >&2

  result=$(generate_for_account "$account" 2>&1)
  exit_code=$?

  if [ $exit_code -eq 0 ] && [ -n "$result" ]; then
    echo "  -> OK (saved to $OUTPUT_DIR/${account}-${TODAY}.json)" >&2

    line_msg=$(format_for_line "$result")
    ALL_LINE_MSG="${ALL_LINE_MSG}${line_msg}\n\n"
    ALL_RESULTS="${ALL_RESULTS}${result}\n---\n"
  else
    echo "  -> FAILED: $result" >&2
  fi
done

# --- LINE送信（Discord移行前・ロールバック用） ---
# if [ "$SEND_LINE" = true ] && [ -n "$ALL_LINE_MSG" ]; then
#   echo "Sending summary to LINE..." >&2
#   FINAL_MSG="📝 SNS投稿案が届きました！\n\n$(echo -e "$ALL_LINE_MSG")"
#   MSG_LEN=$(echo -e "$FINAL_MSG" | wc -c | tr -d ' ')
#   if [ "$MSG_LEN" -le 4500 ]; then
#     curl -s -X POST https://api.line.me/v2/bot/message/push \
#       -H "Content-Type: application/json" \
#       -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
#       -d "$(jq -n --arg to "$LINE_USER_ID" --arg text "$(echo -e "$FINAL_MSG")" '{
#         to: $to, messages: [{type: "text", text: $text}]
#       }')" && echo "  -> LINE sent" >&2
#   else
#     for account in $(get_accounts); do
#       local_file="$OUTPUT_DIR/${account}-${TODAY}.json"
#       if [ -f "$local_file" ]; then
#         local_msg=$(format_for_line "$(cat "$local_file")")
#         curl -s -X POST https://api.line.me/v2/bot/message/push \
#           -H "Content-Type: application/json" \
#           -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
#           -d "$(jq -n --arg to "$LINE_USER_ID" --arg text "$local_msg" '{
#             to: $to, messages: [{type: "text", text: $text}]
#           }')"
#         sleep 1
#       fi
#     done
#     echo "  -> LINE sent (split)" >&2
#   fi
# fi

# --- Discord #sns-drafts 送信 ---
DISCORD_BOT_TOKEN=$(grep '^DISCORD_BOT_TOKEN=' "$HOME/.claude/channels/discord/.env" 2>/dev/null | cut -d= -f2)
DISCORD_SNS_CHANNEL_ID="1486662866026364928"  # #sns-drafts

if [ "$SEND_LINE" = true ] && [ -n "$ALL_LINE_MSG" ] && [ -n "$DISCORD_BOT_TOKEN" ]; then
  echo "Sending summary to Discord #sns-drafts..." >&2

  FINAL_MSG="📝 SNS投稿案が届きました！\n\n$(echo -e "$ALL_LINE_MSG")"

  # Discord 2000文字制限対応: チャンク分割送信
  REMAINING="$(echo -e "$FINAL_MSG")"
  while [ ${#REMAINING} -gt 0 ]; do
    CHUNK="${REMAINING:0:2000}"
    REMAINING="${REMAINING:2000}"
    curl -s -X POST "https://discord.com/api/v10/channels/$DISCORD_SNS_CHANNEL_ID/messages" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
      -d "$(jq -n --arg text "$CHUNK" '{content: $text}')"
    [ ${#REMAINING} -gt 0 ] && sleep 1
  done
  echo "  -> Discord #sns-drafts sent" >&2
elif [ "$SEND_LINE" = true ] && [ -z "$DISCORD_BOT_TOKEN" ]; then
  echo "ERROR: DISCORD_BOT_TOKEN not found, skipping send" >&2
fi

# --- 全結果のサマリーをファイルに ---
SUMMARY_FILE="$OUTPUT_DIR/summary-${TODAY}.md"
cat > "$SUMMARY_FILE" << SUMMARY_HEADER
# SNS投稿案サマリー - ${TODAY}

生成日時: $(date '+%Y-%m-%d %H:%M')

SUMMARY_HEADER

for account in $(get_accounts); do
  local_file="$OUTPUT_DIR/${account}-${TODAY}.json"
  if [ -f "$local_file" ]; then
    python3 -c "
import json
data = json.load(open('$local_file'))
account = data.get('account', '')
posts = data.get('posts', [])
note = data.get('weekly_plan_note', '')

print(f'## @{account}')
print()
for i, p in enumerate(posts, 1):
    print(f'### [{i}] {p.get(\"topic\", \"\")} ({p.get(\"type\", \"single\")})')
    print(f'- 柱: {p.get(\"content_pillar\", \"\")}')
    print(f'- 推奨時間: {p.get(\"best_time\", \"\")}')
    print(f'- 優先度: {p.get(\"priority\", \"medium\")}')
    print()
    print('**キャプション:**')
    print('> ' + p.get('caption', '').replace('\n', '\n> '))
    print()
    print(f'**ビジュアル方向性:** {p.get(\"visual_direction\", \"\")}')
    slides = p.get('slide_texts', [])
    if slides:
        print()
        print('**スライド:**')
        for j, s in enumerate(slides, 1):
            print(f'{j}. {s}')
    print()
    print('---')
    print()

if note:
    print(f'> 💡 {note}')
    print()
" >> "$SUMMARY_FILE" 2>/dev/null
  fi
done

echo "=== SNS Generate completed at $(date '+%Y-%m-%d %H:%M:%S') ===" >&2
echo "Summary: $SUMMARY_FILE" >&2

# 標準出力には全結果のLINEフォーマットを返す（他スクリプトからの呼び出し用）
echo -e "$ALL_LINE_MSG"
