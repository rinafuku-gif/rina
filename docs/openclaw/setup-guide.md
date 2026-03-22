# OpenClaw × rina リポジトリ 共有セットアップガイド

## 概要

OpenClaw（Mac mini）からrinaリポジトリを**読み取り専用**で参照できるようにする。
これにより、OpenClawのAI秘書がRyoの事業情報・タスク・ドキュメントを理解した上で動作できる。

## 構成図

```
┌─────────────────────┐          ┌──────────────────────┐
│  Claude Code (rina)  │  push →  │   GitHub (private)   │
│  メインPC / Web      │          │   rinafuku-gif/rina  │
│  読み書き可能        │  ← pull  │                      │
└─────────────────────┘          └──────────────────────┘
                                          │
                                     pull │ (読み取り専用)
                                          │
                                 ┌────────▼───────────┐
                                 │  OpenClaw (Mac mini) │
                                 │  Slack経由で稼働     │
                                 │  定期git pullで同期  │
                                 └─────────────────────┘
```

## ステップ1: GitHubでCollaborator招待

1. GitHub にログイン（rinafuku-gif アカウント）
2. `rinafuku-gif/rina` リポジトリの Settings を開く
3. 左メニューから **Collaborators** を選択
4. **Add people** をクリック
5. OpenClaw用のGitHubアカウント（open.craw.ryo@gmail.com で作成したもの）を検索して招待
6. 権限は **Read** に設定

> **注意**: Write権限は付与しない。OpenClawからrinaへの書き込みは不要。

## ステップ2: Mac mini側でSSH鍵を設定

Mac miniのターミナルで以下を実行：

```bash
# SSH鍵を生成（OpenClaw用アカウントのメールアドレスで）
ssh-keygen -t ed25519 -C "open.craw.ryo@gmail.com" -f ~/.ssh/id_ed25519_openclaw

# 公開鍵を表示（コピーしてGitHubに登録）
cat ~/.ssh/id_ed25519_openclaw.pub
```

GitHubのOpenClaw用アカウントで：
1. Settings > SSH and GPG keys
2. **New SSH key** をクリック
3. 上でコピーした公開鍵を貼り付けて保存

SSH configを設定：

```bash
cat >> ~/.ssh/config << 'EOF'
Host github-openclaw
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_openclaw
EOF
```

## ステップ3: rinaリポジトリをclone

```bash
# 作業ディレクトリを作成
mkdir -p ~/OpenClaw-Workspace

# cloneする
cd ~/OpenClaw-Workspace
git clone git@github-openclaw:rinafuku-gif/rina.git

# 確認
ls rina/
```

## ステップ4: 定期同期の設定（launchd）

15分ごとにgit pullして最新情報を取得する。

### スクリプト作成

```bash
cat > ~/OpenClaw-Workspace/sync-rina.sh << 'SCRIPT'
#!/bin/bash
# rina リポジトリ同期スクリプト
# OpenClawが常に最新のrina情報を参照できるようにする

RINA_DIR="$HOME/OpenClaw-Workspace/rina"
LOG_FILE="$HOME/OpenClaw-Workspace/sync.log"

cd "$RINA_DIR" || exit 1

# git pull（fast-forward only = 安全）
git pull --ff-only origin master >> "$LOG_FILE" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] sync completed" >> "$LOG_FILE"

# ログが大きくなりすぎないよう最新100行だけ保持
tail -100 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
SCRIPT

chmod +x ~/OpenClaw-Workspace/sync-rina.sh
```

### launchd plistを作成

```bash
cat > ~/Library/LaunchAgents/com.openclaw.sync-rina.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openclaw.sync-rina</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/YOUR_USERNAME/OpenClaw-Workspace/sync-rina.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/OpenClaw-Workspace/sync-error.log</string>
</dict>
</plist>
PLIST
```

> `YOUR_USERNAME` を Mac mini の実際のユーザー名に置き換えること。

### launchdに登録

```bash
launchctl load ~/Library/LaunchAgents/com.openclaw.sync-rina.plist
```

## ステップ5: OpenClawにrinaの存在を教える

OpenClawのMEMORY.mdまたはシステム設定に、以下の情報を追加：

```
## 参照リポジトリ

- パス: ~/OpenClaw-Workspace/rina/
- 内容: Ryoの事業情報・タスク管理・ドキュメント
- 更新: 15分ごとに自動同期（読み取り専用）
- 主要ファイル:
  - CLAUDE.md: 事業ポートフォリオ、タスク、ルール
  - docs/: 各事業の詳細ドキュメント
  - logs/daily/: 日次ブリーフィング記録
```

## セキュリティ注意事項

- rinaリポはprivateリポジトリ。SSH鍵の管理を徹底すること
- OpenClaw用アカウントにはRead権限のみ付与
- APIキー・パスワード等はrinaリポにコミットしない（CLAUDE.mdのルール通り）
- Mac miniのSSH秘密鍵は他者に共有しないこと
