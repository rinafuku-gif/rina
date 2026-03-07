#!/bin/bash
# エラーキャプチャツール
# Usage:
#   error-capture.sh              → 全画面スクショ → ターミナル表示 + OCRテキスト出力
#   error-capture.sh --line       → 上記 + LINE送信
#   error-capture.sh --window     → ウィンドウ選択モード（クリックで選択）
#   error-capture.sh --area       → 範囲選択モード（ドラッグで選択）
#   error-capture.sh --clipboard  → クリップボードの画像を使用

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SCREENSHOT_DIR="$REPO_DIR/logs/screenshots"
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
SCREENSHOT_PATH="$SCREENSHOT_DIR/error-$TIMESTAMP.png"
SEND_LINE=false
CAPTURE_MODE="full"

# .env 読み込み
if [ -f "$REPO_DIR/.env" ]; then
  source "$REPO_DIR/.env"
fi

# 引数解析
for arg in "$@"; do
  case $arg in
    --line)    SEND_LINE=true ;;
    --window)  CAPTURE_MODE="window" ;;
    --area)    CAPTURE_MODE="area" ;;
    --clipboard) CAPTURE_MODE="clipboard" ;;
  esac
done

# スクショディレクトリ作成
mkdir -p "$SCREENSHOT_DIR"

# スクリーンショット取得
echo "📸 スクリーンショットを取得中..."
case $CAPTURE_MODE in
  full)
    screencapture "$SCREENSHOT_PATH"
    ;;
  window)
    echo "   → キャプチャしたいウィンドウをクリックしてください"
    screencapture -w "$SCREENSHOT_PATH"
    ;;
  area)
    echo "   → キャプチャしたい範囲をドラッグしてください"
    screencapture -s "$SCREENSHOT_PATH"
    ;;
  clipboard)
    # クリップボードからpngを取得
    osascript -e 'the clipboard as «class PNGf»' | \
      sed 's/«data PNGf//;s/»//' | xxd -r -p > "$SCREENSHOT_PATH" 2>/dev/null
    if [ ! -s "$SCREENSHOT_PATH" ]; then
      echo "❌ クリップボードに画像がありません"
      exit 1
    fi
    ;;
esac

if [ ! -f "$SCREENSHOT_PATH" ]; then
  echo "❌ スクリーンショットの取得に失敗しました"
  exit 1
fi

FILE_SIZE=$(stat -f%z "$SCREENSHOT_PATH" 2>/dev/null || echo "0")
echo "✅ 保存: $SCREENSHOT_PATH ($((FILE_SIZE / 1024))KB)"

# ターミナルに画像表示（chafa）
echo ""
echo "=== プレビュー ==="
chafa --size=80x40 "$SCREENSHOT_PATH"
echo "=================="

# OCR テキスト抽出
echo ""
echo "=== OCR テキスト抽出 ==="
OCR_TEXT=$(tesseract "$SCREENSHOT_PATH" stdout -l eng+jpn 2>/dev/null || echo "(OCR失敗)")
echo "$OCR_TEXT"
echo "========================"

# OCRテキストをファイルにも保存
OCR_PATH="$SCREENSHOT_DIR/error-$TIMESTAMP.txt"
echo "$OCR_TEXT" > "$OCR_PATH"
echo ""
echo "📝 OCRテキスト保存: $OCR_PATH"

# LINE送信
if [ "$SEND_LINE" = true ]; then
  echo ""
  echo "📱 LINEに送信中..."

  if [ -z "${LINE_CHANNEL_ACCESS_TOKEN:-}" ] || [ -z "${LINE_USER_ID:-}" ]; then
    echo "❌ LINE環境変数が設定されていません（.envを確認）"
    exit 1
  fi

  # 画像をbase64エンコードしてImgBBにアップロード（無料・APIキー不要のサービス）
  # 代替: ローカルサーバーで一時的に公開
  # ここではOCRテキストをLINEテキストメッセージとして送信
  TRUNCATED_TEXT=$(echo "$OCR_TEXT" | head -50)

  LINE_MESSAGE="🚨 エラーキャプチャ\n\n📅 $(date '+%Y/%m/%d %H:%M:%S')\n📁 $SCREENSHOT_PATH\n\n--- OCRテキスト ---\n$TRUNCATED_TEXT"

  curl -s -X POST https://api.line.me/v2/bot/message/push \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
    -d "$(jq -n \
      --arg to "$LINE_USER_ID" \
      --arg text "$LINE_MESSAGE" \
      '{to: $to, messages: [{type: "text", text: $text}]}')" \
    > /dev/null 2>&1

  echo "✅ LINEに送信しました"
fi

# Claude Code 用のヒント
echo ""
echo "💡 Claude Code で分析するには:"
echo "   このターミナルで claude を起動し、以下を貼り付け:"
echo "   「$SCREENSHOT_PATH のエラーを分析して」"
echo "   または OCR テキストをそのままコピペしてください"
