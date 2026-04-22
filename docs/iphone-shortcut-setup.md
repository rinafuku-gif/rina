# iPhoneショートカット設定ガイド: 音声 → SNS投稿案

## 概要

iPhoneで録音してiCloud Driveに保存するだけで、
Mac miniが自動で文字起こし・SNS生成・Discord通知まで完結します。
サーバー起動不要、外出先でもWi-Fi関係なく使えます。

**フロー:**
```
iPhone録音 → iCloud Drive「音声メモ」フォルダに保存
  → Mac mini自動検知（fswatch）
  → mlx-whisperでローカル文字起こし（無料・プライバシー安全）
  → Claude Codeで note / Instagram / X の3種生成
  → Discord #sns-drafts に通知
  → Obsidian 05_リソース/音声ジャーナリング/ に保存
  → 音声ファイルを「処理済み」フォルダに移動
```

---

## ショートカット作成手順

1. iPhoneの「ショートカット」アプリを開く
2. 右上「＋」で新規作成、タイトルを **「音声メモ保存」** にする

### アクション 1: オーディオを録音

- 「アクションを追加」→「オーディオを録音」を選択
- 設定:
  - 開始: **すぐに**
  - 品質: **高**

### アクション 2: ファイルを保存

- 「アクションを追加」→「ファイルを保存」を選択
- 設定:
  - 保存先: **iCloud Drive**
  - フォルダ: **音声メモ**（iCloud Drive直下にあるフォルダ）
  - 名前を聞く: **オフ**

### アクション 3: 通知を表示

- 「アクションを追加」→「通知を表示」を選択
- 本文: **「録音を保存しました。処理完了後にDiscord #sns-drafts に届きます」**

3. 右上「完了」で保存

---

## 使い方

- ショートカットアプリから「音声メモ保存」をタップ → 録音開始
- 話し終わったら停止 → 自動でiCloud Driveに保存
- 数分後にDiscord #sns-drafts に投稿案が届く

**ホーム画面に追加すると便利:**
ショートカットを長押し →「ホーム画面に追加」で1タップ起動

---

## 話し方のコツ

- 口語でOK。フィラー（えー、あのー）が入っても自動除去されます
- 事業名を最初に言うと、そのブランドのトーンに合った文章になります
  - 例：「えんがわの話なんですけど、今日ゲストから...」
  - 例：「三十日珈琲、今日焙煎した豆が...」
  - 例：「SATOYAMA AI BASEで気づいたことがあって...」
- 1〜5分程度が最適（それ以上でも動きます）
- 途中で詰まっても大丈夫。録音なので好きなだけ考えてOK

---

## 出力されるもの

Discord #sns-drafts に以下が届きます:

1. **note記事本文**（1500字以内）
2. **Instagram投稿文**（300字以内 + ハッシュタグ5個）
3. **X投稿**（140字以内）

Obsidianには以下が自動保存されます:

- `05_リソース/音声ジャーナリング/原文/YYYY-MM-DD_トピック名.md`
- `05_リソース/音声ジャーナリング/要約/YYYY-MM-DD_トピック名_要約.md`

処理済みの音声ファイルは iCloud Drive の「音声メモ/処理済み/」に移動されます。

---

## 技術的な詳細（参考）

| 項目 | 内容 |
|------|------|
| 文字起こしエンジン | mlx-whisper（Apple Silicon最適化、ローカル処理） |
| 使用モデル | whisper-large-v3-turbo（初回のみダウンロード） |
| SNS生成 | Claude Code（claude -p コマンド、定額内） |
| 監視方式 | fswatch（ファイル作成イベント検知） |
| 常駐方式 | launchd（Mac mini起動時に自動開始） |
| ログ | ~/rina/logs/voice-pipeline.log |

---

## トラブルシューティング

### Discord に届かない

```bash
# ログを確認
tail -30 ~/rina/logs/voice-pipeline.log

# パイプラインが動いているか確認
launchctl list | grep com.rina.voice-pipeline
```

### パイプラインを再起動したい

```bash
launchctl unload ~/Library/LaunchAgents/com.rina.voice-pipeline.plist
launchctl load ~/Library/LaunchAgents/com.rina.voice-pipeline.plist
```

### 手動でテスト実行したい

iCloud Driveの「音声メモ」フォルダに .m4a ファイルを置くと自動で処理が走ります。

### 初回文字起こし時にダウンロードが走る

whisper-large-v3-turbo モデルを初回のみダウンロードします（約1.5GB）。
2回目以降はキャッシュを使用するため即座に動作します。
