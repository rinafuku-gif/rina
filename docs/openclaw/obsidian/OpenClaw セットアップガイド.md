# OpenClaw セットアップガイド

> Mac mini を自律型AIアシスタント「OpenClaw」として稼働させるための完全ガイド。
> このノートを Mac mini 側の Claude Code セッションに渡して実行してもらう。

## 概要

OpenClaw は Mac mini 上で動作する自律型AIエージェント。
最初のタスクは **朝ブリーフィングの自律生成**。

従来の MBP 版との違い:

| | 従来版（MBP） | OpenClaw版（Mac mini） |
|---|---|---|
| プロンプト | 固定テンプレート | Claude が状況を自律判断して構成 |
| 曜日対応 | なし | 月曜→週の見通し、金曜→週末準備 等 |
| 予定の先読み | 今日のみ | 今日〜3日先 |
| リマインド | タスクリストから機械的に抽出 | 「やると言ったのに未完了」も検出 |
| ログ記録 | なし | `logs/daily/` に自動記録 & git push |
| リポジトリ同期 | なし | 実行前に `git pull` で最新化 |

---

## 前提条件チェック

Mac mini で以下を実行して確認:

```bash
# Claude Code
which claude && claude --version

# Node.js (v18+)
node --version

# jq
which jq || echo "→ brew install jq"

# Git SSH (Deploy Key)
ssh -T git@github.com
```

---

## Step 1: rina リポジトリを clone

```bash
cd ~
git clone git@github.com:rinafuku-gif/rina.git
cd ~/rina
```

> clone 済みなら `cd ~/rina && git pull origin main`

---

## Step 2: .env を作成

MBP 側の `~/rina/.env` から値をコピーして、Mac mini 側に作成。

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

> `.env` は `.gitignore` に入っているのでコミットされない。安心。

---

## Step 3: Google Calendar MCP を設定

これが一番重要。Claude Code が Google Calendar を読み書きするための設定。

### 3-1. MBP 側の設定を確認

MBP で実行:
```bash
cat ~/.claude/settings.json
```

### 3-2. Mac mini に同じ設定を作成

```bash
mkdir -p ~/.claude
```

`~/.claude/settings.json` を作成（MBP側の内容をベースに）:

```json
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
```

> MBP 側に他の MCP（Google Drive 等）もあるなら、それも含める。

### 3-3. 動作確認

```bash
cd ~/rina
claude -p "Google Calendar で今日の予定を確認して。全カレンダーの予定を一覧表示して。"
```

> 予定が返ってきたら MCP 正常動作。

---

## Step 4: テスト実行

```bash
cd ~/rina
bash scripts/openclaw-morning-briefing.sh
```

### 確認ポイント

- [ ] `git pull` が成功している
- [ ] Claude がブリーフィングを生成できている
- [ ] LINE にブリーフィングが届いている
- [ ] `logs/daily/YYYY-MM-DD.md` にログが記録されている

### ログの確認

```bash
cat ~/rina/logs/briefing-stdout.log
cat ~/rina/logs/briefing-stderr.log
```

---

## Step 5: launchd に登録（毎朝7:00）

### plist を設置

```bash
sed "s|/path/to/rina|$HOME/rina|g; s|/Users/inaryo|$HOME|g" \
  ~/rina/scripts/com.openclaw.morning-briefing.plist \
  > ~/Library/LaunchAgents/com.openclaw.morning-briefing.plist
```

### 登録

```bash
launchctl load ~/Library/LaunchAgents/com.openclaw.morning-briefing.plist
launchctl list | grep openclaw
```

### 即実行テスト

```bash
launchctl start com.openclaw.morning-briefing
```

---

## Step 6: MBP 側の旧ブリーフィングを停止

> 1週間は両方動かして安定確認してから停止するのがおすすめ。

```bash
# MBP 側で実行
launchctl unload ~/Library/LaunchAgents/com.rina.morning-briefing.plist
```

---

## トラブルシューティング

### Google Calendar MCP が動かない

```bash
# MCP サーバーを直接テスト
npx -y @anthropic/google-calendar-mcp

# Claude Code の MCP 設定を確認
claude mcp list
```

### claude -p がタイムアウトする

- ログイン確認: `claude auth status`
- ネットワーク確認
- タイムアウトは 420秒（7分）に設定済み

### LINE に届かない

```bash
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
ssh -T git@github.com
cd ~/rina && git remote -v
# SSH 形式 (git@github.com:...) になっていること
```

---

## 関連ファイル

| ファイル | 説明 |
|---|---|
| `scripts/openclaw-morning-briefing.sh` | 自律型ブリーフィング実行スクリプト |
| `scripts/com.openclaw.morning-briefing.plist` | launchd 設定テンプレート |
| `scripts/morning-briefing.sh` | 旧版（MBP用・参考） |
| `docs/ai-secretary-architecture.md` | AI秘書全体アーキテクチャ |

---

## 完了チェックリスト

- [ ] Claude Code インストール済み & ログイン済み
- [ ] rina リポジトリ clone 済み
- [ ] .env 設定済み
- [ ] Google Calendar MCP 設定済み & 動作確認済み
- [ ] テスト実行でブリーフィングが LINE に届いた
- [ ] launchd 登録済み
- [ ] 翌朝 7:00 にブリーフィングが届くことを確認
