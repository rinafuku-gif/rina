# ERROR_LOG

---

## 2026-03-12 - 朝ブリーフィングLINEメッセージが2通届く

- **症状**: 毎朝7:00に1通だけ届くはずのブリーフィングLINEが、3/10と3/11に2通ずつ届いた
- **根本原因**: 2つの原因が重なっていた。(1) 旧版スクリプト(ロック機構なし)が3/10 07:00に実行された後、同日21:50に新版スクリプトがClaude Codeセッションから手動テスト実行され、ロックファイルが存在しなかったため2回目もLINE送信された。(2) 3/11は07:03にlaunchdが正規実行した後、08:36頃にClaude Codeセッションがdaily-scan.shを編集、08:48にmorning-briefing.shがテスト実行され、ロックファイルの内容が編集過程で消失またはリセットされた可能性がある。パス解決が相対パス(`$(dirname "$0")`)だったため、worktreeからの実行時にロックファイルが別パスになる構造的欠陥もあった
- **修正内容**:
  - `morning-briefing.sh`: パス解決を絶対パス(`/Users/Inaryo/rina`)に固定。worktreeや別ディレクトリからの実行でも同じロックファイルを参照するように変更
  - `morning-briefing.sh`: `DRY_RUN=1`環境変数によるテストモードを追加。テスト実行時はLINE/PWA Push送信をスキップ
  - `morning-briefing.sh`: ロックファイル読み込み時に`tr -d '[:space:]'`で空白文字を除去し、比較の堅牢性を向上
  - `morning-briefing.sh`: ロック書き込み後の再確認（verify）ステップを追加
  - worktreeの旧スクリプト(`angry-allen/scripts/morning-briefing.sh`)をエラー終了するスタブに置換
- **修正ファイル**:
  - `/Users/Inaryo/rina/scripts/morning-briefing.sh`
  - `/Users/Inaryo/rina/.claude/worktrees/angry-allen/scripts/morning-briefing.sh`
- **再発防止**:
  - スクリプトのテスト実行時は必ず `DRY_RUN=1` を付けること
  - LINE送信等の副作用があるスクリプトは、テストモードを必ず実装すること
  - ロックファイルのパスは絶対パスで固定し、相対パス解決に依存しないこと
  - worktreeに残った旧スクリプトが実行されないよう、旧版は無害化すること

---
