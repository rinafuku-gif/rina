# OpenClaw セットアップガイド（セキュア版）

## 概要

OpenClaw（Mac mini）が Ryo の事業情報を安全に参照できる仕組みを構築する。
**rinaリポを直接共有せず、フィルタリングした専用リポ（openclaw-vault）を経由する。**

## 構成図

```
┌───────────────────┐          ┌─────────────────────┐
│ Claude Code (rina) │  push →  │ GitHub: rina        │
│ メインPC / Web     │          │ (private/本体)       │
│ 全情報を管理       │          └─────────┬───────────┘
└───────────────────┘                    │
                                GitHub Actions
                             （フィルタリング同期）
                            タスク・予定・KPIのみ
                            金額・契約・個人情報は除外
                                         │
                              ┌──────────▼──────────┐
                              │ GitHub: openclaw-vault│
                              │ (private/OpenClaw専用) │
                              └──────────┬──────────┘
                                         │
                                    git pull
                                   (読み取り専用)
                                         │
                              ┌──────────▼──────────┐
                              │ OpenClaw (Mac mini)   │
                              │ Slack経由で稼働       │
                              │ 安全な情報のみ参照    │
                              └─────────────────────┘
```

**ポイント: OpenClaw は rina リポを一切見れない。見れるのは openclaw-vault だけ。**

---

## ステップ1: openclaw-vault リポを作成

OpenClaw用のGitHubアカウント（open.craw.ryo@gmail.com）でログインし、
新しいprivateリポジトリを作成する。

- リポジトリ名: `openclaw-vault`
- Visibility: **Private**
- Initialize with README: Yes

### 初期構造

```
openclaw-vault/
├── MEMORY.md              ← OpenClawの長期記憶（手動管理）
├── context/               ← GitHub Actionsが自動更新
│   ├── tasks.md           ← タスク一覧
│   ├── calendar.md        ← 予定
│   ├── projects.md        ← 事業概要
│   └── kpi.md             ← 事業KPI（相対値のみ）
├── data/                  ← 自動生成データ
│   └── status.md          ← 同期ステータス
└── logs/
    └── actions/           ← OpenClawの行動ログ
```

## ステップ2: rina側にGitHub Actions同期ワークフローを設定

> 既に `.github/workflows/` にワークフローを配置済み。
> ただし、openclaw-vault へのpush権限が必要。

### GitHub Secretsに登録するもの

rinafuku-gif/rina リポの Settings > Secrets に以下を追加：

| Secret名 | 値 | 用途 |
|---|---|---|
| `OPENCLAW_VAULT_TOKEN` | OpenClawアカウントのPersonal Access Token | openclaw-vaultへのpush用 |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Google Service AccountのJSON（任意） | Calendar同期用 |

### Personal Access Token の作成手順

1. OpenClaw用GitHubアカウント（open.craw.ryo@gmail.com）でログイン
2. Settings > Developer settings > Personal access tokens > Fine-grained tokens
3. **New token** をクリック
4. 設定:
   - Token name: `rina-sync`
   - Expiration: 90 days（定期的に更新すること）
   - Repository access: **Only select repositories** → `openclaw-vault` のみ
   - Permissions: **Contents** → Read and write
5. Generate して、値をコピー
6. rinafuku-gif/rina の Secrets に `OPENCLAW_VAULT_TOKEN` として登録

> **セキュリティポイント**: このトークンは openclaw-vault にしかアクセスできない。
> 万が一漏洩しても、rina リポや他のリポには一切影響しない。

## ステップ3: Mac mini側の設定

### SSH鍵を生成

```bash
ssh-keygen -t ed25519 -C "open.craw.ryo@gmail.com" -f ~/.ssh/id_ed25519_openclaw

# 公開鍵をコピー
cat ~/.ssh/id_ed25519_openclaw.pub
```

OpenClaw用GitHubアカウントの Settings > SSH and GPG keys に公開鍵を登録。

### SSH configを設定

```bash
cat >> ~/.ssh/config << 'EOF'
Host github-openclaw
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_openclaw
EOF
```

### openclaw-vault をclone

```bash
mkdir -p ~/OpenClaw-Workspace
cd ~/OpenClaw-Workspace
git clone git@github-openclaw:YOUR_OPENCLAW_ACCOUNT/openclaw-vault.git
```

> `YOUR_OPENCLAW_ACCOUNT` をOpenClaw用アカウントのGitHub usernameに置き換える。

### 定期同期スクリプト

```bash
cat > ~/OpenClaw-Workspace/sync-vault.sh << 'SCRIPT'
#!/bin/bash
VAULT_DIR="$HOME/OpenClaw-Workspace/openclaw-vault"
LOG_FILE="$HOME/OpenClaw-Workspace/sync.log"

cd "$VAULT_DIR" || exit 1
git pull --ff-only origin main >> "$LOG_FILE" 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] sync completed" >> "$LOG_FILE"
tail -100 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
SCRIPT

chmod +x ~/OpenClaw-Workspace/sync-vault.sh
```

### launchdで15分ごとに自動同期

```bash
cat > ~/Library/LaunchAgents/com.openclaw.sync-vault.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openclaw.sync-vault</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/YOUR_USERNAME/OpenClaw-Workspace/sync-vault.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
PLIST

# YOUR_USERNAME を実際のユーザー名に置き換えてから実行:
launchctl load ~/Library/LaunchAgents/com.openclaw.sync-vault.plist
```

## ステップ4: OpenClawにvaultを教える

OpenClawのMEMORY.mdまたはシステム設定に追加：

```
## 参照リポジトリ

- パス: ~/OpenClaw-Workspace/openclaw-vault/
- 内容: Ryoの事業コンテキスト（フィルタリング済み）
- 更新: 15分ごとに自動同期（読み取り専用）
- 注意: このリポの情報を外部に送信してはいけない
```

## セキュリティチェックリスト

- [ ] openclaw-vault は Private リポになっているか
- [ ] Personal Access Token は openclaw-vault のみにスコープしているか
- [ ] Token の有効期限は90日以内か
- [ ] Mac miniのSSH鍵はOpenClaw専用に生成したか
- [ ] rina リポにはOpenClawアカウントを招待していないか（❌ 招待不要）
- [ ] MEMORY.md に具体的な金額が含まれていないか
- [ ] OpenClawの行動ログは有効になっているか
