# OpenClaw セキュリティ硬化ガイド（Mac mini + Slack）

> 最終更新: 2026-03-23
> 対象バージョン: v2026.2.26 以降必須（CVE-2026-25253 修正済み）
> 実行環境: Mac mini（稼働中）、Slack 経由で API 通信

## 現在の構成

```
┌──────────────────────────────┐
│  Ryo（iPhone / MacBook）      │
│  └─ Slack App                │
└──────────────┬───────────────┘
               │ Slack API
┌──────────────▼───────────────┐
│  Mac mini（OpenClaw 稼働中）   │
│  ├─ OpenClaw Gateway         │
│  ├─ Slack チャネル連携         │
│  └─ Anthropic Claude API     │
└──────────────────────────────┘
```

---

## セキュリティチェックリスト

以下を順番に確認・適用していく。**既にできていればスキップ。**

### 1. バージョン確認（最重要）

```bash
openclaw --version
```

v2026.2.26 未満なら即アップデート。RCE 脆弱性（CVE-2026-25253）の対象。

```bash
npm update -g openclaw@latest
```

### 2. Gateway のバインド確認

```bash
# 現在の設定確認
cat ~/.openclaw/openclaw.json | grep -A5 gateway
```

**確認ポイント:**
- `bind` が `"loopback"` になっているか（外部公開されていないか）
- Gateway トークン認証が有効になっているか（2026年2月パッチで必須化）

```json
{
  "gateway": {
    "bind": "loopback",
    "port": 18789
  }
}
```

もし `bind` が `"0.0.0.0"` や未設定なら、Shodan 等から見える状態になっている可能性がある。即修正。

### 3. ファイルパーミッション

```bash
# 設定ディレクトリ
chmod 700 ~/.openclaw
chmod 600 ~/.openclaw/openclaw.json

# credentials があれば
ls ~/.openclaw/credentials/ 2>/dev/null && chmod 600 ~/.openclaw/credentials/*
```

### 4. API キーの管理

**NG:** `openclaw.json` に平文でキーを書く
**OK:** 環境変数で渡す

```bash
# 確認: openclaw.json にキーが直書きされていないか
grep -i "apikey\|api_key\|secret\|token" ~/.openclaw/openclaw.json
```

もし平文で書かれていたら、環境変数方式に切り替え：

```bash
# ~/.zshrc に追加
export ANTHROPIC_API_KEY="sk-ant-xxxxx"

# openclaw.json では変数参照にする
# "apiKey": "$ANTHROPIC_API_KEY"
```

### 5. サンドボックス設定

```bash
# 現在のサンドボックス設定確認
cat ~/.openclaw/openclaw.json | grep -A10 sandbox
```

推奨設定:

```json
{
  "sandbox": {
    "mode": "non-main",
    "scope": "session"
  }
}
```

Docker サンドボックスも使える場合（Docker がインストール済みの場合）：

```json
{
  "sandbox": {
    "mode": "non-main",
    "scope": "session",
    "docker": {
      "image": "openclaw/sandbox:latest",
      "network": "none",
      "readOnlyRoot": true
    }
  }
}
```

### 6. deny リスト（危険なコマンドのブロック）

```json
{
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

### 7. 専用ユーザーでの実行（推奨）

現在 root や Ryo の個人アカウントで実行している場合は、専用ユーザーに切り替えることを推奨。

```bash
# 専用ユーザー作成
sudo dscl . -create /Users/openclaw
sudo dscl . -create /Users/openclaw UserShell /bin/zsh
sudo dscl . -create /Users/openclaw RealName "OpenClaw Agent"
sudo dscl . -create /Users/openclaw UniqueID 550
sudo dscl . -create /Users/openclaw PrimaryGroupID 20
sudo dscl . -create /Users/openclaw NFSHomeDirectory /Users/openclaw
sudo mkdir -p /Users/openclaw
sudo chown openclaw:staff /Users/openclaw
```

これにより OpenClaw が Ryo の個人ファイルにアクセスできなくなる。

### 8. ClawHub スキルの制限

ClawHub（サードパーティスキルのマーケットプレイス）は汚染リスクが報告されている。

**方針: ClawHub のスキルは使わない。自作 or 検証済みのみ使用。**

```json
{
  "plugins": {
    "marketplace": {
      "enabled": false
    }
  }
}
```

---

## 最終確認チェックリスト

```
□ OpenClaw バージョンが v2026.2.26 以上
□ Gateway が loopback にバインドされている
□ Gateway トークン認証が有効
□ ~/.openclaw/ のパーミッションが 700
□ ~/.openclaw/openclaw.json のパーミッションが 600
□ API キーが環境変数で管理されている（平文保存なし）
□ サンドボックスモードが ON
□ deny リストが設定されている
□ ClawHub マーケットプレイスが無効化されている
□ Slack 経由で正常に応答が返ってくる
```

---

## Tailscale の追加（任意）

Mac mini へのリモート SSH アクセスを安全にしたい場合は Tailscale を追加。

```bash
brew install tailscale
tailscale up --ssh
```

Tailscale を入れると：
- パブリック IP 不要で Mac mini に SSH できる
- Gateway を Tailscale Serve で公開すれば、外出先からも安全にアクセス可能

**Slack 経由で十分なら Tailscale は必須ではない。** SSH アクセスが必要になったら検討。

---

## トラブルシューティング

### Gateway が起動しない

```bash
launchctl list | grep openclaw
cat ~/Library/Logs/openclaw/gateway.log
```

### deny リストが効かない

- サンドボックスのツールポリシーとエージェントの deny リストは**独立している**
- 両方で制限する必要がある

### Slack メッセージが届かない

```bash
openclaw logs --channel slack
```

---

## 参考リンク

- [OpenClaw 公式セキュリティガイド](https://docs.openclaw.ai/gateway/security)
- [OpenClaw CVE トラッカー](https://github.com/jgamblin/OpenClawCVEs/)
- [セキュアな OpenClaw セルフホスト（dsebastien.net）](https://www.dsebastien.net/how-to-self-host-openclaw-securely-on-a-vps-a-security-first-guide/)
- [Microsoft: OpenClaw を安全に実行する方法](https://www.microsoft.com/en-us/security/blog/2026/02/19/running-openclaw-safely-identity-isolation-runtime-risk/)
