# GitHub Actions 外部データ同期 セットアップガイド

## 概要

GitHub Actionsを使って、外部サービスのデータをrinaリポジトリに自動取り込みする。
OpenClawはgit pullするだけで最新の外部データも参照できるようになる。

## ワークフロー一覧

| ワークフロー | 実行頻度 | 内容 |
|---|---|---|
| `daily-snapshot.yml` | 毎日 6:00 JST | タスク状況・更新履歴のスナップショット |
| `sync-external-data.yml` | 毎時 | Google Calendar同期 + ステータス更新 |

## セットアップ手順

### 1. daily-snapshot（すぐ動く）

設定不要。pushすれば即稼働する。手動実行もGitHubのActionsタブから可能。

### 2. Google Calendar同期（要Secret設定）

#### ステップ1: Google Cloud Console でサービスアカウント作成

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. プロジェクトを選択（または新規作成）
3. **APIs & Services** > **Enabled APIs** で **Google Calendar API** を有効化
4. **IAM & Admin** > **Service Accounts** で新しいサービスアカウントを作成
   - 名前: `rina-github-actions`
   - 役割: 不要（カレンダーは共有設定で制御）
5. サービスアカウントのキー（JSON）をダウンロード

#### ステップ2: カレンダーの共有設定

各カレンダーで、サービスアカウントのメールアドレス（`xxx@xxx.iam.gserviceaccount.com`）を**閲覧者**として追加：

- Google Calendarの設定 > 特定のカレンダー > 共有設定
- 「特定のユーザーと共有」にサービスアカウントのメールを追加
- 権限: **閲覧権限（すべての予定の詳細）**

以下のカレンダーに設定：
- プライベート（r.inafuku@tonari2tomaru.com）
- R&M 共有カレンダー
- 三十日珈琲
- えんがわ（HIBA）
- えんがわ（UME）
- 大広間
- ADDress上野原

#### ステップ3: GitHub Secretsに登録

1. GitHubで `rinafuku-gif/rina` > Settings > Secrets and variables > Actions
2. **New repository secret** をクリック
3. Name: `GOOGLE_SERVICE_ACCOUNT_KEY`
4. Value: ダウンロードしたJSONキーの内容をそのまま貼り付け
5. **Add secret**

#### ステップ4: 動作確認

1. GitHubのActionsタブで `Sync External Data` ワークフローを選択
2. **Run workflow** で手動実行
3. 成功すると `data/calendar-today.md` と `data/calendar-week.md` が生成される

## 生成されるファイル

```
data/
├── status.md           # OpenClaw参照用ステータスサマリー
├── calendar-today.md   # 本日の予定（毎時更新）
└── calendar-week.md    # 今週の予定（毎時更新）

logs/daily/
└── YYYY-MM-DD-snapshot.md  # 日次スナップショット
```

## 拡張案（今後追加可能）

- **Airbnb予約データ**: iCalフィードをパースして予約状況を `data/airbnb/` に保存
- **財務データ**: スプレッドシートAPIで収支サマリーを取得
- **GitHubイシュー**: 他リポ（fate-decoder等）の進捗を集約
- **天気予報**: 外出・ゲスト対応の判断材料
