# 朝ブリーフィング — Mac mini セットアップ手順

このドキュメントは、Mac mini 側の Claude Code セッションに読ませて手順通りに進めるための指示書です。

## 前提

- MBP（MacBook Pro）で朝ブリーフィングが正常に動作している
- Mac mini に Claude Code がインストール済み
- GitHub の Deploy Key が設定済み

## セットアップ手順（6ステップ）

### Step 1: rina リポジトリを clone

```bash
cd ~
git clone git@github.com:rinafuku-gif/rina.git
```

Deploy Key を使用。SSH鍵が `~/.ssh/` に配置されていること。

### Step 2: .env をMBPからコピー

MBP側で以下を実行してMac miniに転送:

```bash
# MBP側で実行（Mac miniのIPアドレスに置き換え）
scp ~/rina/.env Inaryo@<MAC_MINI_IP>:~/rina/.env
```

または、MBP側で `cat ~/rina/.env` して内容をコピー → Mac mini側で `nano ~/rina/.env` にペースト。

必要な環境変数:
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_USER_ID`
- `SHIRATAMA_API_TOKEN`
- `GEMINI_API_KEY`（daily-scan.sh で使用）
- その他 `.env` に含まれるすべての変数

### Step 3: Google Calendar MCP を設定（最重要）

Claude Code が Google Calendar にアクセスするために、MBP側の MCP設定をMac miniにコピーする。

**MBP側の設定ファイル**: `~/.claude/.mcp.json`

現在の内容:
```json
{
  "mcpServers": {
    "google-drive": {
      "command": "npx",
      "args": ["-y", "@piotr-agier/google-drive-mcp"],
      "env": {
        "GOOGLE_CREDENTIALS_PATH": "/Users/Inaryo/.claude/plugins/cache/local-desktop-app-uploads/gdrive-connector/0.1.0/gcp-oauth.keys.json"
      }
    }
  }
}
```

**やること:**
1. MBP側の `~/.claude/.mcp.json` をMac miniの同じパスにコピー
2. `GOOGLE_CREDENTIALS_PATH` で指定されている認証ファイルもコピー:
   ```bash
   # MBP側で実行
   scp ~/.claude/.mcp.json Inaryo@<MAC_MINI_IP>:~/.claude/.mcp.json

   # 認証ファイルもコピー（ディレクトリ構造ごと）
   ssh Inaryo@<MAC_MINI_IP> "mkdir -p ~/.claude/plugins/cache/local-desktop-app-uploads/gdrive-connector/0.1.0/"
   scp ~/.claude/plugins/cache/local-desktop-app-uploads/gdrive-connector/0.1.0/gcp-oauth.keys.json \
       Inaryo@<MAC_MINI_IP>:~/.claude/plugins/cache/local-desktop-app-uploads/gdrive-connector/0.1.0/
   ```

3. Google Calendar MCP は Claude Code 内蔵の MCP サーバー経由で動作する。`settings.json` の認証状態も必要な場合は:
   ```bash
   scp ~/.claude/settings.json Inaryo@<MAC_MINI_IP>:~/.claude/settings.json
   ```

**確認方法:** Mac mini側でClaude Codeを起動し、「今日のカレンダーを見せて」と聞いてカレンダーが読めればOK。

### Step 4: パス確認

Mac mini のユーザー名が `Inaryo` であれば修正不要。

異なる場合は以下のファイルのパスを修正:
- `scripts/openclaw-morning-briefing.sh` → 環境変数 `OPENCLAW_REPO_DIR` で上書き可能
- `scripts/com.openclaw.morning-briefing.plist` → `ProgramArguments` と `StandardOutPath` / `StandardErrorPath` のパスを修正

### Step 5: テスト実行

```bash
cd ~/rina

# DRY_RUNモードでテスト（LINE/Push送信なし）
DRY_RUN=1 bash scripts/openclaw-morning-briefing.sh

# ログを確認
cat logs/briefing-stdout.log
cat logs/briefing-stderr.log
```

エラーがなければ、実際に送信テスト:
```bash
# ロックファイルを削除（同日2回目の実行を許可）
rm -f logs/.briefing-lock

# 本番実行
bash scripts/openclaw-morning-briefing.sh
```

LINE にブリーフィングが届けば成功。

### Step 6: launchd 登録（毎朝7:00自動実行）

```bash
# plist をコピー
cp ~/rina/scripts/com.openclaw.morning-briefing.plist ~/Library/LaunchAgents/

# 登録
launchctl load ~/Library/LaunchAgents/com.openclaw.morning-briefing.plist

# 確認
launchctl list | grep openclaw
```

**既存の morning-briefing が MBP 側で動いている場合:**
MBP側で旧版を停止してから Mac mini 側で登録すること（二重配信防止）:
```bash
# MBP側で実行
launchctl unload ~/Library/LaunchAgents/com.rina.morning-briefing.plist
```

## トラブルシューティング

### ブリーフィングが届かない
1. `cat ~/rina/logs/briefing-stdout.log` でログ確認
2. `cat ~/rina/logs/briefing-stderr.log` でエラー確認
3. `.env` の `LINE_CHANNEL_ACCESS_TOKEN` と `LINE_USER_ID` が正しいか確認

### daily-scan が失敗する
1. `claude` コマンドが PATH に含まれているか: `which claude`
2. `node` が使えるか: `which node`、`node --version`
3. `jq` がインストールされているか: `which jq`（なければ `brew install jq`）

### Google Calendar にアクセスできない
1. `~/.claude/.mcp.json` が正しくコピーされているか
2. 認証ファイルのパスが存在するか
3. Claude Code を起動して対話的にカレンダーアクセスを試す

### ロックファイルで実行がスキップされる
同日に手動で再実行したい場合:
```bash
rm -f ~/rina/logs/.briefing-lock
bash scripts/openclaw-morning-briefing.sh
```
