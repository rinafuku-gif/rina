#!/bin/bash
# ai-news-daily.sh — AI動向日次レポート
# 毎朝6:00にAIニュースを収集 → Claude要約 → Discord #ai-news + Obsidian保存

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$REPO_DIR/logs"
LOCK_FILE="$LOG_DIR/.ai-news-lock"
TODAY=$(date +%Y-%m-%d)
MONTH=$(date +%Y-%m)

# Discord設定
DISCORD_CHANNEL_ID="1487033122888613939"  # #ai-news
DISCORD_BOT_TOKEN=$(grep '^DISCORD_BOT_TOKEN=' "$HOME/.claude/channels/discord/.env" 2>/dev/null | cut -d= -f2)

# Claude CLI
CLAUDE_PATH="$HOME/.local/share/mise/installs/node/24.14.0/bin/claude"

# Obsidian保存先
OBSIDIAN_DIR="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-vault/05_リソース/AI動向"

# 環境変数クリーン（OAuth認証用）
unset CLAUDECODE 2>/dev/null || true
unset ANTHROPIC_API_KEY 2>/dev/null || true
export PATH="$HOME/.local/share/mise/installs/node/24.14.0/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$LOG_DIR" "$OBSIDIAN_DIR"

# 重複実行防止
if [ -f "$LOCK_FILE" ] && [ "$(cat "$LOCK_FILE")" = "$TODAY" ]; then
  echo "ai-news: Already ran today ($TODAY). Skipping."
  exit 0
fi

echo "ai-news: Starting AI news collection ($TODAY)..." >&2

# ── ニュース収集 ─────────────────────────────────

collect_news() {
  local all_news=""

  # 1. Hacker News — AI関連トップストーリー
  echo "ai-news: Fetching Hacker News..." >&2
  HN_IDS=$(curl -sf "https://hacker-news.firebaseio.com/v0/topstories.json" 2>/dev/null | python3 -c "import json,sys; print(' '.join(str(x) for x in json.load(sys.stdin)[:30]))" 2>/dev/null || echo "")
  HN_NEWS=""
  for id in $HN_IDS; do
    ITEM=$(curl -sf "https://hacker-news.firebaseio.com/v0/item/$id.json" 2>/dev/null || echo "{}")
    TITLE=$(echo "$ITEM" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('title',''))" 2>/dev/null || echo "")
    URL=$(echo "$ITEM" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('url',''))" 2>/dev/null || echo "")
    SCORE=$(echo "$ITEM" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('score',0))" 2>/dev/null || echo "0")
    # AI関連フィルタ
    if echo "$TITLE" | grep -qiE "AI|LLM|GPT|Claude|Anthropic|OpenAI|Gemini|DeepMind|machine learn|neural|transformer|diffusion|AGI|agent"; then
      HN_NEWS="${HN_NEWS}[HN score:${SCORE}] ${TITLE} | ${URL}\n"
    fi
  done
  all_news="${all_news}--- Hacker News ---\n${HN_NEWS}\n"

  # 2. Reddit r/ClaudeAI — Hot posts
  echo "ai-news: Fetching Reddit r/ClaudeAI..." >&2
  REDDIT=$(curl -sf -H "User-Agent: rina-ai-news/1.0" "https://www.reddit.com/r/ClaudeAI/hot.json?limit=10" 2>/dev/null || echo '{"data":{"children":[]}}')
  REDDIT_NEWS=$(echo "$REDDIT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for post in d.get('data',{}).get('children',[])[:10]:
    p=post.get('data',{})
    title=p.get('title','')
    score=p.get('score',0)
    url=f\"https://reddit.com{p.get('permalink','')}\"
    print(f'[Reddit score:{score}] {title} | {url}')
" 2>/dev/null || echo "")
  all_news="${all_news}--- Reddit r/ClaudeAI ---\n${REDDIT_NEWS}\n\n"

  # 3. Anthropic Blog RSS
  echo "ai-news: Fetching Anthropic blog..." >&2
  ANTHROPIC_RSS=$(curl -sf "https://www.anthropic.com/rss.xml" 2>/dev/null || echo "")
  ANTHROPIC_NEWS=$(echo "$ANTHROPIC_RSS" | python3 -c "
import sys, re
xml = sys.stdin.read()
items = re.findall(r'<item>.*?</item>', xml, re.DOTALL)[:5]
for item in items:
    title = re.search(r'<title>(.*?)</title>', item)
    link = re.search(r'<link>(.*?)</link>', item)
    date = re.search(r'<pubDate>(.*?)</pubDate>', item)
    if title:
        t = title.group(1).replace('<![CDATA[','').replace(']]>','')
        l = link.group(1) if link else ''
        d = date.group(1)[:16] if date else ''
        print(f'[Anthropic {d}] {t} | {l}')
" 2>/dev/null || echo "")
  all_news="${all_news}--- Anthropic Blog ---\n${ANTHROPIC_NEWS}\n\n"

  # 4. OpenAI Blog RSS
  echo "ai-news: Fetching OpenAI blog..." >&2
  OPENAI_RSS=$(curl -sf "https://openai.com/blog/rss.xml" 2>/dev/null || echo "")
  OPENAI_NEWS=$(echo "$OPENAI_RSS" | python3 -c "
import sys, re
xml = sys.stdin.read()
items = re.findall(r'<item>.*?</item>', xml, re.DOTALL)[:5]
for item in items:
    title = re.search(r'<title>(.*?)</title>', item)
    link = re.search(r'<link>(.*?)</link>', item)
    if title:
        t = title.group(1).replace('<![CDATA[','').replace(']]>','')
        l = link.group(1) if link else ''
        print(f'[OpenAI] {t} | {l}')
" 2>/dev/null || echo "")
  all_news="${all_news}--- OpenAI Blog ---\n${OPENAI_NEWS}\n\n"

  # 5. Zenn AI/LLMタグ
  echo "ai-news: Fetching Zenn..." >&2
  ZENN=$(curl -sf "https://zenn.dev/api/articles?topicname=ai&order=latest&count=5" 2>/dev/null || echo '{"articles":[]}')
  ZENN_NEWS=$(echo "$ZENN" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for a in d.get('articles',[])[:5]:
    title=a.get('title','')
    slug=a.get('slug','')
    user=a.get('user',{}).get('username','')
    likes=a.get('liked_count',0)
    print(f'[Zenn likes:{likes}] {title} | https://zenn.dev/{user}/articles/{slug}')
" 2>/dev/null || echo "")
  all_news="${all_news}--- Zenn AI ---\n${ZENN_NEWS}\n\n"

  echo -e "$all_news"
}

# ── Claude要約 ───────────────────────────────────

RAW_NEWS=$(collect_news)
echo "ai-news: Collected raw news. Summarizing with Claude..." >&2

PROMPT=$(cat <<PROMPT_EOF
以下は今日のAI関連ニュースの生データです。日次レポートにまとめてください。

## 生データ
$RAW_NEWS

## ルール
1. 最大10件にフィルタリング（重要度順）
2. 各ニュースに①②③...と番号を振る
3. 重要度レベルを付ける:
   - 🔴 緊急: 即座に対応が必要（API変更、セキュリティ、料金変更等）
   - 🟡 重要: 今週中に確認すべき（新機能、重要アップデート等）
   - ⚪ 参考: 知っておくと良い（トレンド、研究等）
4. まず「そのニュースが何を言っているか」を正確にわかりやすく伝える。一次情報を崩さない
5. 技術用語には括弧で言い換えを添える（非エンジニア向け）
6. 事業への影響は末尾に1行で簡潔に補足（メインにしない）
7. 日本語のニュースは日本語のまま、英語のニュースは日本語で要約
8. 24時間以内のニュースを優先。古いものは除外
9. URLは必ず含める

## 出力フォーマット（このまま出力）
📰 AI動向日次レポート ($TODAY)

① 🟡 タイトル（わかりやすく）
内容の説明（2-3文。何が起きたか、何が変わるか。技術用語には言い換えを添える）
→ SATOYAMA: 事業への影響を1行で
🔗 URL

② ⚪ タイトル
...

（10件まで。番号は連番で）

💡 今日のアクション
- （もしあれば1-2件の具体的アクション）

テキストのみを出力してください。マークダウンの装飾は最小限に。
PROMPT_EOF
)

REPORT=$(echo "$PROMPT" | "$CLAUDE_PATH" -p --model claude-haiku-4-5-20251001 --max-turns 1 --tools "" 2>/dev/null || echo "")

if [ -z "$REPORT" ]; then
  echo "ai-news: Claude summarization failed" >&2
  REPORT="📰 AI動向日次レポート ($TODAY)\n\n⚠️ 要約の生成に失敗しました。生データ:\n\n$RAW_NEWS"
fi

echo "ai-news: Report generated ($(echo "$REPORT" | wc -c | tr -d ' ') chars)" >&2

# ── Discord投稿 ──────────────────────────────────

echo "ai-news: Posting to Discord #ai-news..." >&2

REMAINING="$REPORT"
while [ ${#REMAINING} -gt 0 ]; do
  CHUNK="${REMAINING:0:2000}"
  REMAINING="${REMAINING:2000}"
  curl -sf -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -d "$(jq -n --arg text "$CHUNK" '{content: $text}')" > /dev/null
  [ ${#REMAINING} -gt 0 ] && sleep 1
done
echo "ai-news: Discord posted" >&2

# ── Obsidian保存 ─────────────────────────────────

OBSIDIAN_FILE="$OBSIDIAN_DIR/${MONTH}.md"

if [ ! -f "$OBSIDIAN_FILE" ]; then
  echo "# AI動向 ${MONTH}" > "$OBSIDIAN_FILE"
  echo "" >> "$OBSIDIAN_FILE"
fi

{
  echo ""
  echo "---"
  echo ""
  echo "## $TODAY"
  echo ""
  echo "$REPORT"
  echo ""
} >> "$OBSIDIAN_FILE"

echo "ai-news: Saved to Obsidian ($OBSIDIAN_FILE)" >&2

# ── 完了 ─────────────────────────────────────────

echo "$TODAY" > "$LOCK_FILE"
echo "ai-news: Done!" >&2
