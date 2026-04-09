#!/bin/bash
# 毎朝のAIスキャン：会話ログ + カレンダー + タスクを分析し、提案JSONを生成
# morning-briefing.sh から呼ばれる。結果は logs/.daily-scan.json に保存

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$REPO_DIR/logs"
DATA_DIR="$REPO_DIR/data"
OUTPUT_FILE="$LOG_DIR/.daily-scan.json"

export PATH="/Users/ocmm/.local/bin:/Users/ocmm/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
unset CLAUDECODE 2>/dev/null || true
unset ANTHROPIC_API_KEY 2>/dev/null || true

# --- task-engine.js を実行して today.json を生成（60秒タイムアウト） ---
echo "daily-scan: Running task-engine.js..." >&2
node "$SCRIPT_DIR/task-engine.js" >&2 2>&1 &
TE_PID=$!
TE_WAIT=60
while [ $TE_WAIT -gt 0 ]; do
  if ! kill -0 $TE_PID 2>/dev/null; then break; fi
  sleep 2; TE_WAIT=$((TE_WAIT - 2))
done
if kill -0 $TE_PID 2>/dev/null; then
  echo "daily-scan: task-engine.js timeout (60s), killing..." >&2
  kill $TE_PID 2>/dev/null; sleep 1; kill -9 $TE_PID 2>/dev/null
  TASK_ENGINE_EXIT=124
else
  wait $TE_PID 2>/dev/null
  TASK_ENGINE_EXIT=$?
fi
if [ $TASK_ENGINE_EXIT -ne 0 ]; then
  echo "daily-scan: task-engine.js failed (exit=$TASK_ENGINE_EXIT)" >&2
fi

# --- 毎月1日: Obsidian定期パトロール ---
OBSIDIAN_PATROL_SECTION=""
DAY_OF_MONTH=$(date +%d)
if [ "$DAY_OF_MONTH" = "01" ]; then
  echo "daily-scan: Monthly Obsidian patrol..." >&2
  PATROL_SCRIPT="$HOME/agents/scripts/obsidian-patrol.sh"
  if [ -f "$PATROL_SCRIPT" ]; then
    OBSIDIAN_PATROL_SECTION=$(bash "$PATROL_SCRIPT" 2>/dev/null) || true
    echo "daily-scan: Obsidian patrol done ($(echo "$OBSIDIAN_PATROL_SECTION" | wc -l | tr -d ' ') lines)" >&2
  fi
fi

# --- 月曜のみ: SNS週間下書きを生成 ---
SNS_WEEKLY_SECTION=""
DOW=$(date +%u)  # 1=月曜, 7=日曜
if [ "$DOW" = "1" ]; then
  echo "daily-scan: Monday detected, generating SNS weekly drafts..." >&2
  SNS_WEEKLY_SECTION=$(node "$SCRIPT_DIR/sns-weekly-draft.js") || true
  if [ -n "$SNS_WEEKLY_SECTION" ]; then
    echo "daily-scan: SNS drafts generated ($(echo "$SNS_WEEKLY_SECTION" | wc -l | tr -d ' ') lines)" >&2
  else
    echo "daily-scan: SNS draft generation returned empty (non-blocking)" >&2
  fi
fi

# today.json からアクション情報を読み込み
TODAY_ACTIONS_CONTEXT=""
if [ -f "$DATA_DIR/today.json" ]; then
  TODAY_ACTIONS_CONTEXT=$(python3 -c "
import json, sys

with open('$DATA_DIR/today.json', 'r') as f:
    data = json.load(f)

lines = []
for section in data.get('sections', []):
    lines.append(f\"### {section['title']}\")
    for item in section.get('items', []):
        src = item.get('source', '')
        title = item.get('title', '')
        detail = item.get('detail', '')
        action_label = item.get('actionLabel', '')
        action_str = f' → [{action_label}]' if action_label else ''
        lines.append(f'- [{src}] {title} — {detail}{action_str}')
    lines.append('')

stats = data.get('stats', {})
lines.append(f\"合計: urgent={stats.get('urgent',0)}, today={stats.get('today',0)}, upcoming={stats.get('upcoming',0)}, total={stats.get('total',0)}\")

print('\n'.join(lines))
" 2>/dev/null)
  echo "daily-scan: Loaded today.json ($(echo "$TODAY_ACTIONS_CONTEXT" | wc -l | tr -d ' ') lines)" >&2
else
  echo "daily-scan: today.json not found" >&2
fi

# --- Obsidian ダッシュボードの読み込み ---
VAULT_DIR="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-vault"
OBSIDIAN_DASHBOARD=""

if [ -f "$VAULT_DIR/ダッシュボード.md" ]; then
  # ダッシュボードから「直近のタスク」セクションを抽出
  OBSIDIAN_DASHBOARD=$(sed -n '/## 直近のタスク/,/^## /p' "$VAULT_DIR/ダッシュボード.md" | head -30)
  echo "daily-scan: Loaded dashboard tasks ($(echo "$OBSIDIAN_DASHBOARD" | wc -l | tr -d ' ') lines)" >&2
fi

# プロジェクト進捗を収集
PROJECT_CONTEXT=$("$SCRIPT_DIR/scan-projects.sh" 2>/dev/null)

# --- 期限データの読み込みと残り日数計算 ---
DEADLINES_CONTEXT=""
if [ -f "$DATA_DIR/deadlines.json" ]; then
  DEADLINES_CONTEXT=$(python3 -c "
import json, sys
from datetime import datetime, date

with open('$DATA_DIR/deadlines.json', 'r') as f:
    data = json.load(f)

today = date.today()
lines = []
for d in data.get('deadlines', []):
    if d.get('status') == '完了':
        continue
    deadline_date = date.fromisoformat(d['date'])
    days_remaining = (deadline_date - today).days
    if days_remaining < 0:
        marker = '❌ 期限超過（D+' + str(abs(days_remaining)) + '）'
    elif days_remaining <= 3:
        marker = '⚠️ D-' + str(days_remaining) + '（残り' + str(days_remaining) + '日）'
    elif days_remaining <= 7:
        marker = '🔔 D-' + str(days_remaining) + '（残り' + str(days_remaining) + '日）'
    else:
        marker = 'D-' + str(days_remaining) + '（残り' + str(days_remaining) + '日）'

    checklist_str = ''
    if d.get('checklist'):
        checklist_str = '  チェックリスト: ' + ' / '.join(d['checklist'])

    notes_str = ''
    if d.get('notes'):
        notes_str = '  備考: ' + d['notes']

    lines.append(f\"- [{d['status']}] {d['title']}（{d['business']}）{d['date']} {marker}{checklist_str}{notes_str}\")

print('\n'.join(lines))
" 2>/dev/null)
  echo "daily-scan: Loaded $(echo "$DEADLINES_CONTEXT" | wc -l | tr -d ' ') deadlines" >&2
fi

# --- 天気予報の取得（OpenMeteo API、上野原市） ---
WEATHER_CONTEXT=""
WEATHER_JSON=$(curl -s --max-time 10 "https://api.open-meteo.com/v1/forecast?latitude=35.6275&longitude=139.1111&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia/Tokyo&forecast_days=3" 2>/dev/null)

if [ -n "$WEATHER_JSON" ] && echo "$WEATHER_JSON" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  WEATHER_CONTEXT=$(python3 -c "
import json, sys
from datetime import datetime, date

weather_json = '''$WEATHER_JSON'''
data = json.loads(weather_json)

daily = data.get('daily', {})
dates = daily.get('time', [])
codes = daily.get('weather_code', [])
t_max = daily.get('temperature_2m_max', [])
t_min = daily.get('temperature_2m_min', [])
precip = daily.get('precipitation_probability_max', [])

# 天気コード → 日本語
def weather_desc(code):
    if code == 0: return '☀️ 晴れ'
    elif code <= 3: return '⛅ くもり'
    elif code <= 48: return '🌫️ 霧'
    elif code <= 55: return '🌦️ 小雨'
    elif code <= 65: return '🌧️ 雨'
    elif code <= 77: return '🌨️ 雪'
    elif code <= 82: return '🌧️ にわか雨'
    elif code <= 99: return '⛈️ 雷雨'
    return '不明'

# 曜日
weekdays = ['月', '火', '水', '木', '金', '土', '日']

lines = []
for i in range(len(dates)):
    d = date.fromisoformat(dates[i])
    wd = weekdays[d.weekday()]
    desc = weather_desc(codes[i]) if i < len(codes) else '不明'
    hi = t_max[i] if i < len(t_max) else '?'
    lo = t_min[i] if i < len(t_min) else '?'
    rain = precip[i] if i < len(precip) else '?'

    wed_note = ''
    if d.weekday() == 2:  # 水曜日
        wed_note = ' 【コーヒースタンド営業日】'
        if codes[i] >= 51:  # 雨系コード
            wed_note += '⚠️ 雨予報あり！営業判断要検討'

    lines.append(f'- {dates[i]}（{wd}）{desc} {lo}℃〜{hi}℃ 降水確率{rain}%{wed_note}')

print('\n'.join(lines))
" 2>/dev/null)
  echo "daily-scan: Weather data loaded" >&2
else
  echo "daily-scan: Weather API failed or returned invalid data" >&2
fi

# プロンプトを組み立て
PROMPT_FILE=$(mktemp)
cat > "$PROMPT_FILE" << 'PROMPT_HEADER'
あなたはRyoの専属AI秘書「しらたま」です。
以下の情報源を分析し、JSON形式で提案を出力してください。

## やること
1. 下に添付する「今日のアクション（today.json）」を確認（カレンダー・Airbnb・期限情報は統合済み）
2. 下に添付する「プロジェクト進捗情報」（Claude Code会話ログ）を分析
3. 以下のJSON形式で出力

## 出力JSON形式（これ以外は出力しないこと）

```json
{
  "briefing": "おはよう、Ryo。\n\n📅 今日の予定\n・○○\n\n📋 やること\n・○○\n\n🔮 先回りメモ\n・○○\n\n💡 ひとこと\n○○",
  "calendar_suggestions": [
    {
      "title": "予定のタイトル",
      "date": "2026-03-11",
      "time": "14:00",
      "duration_min": 60,
      "source": "どの会話/プロジェクトから検出したか",
      "reason": "なぜ登録すべきか"
    }
  ],
  "task_updates": [
    {
      "action": "add|update|complete",
      "project": "プロジェクト名",
      "title": "タスクのタイトル",
      "detail": "詳細や経過",
      "priority": "high|medium|low",
      "due_date": "2026-03-15",
      "source": "検出元の情報"
    }
  ]
}
```

## ブリーフィング生成の最重要ルール

あなたはRyoの専属秘書です。単なる情報リストではなく、「秘書としての判断と提案」を提供してください。

### 出力の原則: 事実→判断→提案
すべての項目は以下の3段構成で書くこと:
1. 事実: 何が起きている/予定されているか（簡潔に）
2. 判断: それがRyoにとってどういう意味か（時間の衝突、準備の必要性、リスク等）
3. 提案: だからRyoは何をすべきか（具体的なアクション）

### 悪い例と良い例
❌「13:30〜焙煎体験（鎌倉さま2名）」
✅「13:30〜焙煎体験（鎌倉さま2名、酸味少なめ希望）→ 深煎り寄りの豆を準備。午前中に焙煎しておくと余裕あり」

❌「えんがわ UME: Estelle Rouxさん → 3/16チェックアウト」
✅「Estelle Rouxさん今日チェックアウト → チェックアウト後に清掃、明日のHugo Bouquetさん（フランス2名）チェックインに備える。焙煎体験を案内するチャンス」

❌「確定申告 → 3/17（D-2）」
✅「⚠️ 確定申告あさって。明日は予定が詰まっているので、今日の空き時間（14:00-15:00）に提出準備を」

❌「退去通知書 内容証明発送 → 3/31（D-16）」
✅「退去通知書の内容証明発送、あと16日。来週のどこかで郵便局に行く時間を確保」

### クロス事業の判断
Ryoは三十日珈琲・えんがわ・蔵サウナ・鳥沢・SATOYAMAの5事業を1人で運営している。
- 予定の衝突や移動時間の危うさを検知したら警告する
- あるイベントが別の事業にチャンスを生む場合は指摘する（例: えんがわゲスト→焙煎体験案内）
- 空き時間があれば、期限が近いタスクを当てはめて提案する

### 天気×事業判断
- 水曜日はコーヒースタンド営業日。雨予報なら営業判断を提案する
- 雨の日は屋内作業（事務、コンテンツ作成、プログラミング）を提案する

### 期限の扱い
- statusが「完了」のものは表示しない
- D-3以内: ⚠️をつけて「今日中に何をすべきか」まで踏み込む
- D-7以内: 具体的なアクションステップを提案する
- D-30以内: 存在をリマインドする程度でOK

### 🔮先回りメモのルール
このセクションが秘書としての真価。以下のような「Ryoが気づいていないかもしれないこと」を指摘する:
- 予定の衝突や移動時間のリスク
- 明日以降の予定に対して今日やっておくべき準備
- ゲスト情報から推測される送客チャンス
- 天気変化による営業判断
- 期限タスクを空き時間にマッピングした提案
- 「この人に連絡した方がいい」「この資料を準備しておいた方がいい」等の気づき

## Airbnb予約のチェックイン/チェックアウト判定ルール（重要）
- カレンダーの予約期間の最初の日 = チェックイン日
- カレンダーの予約期間の最後の日 = チェックアウト日（この日は宿泊しない、退出する日）
- 例: 「3/14-3/16」→ 3/14チェックイン、3/16チェックアウト（3/14と3/15の2泊）
- チェックアウト日には「清掃→次のゲスト準備」のリマインドを添える
- チェックイン日には「おもてなし準備」のリマインドを添える

## その他のルール
- briefing: LINEで読みやすい朝ブリーフィング。**必ず2000文字以内に収めること（厳守）**
- briefingの文字数制約を守るための書き方ルール:
  - 箇条書きは1項目1行。「事実→判断→提案」は「→」でつないで1行にまとめる
  - 同種の情報はまとめる（例: 予定なし→「特になし」の一言でOK）
  - 冗長な挨拶・前置き・まとめは不要。「おはよう、Ryo。」の一言で始める
  - 「💡 ひとこと」は2行以内。短く刺さる一言にする
  - 情報の優先度: 今日の予定 > 期限の近いタスク > プロジェクト状況 > その他
  - 重要度の低い項目は思い切って省略する
- calendar_suggestions: 会話ログからカレンダーに未登録と思われる予定を検出。確実なものだけ。空配列OK
- task_updates:
  - add: 会話で出てきた新しい宿題・やるべきこと
  - update: 既存タスクに進捗があった場合（タイトル修正、状況メモ追加）
  - complete: 完了と判断できるタスク
  - 空配列OK
- calendar_suggestionsとtask_updatesは引き続きJSON内に出力すること（PWAが参照するため）
- priority: カレンダーの空き状況・期日・事業の重要度から総合判断
- 出力は```jsonブロック内のJSONのみ。前後に説明文を入れないこと
- 重要: このタスクはJSON出力のみ。LINE送信、メール送信、API呼び出し、ファイル書き込みなどの副作用のあるアクションは絶対に実行しないこと。分析と出力だけを行うこと

## 今日のアクション（task-engine.js が生成した today.json）
以下はカレンダー・Airbnb予約・期限情報・Git活動を統合した今日のアクションリストです。
これを元にブリーフィングを生成してください。

{today_actions}

## 追加データ

### Obsidian ダッシュボード（直近のタスク）
{obsidian_dashboard}

### タスク情報
※ Notion Task DBが正本（task-engine.jsが取得済み）

### 期限情報（詳細）
{deadlines_with_days_remaining}

### 天気予報（3日間）
{weather_summary}
PROMPT_HEADER

# プロンプト内のプレースホルダーを実データで置換
if [ -n "$TODAY_ACTIONS_CONTEXT" ]; then
  TODAY_ACTIONS_DATA="$TODAY_ACTIONS_CONTEXT"
else
  TODAY_ACTIONS_DATA="（today.json データなし — task-engine.js の実行に失敗した可能性あり）"
fi

if [ -n "$DEADLINES_CONTEXT" ]; then
  DEADLINES_DATA="$DEADLINES_CONTEXT"
else
  DEADLINES_DATA="（期限データなし）"
fi

if [ -n "$WEATHER_CONTEXT" ]; then
  WEATHER_DATA="$WEATHER_CONTEXT"
else
  WEATHER_DATA="（天気データ取得失敗）"
fi

# Obsidianデータのフォールバック
OBSIDIAN_DASHBOARD_DATA="${OBSIDIAN_DASHBOARD:-（ダッシュボードデータなし）}"

# sedで置換（複数行対応のためpython3を使用）
python3 -c "
import sys

with open('$PROMPT_FILE', 'r') as f:
    content = f.read()

today_actions = '''$TODAY_ACTIONS_DATA'''
deadlines = '''$DEADLINES_DATA'''
weather = '''$WEATHER_DATA'''
dashboard = '''$OBSIDIAN_DASHBOARD_DATA'''
content = content.replace('{today_actions}', today_actions)
content = content.replace('{deadlines_with_days_remaining}', deadlines)
content = content.replace('{weather_summary}', weather)
content = content.replace('{obsidian_dashboard}', dashboard)

with open('$PROMPT_FILE', 'w') as f:
    f.write(content)
"

cat >> "$PROMPT_FILE" << PROMPT_PROJECTS

## プロジェクト進捗情報（Claude Code会話ログより自動収集）
${PROJECT_CONTEXT}
PROMPT_PROJECTS

# 月曜のみ: SNS下書きセクションを追加
if [ -n "$SNS_WEEKLY_SECTION" ]; then
  cat >> "$PROMPT_FILE" << SNS_SECTION

${SNS_WEEKLY_SECTION}
SNS_SECTION
  echo "daily-scan: Added SNS section to prompt" >&2
fi

# 毎月1日: Obsidianパトロールセクションを追加
if [ -n "$OBSIDIAN_PATROL_SECTION" ]; then
  cat >> "$PROMPT_FILE" << PATROL_SECTION

## Obsidian定期パトロール（月次）
以下は30日以上更新がないObsidianファイルのリストです。
ブリーフィングに「Obsidianパトロール結果」として含め、Ryoにアーカイブ or 更新の判断を促してください。

${OBSIDIAN_PATROL_SECTION}
PATROL_SECTION
  echo "daily-scan: Added Obsidian patrol section to prompt" >&2
fi

# Claude実行
RESULT_FILE=$(mktemp)
(cd "$REPO_DIR" && cat "$PROMPT_FILE" | claude -p --dangerously-skip-permissions --allowedTools "Read Glob Grep" > "$RESULT_FILE") &
CLAUDE_PID=$!

# 5分タイムアウト
WAIT_SECONDS=300
while [ $WAIT_SECONDS -gt 0 ]; do
  if ! kill -0 $CLAUDE_PID 2>/dev/null; then
    break
  fi
  sleep 5
  WAIT_SECONDS=$((WAIT_SECONDS - 5))
done

if kill -0 $CLAUDE_PID 2>/dev/null; then
  echo "daily-scan: Claude timed out" >&2
  kill $CLAUDE_PID 2>/dev/null
  sleep 2
  kill -9 $CLAUDE_PID 2>/dev/null
fi

RAW_RESULT=$(cat "$RESULT_FILE" 2>/dev/null)
rm -f "$RESULT_FILE" "$PROMPT_FILE"

if [ -z "$RAW_RESULT" ]; then
  echo "daily-scan: No output from Claude" >&2
  exit 1
fi

# JSON部分を抽出（```json ... ``` の中身、またはそのまま）
SCAN_JSON=$(echo "$RAW_RESULT" | python3 -c "
import sys, json, re

raw = sys.stdin.read()

# Try to extract JSON from markdown code block
m = re.search(r'\`\`\`json\s*\n(.*?)\n\s*\`\`\`', raw, re.DOTALL)
if m:
    candidate = m.group(1)
else:
    candidate = raw.strip()

# Validate JSON
try:
    parsed = json.loads(candidate)
    # Add metadata
    parsed['generated_at'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
    parsed['date'] = '$(date +%Y-%m-%d)'
    print(json.dumps(parsed, ensure_ascii=False, indent=2))
except json.JSONDecodeError as e:
    # Fallback: create minimal valid JSON
    fallback = {
        'briefing': raw[:3000],
        'calendar_suggestions': [],
        'task_updates': [],
        'generated_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
        'date': '$(date +%Y-%m-%d)',
        'parse_error': str(e)
    }
    print(json.dumps(fallback, ensure_ascii=False, indent=2))
" 2>/dev/null)

if [ -z "$SCAN_JSON" ]; then
  echo "daily-scan: Failed to parse JSON" >&2
  exit 1
fi

# 結果を保存
echo "$SCAN_JSON" > "$OUTPUT_FILE"
echo "daily-scan: Saved to $OUTPUT_FILE ($(echo "$SCAN_JSON" | wc -c | tr -d ' ') bytes)" >&2

# ブリーフィングテキストを標準出力に返す（morning-briefing.sh用）
echo "$SCAN_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data.get('briefing', ''))
"
