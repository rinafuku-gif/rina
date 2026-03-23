# OpenClaw セットアップガイド（Mac mini + Tailscale）

> 最終更新: 2026-03-23
> 対象バージョン: v2026.3.x（v2026.2.26以降必須）
> 実行環境: Mac mini（クリーンインストール済み・専用機）

## 構成概要

```
┌─────────────────────────────────────────────┐
│  iPhone / MacBook（外出先）                    │
│  └─ Tailscale VPN                            │
│      └─ SSH / LINE / Telegram                │
└──────────────┬──────────────────────────────┘
               │ Tailscale Mesh VPN
┌──────────────▼──────────────────────────────┐
│  Mac mini（OpenClaw 専用機）                   │
│  ├─ OpenClaw Gateway (localhost:18789)       │
│  ├─ Tailscale Serve (HTTPS)                  │
│  ├─ Cloudflare Tunnel (LINE Webhook用)       │
│  └─ サンドボックス環境                          │
└─────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│  外部API                                     │
│  ├─ Anthropic Claude API                     │
│  ├─ LINE Messaging API                       │
│  └─ Google Calendar / etc.                   │
└─────────────────────────────────────────────┘
```

## セキュリティ方針

| 原則 | 実装 |
|------|------|
| 専用マシン | Mac mini をクリーンインストールし、OpenClaw 専用で使用 |
| 最小権限 | 専用ユーザー `openclaw` で実行（root 禁止） |
| ネットワーク隔離 | Gateway は localhost のみ。外部アクセスは Tailscale 経由 |
| 認証必須 | Gateway トークン + Tailscale ID 認証 |
| LINE Webhook | Cloudflare Tunnel 経由（既存の `api.tonari2tomaru.com` を活用） |
| サンドボックス | サンドボックスモード ON |
| APIキー管理 | 環境変数で管理、設定ファイルに平文保存しない |

---

## Step 1: Mac mini 初期セットアップ

### 1-1. 専用ユーザーの作成

```bash
# 管理者アカウントで実行
sudo dscl . -create /Users/openclaw
sudo dscl . -create /Users/openclaw UserShell /bin/zsh
sudo dscl . -create /Users/openclaw RealName "OpenClaw Agent"
sudo dscl . -create /Users/openclaw UniqueID 550
sudo dscl . -create /Users/openclaw PrimaryGroupID 20
sudo dscl . -create /Users/openclaw NFSHomeDirectory /Users/openclaw
sudo mkdir -p /Users/openclaw
sudo chown openclaw:staff /Users/openclaw

# パスワード設定
sudo dscl . -passwd /Users/openclaw <パスワード>
```

### 1-2. Node.js 22 インストール

```bash
# openclaw ユーザーでログイン後
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.zshrc
nvm install 22
nvm use 22
node -v  # v22.x.x を確認
```

### 1-3. Tailscale インストール

```bash
# Homebrew でインストール
brew install tailscale

# 起動・ログイン
sudo tailscaled &
tailscale up --ssh
```

---

## Step 2: OpenClaw インストール

### 2-1. インストール

```bash
# openclaw ユーザーで実行
npm install -g openclaw@latest
openclaw --version  # v2026.3.x を確認
```

### 2-2. オンボーディング

```bash
# Gateway デーモンも自動インストール
openclaw onboard --install-daemon
```

- Gateway が `http://127.0.0.1:18789/` で起動
- macOS では launchd デーモンとして自動起動に登録される

### 2-3. APIキーの設定（環境変数方式）

```bash
# ~/.zshrc に追加（平文ファイルには保存しない）
echo 'export ANTHROPIC_API_KEY="sk-ant-xxxxx"' >> ~/.zshrc
source ~/.zshrc

# onboard で API キーを登録
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

---

## Step 3: セキュリティ設定

### 3-1. メイン設定ファイル（`~/.openclaw/openclaw.json`）

```json
{
  "gateway": {
    "bind": "loopback",
    "port": 18789,
    "auth": {
      "allowTailscale": true
    },
    "tailscale": {
      "mode": "serve"
    }
  },
  "sandbox": {
    "mode": "non-main",
    "scope": "session",
    "docker": {
      "image": "openclaw/sandbox:latest",
      "network": "none",
      "readOnlyRoot": true
    }
  },
  "models": {
    "providers": {
      "anthropic": {
        "apiKey": "$ANTHROPIC_API_KEY"
      }
    },
    "defaults": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514"
    }
  },
  "agents": {
    "tools": {
      "deny": [
        "exec:rm -rf /",
        "exec:rm -rf ~",
        "exec:curl * | sh",
        "exec:wget * | bash",
        "exec:chmod 777",
        "exec:sudo *",
        "exec:env",
        "exec:printenv",
        "exec:cat .env*"
      ]
    }
  }
}
```

### 3-2. ファイルパーミッションの設定

```bash
chmod 700 ~/.openclaw
chmod 600 ~/.openclaw/openclaw.json
chmod 600 ~/.openclaw/credentials/*
```

### 3-3. Tailscale Serve の有効化

```bash
# Gateway を Tailscale 経由でセキュアに公開（Tailnet内のみ）
openclaw config set gateway.tailscale.mode serve

# 確認
tailscale serve status
```

---

## Step 4: LINE 連携（Cloudflare Tunnel 経由）

### 4-1. OpenClaw の LINE プラグインを有効化

```json
{
  "plugins": {
    "entries": {
      "line": {
        "enabled": true
      }
    }
  }
}
```

### 4-2. LINE Developers Console の設定

1. [LINE Developers Console](https://developers.line.biz/) でMessaging API チャネルを作成
   - ※既存のしらたま用とは別チャネルを作成する
2. Channel Access Token と Channel Secret を取得
3. 自動応答メッセージ → 無効
4. あいさつメッセージ → 無効

### 4-3. Cloudflare Tunnel で Webhook エンドポイント公開

```bash
# 既存の Cloudflare Tunnel を活用
# 例: openclaw.tonari2tomaru.com → localhost:18789

cloudflared tunnel route dns <tunnel-name> openclaw.tonari2tomaru.com
```

LINE Developers Console で Webhook URL を設定：
```
https://openclaw.tonari2tomaru.com/webhook/line
```

### 4-4. 環境変数の追加

```bash
echo 'export LINE_CHANNEL_ACCESS_TOKEN="xxxxx"' >> ~/.zshrc
echo 'export LINE_CHANNEL_SECRET="xxxxx"' >> ~/.zshrc
source ~/.zshrc
```

---

## Step 5: 動作確認チェックリスト

```
□ openclaw --version で最新版を確認
□ Gateway が localhost:18789 で起動している
□ Tailscale SSH で Mac mini にアクセスできる
□ Tailscale Serve で Gateway にアクセスできる
□ サンドボックスモードが ON になっている
□ Claude API でチャット応答が返ってくる
□ LINE Webhook で メッセージ送受信できる
□ deny リストのコマンドがブロックされることを確認
□ ~/.openclaw/ のパーミッションが 700/600 になっている
```

---

## しらたまとの棲み分け

| 機能 | しらたま | OpenClaw |
|------|---------|----------|
| 朝ブリーフィング | ○（LINE Push） | △（設定次第） |
| 経費記帳 | ○（チャット入力） | ○（チャット入力） |
| カレンダー操作 | ○（MCP連携） | ○（スキル） |
| ファイル操作 | ×（API経由のみ） | ○（直接アクセス） |
| ブラウザ操作 | × | ○ |
| 自律的タスク実行 | × | ○（24/7 稼働） |
| マルチチャネル | LINE のみ | LINE + Telegram + 他 |

### 推奨する棲み分け

- **しらたま**: 既存の安定したワークフロー（朝ブリーフィング、経費記帳、カレンダー）を継続
- **OpenClaw**: 新しい自律型タスク（情報収集、Web スクレイピング、自動化実験）に使用
- 将来的にはしらたまの機能を OpenClaw に統合していく可能性あり

---

## トラブルシューティング

### Gateway が起動しない

```bash
# launchd のステータス確認
launchctl list | grep openclaw

# ログ確認
cat ~/Library/Logs/openclaw/gateway.log
```

### Tailscale 接続できない

```bash
tailscale status
tailscale ping <mac-mini-hostname>
```

### LINE Webhook が届かない

```bash
# Cloudflare Tunnel のステータス確認
cloudflared tunnel info <tunnel-name>

# OpenClaw のログで Webhook 受信を確認
openclaw logs --channel line
```

---

## 参考リンク

- [OpenClaw 公式ドキュメント](https://docs.openclaw.ai/)
- [OpenClaw Docker セットアップ](https://docs.openclaw.ai/install/docker)
- [OpenClaw セキュリティガイド](https://docs.openclaw.ai/gateway/security)
- [OpenClaw Tailscale 連携](https://docs.openclaw.ai/gateway/tailscale)
- [OpenClaw LINE 連携ガイド](https://medium.com/@tentenco/how-to-connect-openclaw-to-line-setup-guide-and-best-practices-for-ai-powered-customer-service-45a1f7032729)
- [Mac mini + OpenClaw 常時稼働ガイド](https://www.mager.co/blog/2026-02-22-openclaw-mac-mini-tailscale/)
