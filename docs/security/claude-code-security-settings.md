# Claude Code セキュリティ設定ガイド

> 最終更新: 2026-03-23
> 参考: [すぐるさんの投稿](https://x.com/sugurukun_ai/status/2035657076371075514)

## 概要

Claude Code のパーミッションシステムを活用し、破壊的操作・機密情報漏洩・サプライチェーン攻撃を防止するための設定。

## 重要な原則

### deny は allow で上書きされない

Claude Code のパーミッションモデルでは、**deny に設定したコマンドは、後から allow を追加しても実行できない**。これはセキュリティ上非常に重要な設計。

### 設定の優先順位

1. **Managed Settings** (`~/.claude/settings.json` の `managed` セクション) — 最優先
2. **プロジェクト設定** (`~/.claude/projects/{project}/settings.json`) — プロジェクト固有
3. **グローバル設定** (`~/.claude/settings.json` の `permissions`) — 全プロジェクト共通

## 現在の設定内容

### グローバル deny リスト（全プロジェクト共通）

| カテゴリ | ブロック対象 | 理由 |
|---------|------------|------|
| **ファイル破壊** | `rm -rf /`, `rm -rf ~`, `rm -rf .`, `rm -rf *` | システム・プロジェクトの全削除を防止 |
| **Git 破壊操作** | `git push --force`, `git push -f`, `git reset --hard`, `git clean -fd`, `git checkout -- .`, `git restore .` | コミット履歴の破壊・未保存変更の消失を防止 |
| **環境変数漏洩** | `env`, `printenv`, `set`, `export`, `cat .env` | APIキー・認証情報の漏洩を防止 |
| **リモートコード実行** | `curl * \| sh`, `curl * \| bash`, `wget * \| sh` | 外部スクリプトの無検証実行を防止 |
| **権限昇格** | `chmod 777`, `sudo rm` | 過剰な権限付与・特権削除を防止 |
| **パッケージ公開** | `npm publish`, `npx * --yes` | 意図しないパッケージ公開・自動承認実行を防止 |

### プロジェクト deny リスト（rina リポジトリ専用）

| カテゴリ | ブロック対象 | 理由 |
|---------|------------|------|
| **main/master 強制プッシュ** | `git push origin main --force` 等 | 本番ブランチの保護 |
| **機密ファイル読み取り** | `cat .env*`, `cat *credentials*`, `cat *secret*`, `cat *token*` | 認証情報ファイルの内容表示を防止 |
| **機密情報検索** | `grep -r API_KEY`, `grep -r SECRET`, `grep -r PASSWORD`, `grep -r TOKEN` | コードベース内の機密情報スキャンを防止 |

## 設定ファイルの場所

```
~/.claude/
├── settings.json                              # グローバル設定（deny リスト含む）
└── projects/
    └── -home-user-rina/
        └── settings.json                      # rina プロジェクト専用設定
```

## 今後の検討事項

### OpenClaw 導入時の追加対策

OpenClaw を導入する場合、以下の追加セキュリティ対策が必要：

1. **専用マシン/VM での実行** — メインPCではなく VPS や Docker コンテナで隔離
2. **root ユーザーで実行しない** — 専用の制限付きユーザーで運用
3. **デフォルトポート（18789）の変更** — ポートスキャン対策
4. **認証の必須化** — 管理インターフェースへの認証設定
5. **ネットワーク制限** — Tailscale 等で VPN 経由のみアクセス可能に
6. **スキルの審査** — 公式/信頼できるスキルのみインストール
7. **環境変数の分離** — OpenClaw プロセスからアクセスできる環境変数を最小限に

### 参考リンク

- [OpenClaw 公式セキュリティドキュメント](https://docs.openclaw.ai/gateway/security)
- [Malwarebytes: OpenClaw の安全な使い方](https://www.malwarebytes.com/blog/news/2026/02/openclaw-what-is-it-and-can-you-use-it-safely)
- [CrowdStrike: OpenClaw セキュリティ分析](https://www.crowdstrike.com/en-us/blog/what-security-teams-need-to-know-about-openclaw-ai-super-agent/)
- [Cisco: AIエージェントのセキュリティリスク](https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare)
