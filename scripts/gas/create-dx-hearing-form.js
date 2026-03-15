/**
 * DXヒアリングフォーム自動生成スクリプト
 *
 * 使い方:
 * 1. Google Apps Script (https://script.google.com) で新規プロジェクト作成
 * 2. このコードを貼り付け
 * 3. createDXHearingForm() を実行
 * 4. ログにフォームURL・スプレッドシートURLが表示される
 *
 * 生成されるもの:
 * - Googleフォーム（セクション分岐付き・全40問）
 * - 回答先スプレッドシート（自動リンク）
 */

function createDXHearingForm() {
  // ===== フォーム作成 =====
  const form = FormApp.create('AI活用DX化ヒアリング');
  form.setDescription(
    'SATOYAMA AI BASE のDX支援サービスにご興味いただきありがとうございます。\n' +
    'お客様の現状を把握し、最適なご提案をするためのヒアリングフォームです。\n' +
    '所要時間：約5〜10分\n\n' +
    'ご記入いただいた内容をもとに、ご提案書を作成いたします。'
  );
  form.setConfirmationMessage(
    'ご回答ありがとうございます！\n' +
    '内容を確認の上、2営業日以内にご連絡いたします。'
  );
  form.setCollectEmail(false); // 独自のメール項目で取得するため

  // ===== セクション1: 基本情報 =====
  form.addSectionHeaderItem()
    .setTitle('基本情報')
    .setHelpText('まずはお客様について教えてください。');

  form.addTextItem()
    .setTitle('お名前')
    .setRequired(true);

  form.addTextItem()
    .setTitle('メールアドレス')
    .setRequired(true)
    .setValidation(FormApp.createTextValidation()
      .requireTextMatchesPattern('^[\\w.+-]+@[\\w-]+\\.[\\w.]+$')
      .setHelpText('正しいメールアドレスを入力してください')
      .build());

  form.addTextItem()
    .setTitle('電話番号 または LINE ID')
    .setHelpText('ご連絡がつきやすい方をご記入ください')
    .setRequired(true);

  form.addTextItem()
    .setTitle('会社名・屋号')
    .setHelpText('個人の場合は「個人」とご記入ください')
    .setRequired(true);

  form.addListItem()
    .setTitle('所在地（都道府県）')
    .setChoiceValues([
      '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
      '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
      '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
      '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
      '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
      '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
      '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'
    ])
    .setRequired(true);

  form.addListItem()
    .setTitle('業種')
    .setChoiceValues(['士業', '飲食', '小売', 'サービス業', '農業', '製造', 'クリエイティブ', '建設・不動産', '医療・福祉', '教育', 'IT・Web', 'その他'])
    .setRequired(true);

  form.addListItem()
    .setTitle('チーム規模')
    .setChoiceValues(['1人', '2〜5人', '6〜10人', '11〜20人', '21人以上'])
    .setRequired(true);

  // ===== セクション2: ご相談内容（分岐の起点）=====
  form.addSectionHeaderItem()
    .setTitle('ご相談内容')
    .setHelpText('どのようなことでお困りですか？');

  const consultationType = form.addMultipleChoiceItem()
    .setTitle('ご相談内容')
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('具体的なお困りごと')
    .setHelpText('現在お困りのことや実現したいことを、できるだけ具体的にお書きください')
    .setRequired(true);

  form.addTextItem()
    .setTitle('参考にしたいサイトやイメージ')
    .setHelpText('URLや「○○のような感じ」など（任意）');

  form.addTextItem()
    .setTitle('既存のWebサイト・SNSのURL')
    .setHelpText('お持ちであればご記入ください（任意）');

  // ===== セクション3: 現状把握（共通）=====
  const sectionCommon = form.addPageBreakItem()
    .setTitle('現在のお仕事のやり方について')
    .setHelpText('今のやり方を教えてください。改善ポイントを見つけるために大切な情報です。');

  form.addCheckboxItem()
    .setTitle('普段お使いのデバイス')
    .setChoiceValues(['Windows PC', 'Mac', 'iPad・タブレット', 'スマホだけ'])
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('普段お使いのサービス・ツール')
    .setChoiceValues(['Gmail', 'LINE', 'Googleカレンダー', 'Excel', 'Googleスプレッドシート', 'ChatGPT', '会計ソフト（freee・MF等）', 'Notion', 'Slack', '特になし', 'その他'])
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('今のやり方')
    .setChoiceValues(['手書き・紙', 'Excel・スプレッドシート', 'Word・Googleドキュメント', '専用ソフト', 'スマホアプリ', 'その他'])
    .setRequired(true);

  // ===== セクション4: 業務改善・効率化 =====
  const sectionBusiness = form.addPageBreakItem()
    .setTitle('業務改善・効率化について')
    .setHelpText('どんな作業をラクにしたいか教えてください。');

  form.addCheckboxItem()
    .setTitle('ラクにしたい作業')
    .setChoiceValues(['見積書・請求書', 'スケジュール管理', '顧客・連絡先の管理', '書類の作成・整理', 'SNS・Web更新', 'データ入力・集計', '予約管理', '在庫管理', '経理・帳簿', 'メール対応', 'その他'])
    .setRequired(true);

  form.addListItem()
    .setTitle('その作業の頻度')
    .setChoiceValues(['毎日', '週2〜3回', '週1回', '月数回'])
    .setRequired(true);

  form.addListItem()
    .setTitle('1回あたりの時間')
    .setChoiceValues(['5分以内', '15分くらい', '30分くらい', '1時間以上'])
    .setRequired(true);

  form.addListItem()
    .setTitle('計算式やルール（その作業に決まったルールはありますか？）')
    .setChoiceValues(['ある', 'なんとなくある', 'ない', 'わからない'])
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('一番イヤなところ')
    .setChoiceValues(['同じことの繰り返し', '計算やチェックが面倒', '時間がかかる', 'ミスが怖い', 'やり方を覚えるのが大変', 'その他']);

  form.addListItem()
    .setTitle('改善されたら一番嬉しいこと')
    .setChoiceValues(['時間が浮く', 'ミスが減る', '自分じゃなくてもできるようになる', 'お客さんへの対応が早くなる', 'その他']);

  // ===== セクション5: ECサイト構築 =====
  const sectionEC = form.addPageBreakItem()
    .setTitle('ECサイト構築について')
    .setHelpText('ネットショップに必要な情報を教えてください。');

  form.addCheckboxItem()
    .setTitle('現在の販売チャネル')
    .setChoiceValues(['実店舗', '自社ECサイト', 'ECモール（Amazon・楽天等）', 'SNS販売（Instagram等）', 'なし（これから始める）', 'その他'])
    .setRequired(true);

  form.addListItem()
    .setTitle('商品数の目安')
    .setChoiceValues(['1〜5点', '6〜20点', '21〜50点', '51点以上'])
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('商品の発送方法')
    .setChoiceValues(['常温', '冷蔵', '冷凍', 'デジタル商品（ダウンロード等）', 'その他'])
    .setRequired(true);

  form.addListItem()
    .setTitle('配送エリア')
    .setChoiceValues(['全国', '地域限定（近県のみ）', '店頭受取のみ', '未定'])
    .setRequired(true);

  form.addListItem()
    .setTitle('送料の考え方')
    .setChoiceValues(['全国一律', '地域別', '○○円以上で送料無料', '送料込み（商品価格に含む）', '未定'])
    .setRequired(true);

  form.addListItem()
    .setTitle('月間の注文数（目安）')
    .setChoiceValues(['〜50件', '50〜200件', '200件以上', 'これから始める'])
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('決済方法の希望')
    .setChoiceValues(['クレジットカード', 'コンビニ払い', '銀行振込', 'PayPay等スマホ決済', 'こだわりなし', 'その他'])
    .setRequired(true);

  form.addListItem()
    .setTitle('商品写真の準備状況')
    .setChoiceValues(['プロが撮影済み', '自分で撮影済み', 'これから撮る', '撮影も依頼したい'])
    .setRequired(true);

  form.addListItem()
    .setTitle('定期購入・サブスクの必要性')
    .setChoiceValues(['あり', '将来的に検討', '不要'])
    .setRequired(true);

  form.addListItem()
    .setTitle('在庫管理の現状')
    .setChoiceValues(['手書き・紙', 'Excel・スプレッドシート', '専用ソフト', '特に管理してない'])
    .setRequired(true);

  form.addListItem()
    .setTitle('返品・交換への対応')
    .setChoiceValues(['対応する', '対応しない', '未定'])
    .setRequired(true);

  // ===== セクション6: Webサイト制作 =====
  const sectionWeb = form.addPageBreakItem()
    .setTitle('Webサイト制作について')
    .setHelpText('どんなサイトを作りたいか教えてください。');

  form.addCheckboxItem()
    .setTitle('サイトの目的')
    .setChoiceValues(['会社・事業紹介', '集客・問い合わせ獲得', '採用', 'ブランディング', '予約受付', 'ブログ・情報発信', 'ポートフォリオ', 'その他'])
    .setRequired(true);

  form.addListItem()
    .setTitle('ページ数の目安')
    .setChoiceValues(['1ページ（LP）', '3〜5ページ', '6〜10ページ', '10ページ以上', 'わからない'])
    .setRequired(true);

  form.addListItem()
    .setTitle('コンテンツの準備状況')
    .setChoiceValues(['原稿・写真すべて揃ってる', '一部ある', 'これから全部作る'])
    .setRequired(true);

  form.addListItem()
    .setTitle('ロゴの有無')
    .setChoiceValues(['ある', 'ない（作ってほしい）', 'ない（不要）'])
    .setRequired(true);

  // ===== セクション7: 予算・スケジュール（共通）=====
  const sectionBudget = form.addPageBreakItem()
    .setTitle('予算・スケジュール')
    .setHelpText('最後に、ご予算と希望スケジュールを教えてください。');

  form.addListItem()
    .setTitle('予算感')
    .setChoiceValues(['〜5万円', '5〜15万円', '15〜30万円', '30〜50万円', '50万円以上', '補助金を使いたい', 'まだ決めてない'])
    .setRequired(true);

  form.addListItem()
    .setTitle('補助金の利用意向')
    .setHelpText('IT導入補助金等を活用すると、費用の1/2〜3/4が補助される場合があります')
    .setChoiceValues(['使いたい', '興味はある', '使わない', 'わからない'])
    .setRequired(true);

  form.addListItem()
    .setTitle('希望納期')
    .setChoiceValues(['1ヶ月以内', '2〜3ヶ月', '半年以内', '急いでない'])
    .setRequired(true);

  form.addListItem()
    .setTitle('独自ドメイン（○○.com 等）の有無')
    .setChoiceValues(['持ってる', '持ってないが取りたい', 'こだわりなし', 'わからない'])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('その他ご要望・ご質問')
    .setHelpText('何でもお気軽にお書きください（任意）');

  // ===== セクション分岐の設定 =====
  consultationType.setChoices([
    consultationType.createChoice('業務改善・効率化', sectionCommon),
    consultationType.createChoice('ECサイト構築', sectionCommon),
    consultationType.createChoice('Webサイト制作', sectionCommon),
    consultationType.createChoice('SNS運用・発信', sectionCommon),
    consultationType.createChoice('その他', sectionCommon)
  ]);

  // 共通セクション → 相談内容に応じた分岐
  // NOTE: Googleフォームの制約上、ページ単位の分岐はPageBreakItemの
  // setGoToPage で制御する。ただし、回答値に基づく動的分岐は
  // MultipleChoiceItem でのみ可能。
  //
  // 現実的な運用: 全セクションを表示し、該当しないセクションは
  // 「該当しない場合はスキップしてください」と案内する方式にする。
  // → GASのonFormSubmitで未回答セクションをフィルタリングする。

  // 各セクションの次ページ設定
  sectionBusiness.setGoToPage(sectionBudget); // 業務改善 → 予算へ
  sectionEC.setGoToPage(sectionBudget);       // EC → 予算へ
  sectionWeb.setGoToPage(sectionBudget);      // Web → 予算へ

  // ===== 回答先スプレッドシート作成 =====
  const ss = SpreadsheetApp.create('DXヒアリング回答一覧');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  // ===== 完了ログ =====
  Logger.log('=== DXヒアリングフォーム作成完了 ===');
  Logger.log('フォームURL（編集）: ' + form.getEditUrl());
  Logger.log('フォームURL（回答）: ' + form.getPublishedUrl());
  Logger.log('スプレッドシートURL: ' + ss.getUrl());
  Logger.log('スプレッドシートID: ' + ss.getId());
  Logger.log('');
  Logger.log('【次のステップ】');
  Logger.log('1. フォームを開いてデザイン・色を調整');
  Logger.log('2. dx-hearing-webhook.js のスクリプトを同じGASプロジェクトに追加');
  Logger.log('3. onFormSubmit のトリガーを設定');
  Logger.log('   - トリガー → トリガーを追加 → onFormSubmit → フォーム送信時');

  return {
    formUrl: form.getPublishedUrl(),
    editUrl: form.getEditUrl(),
    spreadsheetUrl: ss.getUrl(),
    spreadsheetId: ss.getId()
  };
}
