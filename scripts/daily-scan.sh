#!/bin/bash
# 毎朝のAIスキャン：会話ログ + カレンダー + タスクを分析し、提案JSONを生成
# morning-briefing.sh から呼ばれる。結果は logs/.daily-scan.json に保存

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$REPO_DIR/logs"
OUTPUT_FILE="$LOG_DIR/.daily-scan.json"

export PATH="/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
unset CLAUDECODE 2>/dev/null || true

# プロジェクト進捗を収集
PROJECT_CONTEXT=$("$SCRIPT_DIR/scan-projects.sh" 2>/dev/null)

# プロンプトを組み立て
PROMPT_FILE=$(mktemp)
cat > "$PROMPT_FILE" << 'PROMPT_HEADER'
あなたはRyoの専属AI秘書「しらたま」です。
以下の情報源を分析し、JSON形式で提案を出力してください。

## やること
1. Google Calendarで今日・明日の予定を確認
2. CLAUDE.mdのタスク管理セクションを読む
3. 下に添付する「プロジェクト進捗情報」（Claude Code会話ログ）を分析
4. 以下のJSON形式で出力

## 出力JSON形式（これ以外は出力しないこと）

```json
{
  "briefing": "おはよう、Ryo。\n\n📅 今日の予定\n・○○（10:00〜）\n\n📋 タスク・宿題\n・○○\n\n📌 プロジェクト状況\n・○○\n\n🔮 先回りメモ\n・○○の予定を登録した方がよさそう\n・○○のタスクが期限近い\n\n💡 ひとこと\n○○",
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

## ルール
- briefing: LINEで読みやすい朝ブリーフィング。**必ず2000文字以内に収めること（厳守）**
- briefingの文字数制約を守るための書き方ルール:
  - 箇条書きは1項目1行。説明は最小限に（補足があれば「→」で短く添える）
  - 同種の情報はまとめる（例: 予定なし→「特になし」の一言でOK）
  - 冗長な挨拶・前置き・まとめは不要。「おはよう、Ryo。」の一言で始める
  - 「💡 ひとこと」は2行以内。短く刺さる一言にする
  - 情報の優先度: 今日の予定 > 期限の近いタスク > プロジェクト状況 > その他
  - 重要度の低い項目は思い切って省略する
- 「🔮 先回りメモ」セクション: calendar_suggestionsやtask_updatesの内容を人間が読める形で簡潔に記載する（例:「○○の打ち合わせ、カレンダー未登録かも」「○○の期限が近い」）。提案がなければセクションごと省略してOK
- calendar_suggestions: 会話ログからカレンダーに未登録と思われる予定を検出。確実なものだけ。空配列OK
- task_updates:
  - add: 会話で出てきた新しい宿題・やるべきこと
  - update: 既存タスクに進捗があった場合（タイトル修正、状況メモ追加）
  - complete: 完了と判断できるタスク
  - 空配列OK
- calendar_suggestionsとtask_updatesは引き続きJSON内に出力すること（PWAが参照するため）
- priority: カレンダーの空き状況・期日・事業の重要度から総合判断
- 出力は```jsonブロック内のJSONのみ。前後に説明文を入れないこと
- Airbnbチェックアウト判定ルール: カレンダーに宿泊予約が「3/8〜3/10」のように入っている場合、チェックアウト日は最終日の3/10。「3/10チェックアウト」と表記すること。最終日の翌日ではない。えんがわUMEやAirbnb予約では、予約の最終日＝チェックアウト日である
- 重要: このタスクはJSON出力のみ。LINE送信、メール送信、API呼び出し、ファイル書き込みなどの副作用のあるアクションは絶対に実行しないこと。分析と出力だけを行うこと
PROMPT_HEADER

cat >> "$PROMPT_FILE" << PROMPT_PROJECTS

## プロジェクト進捗情報（Claude Code会話ログより自動収集）
${PROJECT_CONTEXT}
PROMPT_PROJECTS

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
