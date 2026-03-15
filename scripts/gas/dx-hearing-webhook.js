/**
 * DXヒアリング Webhook ハンドラー
 *
 * Googleフォーム送信時に自動実行される。
 * 1. 回答データを構造化
 * 2. Mac mini（しらたま）にPOST
 * 3. Notion DBに同期
 *
 * セットアップ:
 * 1. このコードをcreate-dx-hearing-form.jsと同じGASプロジェクトに追加
 * 2. 下記の定数を環境に合わせて設定
 * 3. トリガー → トリガーを追加 → onFormSubmit → イベント: フォーム送信時
 */

// ===== 設定 =====
const CONFIG = {
  // しらたまエンドポイント
  SHIRATAMA_URL: 'https://api.tonari2tomaru.com/api/dx-hearing',

  // Notion API
  NOTION_API_KEY: PropertiesService.getScriptProperties().getProperty('NOTION_API_KEY'),
  NOTION_DB_ID: '970d40a58c9f4db8b562c0d9196be4c4',

  // LINE通知（しらたま経由でも可だが、直接送る場合）
  LINE_NOTIFY_URL: 'https://api.tonari2tomaru.com/api/line/push',
};

// ===== フォーム項目 → フィールド名のマッピング =====
const FIELD_MAP = {
  // 基本情報
  'お名前': 'name',
  'メールアドレス': 'email',
  '電話番号 または LINE ID': 'phone_or_line',
  '会社名・屋号': 'company',
  '所在地（都道府県）': 'prefecture',
  '業種': 'industry',
  'チーム規模': 'team_size',

  // 相談内容
  'ご相談内容': 'consultation_type',
  '具体的なお困りごと': 'problem_detail',
  '参考にしたいサイトやイメージ': 'reference_url',
  '既存のWebサイト・SNSのURL': 'existing_url',

  // 現状
  '普段お使いのデバイス': 'devices',
  '普段お使いのサービス・ツール': 'services',
  '今のやり方': 'current_method',

  // 業務改善
  'ラクにしたい作業': 'tasks_to_simplify',
  'その作業の頻度': 'frequency',
  '1回あたりの時間': 'time_per_task',
  '計算式やルール（その作業に決まったルールはありますか？）': 'has_rules',
  '一番イヤなところ': 'pain_points',
  '改善されたら一番嬉しいこと': 'desired_outcome',

  // EC
  '現在の販売チャネル': 'sales_channels',
  '商品数の目安': 'product_count',
  '商品の発送方法': 'shipping_method',
  '配送エリア': 'delivery_area',
  '送料の考え方': 'shipping_fee_type',
  '月間の注文数（目安）': 'monthly_orders',
  '決済方法の希望': 'payment_methods',
  '商品写真の準備状況': 'photo_status',
  '定期購入・サブスクの必要性': 'subscription_need',
  '在庫管理の現状': 'inventory_management',
  '返品・交換への対応': 'return_policy',

  // Web制作
  'サイトの目的': 'site_purpose',
  'ページ数の目安': 'page_count',
  'コンテンツの準備状況': 'content_status',
  'ロゴの有無': 'logo_status',

  // 予算
  '予算感': 'budget',
  '補助金の利用意向': 'subsidy_interest',
  '希望納期': 'deadline',
  '独自ドメイン（○○.com 等）の有無': 'domain_status',
  'その他ご要望・ご質問': 'additional_notes',
};

/**
 * フォーム送信時のメインハンドラー
 */
function onFormSubmit(e) {
  try {
    // 回答データを構造化
    const data = parseFormResponse(e);

    // Mac mini（しらたま）にPOST
    const shiratamaResult = postToShiratama(data);

    // Notion DBに同期
    const notionResult = syncToNotion(data);

    // ログ
    Logger.log('=== DXヒアリング処理完了 ===');
    Logger.log('案件名: ' + data.name);
    Logger.log('相談内容: ' + data.consultation_type);
    Logger.log('しらたま: ' + (shiratamaResult ? 'OK' : 'FAILED'));
    Logger.log('Notion: ' + (notionResult ? 'OK' : 'FAILED'));

  } catch (error) {
    Logger.log('ERROR: ' + error.message);
    Logger.log(error.stack);
    // エラー時もLINE通知
    notifyError(error, e);
  }
}

/**
 * フォーム回答をパース → 構造化データに変換
 */
function parseFormResponse(e) {
  const responses = e.response.getItemResponses();
  const data = {
    submitted_at: new Date().toISOString(),
    form_response_id: e.response.getId(),
  };

  responses.forEach(function(itemResponse) {
    const title = itemResponse.getItem().getTitle();
    const fieldName = FIELD_MAP[title];
    if (fieldName) {
      const answer = itemResponse.getResponse();
      // 配列の場合はそのまま、文字列の場合もそのまま
      data[fieldName] = answer;
    }
  });

  return data;
}

/**
 * Mac mini（しらたま）にPOST
 */
function postToShiratama(data) {
  try {
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(data),
      muteHttpExceptions: true,
      connectTimeout: 10000,
    };

    const response = UrlFetchApp.fetch(CONFIG.SHIRATAMA_URL, options);
    const code = response.getResponseCode();

    if (code === 200 || code === 201) {
      Logger.log('しらたまPOST成功: ' + code);
      return true;
    } else {
      Logger.log('しらたまPOST失敗: ' + code + ' ' + response.getContentText());
      return false;
    }
  } catch (error) {
    Logger.log('しらたまPOSTエラー: ' + error.message);
    return false;
  }
}

/**
 * Notion DBに同期
 */
function syncToNotion(data) {
  try {
    const notionApiKey = CONFIG.NOTION_API_KEY;
    if (!notionApiKey) {
      Logger.log('NOTION_API_KEY が未設定です。スクリプトプロパティに設定してください。');
      return false;
    }

    // Notion APIのプロパティ形式に変換
    const properties = buildNotionProperties(data);

    const payload = {
      parent: { database_id: CONFIG.NOTION_DB_ID },
      properties: properties,
    };

    const options = {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + notionApiKey,
        'Notion-Version': '2022-06-28',
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };

    const response = UrlFetchApp.fetch('https://api.notion.com/v1/pages', options);
    const code = response.getResponseCode();

    if (code === 200) {
      Logger.log('Notion同期成功');
      return true;
    } else {
      Logger.log('Notion同期失敗: ' + code + ' ' + response.getContentText());
      return false;
    }
  } catch (error) {
    Logger.log('Notionエラー: ' + error.message);
    return false;
  }
}

/**
 * Notion APIのプロパティ形式に変換
 */
function buildNotionProperties(data) {
  const props = {};

  // タイトル（お名前）
  if (data.name) {
    props['お名前'] = {
      title: [{ text: { content: data.name } }]
    };
  }

  // セレクト系
  const selectFields = {
    'ご相談内容': data.consultation_type,
    '業種': data.industry,
    'チーム規模': data.team_size,
    '作業の頻度': data.frequency,
    '1回あたりの時間': data.time_per_task,
    '計算式やルール': data.has_rules,
    '一番嬉しいこと': data.desired_outcome,
    '月間の注文数（目安）': data.monthly_orders,
    '予算感': data.budget,
    '補助金の利用意向': data.subsidy_interest,
    '希望納期': data.deadline,
    '独自ドメインの有無': data.domain_status,
    '商品数の目安': data.product_count,
    '配送エリア': data.delivery_area,
    '送料の考え方': data.shipping_fee_type,
    '商品写真の準備状況': data.photo_status,
    '定期購入・サブスクの必要性': data.subscription_need,
    '在庫管理の現状': data.inventory_management,
    '返品・交換への対応': data.return_policy,
    'ページ数の目安': data.page_count,
    'コンテンツの準備状況': data.content_status,
    'ロゴの有無': data.logo_status,
    '所在地': data.prefecture,
    'ステータス': '問い合わせ',
  };

  for (const [key, value] of Object.entries(selectFields)) {
    if (value) {
      props[key] = { select: { name: String(value) } };
    }
  }

  // マルチセレクト系
  const multiSelectFields = {
    'ラクにしたい作業': data.tasks_to_simplify,
    '一番イヤなところ': data.pain_points,
    '使用サービス': data.services,
    '使用デバイス': data.devices,
    '今のやり方': data.current_method,
    '商品の発送方法': data.shipping_method,
    '決済方法の希望': data.payment_methods,
    '現在の販売チャネル': data.sales_channels,
    'サイトの目的': data.site_purpose,
  };

  for (const [key, value] of Object.entries(multiSelectFields)) {
    if (value) {
      const items = Array.isArray(value) ? value : [value];
      props[key] = {
        multi_select: items.map(function(v) { return { name: String(v) }; })
      };
    }
  }

  // email型
  if (data.email) {
    props['メールアドレス'] = { email: data.email };
  }

  // url型
  if (data.existing_url) {
    props['既存WebサイトURL'] = { url: data.existing_url };
  }
  if (data.reference_url) {
    props['参考サイト・イメージ'] = { url: data.reference_url };
  }

  // リッチテキスト系
  const textFields = {
    '電話番号 / LINE ID': data.phone_or_line,
    '会社名・屋号': data.company,
    '具体的なお困りごと': data.problem_detail,
    'その他ご要望': data.additional_notes,
  };

  for (const [key, value] of Object.entries(textFields)) {
    if (value) {
      props[key] = {
        rich_text: [{ text: { content: String(value).substring(0, 2000) } }]
      };
    }
  }

  return props;
}

/**
 * エラー時のLINE通知
 */
function notifyError(error, event) {
  try {
    const message = '⚠️ DXヒアリングフォーム処理エラー\n' +
      'エラー: ' + error.message + '\n' +
      '時刻: ' + new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    UrlFetchApp.fetch(CONFIG.LINE_NOTIFY_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ message: message }),
      muteHttpExceptions: true,
    });
  } catch (e) {
    Logger.log('LINE通知も失敗: ' + e.message);
  }
}

/**
 * テスト用: 手動でフォーム送信をシミュレート
 */
function testOnFormSubmit() {
  const testData = {
    submitted_at: new Date().toISOString(),
    form_response_id: 'test-001',
    name: 'テスト太郎',
    email: 'test@example.com',
    phone_or_line: '090-1234-5678',
    company: 'テスト株式会社',
    prefecture: '山梨県',
    industry: '飲食',
    team_size: '2〜5人',
    consultation_type: 'ECサイト構築',
    problem_detail: 'ソーセージをネットで販売したい',
    devices: ['Windows PC', 'スマホだけ'],
    services: ['Gmail', 'LINE'],
    current_method: ['手書き・紙'],
    sales_channels: ['実店舗'],
    product_count: '6〜20点',
    shipping_method: ['冷蔵', '冷凍'],
    delivery_area: '全国',
    shipping_fee_type: '地域別',
    monthly_orders: 'これから始める',
    payment_methods: ['クレジットカード'],
    photo_status: '自分で撮影済み',
    subscription_need: '将来的に検討',
    inventory_management: 'Excel・スプレッドシート',
    return_policy: '対応する',
    budget: '15〜30万円',
    subsidy_interest: '興味はある',
    deadline: '2〜3ヶ月',
    domain_status: '持ってないが取りたい',
  };

  // しらたまにPOST
  const shiratamaResult = postToShiratama(testData);
  Logger.log('しらたまテスト: ' + shiratamaResult);

  // Notion同期
  const notionResult = syncToNotion(testData);
  Logger.log('Notionテスト: ' + notionResult);
}
