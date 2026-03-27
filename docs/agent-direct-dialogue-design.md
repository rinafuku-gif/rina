# エージェント間直接対話 設計書

**作成**: Engineer
**日付**: 2026-03-27
**ステータス**: 設計完了・実装待ち

---

## 概要

EngineerとAuditorがclaude-peersで直接対話し、CEOを介さずに品質改善ループを回す仕組み。

## 現状の課題

1. Engineer → CEO → Auditor → CEO → Engineer の伝言ゲームで遅延が発生
2. CEOのコンテキストウィンドウを消費する
3. 品質改善の反復が遅い（1往復に数分）

## 設計

### フロー

```
Engineer: 実装完了
    ↓ (claude-peers: send_message)
Auditor: 品質チェック実行
    ↓ (claude-peers: send_message)
Engineer: 指摘事項を修正
    ↓ (claude-peers: send_message)
Auditor: 再チェック → LGTM
    ↓ (claude-peers: send_message to CEO)
CEO: 最終結果のみ受け取る
```

### トリガー条件

Engineerが以下のタスクを完了したとき、自動的にAuditorに品質チェックを依頼：
1. UI変更・デザイン変更
2. SNS共有物（シェアカード、OGP画像等）
3. セキュリティに関わる変更
4. API設計・エンドポイント追加

### メッセージプロトコル

#### Engineer → Auditor（レビュー依頼）
```
【レビュー依頼】{タスク名}

## 変更内容
- {変更ファイル一覧}
- {変更概要}

## 確認してほしいポイント
- {重点確認事項}

## 対象ファイル
{ファイルパス}
```

#### Auditor → Engineer（レビュー結果）
```
【レビュー結果】{タスク名}

## 判定: LGTM / 要修正

## 指摘事項（要修正の場合）
1. {指摘内容} — {対象ファイル:行}
2. ...

## 良い点
- {良かった点}
```

#### Engineer → CEO（完了報告）
```
【完了報告】{タスク名}
Auditorレビュー済み: LGTM

## 変更内容
{概要}
```

### 実装方法

1. **CLAUDE.mdの更新**（済み）: Engineerの「自発的連携ルール」にAuditorへの直接依頼を記載
2. **Auditorの応答パターン**: AuditorのCLAUDE.mdに「Engineerからのレビュー依頼への対応方法」を追加
3. **claude-peers**: 既存のlist_peers + send_messageで実装可能。新規開発不要

### 拡張案（Phase 2以降）

- Creative → Engineer の直接対話（デザイン→実装）
- Researcher → Engineer の直接対話（技術調査→実装）
- 複数メンバーの同時参加（グループチャット的な利用）
- 対話ログの自動保存（Obsidian or Discord #audit チャンネル）

## リスク

- エージェント間で無限ループに入る可能性 → 最大往復回数を設定（3往復で打ち切り、CEOにエスカレーション）
- CEOが把握していない変更が入る → 完了報告の義務化で対応
- Auditorが不在の場合 → 5分タイムアウトでCEOにフォールバック（既存ルール）
