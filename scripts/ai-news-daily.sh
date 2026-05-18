#!/bin/bash
# @critical: launchd com.rina.ai-news-daily から毎朝7:00実行
# @stops-if-deleted: AI・観光・補助金・EC等15ソースの日次レポートがDiscord #ai-news に届かなくなる。Notion AI News DB蓄積も停止
# ai-news-daily.sh — AI動向日次レポート（v2: 11ソース + Notion蓄積）
# 毎朝7:00にAIニュースを収集 → Claude要約 → Discord #ai-news + Obsidian保存 + Notion AI News DB蓄積
#
# v2変更点:
#   - ソース拡充: HN/Reddit/Anthropic/OpenAI/Zenn + DeepMind/Vercel/DevelopersIO/ProductHunt/GoogleSuggest
#   - Notion AI News DBへの構造化蓄積
#   - 活用先自動判定（記事ネタ/教材ネタ/DX提案/SNS投稿）

set -uo pipefail

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

# Notion設定
source "$REPO_DIR/.env" 2>/dev/null || true
NOTION_AI_NEWS_DB="d24d55d9c5944a7eb42e9fcc8383035b"

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
    if echo "$TITLE" | grep -qiE "AI|LLM|GPT|Claude|Anthropic|OpenAI|Gemini|DeepMind|machine learn|neural|transformer|diffusion|AGI|agent|DeepSeek|Qwen"; then
      HN_NEWS="${HN_NEWS}[HN score:${SCORE}] ${TITLE} | ${URL}\n"
    fi
  done
  all_news="${all_news}--- Hacker News ---\n${HN_NEWS}\n"

  # 2. Reddit r/ClaudeAI + r/LocalLLaMA
  for subreddit in ClaudeAI LocalLLaMA; do
    echo "ai-news: Fetching Reddit r/${subreddit}..." >&2
    REDDIT=$(curl -sf -H "User-Agent: rina-ai-news/2.0" "https://www.reddit.com/r/${subreddit}/hot.json?limit=10" 2>/dev/null || echo '{"data":{"children":[]}}')
    REDDIT_NEWS=$(echo "$REDDIT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for post in d.get('data',{}).get('children',[])[:10]:
    p=post.get('data',{})
    title=p.get('title','')
    score=p.get('score',0)
    url=f\"https://reddit.com{p.get('permalink','')}\"
    print(f'[Reddit r/${subreddit} score:{score}] {title} | {url}')
" 2>/dev/null || echo "")
    all_news="${all_news}--- Reddit r/${subreddit} ---\n${REDDIT_NEWS}\n\n"
  done

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

  # 5. Google DeepMind Blog RSS
  echo "ai-news: Fetching DeepMind blog..." >&2
  DEEPMIND_RSS=$(curl -sf "https://deepmind.google/blog/rss.xml" 2>/dev/null || echo "")
  DEEPMIND_NEWS=$(echo "$DEEPMIND_RSS" | python3 -c "
import sys, re
xml = sys.stdin.read()
items = re.findall(r'<item>.*?</item>', xml, re.DOTALL)[:5]
for item in items:
    title = re.search(r'<title>(.*?)</title>', item)
    link = re.search(r'<link>(.*?)</link>', item)
    if title:
        t = title.group(1).replace('<![CDATA[','').replace(']]>','')
        l = link.group(1) if link else ''
        print(f'[DeepMind] {t} | {l}')
" 2>/dev/null || echo "")
  all_news="${all_news}--- DeepMind Blog ---\n${DEEPMIND_NEWS}\n\n"

  # 6. Vercel Blog RSS
  echo "ai-news: Fetching Vercel blog..." >&2
  VERCEL_RSS=$(curl -sf "https://vercel.com/atom" 2>/dev/null || echo "")
  VERCEL_NEWS=$(echo "$VERCEL_RSS" | python3 -c "
import sys, re
xml = sys.stdin.read()
entries = re.findall(r'<entry>.*?</entry>', xml, re.DOTALL)[:5]
for entry in entries:
    title = re.search(r'<title>(.*?)</title>', entry)
    link = re.search(r'<link[^>]*href=\"(.*?)\"', entry)
    if title:
        t = title.group(1).replace('<![CDATA[','').replace(']]>','')
        l = link.group(1) if link else ''
        if any(kw in t.lower() for kw in ['ai', 'llm', 'model', 'agent', 'sdk', 'next.js', 'deploy']):
            print(f'[Vercel] {t} | {l}')
" 2>/dev/null || echo "")
  all_news="${all_news}--- Vercel Blog ---\n${VERCEL_NEWS}\n\n"

  # 7. Zenn AI/LLMタグ
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

  # 8. DevelopersIO (Classmethod)
  echo "ai-news: Fetching DevelopersIO..." >&2
  DEVIO_RSS=$(curl -sf "https://dev.classmethod.jp/feed/" 2>/dev/null || echo "")
  DEVIO_NEWS=$(echo "$DEVIO_RSS" | python3 -c "
import sys, re
xml = sys.stdin.read()
items = re.findall(r'<item>.*?</item>', xml, re.DOTALL)[:15]
for item in items:
    title = re.search(r'<title>(.*?)</title>', item)
    link = re.search(r'<link>(.*?)</link>', item)
    if title:
        t = title.group(1).replace('<![CDATA[','').replace(']]>','')
        l = link.group(1) if link else ''
        if any(kw in t.lower() for kw in ['ai', 'llm', 'claude', 'gpt', 'bedrock', 'sagemaker', 'openai', 'gemini', 'agent']):
            print(f'[DevelopersIO] {t} | {l}')
" 2>/dev/null || echo "")
  all_news="${all_news}--- DevelopersIO ---\n${DEVIO_NEWS}\n\n"

  # 9. Product Hunt — Today's AI products
  echo "ai-news: Fetching Product Hunt..." >&2
  PH_NEWS=$(curl -sf -H "User-Agent: rina-ai-news/2.0" "https://www.producthunt.com/frontend/graphql" \
    -H "Content-Type: application/json" \
    -d '{"query":"query { posts(order: RANKING, first: 10) { edges { node { name tagline url votesCount topics { edges { node { name } } } } } } }"}' 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    for edge in d.get('data',{}).get('posts',{}).get('edges',[]):
        node = edge.get('node',{})
        name = node.get('name','')
        tagline = node.get('tagline','')
        url = node.get('url','')
        votes = node.get('votesCount',0)
        topics = [t['node']['name'] for t in node.get('topics',{}).get('edges',[])]
        if any(kw in ' '.join(topics+[name,tagline]).lower() for kw in ['artificial intelligence','ai','machine learning','llm','chatbot','automation']):
            print(f'[PH votes:{votes}] {name}: {tagline} | {url}')
except:
    pass
" 2>/dev/null || echo "")
  all_news="${all_news}--- Product Hunt ---\n${PH_NEWS}\n\n"

  # 10. Googleサジェスト（市場需要モニタリング）
  echo "ai-news: Fetching Google Suggest..." >&2
  SUGGEST_NEWS=""
  SUGGEST_HISTORY="$OBSIDIAN_DIR/suggest-history.md"
  for keyword in "AI研修" "AIスクール" "Claude+Code" "AI+エージェント" "DX+補助金" "AI+地方" "古民家+宿泊" "インバウンド+2026" "持続化補助金" "コーヒー+通販" "撮影スタジオ" "中小企業+DX"; do
    DECODED=$(echo "$keyword" | sed 's/+/ /g')
    SUGGESTIONS=$(curl -sf "https://suggestqueries.google.com/complete/search?client=firefox&q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$DECODED'))")" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(', '.join(d[1][:5]))" 2>/dev/null || echo "")
    if [ -n "$SUGGESTIONS" ]; then
      SUGGEST_NEWS="${SUGGEST_NEWS}[GS] ${DECODED}: ${SUGGESTIONS}\n"
    fi
  done
  all_news="${all_news}--- Googleサジェスト ---\n${SUGGEST_NEWS}\n\n"

  # 11. JNTO(日本政府観光局) ニュース RSS
  echo "ai-news: Fetching JNTO..." >&2
  JNTO_NEWS=$(curl -sf "https://www.jnto.go.jp/news/rss.xml" 2>/dev/null | python3 -c "
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
        print(f'[JNTO {d}] {t} | {l}')
" 2>/dev/null || echo "")
  if [ -n "$JNTO_NEWS" ]; then
    all_news="${all_news}--- JNTO ---\n${JNTO_NEWS}\n\n"
  fi

  # 12. トラベルボイス（観光業界メディア）RSS
  echo "ai-news: Fetching トラベルボイス..." >&2
  TRAVELVOICE_NEWS=$(curl -sf "https://www.travelvoice.jp/feed" 2>/dev/null | python3 -c "
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
        print(f'[TravelVoice {d}] {t} | {l}')
" 2>/dev/null || echo "")
  if [ -n "$TRAVELVOICE_NEWS" ]; then
    all_news="${all_news}--- トラベルボイス ---\n${TRAVELVOICE_NEWS}\n\n"
  fi

  # 13. ネットショップ担当者フォーラム（EC業界）RSS
  echo "ai-news: Fetching ネットショップ担当者フォーラム..." >&2
  NSHOP_NEWS=$(curl -sfL "https://netshop.impress.co.jp/rss.xml" 2>/dev/null | python3 -c "
import sys, re
xml = sys.stdin.read()
items = re.findall(r'<item.*?>.*?</item>', xml, re.DOTALL)[:5]
for item in items:
    title = re.search(r'<title>(.*?)</title>', item)
    link = re.search(r'<link>(.*?)</link>', item)
    date = re.search(r'<pubDate>(.*?)</pubDate>', item)
    if title:
        t = title.group(1).replace('<![CDATA[','').replace(']]>','')
        l = link.group(1) if link else ''
        d = date.group(1)[:16] if date else ''
        print(f'[EC業界 {d}] {t} | {l}')
" 2>/dev/null || echo "")
  if [ -n "$NSHOP_NEWS" ]; then
    all_news="${all_news}--- EC業界(ネットショップ担当者) ---\n${NSHOP_NEWS}\n\n"
  fi

  # 14-17. PR TIMES — 4カテゴリ一括取得（飲食・AI教育・観光・補助金DX）
  echo "ai-news: Fetching PR TIMES (4カテゴリ)..." >&2
  PRTIMES_RAW=$(curl -sfL "https://prtimes.jp/index.rdf" 2>/dev/null || echo "")
  if [ -n "$PRTIMES_RAW" ]; then
    PRTIMES_FILTERED=$(echo "$PRTIMES_RAW" | python3 -c "
import sys, re
xml = sys.stdin.read()
items = re.findall(r'<item.*?>.*?</item>', xml, re.DOTALL)

categories = {
    '飲食・EC': r'コーヒー|珈琲|カフェ|飲食|D2C|EC|焙煎|食品|ネット通販|Shopify',
    'AI教育': r'AI.*研修|AI.*スクール|AI.*人材|生成AI.*研修|DX.*研修|AI.*教育|リスキリング|AIスキル',
    '観光・宿泊': r'観光|インバウンド|宿泊|民泊|ホテル|古民家|旅館|地方創生|ワーケーション|サウナ',
    '補助金・DX': r'補助金|助成金|中小企業.*DX|事業再構築|持続化|IT導入|デジタル化.*支援',
}

for cat_name, pattern in categories.items():
    hits = []
    for item in items:
        t_match = re.search(r'<title>(.*?)</title>', item)
        l_match = re.search(r'<link>(.*?)</link>', item)
        d_match = re.search(r'<dc:date>(.*?)</dc:date>', item)
        if t_match:
            t = t_match.group(1).replace('<![CDATA[','').replace(']]>','')
            if re.search(pattern, t):
                l = l_match.group(1) if l_match else ''
                d = d_match.group(1)[:10] if d_match else ''
                hits.append(f'[PRTIMES {cat_name} {d}] {t} | {l}')
                if len(hits) >= 4: break
    if hits:
        print(f'### PR TIMES - {cat_name}')
        for h in hits: print(h)
        print()
" 2>/dev/null || echo "")
    if [ -n "$PRTIMES_FILTERED" ]; then
      all_news="${all_news}--- PR TIMES (4カテゴリ) ---\n${PRTIMES_FILTERED}\n\n"
    fi
  fi

  # 18. Claude Code CHANGELOG（最新リリース）
  echo "ai-news: Checking Claude Code releases..." >&2
  CC_RELEASE=$(curl -sf -H "Accept: application/vnd.github+json" "https://api.github.com/repos/anthropics/claude-code/releases?per_page=1" 2>/dev/null | python3 -c "
import json, sys
from datetime import datetime, timedelta, timezone
d = json.load(sys.stdin)
if d:
    r = d[0]
    pub = r.get('published_at','')
    name = r.get('name','') or r.get('tag_name','')
    url = r.get('html_url','')
    # 3日以内のリリースのみ表示
    if pub:
        pub_dt = datetime.fromisoformat(pub.replace('Z','+00:00'))
        if (datetime.now(timezone.utc) - pub_dt).days <= 3:
            body = r.get('body','')[:200]
            print(f'[Claude Code] {name} — {body} | {url}')
" 2>/dev/null || echo "")
  if [ -n "$CC_RELEASE" ]; then
    all_news="${all_news}--- Claude Code Release ---\n${CC_RELEASE}\n\n"
  fi

  echo -e "$all_news"
}

# ── Claude要約 ───────────────────────────────────

RAW_NEWS=$(collect_news)
echo "ai-news: Collected raw news. Summarizing with Claude..." >&2

# 生データが大きすぎる場合は切り詰め
RAW_NEWS_TRIMMED=$(echo -e "$RAW_NEWS" | head -200)

# プロンプトをファイルに書き出し（heredocのエスケープ問題回避）
PROMPT_FILE="$LOG_DIR/.ai-news-prompt.txt"
cat > "$PROMPT_FILE" <<'PROMPT_HEADER'
あなたはRyoの右腕AIキャスター。事業に効く情報だけを厳選して、リズムよく届けてください。

# 絶対ルール
- **件数の目安は 7〜10件**（10件を超えない・最低5件は確保）
- カテゴリは「🔥即行動候補」「👀押さえる」「🌐周辺動向」の **3つだけ**
- 該当なしのカテゴリは見出しごと省略
- メタコメント（「厳選しました」等）禁止。レポート本文だけ
- URLは必ず含める。URLがないニュースは書かない
- 英語・中国語は日本語に翻訳

# トーン
- **単調な「要約: ...」「→ 影響: ...」フォーマットは捨てる**
- 自然な日本語、リズミカル、ときどき感情的なツッコミOK
- 「これ気になる」「ヤバめ」「~~注目」「動くなら今」等の言葉を適度に
- 事実は端的に、解釈は具体的に
- **業界知識がない一般消費者にもわかるように書く**

# 専門用語のルール（重要）
- 業界用語・英語略語・テック用語が出てきたら、() 内に **1行で分かりやすい解説** を必ず添える
  - 例: 「OTA（オンライン旅行予約サイトのこと）」
  - 例: 「Claude Skills（AIに特定タスクを覚えさせる新機能）」
  - 例: 「タビナカ商品（旅行中に現地で体験するアクティビティ）」
  - 例: 「D2C（メーカー直販、卸を通さずに消費者に直接売るモデル）」
  - 例: 「LLM（大規模言語モデル＝ChatGPTのような生成AIの基盤技術）」
- 解説なしの「英語そのまま」「カタカナそのまま」は避ける
- 「専門用語を排除する」のではなく「**そのまま使うけど初見でも分かる**」を目指す

# 言語
- 英語タイトル・中国語タイトルは日本語に翻訳してメイン表示
- 原題は補足が必要な時だけ括弧で

# リンク表記
- 長いURLは Discord Markdown 形式で短縮:
  - 旧: `🔗 https://reddit.com/r/ClaudeAI/comments/1tc9oa0/...`
  - 新: `🔗 [Reddit原文](https://reddit.com/r/ClaudeAI/comments/1tc9oa0/...)`
- リンクテキストは「Reddit原文」「JNTO公式」「Anthropic Blog」「PR TIMES記事」など出元がわかる短い表現で

# 出力形式（厳守）

```
📰 AI日報 [日付]
> [今日のヒトコト: Ryoの事業視点で本日のトーンを1行で]

## 🔥即行動候補

**[★★★ ソース] タイトル**
本質を1-2文。なぜ重要かを直接書く。
→ 関連: [事業名] / 動くなら: [具体的アクション]
🔗 URL

## 👀押さえる

**[★★ ソース] タイトル**
コンパクトに状況。
→ 関連: [事業名]
🔗 URL

## 🌐周辺動向

**[★ ソース] タイトル** — 1行コメント
🔗 URL
```

# Ryo の事業（2026-05時点・影響評価軸）
- **えんがわ**: 山梨梁川の古民家民泊（主収入源）。注目=インバウンド・民泊法・地方創生補助金・コーヒー連動
- **三十日珈琲**: 山梨上野原の自家焙煎コーヒー＋EC。注目=コーヒー業界動向・D2C・Stripe決済・Instagram集客
- **となりにとまる**: 山梨の古民家民泊群（Basecamp Torisawa/任屋/よりみち）。注目=持続化補助金・地方創生・撮影需要
- **任屋（蔵サウナ）**: 古民家×サウナ×宿泊（6月補助金申請中）。注目=サウナ業界・宿泊施設サステナビリティ補助金
- **SATOYAMA AI BASE**: AIスクール・DX支援。注目=AI人材育成・DX補助金・競合AIスクール動向
- **個人技術基盤**: Claude/Anthropic・Vercel・Next.js・Stripe・Notion・LINE・GAS

# 重要度の基準
- ★★★ 緊急（即行動候補にのみ）: 今週中に動くべき
- ★★ 重要（押さえるに入れる）: 戦略・判断に影響
- ★ 参考（周辺動向）: 業界トレンド・競合・補助金

## 出力（ここから下を上の形式で）

PROMPT_HEADER

echo "対象日: $TODAY" >> "$PROMPT_FILE"
cat >> "$PROMPT_FILE" <<'PROMPT_FORMAT'

出力が完了したら、レポート本文の後に `===NOTION_JSON===` と書いてから、以下のJSON配列を出力:
[{"title":"タイトル","url":"URL","source":"HN","category":"AI・技術","importance":"★★ 重要","business_relevance":"高","usage":["記事ネタ"],"impact":"影響","summary":"要約"}]
source: HN/Reddit/PH/GS/公式/JP/JNTO/TravelVoice/EC業界/PRTIMES
category: AI・技術/事業直結/観光・宿泊/補助金・政策/食・EC/教育市場/市場動向/海外
importance: ★★★ 緊急/★★ 重要/★ 参考
business_relevance: 高/中/低
usage(複数可): 記事ネタ/教材ネタ/DX提案/SNS投稿/未活用

---

# 本日の生データ
PROMPT_FORMAT

echo "$RAW_NEWS_TRIMMED" >> "$PROMPT_FILE"

FULL_OUTPUT=$("$CLAUDE_PATH" -p --model claude-sonnet-4-6 --max-turns 3 < "$PROMPT_FILE" 2>/dev/null || echo "")
rm -f "$PROMPT_FILE"

# レポート部分とJSON部分を分離
REPORT=$(echo "$FULL_OUTPUT" | sed '/===NOTION_JSON===/,$d')
NOTION_JSON_RAW=$(echo "$FULL_OUTPUT" | sed -n '/===NOTION_JSON===/,$p' | tail -n +2)

# JSONの抽出（```json ブロックを除去し、配列部分だけ取り出す）
NOTION_JSON=$(echo "$NOTION_JSON_RAW" | python3 -c "
import sys, json, re
raw = sys.stdin.read()
# ```json ... ``` ブロックを除去
raw = re.sub(r'\`\`\`json\s*', '', raw)
raw = re.sub(r'\`\`\`\s*', '', raw)
# JSON配列を抽出
match = re.search(r'\[.*\]', raw, re.DOTALL)
if match:
    try:
        data = json.loads(match.group())
        print(json.dumps(data))
    except:
        print('')
else:
    print('')
" 2>/dev/null || echo "")

echo "ai-news: Notion JSON extracted ($(echo "$NOTION_JSON" | wc -c | tr -d ' ') chars)" >&2

if [ -z "$REPORT" ]; then
  echo "ai-news: Claude summarization failed" >&2
  REPORT="📰 AI日報 ($TODAY)\n\n⚠️ 要約の生成に失敗しました。生データ:\n\n$(echo "$RAW_NEWS" | head -50)"
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

# printfで一括書き込み（失敗を検出してstderrに残す。iCloud deadlock のサイレント失敗対策）
OBSIDIAN_TMP_ERR=$(mktemp)
if printf '\n---\n\n## %s\n\n%s\n\n' "$TODAY" "$REPORT" >> "$OBSIDIAN_FILE" 2>"$OBSIDIAN_TMP_ERR"; then
  echo "ai-news: Saved to Obsidian ($OBSIDIAN_FILE)" >&2
else
  OBSIDIAN_ERR_MSG=$(cat "$OBSIDIAN_TMP_ERR")
  echo "ai-news: ERROR Obsidian write failed ($OBSIDIAN_FILE): $OBSIDIAN_ERR_MSG" >&2
  echo "ai-news: ERROR iCloud Drive状態を確認してください。Notion DBには書き込み済み" >&2
fi
rm -f "$OBSIDIAN_TMP_ERR"

# ── Notion AI News DB蓄積 ────────────────────────

if [ -n "$NOTION_JSON" ] && [ -n "${NOTION_API_KEY:-}" ]; then
  echo "ai-news: Writing to Notion AI News DB..." >&2

  # JSONをパースしてNotion APIで各ニュースを登録
  echo "$NOTION_JSON" | python3 -c "
import json, sys, urllib.request

api_key = '${NOTION_API_KEY}'
db_id = '${NOTION_AI_NEWS_DB}'
today = '${TODAY}'

try:
    items = json.load(sys.stdin)
except:
    print('ai-news: Failed to parse Notion JSON', file=sys.stderr)
    sys.exit(0)

if not isinstance(items, list):
    print('ai-news: Notion JSON is not a list', file=sys.stderr)
    sys.exit(0)

success = 0
for item in items[:12]:
    try:
        title = item.get('title', '')[:100]
        if not title:
            continue

        # ソース名をDB選択肢にマッピング
        source_map = {
            'HN': 'HN', 'Reddit': 'Reddit', 'Anthropic': '公式', 'OpenAI': '公式',
            'DeepMind': '公式', 'Vercel': '公式', 'Zenn': 'JP', 'DevelopersIO': 'JP',
            'PH': 'PH', 'GS': 'GS', 'Claude Code': '公式', 'X': 'X', 'YT': 'YT',
            'CN': 'CN', 'GT': 'GT', 'JP': 'JP', '公式': '公式',
        }
        source_val = source_map.get(item.get('source', ''), 'JP')

        # カテゴリをDB選択肢にマッピング
        valid_categories = ['モデル・ツール', '市場動向', '規制・政策', '事業直結', '海外コミュニティ', '国内', '中国AI']
        cat_val = item.get('category', 'モデル・ツール')
        if cat_val not in valid_categories:
            cat_val = 'モデル・ツール'

        # 重要度をDB選択肢にマッピング
        imp_raw = item.get('importance', '★ 参考')
        imp_map = {'★★★': '★★★ 緊急', '★★': '★★ 重要', '★': '★ 参考',
                   '★★★ 緊急': '★★★ 緊急', '★★ 重要': '★★ 重要', '★ 参考': '★ 参考'}
        imp_val = imp_map.get(imp_raw, '★ 参考')

        # 事業関連度
        rel_raw = item.get('business_relevance', '低')
        rel_val = rel_raw if rel_raw in ['高', '中', '低'] else '低'

        # 活用先（multi_select）
        valid_usage = ['記事ネタ', '教材ネタ', 'DX提案', 'SNS投稿', '未活用']
        usage_list = [u for u in item.get('usage', ['未活用']) if u in valid_usage]
        if not usage_list:
            usage_list = ['未活用']

        properties = {
            'タイトル': {'title': [{'text': {'content': title}}]},
            'ソース': {'select': {'name': source_val}},
            'カテゴリ': {'select': {'name': cat_val}},
            'SATOYAMA影響': {'rich_text': [{'text': {'content': item.get('impact', '')[:200]}}]},
            '要約': {'rich_text': [{'text': {'content': item.get('summary', '')[:500]}}]},
            '重要度': {'select': {'name': imp_val}},
            '事業関連度': {'select': {'name': rel_val}},
            '活用先': {'multi_select': [{'name': u} for u in usage_list]},
            '活用済み': {'checkbox': False},
            '収集日': {'date': {'start': today}},
        }

        # URL
        url = item.get('url', '')
        if url:
            properties['URL'] = {'url': url}

        body = json.dumps({
            'parent': {'database_id': db_id},
            'properties': properties,
        }).encode()

        req = urllib.request.Request(
            'https://api.notion.com/v1/pages',
            data=body,
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
                'Notion-Version': '2022-06-28',
            },
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status in (200, 201):
                success += 1

    except Exception as e:
        print(f'ai-news: Notion write error for \"{title}\": {e}', file=sys.stderr)
        continue

print(f'ai-news: Notion DB — {success}/{len(items)} items written', file=sys.stderr)
" 2>&1 | while read line; do echo "$line" >&2; done

else
  if [ -z "${NOTION_API_KEY:-}" ]; then
    echo "ai-news: NOTION_API_KEY not set, skipping Notion DB write" >&2
  elif [ -z "$NOTION_JSON" ]; then
    echo "ai-news: No Notion JSON generated, skipping DB write" >&2
  fi
fi

# ── Googleサジェスト履歴保存 ─────────────────────

SUGGEST_HISTORY="$OBSIDIAN_DIR/suggest-history.md"
if [ ! -f "$SUGGEST_HISTORY" ]; then
  echo "# Googleサジェスト履歴" > "$SUGGEST_HISTORY"
fi

# サジェストデータを履歴に追記
SUGGEST_DATA=""
for keyword in "AI研修" "AIスクール" "Claude Code" "AIエージェント" "DX補助金" "AI地方"; do
  SUGGESTIONS=$(curl -sf "https://suggestqueries.google.com/complete/search?client=firefox&q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$keyword'))")" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(', '.join(d[1][:5]))" 2>/dev/null || echo "")
  if [ -n "$SUGGESTIONS" ]; then
    SUGGEST_DATA="${SUGGEST_DATA}| ${keyword} | ${SUGGESTIONS} |\n"
  fi
done

if [ -n "$SUGGEST_DATA" ]; then
  {
    echo ""
    echo "## $TODAY"
    echo "| キーワード | サジェスト |"
    echo "|-----------|----------|"
    echo -e "$SUGGEST_DATA"
  } >> "$SUGGEST_HISTORY"
fi

# ── 完了 ─────────────────────────────────────────

echo "$TODAY" > "$LOCK_FILE" 2>/dev/null || true
echo "ai-news: Done!" >&2
