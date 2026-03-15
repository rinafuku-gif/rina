# しらたま DXヒアリングエンドポイント実装指示書

> この指示書をClaude Code CLIにそのまま渡して実装してもらう用
> 対象リポジトリ: しらたま（Mac mini上で動作中のExpressサーバー）

## 概要

GoogleフォームでDXヒアリングの回答が送信されると、GAS経由でしらたまの `/api/dx-hearing` エンドポイントにPOSTされる。しらたまはその回答データを分析し、提案書を自動生成してLINEでRyoに通知する。

## 実装してほしいこと

### 1. エンドポイント追加: `POST /api/dx-hearing`

```javascript
// リクエストボディの構造
{
  "submitted_at": "2026-03-15T10:00:00.000Z",
  "form_response_id": "abc123",

  // 基本情報
  "name": "村上さん",
  "email": "test@example.com",
  "phone_or_line": "090-1234-5678",
  "company": "ハヤリソーセージ",
  "prefecture": "山梨県",
  "industry": "飲食",
  "team_size": "2〜5人",

  // 相談内容
  "consultation_type": "ECサイト構築",
  "problem_detail": "ソーセージをネットで販売したい...",
  "reference_url": "https://example.com",
  "existing_url": "https://instagram.com/hayari",

  // 現状把握
  "devices": ["Windows PC", "スマホだけ"],
  "services": ["Gmail", "LINE"],
  "current_method": ["手書き・紙"],

  // EC専用（consultation_type がECの場合）
  "sales_channels": ["実店舗"],
  "product_count": "6〜20点",
  "shipping_method": ["冷蔵", "冷凍"],
  "delivery_area": "全国",
  "shipping_fee_type": "地域別",
  "monthly_orders": "これから始める",
  "payment_methods": ["クレジットカード"],
  "photo_status": "自分で撮影済み",
  "subscription_need": "将来的に検討",
  "inventory_management": "Excel・スプレッドシート",
  "return_policy": "対応する",

  // 業務改善専用（consultation_type が業務改善の場合）
  "tasks_to_simplify": ["見積書・請求書", "顧客・連絡先の管理"],
  "frequency": "毎日",
  "time_per_task": "30分くらい",
  "has_rules": "なんとなくある",
  "pain_points": ["同じことの繰り返し", "時間がかかる"],
  "desired_outcome": "時間が浮く",

  // Web制作専用（consultation_type がWebの場合）
  "site_purpose": ["会社・事業紹介", "集客・問い合わせ獲得"],
  "page_count": "3〜5ページ",
  "content_status": "一部ある",
  "logo_status": "ある",

  // 予算・スケジュール
  "budget": "15〜30万円",
  "subsidy_interest": "興味はある",
  "deadline": "2〜3ヶ月",
  "domain_status": "持ってないが取りたい",
  "additional_notes": "特になし"
}
```

### 2. 処理フロー

```
POST /api/dx-hearing 受信
    ↓
1. データをJSONファイルとして保存
   保存先: data/dx-hearing/案件ID-名前-日付.json
    ↓
2. 回答内容に応じた提案書テンプレートを生成
   - consultation_type に応じて分岐
   - 技術スタック提案を自動生成
   - 概算見積もりを算出
    ↓
3. 提案書をMarkdownで出力
   保存先: data/dx-hearing/proposals/案件ID-提案書.md
    ↓
4. LINE通知をRyoに送信
   「新規案件: [名前] - [相談内容]\n提案書を生成しました」
    ↓
5. レスポンス返却 { success: true, proposal_path: "..." }
```

### 3. 提案書テンプレート生成ロジック

consultation_type に応じて自動的に技術スタックと見積もりを提案する。

#### ECサイト構築の場合

```markdown
# DX支援 提案書

## お客様情報
- お名前: {{name}}
- 会社名: {{company}}
- 業種: {{industry}}

## ご相談内容
{{problem_detail}}

## 現状分析
- 現在の販売チャネル: {{sales_channels}}
- 商品数: {{product_count}}
- 発送方法: {{shipping_method}}
- 在庫管理: {{inventory_management}}

## ご提案

### 技術スタック
- フレームワーク: Next.js（高速・SEO対応）
- 決済: Stripe（{{payment_methods}} 対応）
- データベース: Supabase（管理画面付き・無料枠で運用可能）
- メール: Brevo（顧客管理+メルマガ配信）
- ホスティング: Vercel（自動デプロイ・高速配信）

### 機能一覧
- [ ] 商品一覧・詳細ページ
- [ ] カート・購入フロー
- [ ] 決済連携（{{payment_methods}}）
- [ ] 注文管理（Supabase管理画面）
- [ ] 顧客管理
- [ ] メルマガ配信
{{#if subscription_need === 'あり'}}
- [ ] 定期購入機能
{{/if}}
{{#if return_policy === '対応する'}}
- [ ] 返品・交換管理
{{/if}}

### 概算見積もり
| 項目 | 金額 |
|---|---|
| ECサイト構築（デザイン+実装） | ¥XXX,XXX |
| 決済連携 | 含む |
| 管理画面セットアップ | 含む |
| 運用レクチャー | 含む |
| **合計** | **¥XXX,XXX** |

※ 補助金利用の場合、実質負担は上記の1/2〜1/4になります

### スケジュール案
- フェーズ1（設計）: 2週間
- フェーズ2（実装）: 3〜4週間
- フェーズ3（テスト・調整）: 1〜2週間
- 納品目標: {{deadline}} 以内
```

#### 業務改善の場合

技術スタックは相談内容に応じて動的に決定:
- スケジュール管理 → Google Calendar API + GAS
- 見積書・請求書 → GAS + テンプレート自動生成
- データ入力・集計 → GAS + スプレッドシート自動化
- 予約管理 → Google Calendar + Webフォーム
- 顧客管理 → Supabase or スプレッドシート

#### Webサイト制作の場合

- フレームワーク: Next.js
- ホスティング: Vercel
- CMS: Notion API or MDX（更新頻度に応じて）

### 4. 見積もり自動算出ロジック

```javascript
function estimateBudget(data) {
  let base = 0;

  switch (data.consultation_type) {
    case 'ECサイト構築':
      base = 200000; // 基本20万円
      if (data.product_count === '21〜50点') base += 50000;
      if (data.product_count === '51点以上') base += 100000;
      if (data.subscription_need === 'あり') base += 50000;
      if (data.shipping_fee_type === '地域別') base += 30000;
      break;

    case 'Webサイト制作':
      base = 100000; // 基本10万円
      if (data.page_count === '6〜10ページ') base += 50000;
      if (data.page_count === '10ページ以上') base += 100000;
      if (data.logo_status === 'ない（作ってほしい）') base += 30000;
      break;

    case '業務改善・効率化':
      base = 50000; // 基本5万円
      const taskCount = data.tasks_to_simplify ? data.tasks_to_simplify.length : 1;
      base += (taskCount - 1) * 30000;
      break;

    default:
      base = 100000;
  }

  return base;
}
```

### 5. LINE通知フォーマット

```
📋 新規DXヒアリング

👤 ${name}（${company}）
📍 ${prefecture} / ${industry}
💬 ${consultation_type}

📝 ${problem_detail.substring(0, 100)}...

💰 予算: ${budget}
📅 希望納期: ${deadline}
🏷 補助金: ${subsidy_interest}

📄 提案書: 生成済み
→ 確認はターミナルで
```

## セットアップ手順

1. しらたまのExpressサーバーにエンドポイントを追加
2. `data/dx-hearing/` と `data/dx-hearing/proposals/` ディレクトリを作成
3. テスト: `curl -X POST https://api.tonari2tomaru.com/api/dx-hearing -H "Content-Type: application/json" -d @test-data.json`

## GAS側の設定（参照）

GASスクリプトは `rina/scripts/gas/` に格納済み:
- `create-dx-hearing-form.js` — Googleフォーム自動生成
- `dx-hearing-webhook.js` — onFormSubmitハンドラー（このエンドポイントにPOSTする）

GASのスクリプトプロパティに設定が必要:
- `NOTION_API_KEY` — Notion Integration のAPIキー
