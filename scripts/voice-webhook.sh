#!/bin/bash
# voice-webhook.sh — iPhoneからのWebhook受信サーバー
# Node.js組み込みhttpモジュールで軽量サーバーを起動する
#
# 使い方:
#   ./voice-webhook.sh          # ポート3456で起動（デフォルト）
#   PORT=3457 ./voice-webhook.sh
#
# エンドポイント:
#   POST /voice   — テキストを受信してvoice-to-sns.shに渡す
#   GET  /health  — ヘルスチェック

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
PORT="${PORT:-3456}"
LOG_DIR="$REPO_DIR/logs"
LOG_FILE="$LOG_DIR/voice-webhook.log"

mkdir -p "$LOG_DIR"

export PATH="/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Node.jsのパス確認
NODE_PATH=$(which node 2>/dev/null)
if [ -z "$NODE_PATH" ]; then
  echo "ERROR: Node.jsが見つかりません" >&2
  exit 1
fi

echo "=== voice-webhook サーバー起動 ===" | tee -a "$LOG_FILE"
echo "ポート: $PORT" | tee -a "$LOG_FILE"
echo "エンドポイント: POST http://localhost:$PORT/voice" | tee -a "$LOG_FILE"
echo "ログ: $LOG_FILE" | tee -a "$LOG_FILE"

# Node.jsインラインスクリプトでHTTPサーバーを起動
node - "$PORT" "$SCRIPT_DIR/voice-to-sns.sh" "$LOG_FILE" "$SCRIPT_DIR/notion-task-inject.js" << 'NODE_EOF'
const http = require('http');
const { exec, execFile } = require('child_process');
const port = parseInt(process.argv[2], 10);
const voiceScript = process.argv[3];
const logFile = process.argv[4];
const taskInjectScript = process.argv[5];
const fs = require('fs');

// タスクマーカー検出 — notion-task-inject.jsと同じ正規表現
const TASK_MARKER_RE = /^\s*(?:タスク|ToDo|TODO|todo|やること|やる事|task|Task|TASK)\s*[:：]/;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(logFile, line, { encoding: 'utf8' });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // ヘルスチェック
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  // 音声テキスト受信
  if (req.method === 'POST' && url === '/voice') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      log(`POST /voice — body length: ${body.length}`);

      let text = '';
      try {
        const parsed = JSON.parse(body);
        // { "text": "..." } 形式
        text = (parsed.text || '').trim();
      } catch {
        // プレーンテキストとして扱う
        text = body.trim();
      }

      if (!text) {
        log('ERROR: テキストが空');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'テキストが空です', status: 'error' }));
        return;
      }

      log(`テキスト受信（${text.length}字）: ${text.slice(0, 50)}...`);

      // タスクマーカー検出 → Notion投入ルート
      if (TASK_MARKER_RE.test(text)) {
        log(`タスクマーカー検出 — Notion投入開始`);
        execFile('node', [taskInjectScript, text], { timeout: 30000 }, (err, stdout, stderr) => {
          let result = null;
          try { result = JSON.parse(stdout.trim().split('\n').pop()); } catch {}
          if (err || !result || result.created === false) {
            log(`Notion投入失敗: ${err?.message || result?.error || 'unknown'}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', error: result?.error || String(err) }));
            return;
          }
          log(`Notion投入成功: ${result.title} (GTD=${result.gtd}, date=${result.date || 'なし'})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'task_created',
            title: result.title,
            gtd: result.gtd,
            date: result.date,
            tags: result.tags,
            page_url: result.page_url,
            message: `タスクを登録しました: ${result.title}`,
          }));
        });
        return;
      }

      // 通常の音声メモ → SNS生成ルート
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'accepted',
        message: 'SNS投稿案の生成を開始しました。Discord #sns-drafts をご確認ください。',
        chars: text.length
      }));

      // エスケープしてシェルに渡す
      const escaped = text.replace(/'/g, "'\\''");
      const cmd = `'${voiceScript}' '${escaped}' >> '${logFile}' 2>&1`;
      log(`実行: voice-to-sns.sh`);

      const child = exec(cmd, { timeout: 300000 }); // 5分タイムアウト
      child.on('exit', (code) => {
        log(`voice-to-sns.sh 終了 (exit code: ${code})`);
      });
      child.on('error', (err) => {
        log(`voice-to-sns.sh エラー: ${err.message}`);
      });
    });
    return;
  }

  // その他は404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(port, '0.0.0.0', () => {
  log(`サーバー起動完了 — ポート ${port}`);
  log(`POST http://localhost:${port}/voice でテキストを受信します`);
});

server.on('error', (err) => {
  log(`サーバーエラー: ${err.message}`);
  process.exit(1);
});

// シグナルハンドリング
process.on('SIGTERM', () => { log('SIGTERM受信 — シャットダウン'); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { log('SIGINT受信 — シャットダウン');  server.close(() => process.exit(0)); });
NODE_EOF
