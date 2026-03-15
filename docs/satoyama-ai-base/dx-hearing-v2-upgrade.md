# DXヒアリング v2 アップグレード指示書

> この指示書をMac miniのしらたまリポジトリでClaude Code CLIに渡して実装してもらう用
> 対象: しらたまの `/api/dx-hearing` エンドポイント改修

## 背景・課題

現在の実装はテンプレートベースで以下の問題がある：

1. **見積もりがハードコード** — 顧客の予算フィールドを一切考慮せず、相談内容だけで機械的に算出
2. **提案書が画一的** — 顧客の具体的な悩みや状況に合わせたカスタマイズがない
3. **当初ビジョン未達** — 本来は「Claude Code CLIが要件分析→提案書生成→実装まで自動」の構想だった

## v2 のゴール

```
フォーム送信
  ↓ GAS Webhook → しらたま受信
  ↓
1. データ保存（現行通り）
  ↓
2. Claude API で要件分析・提案書生成（★ここがv2の核）
   - 顧客の具体的な悩み・状況を深く分析
   - 予算に合わせた松竹梅プランを生成
   - 技術スタック提案に根拠を添える
   - 補助金活用時の実質負担額を算出
  ↓
3. 提案書をMarkdownで保存
  ↓
4. LINE通知（提案書サマリー付き）
  ↓
5. RyoがレビューしてGOサイン
  ↓
6. GOサイン後 → Claude Code CLIが実装を開始（フェーズ2で対応）
```

## 実装内容

### 1. Claude API を使った提案書生成

現在の `estimateBudget()` + テンプレート方式を廃止し、Claude API で生成する。

#### Anthropic SDK インストール

```bash
npm install @anthropic-ai/sdk
```

#### 環境変数

```
ANTHROPIC_API_KEY=sk-ant-xxxxx  # .envに追加
```

#### 提案書生成関数

```javascript
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();

async function generateProposal(hearingData) {
  const systemPrompt = `あなたはSATOYAMA AI BASEの提案書作成AIです。
DXヒアリングフォームの回答データを分析し、顧客に最適な提案書を生成してください。

## あなたの役割
- 顧客の課題を深く理解し、実現可能な解決策を提案する
- 予算に合わせた現実的なプランを提示する（予算オーバーの提案はしない）
- 技術スタックの選定理由を明確にする
- SATOYAMA AI BASEの強みを活かした提案をする

## SATOYAMA AI BASEの技術スタック
- Web: Next.js + Vercel（高速・SEO対応・無料枠で運用可能）
- 決済: Stripe（クレジットカード・コンビニ払い対応）
- DB: Supabase（管理画面付き・PostgreSQL・無料枠あり）
- メール: Brevo（顧客管理+メルマガ・月300通無料）
- 自動化: Google Apps Script / Make（ノーコード連携）
- CMS: Notion API / MDX

## 予算別の提案方針
- 〜5万円: GAS中心の自動化、既存ツールの組み合わせ。コーディング最小限
- 5〜15万円: シンプルなWebサイト or 業務自動化。テンプレート活用
- 15〜30万円: ECサイト基本構成 or 本格Webサイト。カスタムデザイン込み
- 30〜50万円: フル機能EC or 複合システム。管理画面カスタマイズ含む
- 50万円以上: エンタープライズ級。独自機能開発・API連携多数
- 補助金利用: IT導入補助金（最大450万円・補助率1/2〜3/4）活用で実質負担を大幅軽減

## 出力形式
Markdownで以下の構成の提案書を生成してください：

# [会社名] 様 DX支援 ご提案書

## お客様の課題
（ヒアリング内容から課題を整理・言語化）

## ご提案概要
（1〜2文で提案の全体像）

## 現状分析
（現在の業務フロー・課題の構造的な分析）

## ご提案プラン

### プランA: [プラン名]（推奨）
- 概要
- 機能一覧
- 技術スタックと選定理由
- 概算: ¥XXX,XXX
- 期間: X週間

### プランB: [プラン名]（ミニマム）
- 概要
- 機能一覧（プランAから削ぎ落としたもの）
- 概算: ¥XXX,XXX
- 期間: X週間

※ 予算が十分な場合のみプランCも追加

## 補助金活用のご案内
（補助金利用意向がある場合のみ）

## スケジュール案
| フェーズ | 内容 | 期間 |
|---|---|---|

## 次のステップ
1. 本提案書の内容確認
2. オンラインまたは対面でのすり合わせ（30分程度）
3. 正式お見積もり・ご契約
4. 制作開始`;

  const userPrompt = `以下のDXヒアリングフォームの回答データを分析し、提案書を生成してください。

## 回答データ
${JSON.stringify(hearingData, null, 2)}

## 重要な注意点
- 予算「${hearingData.budget || '未回答'}」を必ず考慮してください
- 予算を大幅に超える提案はNGです。予算内で最大の価値を出すプランを考えてください
- 予算が低い場合は、スコープを絞って実現可能な提案にしてください
- 「まだ決めてない」の場合は、相談内容に応じた相場感を提示してください
- 補助金利用意向「${hearingData.subsidy_interest || '未回答'}」も考慮してください`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [
      { role: 'user', content: userPrompt }
    ],
    system: systemPrompt,
  });

  return response.content[0].text;
}
```

### 2. エンドポイント改修

既存の `/api/dx-hearing` ハンドラーを以下のように改修する：

```javascript
app.post('/api/dx-hearing', async (req, res) => {
  try {
    const data = req.body;

    // 1. データ保存（現行通り）
    const caseId = saveCaseData(data);

    // 2. Claude APIで提案書生成（★v2の核）
    console.log(`[DX Hearing] Claude APIで提案書生成中... 案件: ${data.name}`);
    const proposal = await generateProposal(data);

    // 3. 提案書をMarkdownで保存
    const proposalPath = saveProposal(caseId, data.name, proposal);

    // 4. 見積もり金額を提案書から抽出（LINE通知用）
    const estimatedAmount = extractEstimate(proposal);

    // 5. LINE通知（提案書サマリー付き）
    await sendLineNotification(data, proposal, estimatedAmount);

    res.json({
      success: true,
      case_id: caseId,
      proposal_path: proposalPath,
      estimated_amount: estimatedAmount,
    });

  } catch (error) {
    console.error('[DX Hearing] エラー:', error);
    // エラー時もLINE通知
    await notifyError(error, req.body);
    res.status(500).json({ success: false, error: error.message });
  }
});
```

### 3. 見積もり金額の抽出

提案書のMarkdownから金額を抽出する関数：

```javascript
function extractEstimate(proposalMarkdown) {
  // 「概算: ¥XXX,XXX」のパターンを検索
  const matches = proposalMarkdown.match(/概算[:：]\s*[¥￥]([0-9,]+)/g);
  if (!matches) return null;

  // 最初のプラン（推奨）の金額を返す
  const firstMatch = matches[0].match(/[0-9,]+/);
  return firstMatch ? parseInt(firstMatch[0].replace(/,/g, ''), 10) : null;
}
```

### 4. LINE通知の改善

提案書の要点をLINE通知に含める：

```javascript
async function sendLineNotification(data, proposal, estimatedAmount) {
  // 提案書の冒頭（お客様の課題 + ご提案概要）を抜粋
  const summary = extractSummary(proposal);

  const message = [
    `📋 新規DXヒアリング`,
    ``,
    `👤 ${data.name}（${data.company || '個人'}）`,
    `📍 ${data.prefecture || '未回答'} / ${data.industry || '未回答'}`,
    `💬 ${data.consultation_type}`,
    ``,
    `📝 ${(data.problem_detail || '').substring(0, 100)}`,
    ``,
    `💰 予算: ${data.budget || '未回答'}`,
    `📊 概算見積もり: ${estimatedAmount ? `¥${estimatedAmount.toLocaleString()}` : '要確認'}`,
    estimatedAmount && data.budget ? `${getBudgetFitMessage(data.budget, estimatedAmount)}` : '',
    `📅 希望納期: ${data.deadline || '未回答'}`,
    `🏷 補助金: ${data.subsidy_interest || '未回答'}`,
    ``,
    `📄 AI提案書: 生成済み`,
    `${summary}`,
    ``,
    `→ 詳細はターミナルで確認`,
  ].filter(Boolean).join('\n');

  // LINE Push API
  await fetch(CONFIG.LINE_NOTIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

// 予算と見積もりの乖離メッセージ
function getBudgetFitMessage(budget, estimate) {
  const budgetMap = {
    '〜5万円': 50000,
    '5〜15万円': 150000,
    '15〜30万円': 300000,
    '30〜50万円': 500000,
    '50万円以上': 1000000,
  };
  const budgetMax = budgetMap[budget];
  if (!budgetMax) return '';

  if (estimate <= budgetMax) {
    return '✅ 予算内に収まります';
  } else if (estimate <= budgetMax * 1.3) {
    return '⚠️ 予算をやや超過（補助金で調整可能）';
  } else {
    return '🔴 予算超過 → ミニマムプランを推奨';
  }
}

// 提案書から要約を抽出
function extractSummary(proposal) {
  const overviewMatch = proposal.match(/## ご提案概要\n([\s\S]*?)(?=\n##)/);
  if (overviewMatch) {
    return overviewMatch[1].trim().substring(0, 150);
  }
  return '';
}
```

### 5. 既存コードの削除対象

以下の関数は不要になるので削除する：

- `estimateBudget()` — ハードコード見積もり
- テンプレートベースの提案書生成ロジック全般

### 6. エラーハンドリング

Claude API が失敗した場合のフォールバック：

```javascript
async function generateProposalWithFallback(data) {
  try {
    return await generateProposal(data);
  } catch (error) {
    console.error('[DX Hearing] Claude API失敗、簡易提案書で代替:', error.message);
    // フォールバック: 最低限の情報をまとめた簡易提案書
    return generateSimpleProposal(data);
  }
}

function generateSimpleProposal(data) {
  return `# ${data.company || data.name} 様 DX支援 ご提案書

## お客様情報
- お名前: ${data.name}
- 会社名: ${data.company || '個人'}
- ご相談内容: ${data.consultation_type}

## お困りごと
${data.problem_detail || '（詳細はヒアリングで確認）'}

## ご予算
${data.budget || '未回答'}

---
⚠️ この提案書はAI生成に失敗したため簡易版です。
Ryoが手動で提案書を作成してください。`;
}
```

## フェーズ2（将来）: GOサイン後の自動実装

RyoがLINEで「GO」と返したら、Claude Code CLIが実装を開始する仕組み。
これはv2の提案書生成が安定してから着手する。

```
Ryo「GO」→ しらたま受信
  ↓
案件データ + 提案書を読み込み
  ↓
Claude Code CLI をサブプロセスで起動
  - 新規リポジトリ作成 or テンプレートから生成
  - 提案書の機能一覧に沿って実装
  - 完了したらVercelにデプロイ
  ↓
LINE通知「実装完了しました → プレビューURL」
```

## テスト方法

```bash
# 既存のテストデータで確認（予算5万円のケース）
curl -X POST https://api.tonari2tomaru.com/api/dx-hearing \
  -H "Content-Type: application/json" \
  -d '{
    "name": "テスト太郎",
    "company": "テスト株式会社",
    "consultation_type": "ECサイト構築",
    "problem_detail": "ソーセージをネットで販売したい",
    "budget": "〜5万円",
    "subsidy_interest": "興味はある",
    "deadline": "2〜3ヶ月",
    "product_count": "6〜20点",
    "shipping_method": ["冷蔵", "冷凍"],
    "delivery_area": "全国"
  }'
```

予算5万円の場合、Claude APIが「ECサイトフル構築は5万円では難しいので、まずはBASEやSTORESなどの既存プラットフォーム活用 or 最小限のLP+決済リンクから始める」といった現実的な提案を返すことを確認する。

## チェックリスト

- [ ] `npm install @anthropic-ai/sdk`
- [ ] `.env` に `ANTHROPIC_API_KEY` を追加
- [ ] `generateProposal()` 関数を実装
- [ ] 既存の `estimateBudget()` + テンプレート生成を置き換え
- [ ] `extractEstimate()` で提案書から金額抽出
- [ ] LINE通知に予算フィット判定メッセージを追加
- [ ] エラー時のフォールバック実装
- [ ] テスト送信で動作確認（予算5万円 / 15〜30万円 / 50万円以上の3パターン）
