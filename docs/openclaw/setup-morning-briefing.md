# OpenClaw セットアップ指示書 — Mac mini 朝ブリーフィング自律生成

> この指示書を Mac mini 上の Claude Code セッションにそのまま渡して実行してもらう。

---

## 前提条件の確認

まず以下を確認してください：

1. **Claude Code がインストールされているか**
   ```bash
   which claude
   claude --version
   ```

2. **Node.js がインストールされているか**
   ```bash
   node --version  # v18+ が必要
   ```

3. **jq がインストールされているか**
   ```bash
   which jq
   # なければ: brew install jq
   ```

4. **Git の SSH 設定（Deploy Key）が機能しているか**
   ```bash
   ssh -T git@github.com
   ```

---

## ステップ 1: rina リポジトリを clone

```bash
# ホームディレクトリ直下に clone
cd ~
git clone git@github.com:rinafuku-gif/rina.git
cd ~/rina
```

すでに clone 済みなら pull で最新化：
```bash
cd ~/rina && git pull origin main
```

---

## ステップ 2: .env ファイルを作成

`~/rina/.env` に以下の環境変数を設定する。
値は MBP 側の `~/rina/.env` からコピーする。

```bash
cat > ~/rina/.env << 'ENVEOF'
# LINE Messaging API
LINE_CHANNEL_ACCESS_TOKEN=（MBPからコピー）
LINE_USER_ID=（MBPからコピー）
LINE_CHANNEL_SECRET=（MBPからコピー）

# Google API（Calendar, Drive, Sheets）
GOOGLE_CLIENT_ID=（MBPからコピー）
GOOGLE_CLIENT_SECRET=（MBPからコピー）
GOOGLE_REFRESH_TOKEN=（MBPからコピー）

# API認証
SHIRATAMA_API_TOKEN=（MBPからコピー）
ENVEOF
```

**注意**: `.env` は `.gitignore` に入っているのでコミットされない。

---

## ステップ 3: Google Calendar MCP を設定

Claude Code が Google Calendar を読み書きするには、MCP サーバーの設定が必要。

### 3-1. MCP 設定ファイルを作成

```bash
mkdir -p ~/.claude

cat > ~/.claude/settings.json << 'MCPEOF'
{
  "mcpServers": {
    "google-calendar": {
      "command": "npx",
      "args": ["-y", "@anthropic/google-calendar-mcp"],
      "env": {
        "GOOGLE_CLIENT_ID": "（.envと同じ値）",
        "GOOGLE_CLIENT_SECRET": "（.envと同じ値）",
        "GOOGLE_REFRESH_TOKEN": "（.envと同じ値）"
      }
    }
  }
}
MCPEOF
```

**重要**: MBP 側の `~/.claude/settings.json` と同じ MCP 設定を再現すること。
MBP 側で以下を実行して、現在の MCP 設定を確認できる：

```bash
# MBP 側で実行
cat ~/.claude/settings.json
```

もし MBP 側の設定が異なる構成（Google Calendar 以外の MCP もある等）なら、そちらに合わせる。

### 3-2. MCP の動作確認

```bash
cd ~/rina
claude -p "Google Calendar で今日の予定を確認して。全カレンダーの予定を一覧表示して。"
```

予定が返ってきたら MCP は正常動作。

---

## ステップ 4: 朝ブリーフィングスクリプトのパスを修正

```bash
# スクリプトの実行権限を確認
ls -la ~/rina/scripts/openclaw-morning-briefing.sh

# PATH の修正（Mac mini のユーザー名に合わせる）
# スクリプト内の以下の行を確認:
# export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# → $HOME が正しく展開されるので、通常は修正不要
```

---

## ステップ 5: テスト実行

```bash
cd ~/rina
bash scripts/openclaw-morning-briefing.sh
```

確認ポイント：
- [ ] `git pull` が成功しているか（ログに "Pulling latest rina repo..." が出力される）
- [ ] Claude がブリーフィングを生成できているか
- [ ] LINE にブリーフィングが届いているか
- [ ] `logs/daily/YYYY-MM-DD.md` にログが記録されているか

ログの確認：
```bash
cat ~/rina/logs/briefing-stdout.log
cat ~/rina/logs/briefing-stderr.log
```

---

## ステップ 6: launchd に登録（毎朝7:00自動実行）

### 6-1. plist を設置

```bash
# plist のパスを実環境に修正してコピー
sed "s|/path/to/rina|$HOME/rina|g; s|/Users/inaryo|$HOME|g" \
  ~/rina/scripts/com.openclaw.morning-briefing.plist \
  > ~/Library/LaunchAgents/com.openclaw.morning-briefing.plist
```

### 6-2. 登録 & 確認

```bash
# 登録
launchctl load ~/Library/LaunchAgents/com.openclaw.morning-briefing.plist

# 登録確認
launchctl list | grep openclaw

# 手動で即実行テスト
launchctl start com.openclaw.morning-briefing
```

### 6-3. MBP 側の既存ブリーフィングを停止

OpenClaw 版が安定動作したら、MBP 側の旧スクリプトを停止する：

```bash
# MBP 側で実行
launchctl unload ~/Library/LaunchAgents/com.rina.morning-briefing.plist
```

**推奨**: 最初の1週間は両方動かして、OpenClaw 版が安定して届くことを確認してから MBP 側を停止する。

---

## トラブルシューティング

### Google Calendar MCP が動かない

```bash
# MCP サーバーを直接テスト
npx -y @anthropic/google-calendar-mcp
# エラーが出たら認証情報を確認

# Claude Code の MCP 設定を確認
claude mcp list
```

### claude -p がタイムアウトする

- Claude Code のログイン状態を確認: `claude auth status`
- ネットワーク接続を確認
- タイムアウトは 420秒（7分）に設定済み

### LINE に届かない

```bash
# LINE API の疎通テスト
source ~/rina/.env
curl -s -X POST https://api.line.me/v2/bot/message/push \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
  -d "$(jq -n --arg to "$LINE_USER_ID" '{
    to: $to,
    messages: [{type: "text", text: "OpenClaw テスト送信"}]
  }')"
```

### git pull / push が失敗する

```bash
# Deploy Key の確認
ssh -T git@github.com

# リモートURLの確認
cd ~/rina && git remote -v
# SSH 形式 (git@github.com:...) になっていること
```

---

## 完了チェックリスト

- [ ] Claude Code インストール済み & ログイン済み
- [ ] rina リポジトリ clone 済み
- [ ] .env 設定済み
- [ ] Google Calendar MCP 設定済み & 動作確認済み
- [ ] テスト実行でブリーフィングが LINE に届いた
- [ ] launchd 登録済み
- [ ] 翌朝 7:00 にブリーフィングが届くことを確認
