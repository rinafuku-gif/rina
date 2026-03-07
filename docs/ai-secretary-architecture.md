# AI秘書システム 構築ガイド

> iPhone × Mac mini × Claude Code で構築する、個人向けAI秘書の全体アーキテクチャと構築手順。
> レシート自動管理、LINE双方向チャット、朝ブリーフィング配信、Web Push通知までをカバー。

## 全体アーキテクチャ

```
iPhone                        Mac mini (常時起動)                    外部サービス
┌──────────────┐             ┌─────────────────────────┐           ┌──────────────┐
│ LINE公式     │──webhook──→│ line-webhook-server.js  │──API────→│ Google Drive  │
│ アカウント   │←──reply────│ (port 3100)             │──API────→│ Google Sheets │
│              │             │                         │──API────→│ Google Cal    │
│ ショートカット│──POST────→│ /api/receipt-quick      │           │              │
│ (レシート撮影)│            │                         │──push──→│ LINE API     │
│              │             │ claude -p (OCR/AI)      │           │              │
│ しらたまPWA  │←─Web Push─│ web-push                │           │ Vercel       │
│              │             │                         │           │ (しらたまPWA) │
└──────────────┘             │ cloudflared tunnel      │           └──────────────┘
                             │ → api.tonari2tomaru.com │
                             └─────────────────────────┘
                                      ↑
                             launchd (自動起動)
                             ├ com.rina.line-bot (常時)
                             └ com.rina.morning-briefing (毎朝7:00)
```

## 必要な環境・サービス

### ハードウェア
- Mac mini（または常時起動できるMac）— サーバーとして使用
- iPhone — LINE・ショートカット・PWA通知の受信

### 外部サービス（すべて無料枠で運用可能）
- **LINE Messaging API** — 無料プラン（Push月200通、Reply無制限）
- **Google Cloud** — Drive API, Sheets API, Calendar API（無料枠内）
- **Cloudflare** — Named Tunnel（無料、固定URL）
- **Vercel** — PWAホスティング（無料枠）
- **Claude Code** — AI処理エンジン（claude -p コマンド）

### 主要パッケージ
- Node.js（v18+）
- cloudflared（Homebrew: `brew install cloudflared`）
- web-push（npm パッケージ）

---

## 1. LINE Bot（双方向チャット）

### 概要
LINEでメッセージを送ると、Claude Code がAIとして返答する仕組み。
Webhook でメッセージを受信し、Reply API で即座に「処理中...」を返し、バックグラウンドで `claude -p` を実行、結果を Push API で送信する。

### セットアップ手順

#### 1-1. LINE公式アカウント作成
1. [LINE Developers](https://developers.line.biz/) でプロバイダー作成
2. Messaging API チャネルを作成
3. 以下を取得:
   - Channel Access Token（長期）
   - Channel Secret
   - ユーザーID（自分のLINE ID）

#### 1-2. Webhook サーバー構築

```javascript
// scripts/line-webhook-server.js の基本構造
const http = require("http");
const crypto = require("crypto");

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/webhook") {
    // 1. LINE署名検証
    // 2. メッセージ受信
    // 3. Reply API で「処理中...」を即返信
    // 4. バックグラウンドで claude -p 実行
    // 5. Push API で結果を送信
  }
});

server.listen(3100);
```

#### 重要ポイント: claude -p の呼び出し

```javascript
const { execSync } = require("child_process");

// CLAUDECODE 環境変数を削除しないとネストエラーになる
const env = { ...process.env };
delete env.CLAUDECODE;

// プロンプトはファイル経由で渡す（シェル特殊文字対策）
fs.writeFileSync("/tmp/prompt.txt", userMessage);
const result = execSync(
  `cat "/tmp/prompt.txt" | claude -p --dangerously-skip-permissions`,
  { env, timeout: 300000 }
).toString();
```

#### 1-3. launchd で自動起動

```xml
<!-- ~/Library/LaunchAgents/com.rina.line-bot.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rina.line-bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/path/to/scripts/start-line-bot.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.rina.line-bot.plist
```

---

## 2. Cloudflare Named Tunnel（固定URL）

### なぜ必要か
Mac mini はプライベートネットワーク内にあるため、外部（LINE Webhook、iPhoneショートカット）からアクセスできない。Cloudflare Tunnel を使えば、固定ドメインで安全に公開できる。

Quick Tunnel（`trycloudflare.com`）はURLが毎回変わるため、Named Tunnel で固定化する。

### セットアップ手順

```bash
# 1. cloudflared インストール
brew install cloudflared

# 2. Cloudflare にログイン（ブラウザが開く）
cloudflared tunnel login

# 3. トンネル作成
cloudflared tunnel create rina-api

# 4. DNSルーティング設定
cloudflared tunnel route dns rina-api api.yourdomain.com

# 5. 設定ファイル作成
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: <tunnel-id>
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: api.yourdomain.com
    service: http://localhost:3100
  - service: http_status:404
EOF

# 6. 起動
cloudflared tunnel run rina-api
```

### 前提条件
- Cloudflare でドメインを管理していること（ネームサーバーをCloudflareに向ける）
- Google Domains 等から移行する場合はネームサーバー変更が必要

---

## 3. レシート自動経費管理

### 概要
iPhoneのアクションボタンでレシートを撮影 → APIに送信 → AI-OCRで読み取り → Google Drive に画像保存 → Google Sheets に仕訳データ記帳 → Web Push で完了通知。

### 処理フロー

```
[iPhone ショートカット]
  1. 写真を選択（複数可）
  2. 各項目を繰り返す
     → 画像のサイズを変更（幅1200, 縦横比維持）  ← 重要: 圧縮しないとタイムアウト
     → 画像を変換（JPEG, 品質70%）
     → URLの内容を取得（POST /api/receipt-quick）
  3. 繰り返し終了
  4. 写真を削除

[サーバー側]
  1. 即座に HTTP 200 レスポンス（ショートカットがタイムアウトしないため）
  2. バックグラウンドでキューに追加
  3. 順次処理:
     a. HEIC判定 → sips で JPEG変換
     b. claude -p でOCR（日付・金額・店名・支払方法・勘定科目を抽出）
     c. Google Drive に月別フォルダで画像保存
     d. Google Sheets に仕訳データ追記
     e. Web Push で結果通知
```

### ハマりポイントと解決策

#### HEIC フォーマット対応
iPhoneの写真はHEIC形式。ファイルヘッダーの magic bytes で判定する。

```javascript
// ファイル先頭の magic bytes で HEIC を判定
const header = buffer.slice(0, 12).toString("ascii");
const isHeic = header.includes("ftyp");

if (isHeic) {
  // sips コマンドで JPEG に変換（macOS標準）
  execSync(`sips -s format jpeg --resampleWidth 2000 -s formatOptions 90 "${inputPath}" --out "${outputPath}"`);
}
```

#### 同時実行の防止（処理キュー）
`claude -p` を同時に複数実行するとクラッシュする。キューで順次処理する。

```javascript
const receiptQueue = [];
let isProcessing = false;

function enqueueReceipt(task) {
  receiptQueue.push(task);
  if (!isProcessing) processNext();
}

async function processNext() {
  if (receiptQueue.length === 0) { isProcessing = false; return; }
  isProcessing = true;
  const task = receiptQueue.shift();
  try {
    await processReceipt(task);
  } finally {
    processNext();
  }
}
```

#### Google Drive 月フォルダの重複防止
同時リクエストで同じ月のフォルダが2つ作られる問題。in-memory lock で解決。

```javascript
const _folderLocks = {};

async function getOrCreateMonthFolder(yearMonth) {
  if (_folderLocks[yearMonth]) return _folderLocks[yearMonth];
  _folderLocks[yearMonth] = (async () => {
    // 既存フォルダ検索 → なければ作成
  })();
  return _folderLocks[yearMonth];
}
```

#### OCR精度の確保
プロンプトに具体的なルールを明記することで精度が上がる。

- 日付: 「レシートに印字された取引日を読み取る。今日の日付を使わない」
- 金額: 「合計金額を読み取る。税込の最終支払額」
- 支払方法: 使用する決済手段を列挙し、判定ルールを明記
- 出力形式: JSON スキーマを厳密に指定

#### iPhone ショートカットのタイムアウト対策
- サーバー側を **非同期処理** にする（即座に200を返す → バックグラウンド処理 → Push通知）
- ショートカット側で **画像を圧縮** する（2MB→200KB で転送時間 7.6s→1s）
- 圧縮は「画像のサイズを変更」+「画像を変換(JPEG/70%)」アクションで実現

---

## 4. Web Push 通知（LINE制限の代替）

### なぜ LINE Push ではダメか
LINE Messaging API 無料プランは Push メッセージ月200通制限。レシート通知を毎回送ると月半ばで枯渇する。Web Push API は無料で無制限。

### アーキテクチャ

```
[しらたまPWA]                      [Mac mini サーバー]
  ブラウザ起動時
  → SW登録 (public/sw.js)          GET /api/vapid-public-key
  → 通知許可バナー表示                → VAPID公開鍵を返す
  → ユーザーが「許可」タップ
  → pushManager.subscribe()        POST /api/push-subscribe
  → サブスクリプション送信 ─────→    → logs/.push-subscriptions.json に保存

  [レシート処理完了時]
  ← Push通知受信 ←──────────────── web-push.sendNotification()
  → SW が showNotification()
```

### セットアップ手順

#### 4-1. VAPID鍵の生成

```bash
npx web-push generate-vapid-keys
# Public Key と Private Key を .env に保存
```

#### 4-2. サーバー側（Node.js）

```javascript
const webpush = require("web-push");

webpush.setVapidDetails(
  "mailto:you@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// サブスクリプション保存
let subscriptions = [];

// エンドポイント: 公開鍵配布
// GET /api/vapid-public-key → { publicKey: "..." }

// エンドポイント: サブスクリプション登録
// POST /api/push-subscribe → subscriptions に追加して永続化

// 通知送信関数
async function sendWebPush(title, body) {
  const payload = JSON.stringify({ title, body });
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (e) {
      if (e.statusCode === 410) {
        // 期限切れのサブスクリプションを削除
      }
    }
  }
}
```

#### 4-3. PWA側（Next.js）

**public/sw.js** — Service Worker（手動配置）
```javascript
self.addEventListener("push", (event) => {
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});
```

**PushSubscriber.tsx** — 通知許可 + 購読コンポーネント
```tsx
// 重要: iOS では Notification.requestPermission() を
// ユーザージェスチャー（ボタンタップ）から呼ばないとブロックされる。
// setTimeout や useEffect からの自動呼び出しは動かない。
```

### ハマりポイント

1. **next-pwa は Next.js 16 (Turbopack) と非互換** — Webpack プラグインのため。sw.js を public/ に手動配置して Service Worker を自前登録する方式に切り替える。

2. **iOS の通知許可はユーザージェスチャー必須** — `setTimeout` や `useEffect` からの `Notification.requestPermission()` はサイレントに無視される。バナーUIを表示して、ユーザーのタップイベント内で呼び出す。

3. **Vercel 環境変数の改行混入** — `echo "value" | vercel env add` だと改行が含まれる場合がある。`printf 'value' | vercel env add` を使う。

4. **PWA はホーム画面追加が必要（iOS）** — Safari で開いただけでは Web Push は機能しない。ホーム画面に追加した PWA として開く必要がある。

---

## 5. 朝ブリーフィング自動配信

### 概要
毎朝7:00に、その日の予定・タスク・直近のアクションを自動生成して LINE に送信。

```bash
#!/bin/bash
# scripts/morning-briefing.sh
CLAUDE="/Users/you/.local/bin/claude"
REPO="/path/to/repo"

cd "$REPO"
BRIEFING=$("$CLAUDE" -p "今日のブリーフィングを作成して..." --dangerously-skip-permissions 2>/dev/null)

# LINE Push API で送信
curl -s -X POST https://api.line.me/v2/bot/message/push \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
  -d "{\"to\":\"$LINE_USER_ID\",\"messages\":[{\"type\":\"text\",\"text\":\"$BRIEFING\"}]}"
```

launchd で毎朝7:00に実行:
```xml
<key>StartCalendarInterval</key>
<dict>
  <key>Hour</key>
  <integer>7</integer>
  <key>Minute</key>
  <integer>0</integer>
</dict>
```

---

## 環境変数一覧 (.env)

```
# LINE
LINE_CHANNEL_ACCESS_TOKEN=xxx
LINE_USER_ID=xxx
LINE_CHANNEL_SECRET=xxx

# Google API
GOOGLE_CLIENT_ID=xxx
GOOGLE_CLIENT_SECRET=xxx
GOOGLE_REFRESH_TOKEN=xxx
GOOGLE_RECEIPT_FOLDER_ID=xxx     # Drive のレシート保存先フォルダID
GOOGLE_EXPENSE_SHEET_ID=xxx      # Sheets のスプレッドシートID

# Web Push
VAPID_PUBLIC_KEY=xxx
VAPID_PRIVATE_KEY=xxx

# API認証
SHIRATAMA_API_TOKEN=xxx          # エンドポイント認証用トークン
```

---

## コスト

| サービス | 費用 |
|---|---|
| LINE Messaging API（無料プラン） | 0円 |
| Google Cloud APIs | 0円（無料枠内） |
| Cloudflare Tunnel | 0円 |
| Vercel（Hobby） | 0円 |
| Claude Code | 使用量に応じた課金 |
| **合計** | **ほぼ0円**（Claude Code 利用料のみ） |

---

## 今後の拡張構想

- **財務ダッシュボード**: しらたまPWA内に円グラフ・棒グラフで支出を可視化、AIによる支出予測・アラート
- **売上自動取得**: Airbnb・Stripe等からの売上データを自動連携し、確定申告までシームレスに
- **音声入力対応**: ショートカットの音声認識 → テキスト化 → Claude で処理
