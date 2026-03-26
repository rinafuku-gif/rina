#!/bin/bash
# Claude Code 全プロジェクトの会話ログをスキャンし、進捗サマリーを生成
# daily-scan.sh から呼ばれる想定

CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"
OUTPUT=""

get_project_name() {
  case "$1" in
    *-rina) echo "rina（メインAIアシスタント / 全事業管理）" ;;
    *-hisho-shiratama) echo "秘書しらたまPWA（フロントエンド開発）" ;;
    *-satoyama-ai-base) echo "SATOYAMA AI BASE（Webリニューアル）" ;;
    *-misoca-coffee) echo "三十日珈琲（Webサイト）" ;;
    *) echo "" ;;
  esac
}

for dir in "$CLAUDE_PROJECTS_DIR"/*/; do
  dirname=$(basename "$dir")

  # プロジェクト名を取得（対象外はスキップ）
  project_name=$(get_project_name "$dirname")
  [ -z "$project_name" ] && continue

  # 直近3セッションのJSONLを取得
  sessions=$(ls -t "$dir"*.jsonl 2>/dev/null | head -3)
  [ -z "$sessions" ] && continue

  # 最終更新日時（最新セッション）
  latest=$(echo "$sessions" | head -1)
  last_mod=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$latest" 2>/dev/null)

  # MEMORY.md があれば読む（最大60行）
  memory=""
  memory_file="$dir/memory/MEMORY.md"
  if [ -f "$memory_file" ]; then
    memory=$(head -60 "$memory_file" 2>/dev/null)
  fi

  # 直近3セッションからユーザー発言を抽出（合計最大15件）
  recent_messages=""
  for session in $sessions; do
    session_name=$(basename "$session" .jsonl)
    session_mod=$(stat -f "%Sm" -t "%m/%d %H:%M" "$session" 2>/dev/null)
    msgs=$(grep '"type":"user"' "$session" 2>/dev/null | tail -5 | python3 -c "
import json, sys
for line in sys.stdin:
    try:
        d = json.loads(line)
        msg = d.get('message', {}).get('content', '')
        ts = d.get('timestamp', '')[:16]
        if isinstance(msg, str):
            text = msg[:300].replace('\n', ' ')
        elif isinstance(msg, list):
            text = ''
            for item in msg:
                if isinstance(item, dict) and item.get('type') == 'text':
                    text = item['text'][:300].replace('\n', ' ')
                    break
        else:
            continue
        if text and not text.startswith('<'):
            print(f'  [{ts}] {text}')
    except:
        pass
" 2>/dev/null)
    if [ -n "$msgs" ]; then
      recent_messages="$recent_messages
#### セッション ($session_mod)
$msgs"
    fi
  done

  # 直近3セッションからAIの重要な発言（完了報告・決定事項など）を抽出
  ai_summaries=""
  for session in $sessions; do
    summaries=$(grep '"type":"assistant"' "$session" 2>/dev/null | python3 -c "
import json, sys
keywords = ['完了', '実装', '修正', 'デプロイ', 'コミット', '決定', '提案', '注意', 'エラー', 'バグ', '成功', '失敗']
results = []
for line in sys.stdin:
    try:
        d = json.loads(line)
        msg = d.get('message', {}).get('content', '')
        ts = d.get('timestamp', '')[:16]
        if isinstance(msg, list):
            text = ''
            for item in msg:
                if isinstance(item, dict) and item.get('type') == 'text':
                    text = item['text']
                    break
        elif isinstance(msg, str):
            text = msg
        else:
            continue
        if not text:
            continue
        # キーワードを含む発言のみ（最初の200文字）
        first_line = text.split('\n')[0][:200]
        if any(kw in first_line for kw in keywords):
            results.append(f'  [{ts}] {first_line}')
    except:
        pass
# 直近5件のみ
for r in results[-5:]:
    print(r)
" 2>/dev/null)
    if [ -n "$summaries" ]; then
      ai_summaries="$ai_summaries
$summaries"
    fi
  done

  OUTPUT="$OUTPUT
## ${project_name}
最終更新: ${last_mod}
"

  if [ -n "$memory" ]; then
    OUTPUT="$OUTPUT
### メモリ
${memory}
"
  fi

  if [ -n "$recent_messages" ]; then
    OUTPUT="$OUTPUT
### 直近のユーザー発言（3セッション分）
${recent_messages}
"
  fi

  if [ -n "$ai_summaries" ]; then
    OUTPUT="$OUTPUT
### AIの作業報告（キーワード抽出）
${ai_summaries}
"
  fi

done

echo "$OUTPUT"
