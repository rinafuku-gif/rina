# MCPセキュリティ監査レポート

**監査者**: Engineer
**日付**: 2026-03-27
**対象**: rina + agents 全エージェント環境

---

## 1. MCP接続一覧

| サーバー名 | コマンド | 用途 |
|-----------|---------|------|
| google-workspace | workspace-mcp | Google Calendar/Gmail連携 |

**所見**: MCP接続は1つのみ。最小限で良い。

## 2. `--dangerously-skip-permissions` の使用状況

**全11エージェントが使用中:**
auditor, ceo, content-analyst, copywriter, creative, devops, engineer, legal-specialist, marketer, researcher, visual-director

### リスク
- ファイルシステムへの無制限アクセス
- シェルコマンドの無制限実行
- 悪意あるプロンプトインジェクション時に任意コード実行の可能性

### 改善提案
- **短期**: 各エージェントのCLAUDE.mdに「禁止操作」を明記（すでに一部実装済み）
- **中期**: `--allowedTools` でエージェントごとに必要最小限のツールに制限
  - Auditor: Read, Grep, Glob のみ（書き込み不要）
  - Researcher: Read, WebFetch, WebSearch のみ
  - Creative: Read, Write（特定ディレクトリのみ）
- **長期**: `--dangerously-skip-permissions` を廃止し、permissions設定で個別許可

## 3. APIキー管理

### .envファイル（適切に管理されている）
| ファイル | キー数 | 状態 |
|---------|--------|------|
| `/Users/ocmm/rina/.env` | 15 | .gitignore済み |
| `~/.claude/channels/discord/.env` | 1 | ディレクトリ保護 |

### 🔴 ハードコードされたトークン
| ファイル | 行 | 内容 | リスク |
|---------|-----|------|--------|
| `gas-receipt-proxy.js:11` | `AUTH_TOKEN = "shiratama-receipt-2026"` | GASプロキシの認証トークン | 中（ローカルのみ使用） |

### 改善提案
- `gas-receipt-proxy.js` のハードコードトークンを `.env` に移動
- APIキーのローテーション計画を策定（特にGOOGLE_REFRESH_TOKEN）

## 4. 依存パッケージのセキュリティ

### Python
| パッケージ | バージョン固定 | 状態 |
|-----------|-------------|------|
| budoux | ✅ ==0.8.0 | 修正済み（本日） |
| pyyaml | ✅ ==6.0.3 | 修正済み（本日） |
| py-cord | ⚠️ gitブランチ指定 | PRマージ後にリリース版に変更要 |

### Node.js
| プロジェクト | package-lock.json | 状態 |
|-------------|------------------|------|
| /Users/ocmm/rina | ✅ あり | OK |
| /Users/ocmm/rina/tools/rough-cut | ✅ あり | OK |

### 改善提案
- `npm audit` / `pip audit` の定期実行（週次）
- Dependabot相当の自動更新通知

## 5. ネットワーク露出

| サービス | ポート | 外部公開 | 認証 |
|---------|--------|---------|------|
| line-webhook-server | 3100 | Cloudflare Tunnel経由 | SHIRATAMA_API_TOKEN |
| VOICEVOX Engine | 50021 | localhost のみ | なし（ローカル限定で問題なし） |

### 改善提案
- Cloudflare Tunnel経由のAPIにレート制限を追加
- SHIRATAMA_API_TOKENの定期ローテーション

## 6. 総合評価

| 項目 | 評価 | 緊急度 |
|------|------|--------|
| MCP接続 | ✅ 良好 | — |
| 権限管理 | ⚠️ 改善余地あり | 中期 |
| APIキー管理 | ⚠️ 1件ハードコード | 低（ローカル） |
| 依存パッケージ | ✅ 固定済み | — |
| ネットワーク | ✅ 概ね良好 | — |
