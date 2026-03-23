# OpenClaw 概要

> Mac mini で動作する自律型AIエージェント。Ryo の「もう一人の頭脳」のハードウェア実装。

## OpenClaw とは

Mac mini 上で常時稼働する Claude Code ベースの自律型AIエージェント。
rina リポジトリを永続記憶として読み書きし、定型作業だけでなく**状況判断を伴うタスク**を自律的に実行する。

## なぜ Mac mini か

- **常時起動**: MBP と違ってスリープしない。24/7 稼働
- **独立環境**: Ryo が MBP で作業中でも干渉しない
- **サーバー兼務**: LINE Bot、Cloudflare Tunnel なども同居可能

## アーキテクチャ

```
Mac mini (OpenClaw)
├─ Claude Code（自律エージェント）
│   ├─ rina リポジトリ（永続記憶）
│   ├─ Google Calendar MCP（予定の読み書き）
│   └─ claude -p（非対話モード実行）
├─ launchd（スケジューラ）
│   ├─ com.openclaw.morning-briefing（毎朝7:00）
│   └─ （今後追加予定）
├─ LINE Bot サーバー（port 3100）※移行予定
└─ Cloudflare Tunnel（外部アクセス）※移行予定
```

## 現在の機能

- [x] Deploy Key で rina リポジトリにアクセス
- [ ] 朝ブリーフィング自律生成 ← **今ここ**
- [ ] LINE Bot サーバー移行
- [ ] しらたまバックエンド移行

## 将来ビジョン

OpenClaw を育てていくことで:
- ブリーフィングの内容を自分で改善していく
- タスクの進捗を自分で追跡・リマインドする
- 事業データを分析して提案を出す
- Ryo の行動パターンを学習して先回りする

## 関連ノート

- [[OpenClaw セットアップガイド]]
- [[OpenClaw 自律ブリーフィング仕様]]
