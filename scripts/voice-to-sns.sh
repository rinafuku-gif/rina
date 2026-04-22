#!/bin/bash
# voice-to-sns.sh — 音声テキスト → SNS投稿案生成 → Discord #sns-drafts 送信 → Obsidian保存
#
# 使い方:
#   echo "今日焙煎したコーヒーが..." | ./voice-to-sns.sh
#   ./voice-to-sns.sh "今日焙煎したコーヒーが..."
#   ./voice-to-sns.sh   # stdinから読む

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CLAUDE_PATH="/Users/Inaryo/.local/bin/claude"

export PATH="/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
unset CLAUDECODE 2>/dev/null || true

# --- .env読み込み ---
if [ -f "$REPO_DIR/.env" ]; then
  source "$REPO_DIR/.env"
fi

DISCORD_BOT_TOKEN=$(grep '^DISCORD_BOT_TOKEN=' "$HOME/.claude/channels/discord/.env" 2>/dev/null | cut -d= -f2-)
DISCORD_SNS_CHANNEL_ID="1486662866026364928"  # #sns-drafts

OBSIDIAN_BASE="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-vault"
OBSIDIAN_RAW_DIR="$OBSIDIAN_BASE/05_リソース/音声ジャーナリング/原文"
OBSIDIAN_SUMMARY_DIR="$OBSIDIAN_BASE/05_リソース/音声ジャーナリング/要約"

TODAY=$(date '+%Y-%m-%d')
NOW=$(date '+%Y-%m-%d %H:%M:%S')

# --- 入力テキスト取得 ---
if [ $# -ge 1 ]; then
  INPUT_TEXT="$1"
else
  INPUT_TEXT=$(cat)
fi

if [ -z "$INPUT_TEXT" ]; then
  echo "ERROR: 入力テキストが空です" >&2
  exit 1
fi

echo "=== voice-to-sns started at $NOW ===" >&2
echo "Input length: ${#INPUT_TEXT} chars" >&2

# --- Step 1: Claude APIでJSONを生成（3チャンネル分 + トピック名） ---
echo "Step 1: Claude APIでコンテンツ生成中..." >&2

PROMPT=$(cat << PROMPT_EOF
あなたはRyo（山梨で複数事業を営む起業家）の代筆者です。
以下の音声入力テキストを元に、3種類のSNSコンテンツを生成してください。

## Ryoの事業
- えんがわ（古民家民泊・ハウススタジオ、山梨県大月市）
- 三十日珈琲（自家焙煎）
- となりにとまる（宿泊施設プロデュース）
- SATOYAMA AI BASE（AIスクール・DX支援）

## 重要ルール
- 入力テキストはRyoの口語体（フィラー・言い直し含む可能性あり）
- Ryoの声のトーンを維持する。AIっぽい整いすぎた文章にしない
- テキストの内容から関連する事業を自動判定してブランドトーンを合わせる
- 事実確認できない情報（数字・固有名詞）は原文のまま使うか削除する
- 各コンテンツは「そのままコピペで使える」クオリティで書く

## 入力テキスト
${INPUT_TEXT}

## 出力形式（JSONのみ。前後に説明文を入れないこと）

\`\`\`json
{
  "topic": "10字以内のトピック名（Obsidianファイル名に使用。記号・スラッシュ不可）",
  "related_business": "えんがわ|三十日珈琲|となりにとまる|SATOYAMA AI BASE|複数",
  "note_article": {
    "title": "note記事タイトル",
    "body": "note記事本文（1500字以内。段落を適切に分ける。マークダウン見出し可）"
  },
  "instagram": {
    "caption": "Instagram投稿文（300字以内）",
    "hashtags": ["ハッシュタグ1", "ハッシュタグ2", "ハッシュタグ3", "ハッシュタグ4", "ハッシュタグ5"]
  },
  "twitter": {
    "text": "X（Twitter）投稿文（140字以内。URLや改行は最小限に）"
  },
  "summary": "原文の要約（200字以内。Obsidianの要約ファイルに使用）"
}
\`\`\`
PROMPT_EOF
)

RESULT_FILE=$(mktemp)
(cd "$REPO_DIR" && echo "$PROMPT" | "$CLAUDE_PATH" -p --dangerously-skip-permissions > "$RESULT_FILE") &
CLAUDE_PID=$!

# 3分タイムアウト
WAIT=180
while [ $WAIT -gt 0 ]; do
  if ! kill -0 $CLAUDE_PID 2>/dev/null; then break; fi
  sleep 5
  WAIT=$((WAIT - 5))
done
if kill -0 $CLAUDE_PID 2>/dev/null; then
  kill $CLAUDE_PID 2>/dev/null; sleep 2; kill -9 $CLAUDE_PID 2>/dev/null
  echo "ERROR: Claude APIタイムアウト" >&2
  rm -f "$RESULT_FILE"
  exit 1
fi

RAW_RESULT=$(cat "$RESULT_FILE" 2>/dev/null)
rm -f "$RESULT_FILE"

if [ -z "$RAW_RESULT" ]; then
  echo "ERROR: Claude APIから出力なし" >&2
  exit 1
fi

# --- JSON抽出 ---
PARSED=$(echo "$RAW_RESULT" | python3 -c "
import sys, json, re
raw = sys.stdin.read()
m = re.search(r'\`\`\`json\s*\n(.*?)\n\s*\`\`\`', raw, re.DOTALL)
candidate = m.group(1) if m else raw.strip()
try:
    data = json.loads(candidate)
    print(json.dumps(data, ensure_ascii=False, indent=2))
except Exception as e:
    sys.stderr.write(f'JSON parse error: {e}\n')
    print('')
" 2>&1)

if [ -z "$PARSED" ]; then
  echo "ERROR: JSONパース失敗。Claude出力:" >&2
  echo "$RAW_RESULT" >&2
  exit 1
fi

echo "Step 1: 完了" >&2

# --- Step 2: 各フィールド取り出し ---
TOPIC=$(echo "$PARSED" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('topic','音声メモ'))" 2>/dev/null)
BUSINESS=$(echo "$PARSED" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('related_business',''))" 2>/dev/null)
SUMMARY=$(echo "$PARSED" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('summary',''))" 2>/dev/null)

NOTE_TITLE=$(echo "$PARSED" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d['note_article']['title'])" 2>/dev/null)
NOTE_BODY=$(echo "$PARSED" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d['note_article']['body'])" 2>/dev/null)

INSTA_CAPTION=$(echo "$PARSED" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d['instagram']['caption'])" 2>/dev/null)
INSTA_TAGS=$(echo "$PARSED" | python3 -c "
import sys,json
d=json.loads(sys.stdin.read())
tags = d['instagram']['hashtags']
print(' '.join('#'+t.lstrip('#') for t in tags))
" 2>/dev/null)

TWITTER_TEXT=$(echo "$PARSED" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d['twitter']['text'])" 2>/dev/null)

# --- Step 3: Obsidianに保存 ---
echo "Step 2: Obsidianに保存中..." >&2

mkdir -p "$OBSIDIAN_RAW_DIR" "$OBSIDIAN_SUMMARY_DIR"

# ファイル名用にトピックをサニタイズ（記号・スペース除去）
SAFE_TOPIC=$(echo "$TOPIC" | tr -d '/:*?"<>|\\' | tr ' ' '_')
RAW_FILE="$OBSIDIAN_RAW_DIR/${TODAY}_${SAFE_TOPIC}.md"
SUMMARY_FILE="$OBSIDIAN_SUMMARY_DIR/${TODAY}_${SAFE_TOPIC}_要約.md"

cat > "$RAW_FILE" << RAW_EOF
---
date: ${TODAY}
topic: ${TOPIC}
business: ${BUSINESS}
type: 音声ジャーナリング
---

# ${TOPIC} — 音声原文

**記録日時:** ${NOW}
**関連事業:** ${BUSINESS}

## 原文（音声入力テキスト）

${INPUT_TEXT}

---

[[${TODAY}_${SAFE_TOPIC}_要約]]
RAW_EOF

cat > "$SUMMARY_FILE" << SUMMARY_EOF
---
date: ${TODAY}
topic: ${TOPIC}
business: ${BUSINESS}
type: 音声ジャーナリング要約
---

# ${TOPIC} — 要約

**記録日時:** ${NOW}
**関連事業:** ${BUSINESS}

## 要約

${SUMMARY}

## 生成コンテンツ

### note記事タイトル
${NOTE_TITLE}

### Instagram（${#INSTA_CAPTION}字）
${INSTA_CAPTION}

${INSTA_TAGS}

### X（Twitter）
${TWITTER_TEXT}

---

[[${TODAY}_${SAFE_TOPIC}|原文を見る]]
SUMMARY_EOF

echo "Step 2: 完了（原文: $RAW_FILE）" >&2

# --- Step 4: Discord #sns-drafts に送信 ---
echo "Step 3: Discord #sns-drafts に送信中..." >&2

if [ -z "$DISCORD_BOT_TOKEN" ]; then
  echo "WARNING: DISCORD_BOT_TOKEN が見つかりません。Discord送信をスキップします" >&2
else
  send_discord() {
    local message="$1"
    local remaining="$message"
    while [ ${#remaining} -gt 0 ]; do
      local chunk="${remaining:0:2000}"
      remaining="${remaining:2000}"
      curl -s -X POST "https://discord.com/api/v10/channels/${DISCORD_SNS_CHANNEL_ID}/messages" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
        -d "$(python3 -c "import json,sys; print(json.dumps({'content': sys.argv[1]}))" "$chunk")" \
        > /dev/null
      [ ${#remaining} -gt 0 ] && sleep 1
    done
  }

  CHAR_COUNT_NOTE=${#NOTE_BODY}
  CHAR_COUNT_INSTA=${#INSTA_CAPTION}
  CHAR_COUNT_TWITTER=${#TWITTER_TEXT}

  DISCORD_MSG="**音声メモ → SNS投稿案** | ${NOW}
**トピック:** ${TOPIC}　**事業:** ${BUSINESS}

━━━━━━━━━━━━━━━━━━━━━━
**[note] ${NOTE_TITLE}**（${CHAR_COUNT_NOTE}字）
━━━━━━━━━━━━━━━━━━━━━━
\`\`\`
${NOTE_BODY}
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━
**[Instagram]**（${CHAR_COUNT_INSTA}字）
━━━━━━━━━━━━━━━━━━━━━━
\`\`\`
${INSTA_CAPTION}

${INSTA_TAGS}
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━
**[X / Twitter]**（${CHAR_COUNT_TWITTER}字）
━━━━━━━━━━━━━━━━━━━━━━
\`\`\`
${TWITTER_TEXT}
\`\`\`

Obsidian保存: \`05_リソース/音声ジャーナリング/\`"

  send_discord "$DISCORD_MSG"
  echo "Step 3: 完了（Discord #sns-drafts 送信済み）" >&2
fi

echo "=== voice-to-sns 完了 at $(date '+%Y-%m-%d %H:%M:%S') ===" >&2
echo "トピック: $TOPIC"
echo "関連事業: $BUSINESS"
echo "Obsidian原文: $RAW_FILE"
echo "Obsidian要約: $SUMMARY_FILE"
