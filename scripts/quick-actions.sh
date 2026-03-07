#!/bin/bash
# クイックアクション: qa で起動、番号選択でclaude起動
CONFIG="$(dirname "$0")/../config/quick-actions.json"

if [ ! -f "$CONFIG" ]; then
  echo "quick-actions.json が見つかりません"
  exit 1
fi

# jq で一覧表示
echo ""
echo "  クイックアクション"
echo "  ─────────────────"
COUNT=$(jq length "$CONFIG")
for i in $(seq 0 $((COUNT - 1))); do
  LABEL=$(jq -r ".[$i].label" "$CONFIG")
  echo "  $((i + 1)). $LABEL"
done
echo ""
echo "  0. キャンセル"
echo ""

# 番号入力
read -p "  番号を選択: " NUM

if [ "$NUM" = "0" ] || [ -z "$NUM" ]; then
  exit 0
fi

IDX=$((NUM - 1))
if [ "$IDX" -lt 0 ] || [ "$IDX" -ge "$COUNT" ]; then
  echo "  無効な番号です"
  exit 1
fi

PROMPT=$(jq -r ".[$IDX].prompt" "$CONFIG")
LABEL=$(jq -r ".[$IDX].label" "$CONFIG")
echo ""
echo "  → $LABEL"
echo ""

# claude を起動（rinaディレクトリで）
cd "$(dirname "$0")/.." || exit 1
exec /Users/Inaryo/.local/bin/claude "$PROMPT"
