# GitHub Actions: rina → openclaw-vault 同期 セットアップガイド

## 概要

GitHub Actionsを使って、rinaリポの情報を**フィルタリングして**openclaw-vaultに自動同期する。
金額・契約・個人情報は自動的に除外される。

## ワークフロー

| ファイル | トリガー | 内容 |
|---|---|---|
| `sync-to-openclaw-vault.yml` | master push時 + 毎時 | タスク・予定・KPI をフィルタリングして openclaw-vault にpush |

## フィルタリングルール

ワークフロー内で以下の自動フィルタリングが適用される：

- `[0-9]万円` → `***万円` に置換
- `[0-9,]円` → `**円` に置換
- `¥[0-9,]` → `¥***` に置換
- `月額[0-9]万` → `月額***万` に置換
- 契約書（docs/contracts/）は同期対象外
- 財務詳細（docs/finance/）は同期対象外
- スクリプト（scripts/）は同期対象外
- カレンダーIDは同期対象外

## セットアップ手順

### 前提条件

- openclaw-vault リポが作成済み（setup-guide.md 参照）
- OpenClaw用GitHubアカウントでPAT（Personal Access Token）が発行済み

### Step 1: GitHub Secrets を設定

rinafuku-gif/rina リポの **Settings > Secrets and variables > Actions** で:

#### 必須

| Secret | 値 | 説明 |
|---|---|---|
| `OPENCLAW_VAULT_TOKEN` | OpenClawアカウントのPAT | openclaw-vaultへのpush権限。**Contents: Read & Write** のみ |

#### 任意（Variables）

| Variable | 値 | 説明 |
|---|---|---|
| `OPENCLAW_VAULT_REPO` | `OpenClawアカウント名/openclaw-vault` | リポジトリのフルパス |

#### 任意（Secrets）

| Secret | 値 | 説明 |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Service AccountのJSON | カレンダー同期用 |

### Step 2: 動作確認

1. GitHub の rina リポ > Actions タブ
2. `Sync to OpenClaw Vault` ワークフローを選択
3. **Run workflow** で手動実行
4. 成功したら openclaw-vault に context/ と data/ が生成されていることを確認

### Step 3: 自動実行の確認

- master に push するたびに自動実行される
- 毎時0分にもスケジュール実行される
- Google Calendar同期は `GOOGLE_SERVICE_ACCOUNT_KEY` が設定されている場合のみ

## 同期されるファイル

```
openclaw-vault/
├── context/
│   ├── tasks.md        ← CLAUDE.md から未完了タスクを抽出（金額マスク済み）
│   ├── calendar.md     ← 今日の予定（Calendar API経由）
│   ├── projects.md     ← 事業概要（静的テンプレート）
│   └── kpi.md          ← KPIサマリー（相対値のみ）
└── data/
    └── status.md       ← 最終同期日時
```

## KPIの更新について

kpi.md の具体的な数値（目標達成率、稼働率等）は自動では入らない。
理由：生データからの自動変換で意図せず金額が推測可能になるリスクを避けるため。

**更新フロー：**
1. rina側のClaude Codeセッションで財務レビューを実施
2. 相対値・トレンドに変換した情報を kpi.md テンプレートに反映
3. commit & push → GitHub Actions → openclaw-vault に自動同期

## トラブルシューティング

### ワークフローが失敗する
- `OPENCLAW_VAULT_TOKEN` の有効期限が切れていないか確認（90日ごとに更新）
- Token の権限が `Contents: Read and write` になっているか確認

### カレンダーが同期されない
- `GOOGLE_SERVICE_ACCOUNT_KEY` が設定されているか確認
- サービスアカウントに各カレンダーの閲覧権限が付与されているか確認
