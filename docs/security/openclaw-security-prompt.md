# OpenClaw セキュリティ診断プロンプト

> Mac mini の Claude Code にそのまま貼り付けて使う

---

## Step 1: 診断（これを先に投げる）

```
OpenClaw のセキュリティ設定を診断してほしい。変更はしないで、現状を確認して報告だけして。

以下の8項目を順番にチェックして、各項目について「✅ OK」「⚠️ 要対応」「❓ 確認できず」で報告して。

1. **バージョン**: `openclaw --version` を実行。v2026.2.26 以上か？（未満だとRCE脆弱性あり）

2. **Gateway バインド**: `~/.openclaw/openclaw.json` の gateway.bind が "loopback" になっているか？"0.0.0.0" や未設定だと外部公開されている

3. **Gateway 認証**: Gateway トークン認証が有効か？

4. **ファイルパーミッション**: 以下を確認
   - `ls -la ~/.openclaw/` → 700 か？
   - `ls -la ~/.openclaw/openclaw.json` → 600 か？
   - `ls -la ~/.openclaw/credentials/` → 中のファイルが 600 か？

5. **APIキー管理**: `~/.openclaw/openclaw.json` 内に API キーが平文で書かれていないか？（"sk-ant-" や "xoxb-" 等の文字列が直書きされていないか）

6. **サンドボックス**: openclaw.json の sandbox セクションの設定内容

7. **deny リスト**: openclaw.json の agents.tools.deny の設定内容

8. **ClawHub**: マーケットプレイス（ClawHub）が無効化されているか？plugins.marketplace.enabled の値

最後に openclaw.json の全体を（APIキー等の機密値は伏せて）表示して。
```

---

## Step 2: 修正（診断結果を見てから投げる）

```
OpenClaw のセキュリティ設定を修正する。openclaw.json を編集する前に、必ずバックアップを取ること。

cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y%m%d)

以下の修正を適用して。ただし既存の Slack 連携設定や channels 設定は絶対に消さないこと。既存設定にマージする形で追加・変更して。

### 修正内容

1. **Gateway**: bind を "loopback" に設定（既にそうなっていればスキップ）

2. **サンドボックス**: 以下を設定
   ```json
   "sandbox": {
     "mode": "non-main",
     "scope": "session"
   }
   ```

3. **deny リスト**: 以下を設定
   ```json
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
   ```

4. **ClawHub 無効化**:
   ```json
   "plugins": {
     "marketplace": {
       "enabled": false
     }
   }
   ```
   ※ plugins 内に既存の設定（Slack等）があればそれは残すこと

5. **APIキー**: もし openclaw.json 内に平文の API キーがあれば、環境変数参照（"$ANTHROPIC_API_KEY" 等）に置き換える。その場合、~/.zshrc に export 行を追加すること

6. **ファイルパーミッション**:
   ```bash
   chmod 700 ~/.openclaw
   chmod 600 ~/.openclaw/openclaw.json
   ls ~/.openclaw/credentials/ 2>/dev/null && chmod 600 ~/.openclaw/credentials/*
   ```

修正後、もう一度 openclaw.json の全体を表示して（機密値は伏せて）。
変更前後の diff も見せて。
```
