# クリティカルスクリプト登録簿

削除や移動で「動いている機能が止まる」スクリプトを記録する。
pre-commit hookがこの登録簿を参照して、該当ファイルの削除時に警告を出す。

**記法**: `- <ファイルパス> — <何の機能か> — <削除すると何が起きるか>`

---

## 🕖 自動実行（launchd管理）

- `scripts/openclaw-morning-briefing.sh` — 朝ブリーフィング本体（com.openclaw.morning-briefing・毎朝7:00） — 朝の予定・期限・天気・Basecamp進捗のDiscord #notifications 配信が停止
- `scripts/daily-scan.sh` — 朝ブリーフィングのAI分析エンジン — ブリーフィング本文が生成できなくなる（フォールバックのみ）
- `scripts/task-engine.js` — Calendar/Airbnb/Notion/Git/Gmail から「今日のアクション」を集約 — 朝ブリーフィングの今日タスクが消える
- `scripts/scan-projects.sh` — 各リポジトリのgit進捗スキャン — ブリーフィングのプロジェクト進捗欄が欠ける
- `scripts/ai-news-daily.sh` — AI/観光/補助金/EC等15ソースの日次レポート（com.rina.ai-news-daily・毎朝7:00） — Discord #ai-news へのAI日報配信・Notion AI News DB蓄積が停止
- `scripts/weekly-review.sh` — 週次レビュー（com.openclaw.weekly-review・毎週日曜20:00） — Discord #notifications への週次レビュー配信停止
- `scripts/airbnb-sync.sh` — Airbnb予約同期（com.rina.airbnb-sync） — Airbnb予約情報の自動取り込みが停止。朝ブリーフィングの宿泊情報が古くなる
- `scripts/finance-report.sh` — 財務レポート本体（com.rina.finance-report/weekly/monthly） — 日次・週次・月次の財務レポート配信が停止
- `scripts/finance-bot.js` — finance-report.sh の本体ロジック — 財務レポート生成が停止
- `scripts/gmail-receipt-scanner.js` — Gmail領収書自動処理（com.rina.gmail-receipt-scanner） — Gmailレシート自動OCR・Drive保存が停止、経費計上が手動化
- `scripts/trading/server.py` — TradingView→MT5 自動売買（com.rina.trading-bot） — TradingViewアラートからの自動発注が停止
- `scripts/trading/start-trading-bot.sh` — trading-bot起動スクリプト — botが起動できなくなる

## 🔌 常駐サービス（start-line-bot.sh経由）

- `scripts/line-webhook-server.js` — Airbnb予約通知・LINE webhook受信サーバー — Airbnb予約の自動取り込み・HIBA/UME室判定・airbnb-sync.shの同期API呼び出しが全て停止
- `scripts/start-line-bot.sh` — LINE bot全体の起動スクリプト — line-webhook-server起動不可

## 🛠️ 依存ユーティリティ（間接的に上記が呼ぶ）

- `scripts/task-store.js` — task-engine.js の内部ストレージ層
- `scripts/task-sync.js` / `task-sync-watcher.js` / `task-updater.js` — task-engine のNotion同期周辺
- `scripts/unified-db.js` / `unified-api.js` — unified.db アクセス層（朝ブリ・週次レビュー両方で使用）
- `scripts/sns-weekly-draft.js` — 日曜日にブリーフィングへSNS週次案を挿入
- `scripts/git-scanner.js` — scan-projects.shの中でgitログ取得

---

## 追加・削除ルール

- 新しいクリティカルスクリプトを追加したら、ここに1行追加
- 機能を廃止したら、ここから削除（同時にlaunchctl unloadも）
- フォーマット: `- <パス> — <機能> — <削除影響>`

## バイパス方法

pre-commit hookで削除がブロックされても、本当に削除したい場合:
```bash
git commit --no-verify
```
