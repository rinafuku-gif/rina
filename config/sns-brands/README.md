# SNS ブランド設定ファイル

## 概要
各Instagramアカウントのブランド設定（世界観、トーン、コンテンツの柱、投稿ルール）を定義。
AI投稿生成スクリプトがこれらを参照して、アカウントごとの世界観に沿った投稿案を生成する。

## アカウント一覧

| ファイル | アカウント | 事業 | フォロワー | 状態 |
|---|---|---|---|---|
| ryosuke_ina.md | @ryosuke_ina | 個人 | 897 | 運用中 |
| misoca_coffee.md | @misoca_coffee | 三十日珈琲 | 654 | 運用中 |
| misoca_coffeestand.md | @misoca_coffeestand | misoca coffee stand | 111 | 運用中 |
| engawa_yanagawa.md | @engawa_yanagawa | えんがわ | 111 | 運用中 |
| satoyama_ai_base.md | @satoyama_ai_base | SATOYAMA AI BASE | 2 | 立ち上げ前 |
| tonari2tomaru.md | (未作成) | となりにとまる | - | 未作成 |

## 使い方
- `scripts/sns-generate.sh` が各ブランド設定を読み込み、投稿案を生成する
- 設定変更はこのフォルダ内のmdファイルを直接編集すればOK
- 新しいアカウントを追加する場合は、既存ファイルをテンプレートにしてコピー
