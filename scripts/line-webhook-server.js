// @critical: start-line-bot.sh から常駐起動（Airbnb予約通知・LINE Webhook）
// @stops-if-deleted: Airbnb予約通知の自動取り込み・HIBA/UME室判定・airbnb-sync.shの同期APIが止まる
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");
const unifiedApi = require("./unified-api");
const dataIngester = require("./data-ingester");
const agentEvaluator = require("./agent-evaluator");

// .env 読み込み
const envPath = path.join(__dirname, "..", ".env");
const envContent = fs.readFileSync(envPath, "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

const CHANNEL_ACCESS_TOKEN = env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = env.LINE_CHANNEL_SECRET;
const USER_ID = env.LINE_USER_ID;
const PORT = 3100;

// Discord通知設定（DXワークフロー用）
const DISCORD_NOTIFICATIONS_CHANNEL_ID = "1486651097157472307";
const DISCORD_BOT_TOKEN = (() => {
  try {
    const discordEnvPath = "/Users/Inaryo/.claude/channels/discord/.env";
    const discordEnv = fs.readFileSync(discordEnvPath, "utf-8");
    const match = discordEnv.match(/^DISCORD_BOT_TOKEN=(.*)$/m);
    return match ? match[1].trim() : "";
  } catch {
    console.error("[Discord] Bot token not found at /Users/Inaryo/.claude/channels/discord/.env");
    return "";
  }
})();

const REPO_DIR = path.join(__dirname, "..");
const PROMPT_FILE = path.join(REPO_DIR, "logs", ".current-prompt.txt");
const CLAUDE_PATH = "/Users/Inaryo/.local/share/mise/installs/node/24.14.0/bin/claude";
const CLAUDE_TIMEOUT = 480000; // 8分

// Notion API 設定
const NOTION_API_KEY = env.NOTION_API_KEY || "";
const NOTION_DX_HEARING_DB_ID = env.NOTION_DX_HEARING_DB_ID || "";

// Web Push 設定
webpush.setVapidDetails(
  "mailto:r.inafuku@tonari2tomaru.com",
  env.VAPID_PUBLIC_KEY,
  env.VAPID_PRIVATE_KEY
);
const SUBSCRIPTIONS_FILE = path.join(REPO_DIR, "logs", ".push-subscriptions.json");
const CHAT_LOG_FILE = path.join(REPO_DIR, "logs", ".chat-history.json");

function loadChatHistory() {
  try { return JSON.parse(fs.readFileSync(CHAT_LOG_FILE, "utf-8")); } catch { return []; }
}
function saveChatHistory(history) {
  fs.writeFileSync(CHAT_LOG_FILE, JSON.stringify(history, null, 2));
}
function appendChatLog(source, role, content) {
  const history = loadChatHistory();
  history.push({
    timestamp: new Date().toISOString(),
    source, // "line" or "pwa"
    role,    // "user" or "assistant"
    content: content.slice(0, 5000), // 長すぎるものは切る
  });
  // 最大500件保持
  if (history.length > 500) history.splice(0, history.length - 500);
  saveChatHistory(history);
}
function loadSubscriptions() {
  try { return JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, "utf-8")); } catch { return []; }
}
function saveSubscriptions(subs) {
  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2));
}
async function sendWebPush(title, body, options = {}) {
  const subs = loadSubscriptions();
  const payload = JSON.stringify({ title, body, ...options });
  const expired = [];
  for (let i = 0; i < subs.length; i++) {
    try {
      await webpush.sendNotification(subs[i], payload);
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) expired.push(i);
      console.error("Web push error:", e.statusCode || e.message);
    }
  }
  if (expired.length > 0) {
    const cleaned = subs.filter((_, i) => !expired.includes(i));
    saveSubscriptions(cleaned);
  }
}

// レシート処理キュー（claude -p は同時1つまで）
const receiptQueue = [];
let receiptProcessing = false;
function enqueueReceipt(fn) {
  receiptQueue.push(fn);
  processReceiptQueue();
}
async function processReceiptQueue() {
  if (receiptProcessing || receiptQueue.length === 0) return;
  receiptProcessing = true;
  const fn = receiptQueue.shift();
  try { await fn(); } catch (e) { console.error("Receipt queue error:", e.message); }
  receiptProcessing = false;
  processReceiptQueue();
}

// Google API helper
function getGoogleAccessToken() {
  return new Promise((resolve, reject) => {
    const postData = new (require("url").URLSearchParams)({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }).toString();
    const req = https.request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const d = JSON.parse(body);
          d.access_token ? resolve(d.access_token) : reject(new Error("No access token"));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function googleApiRequest(method, url, body, token, contentType) {
  return new Promise((resolve, reject) => {
    const urlObj = new (require("url").URL)(url);
    const headers = { "Authorization": `Bearer ${token}` };
    if (contentType) headers["Content-Type"] = contentType;
    else if (body && typeof body === "string") headers["Content-Type"] = "application/json";
    else if (body && Buffer.isBuffer(body)) { /* content-type set by caller */ }

    const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method, headers };
    const req = https.request(options, (res) => {
      let data = [];
      res.on("data", (c) => data.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(data);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf.toString())); } catch { resolve(buf.toString()); }
        } else {
          reject(new Error(`Google API ${res.statusCode}: ${buf.toString().slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : body);
    req.end();
  });
}

// ========== Airbnb予約メール同期 ==========
const BOOKINGS_LOG = path.join(REPO_DIR, "logs", ".airbnb-bookings.json");
const ENGAWA_HIBA_CAL = "4651f62429c52388651033e5b59f4cb81a418694431ab262748b231c663e461f@group.calendar.google.com";
const ENGAWA_UME_CAL = "engawa.yanagawa@gmail.com";
const BC_TORISAWA_CAL = "c_aba25d9245279ce28085bd6ccde59d6af1b75a3212bc83613eca252f20d391b3@group.calendar.google.com";

function loadBookingsLog() {
  try { return JSON.parse(fs.readFileSync(BOOKINGS_LOG, "utf-8")); } catch { return []; }
}
function saveBookingsLog(bookings) {
  fs.writeFileSync(BOOKINGS_LOG, JSON.stringify(bookings, null, 2));
}

function parseAirbnbConfirmationEmail(body) {
  // リスティング名からHIBA/UME判定
  // 実際のリスティング名: "COFFEE WITH A MOUNTAIN VIEW | TRADITIONAL HOUSE H" or "...HOUSE U"
  let room = "UNKNOWN";
  if (/TRADITIONAL\s+HOUSE\s+H\b/i.test(body) || /HOUSE\s+H\b/i.test(body)) room = "HIBA";
  else if (/TRADITIONAL\s+HOUSE\s+U\b/i.test(body) || /HOUSE\s+U\b/i.test(body)) room = "UME";
  // フォールバック: 旧パターン（互換性のため残す）
  else if (/MOUNTAIN VIEW\s*\|\s*.*H\b/i.test(body)) room = "HIBA";
  else if (/MOUNTAIN VIEW\s*\|\s*.*U\b/i.test(body)) room = "UME";
  // BC鳥沢: リスティング名「【大月・鳥沢】泊まれる道具箱 - こだわりギアが詰まった山麓のベースキャンプ」
  else if (/【?大月[・\s]*鳥沢】?|泊まれる道具箱|Basecamp\s*Torisawa|BC\s*鳥沢/i.test(body)) room = "TORISAWA";

  // チェックイン・チェックアウト日
  // メール形式: 「チェックイン    チェックアウト\n\n4月5日(日)   4月6日(月)」
  // → 「チェックイン」セクション以降の最初の2つの日付がCI/CO
  const dates = [];
  const ciSection = body.indexOf("チェックイン");
  if (ciSection >= 0) {
    const afterCI = body.slice(ciSection);
    const datePattern = /(\d{1,2})月(\d{1,2})日/g;
    let dm;
    while ((dm = datePattern.exec(afterCI)) !== null && dates.length < 2) {
      dates.push({ month: parseInt(dm[1]), day: parseInt(dm[2]) });
    }
  }

  // 確認コード
  const codeMatch = body.match(/確認コード\s*\n?\s*([A-Z0-9]{8,12})/);
  const confirmationCode = codeMatch ? codeMatch[1] : null;

  // ゲスト名（Subject から取得するので別途渡す）
  // ゲスト人数
  const guestMatch = body.match(/大人(\d+)人/);
  const guests = guestMatch ? parseInt(guestMatch[1]) : 1;

  // 金額: 1泊の宿泊料金
  const nightlyMatch = body.match(/(\d{1,2})泊の宿泊料金\s+[¥￥]\s*([\d,]+)/);
  // 金額: ¥ XX,XXX x N泊
  const priceMatch = body.match(/[¥￥]\s*([\d,]+)\s*x\s*(\d+)泊/);
  let nightlyRate = 0;
  let nights = 1;
  if (priceMatch) {
    nightlyRate = parseInt(priceMatch[1].replace(/,/g, ""), 10);
    nights = parseInt(priceMatch[2], 10);
  }

  // ホスト収益（あなたの収益）
  const earningsMatch = body.match(/あなたの収益\s+[¥￥]\s*([\d,]+)/);
  const hostEarnings = earningsMatch ? parseInt(earningsMatch[1].replace(/,/g, ""), 10) : 0;

  // ゲスト支払額合計
  const totalMatch = body.match(/合計（JPY）\s+[¥￥]\s*([\d,]+)/);
  const guestTotal = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ""), 10) : 0;

  // 過去メール（リスティング名にH/Uがない場合）の1泊単価判定
  if (room === "UNKNOWN" && nightlyRate > 0) {
    room = nightlyRate >= 10000 ? "UME" : "HIBA";
  }
  // BC鳥沢のメールフォーマット未確認 → 判定漏れ検出用の警告ログ
  if (room === "UNKNOWN") {
    console.warn("[Airbnb parser] UNKNOWN room - body sample:", body.slice(0, 300).replace(/\s+/g, " "));
  }

  return { room, dates, confirmationCode, guests, nightlyRate, nights, hostEarnings, guestTotal };
}

async function syncAirbnbBookings(gToken) {
  // 過去30日分の予約確定メールを検索
  const after = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0].replace(/-/g, "/");
  const query = encodeURIComponent(`from:automated@airbnb.com subject:予約確定 after:${after}`);
  const gmailUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=20`;
  const listResult = await googleApiRequest("GET", gmailUrl, null, gToken);

  if (!listResult.messages || listResult.messages.length === 0) {
    return { synced: 0, skipped: 0 };
  }

  const existingBookings = loadBookingsLog();
  const existingCodes = new Set(existingBookings.map(b => b.confirmationCode));
  let synced = 0;
  let skipped = 0;
  let duplicateLogged = 0; // バグ②修正: duplicate時もログ保存対象としてカウントする

  for (const msg of listResult.messages) {
    // メール本文取得
    const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`;
    const msgData = await googleApiRequest("GET", msgUrl, null, gToken);

    // Subject からゲスト名を取得
    const subjectHeader = msgData.payload?.headers?.find(h => h.name === "Subject");
    const subject = subjectHeader?.value || "";
    const guestNameMatch = subject.match(/予約確定\s*-\s*(.+?)さんが/);
    const guestName = guestNameMatch ? guestNameMatch[1] : "不明";

    // メール本文をデコード（text/plain優先、なければtext/htmlからテキスト抽出）
    let bodyText = "";
    let htmlText = "";
    function extractText(part) {
      if (!part) return;
      if (part.mimeType === "text/plain" && part.body?.data) {
        bodyText += Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = Buffer.from(part.body.data, "base64url").toString("utf-8");
        htmlText += html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "").replace(/\s+/g, " ");
      }
      if (part.parts) part.parts.forEach(extractText);
    }
    if (msgData.payload) extractText(msgData.payload);
    if (!bodyText) bodyText = htmlText;

    if (!bodyText) {
      skipped++;
      continue;
    }

    const parsed = parseAirbnbConfirmationEmail(bodyText);
    if (!parsed.confirmationCode) {
      skipped++;
      continue;
    }

    // 既に同期済みならスキップ
    if (existingCodes.has(parsed.confirmationCode)) {
      skipped++;
      continue;
    }

    // 年の推定（メール日時から）
    const emailDate = new Date(parseInt(msgData.internalDate));
    const emailYear = emailDate.getFullYear();

    // チェックイン・チェックアウト日をISO形式に変換
    let checkinDate = "", checkoutDate = "";
    if (parsed.dates.length >= 2) {
      let ciYear = emailYear;
      // メール送信月よりチェックイン月が小さければ翌年
      if (parsed.dates[0].month < emailDate.getMonth() + 1) ciYear++;
      checkinDate = `${ciYear}-${String(parsed.dates[0].month).padStart(2, "0")}-${String(parsed.dates[0].day).padStart(2, "0")}`;

      let coYear = ciYear;
      if (parsed.dates[1].month < parsed.dates[0].month) coYear++;
      checkoutDate = `${coYear}-${String(parsed.dates[1].month).padStart(2, "0")}-${String(parsed.dates[1].day).padStart(2, "0")}`;
    }

    if (!checkinDate || !checkoutDate) {
      skipped++;
      continue;
    }

    // Google Calendar にイベント作成
    const calId = parsed.room === "HIBA" ? ENGAWA_HIBA_CAL : parsed.room === "TORISAWA" ? BC_TORISAWA_CAL : ENGAWA_UME_CAL;
    // CI/CO日と泊数をタイトルに明記（カレンダーで一目でわかるように）
    const ciMonth = parseInt(checkinDate.split("-")[1]);
    const ciDay = parseInt(checkinDate.split("-")[2]);
    const coMonth = parseInt(checkoutDate.split("-")[1]);
    const coDay = parseInt(checkoutDate.split("-")[2]);
    const eventTitle = `${guestName}（${parsed.guests}名・${parsed.nights}泊）CI:${ciMonth}/${ciDay} → CO:${coMonth}/${coDay}`;
    const description = [
      `ゲスト: ${guestName}（大人${parsed.guests}人）`,
      `確認コード: ${parsed.confirmationCode}`,
      `ホスト収益: ¥${(parsed.hostEarnings || 0).toLocaleString()}`,
      `ゲスト支払額: ¥${(parsed.guestTotal || 0).toLocaleString()}（参考）`,
      `1泊単価: ¥${(parsed.nightlyRate || 0).toLocaleString()} × ${parsed.nights}泊`,
      `部屋: ${parsed.room}`,
    ].join("\n");

    try {
      // Google Calendar の allDay イベント: end.date = 最終表示日の翌日
      // checkoutDate（チェックアウト日）をそのまま end に使う → 表示枠 = 泊数分だけになる
      const calEndDate = checkoutDate;

      // 重複チェック: 同じ日付範囲に同じゲスト名の予定が既にあればスキップ
      const searchUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${checkinDate}T00:00:00Z&timeMax=${calEndDate}T00:00:00Z&singleEvents=true&maxResults=20`;
      const existingEvents = await googleApiRequest("GET", searchUrl, null, gToken);
      const isDuplicate = existingEvents.items && existingEvents.items.some(ev => ev.summary && ev.summary.includes(guestName));
      if (isDuplicate) {
        console.log(`Calendar duplicate skipped: ${guestName} (${parsed.confirmationCode}) already exists on ${checkinDate}`);
        // ログには追加する（次回のメールスキャンで再チェックしないように）
        existingBookings.push({
          confirmationCode: parsed.confirmationCode,
          guestName,
          guests: parsed.guests,
          room: parsed.room,
          checkin: checkinDate,
          checkout: checkoutDate,
          nightlyRate: parsed.nightlyRate,
          nights: parsed.nights,
          hostEarnings: parsed.hostEarnings,
          guestTotal: parsed.guestTotal,
          syncedAt: new Date().toISOString(),
        });
        existingCodes.add(parsed.confirmationCode);
        duplicateLogged++;
        skipped++;
        continue;
      }

      const calUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;
      await googleApiRequest("POST", calUrl, JSON.stringify({
        summary: eventTitle,
        description,
        start: { date: checkinDate },
        end: { date: calEndDate },
      }), gToken, "application/json");
    } catch (calErr) {
      console.error(`Calendar event create error (${parsed.confirmationCode}):`, calErr.message);
    }

    // ログに保存
    existingBookings.push({
      confirmationCode: parsed.confirmationCode,
      guestName,
      guests: parsed.guests,
      room: parsed.room,
      checkin: checkinDate,
      checkout: checkoutDate,
      nightlyRate: parsed.nightlyRate,
      nights: parsed.nights,
      hostEarnings: parsed.hostEarnings,
      guestTotal: parsed.guestTotal,
      syncedAt: new Date().toISOString(),
    });
    existingCodes.add(parsed.confirmationCode);
    synced++;
  }

  // バグ②修正: 新規(synced)だけでなくduplicate-skip(duplicateLogged)でも配列がmutateされているので保存する。
  // 保存しないとそのconfirmationCodeが .airbnb-bookings.json に永久に載らず、後続のキャンセル判定(activeCodes)から
  // 恒久的に漏れてキャンセルメールが来ても削除されなくなる。
  if (synced > 0 || duplicateLogged > 0) saveBookingsLog(existingBookings);

  // キャンセルメールもチェックして反映
  let cancelled = 0;
  try {
    const cancelQuery = encodeURIComponent(`from:automated@airbnb.com subject:キャンセル after:${after}`);
    const cancelUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${cancelQuery}&maxResults=20`;
    const cancelResult = await googleApiRequest("GET", cancelUrl, null, gToken);

    if (cancelResult.messages && cancelResult.messages.length > 0) {
      const currentBookings = loadBookingsLog();
      // バグ①修正: 既にtombstone済み(status:"cancelled")のbookingはactiveから除外。
      // こうしないとGmailの「キャンセル」検索が過去分を拾うたびに毎回削除処理を再実行してしまう。
      const activeCodes = new Set(currentBookings.filter(b => b.status !== "cancelled").map(b => b.confirmationCode));
      const cancelledCodes = [];

      for (const msg of cancelResult.messages) {
        // Subject + 本文の両方から確認コードを探す
        const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`;
        const msgData = await googleApiRequest("GET", msgUrl, null, gToken);
        const subjectH = msgData.payload?.headers?.find(h => h.name === "Subject");
        const subj = subjectH?.value || "";

        // 全角括弧（）と半角括弧()の両方に対応
        let confirmCode = null;
        const subjectMatch = subj.match(/[（(]([A-Z0-9]{8,})[）)]/);
        if (subjectMatch) confirmCode = subjectMatch[1];

        // Subjectで見つからなければ本文からも探す
        if (!confirmCode) {
          let bodyText = "";
          function extractCancelText(part) {
            if (!part) return;
            if (part.mimeType === "text/plain" && part.body?.data) {
              bodyText += Buffer.from(part.body.data, "base64url").toString("utf-8");
            }
            if (part.mimeType === "text/html" && part.body?.data) {
              const html = Buffer.from(part.body.data, "base64url").toString("utf-8");
              bodyText += html.replace(/<[^>]+>/g, " ");
            }
            if (part.parts) part.parts.forEach(extractCancelText);
          }
          if (msgData.payload) extractCancelText(msgData.payload);

          // 本文中のAirbnb予約コードパターン（HMで始まる10文字の英数字）
          const bodyCodeMatch = bodyText.match(/[（(]?(HM[A-Z0-9]{6,10})[）)]?/);
          if (bodyCodeMatch) confirmCode = bodyCodeMatch[1];
        }

        if (confirmCode && activeCodes.has(confirmCode)) {
          cancelledCodes.push(confirmCode);
          console.log(`[cancel] Found cancelled booking: ${confirmCode} (from: ${subj.slice(0, 50)})`);
        }
      }

      if (cancelledCodes.length > 0) {
        // カレンダーから削除（確認コード + ゲスト名の両方で検索）
        for (const code of cancelledCodes) {
          const booking = currentBookings.find(b => b.confirmationCode === code);
          if (!booking) continue;
          const calId = booking.room === "HIBA" ? ENGAWA_HIBA_CAL : booking.room === "TORISAWA" ? BC_TORISAWA_CAL : ENGAWA_UME_CAL;
          const timeMin = booking.checkin + "T00:00:00Z";
          const coD = new Date(booking.checkout + "T00:00:00Z");
          coD.setUTCDate(coD.getUTCDate() + 2);
          const timeMax = coD.toISOString();
          let deleted = false;
          try {
            const evUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&maxResults=50`;
            const evResult = await googleApiRequest("GET", evUrl, null, gToken);
            if (evResult.items) {
              for (const ev of evResult.items) {
                // 確認コードまたはゲスト名でマッチ
                const desc = ev.description || "";
                const summary = ev.summary || "";
                if (desc.includes(code) || summary.includes(booking.guestName)) {
                  const delUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${ev.id}`;
                  await googleApiRequest("DELETE", delUrl, null, gToken);
                  console.log(`[cancel] Calendar event deleted: ${booking.guestName} (${code}) from ${calId === ENGAWA_HIBA_CAL ? "HIBA" : calId === BC_TORISAWA_CAL ? "TORISAWA" : "UME"}`);
                  deleted = true;
                }
              }
            }
            if (!deleted) {
              console.log(`[cancel] No calendar event found for: ${booking.guestName} (${code}) — may have been manually removed`);
            }
          } catch (e) {
            console.error(`[cancel] Cleanup error (${code}):`, e.message);
          }
        }
        // バグ①修正(根本): ログから物理削除しない。
        // Gmail検索は毎時「過去30日」ローリングウィンドウ(after:${after})なので予約確定メール自体は
        // 消えない。物理削除でconfirmationCodeがログから消えると、次回サイクルで
        // existingCodes.has(code) が false になり「新規予約」と誤解釈されカレンダーに再生成される
        // （ゾンビ化）。論理削除(tombstone)としてログには残し、status:"cancelled"を付与するだけにする。
        const cancelSet = new Set(cancelledCodes);
        const cancelledAt = new Date().toISOString();
        for (const b of currentBookings) {
          if (cancelSet.has(b.confirmationCode)) {
            b.status = "cancelled";
            b.cancelledAt = cancelledAt;
          }
        }
        saveBookingsLog(currentBookings);
        cancelled = cancelledCodes.length;
        console.log(`[cancel] Marked ${cancelled} bookings as cancelled (tombstone, not deleted) in log`);
      }
    }
  } catch (cancelErr) {
    console.error("Cancellation check error:", cancelErr.message);
  }

  // 予約変更メールもチェック
  let modified = 0;
  try {
    const modQuery = encodeURIComponent(`from:automated@airbnb.com (subject:予約変更 OR subject:変更に同意 OR subject:変更が承認) after:${after}`);
    const modUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${modQuery}&maxResults=20`;
    const modResult = await googleApiRequest("GET", modUrl, null, gToken);

    if (modResult.messages && modResult.messages.length > 0) {
      const currentBookings = loadBookingsLog();

      for (const msg of modResult.messages) {
        const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`;
        const msgData = await googleApiRequest("GET", msgUrl, null, gToken);

        // メール本文を取得
        let body = "";
        function extractModText(part) {
          if (!part) return;
          if (part.mimeType === "text/plain" && part.body?.data) {
            body += Buffer.from(part.body.data, "base64url").toString("utf-8");
          }
          if (part.mimeType === "text/html" && part.body?.data) {
            const html = Buffer.from(part.body.data, "base64url").toString("utf-8");
            body += html.replace(/<[^>]+>/g, " ");
          }
          if (part.parts) part.parts.forEach(extractModText);
        }
        if (msgData.payload) extractModText(msgData.payload);

        // 確認コード抽出
        let confirmCode = null;
        const subjectH = msgData.payload?.headers?.find(h => h.name === "Subject");
        const subj = subjectH?.value || "";
        const subjMatch = subj.match(/[（(]([A-Z0-9]{8,})[）)]/);
        if (subjMatch) confirmCode = subjMatch[1];
        if (!confirmCode) {
          const bodyMatch = body.match(/[（(]?(HM[A-Z0-9]{6,10})[）)]?/);
          if (bodyMatch) confirmCode = bodyMatch[1];
        }

        if (!confirmCode) continue;

        const existing = currentBookings.find(b => b.confirmationCode === confirmCode);
        if (!existing) continue;

        // 新しい日程をメール本文からパース
        const checkinMatch = body.match(/チェックイン[:\s]*(\d{4})[年/](\d{1,2})[月/](\d{1,2})/);
        const checkoutMatch = body.match(/チェックアウト[:\s]*(\d{4})[年/](\d{1,2})[月/](\d{1,2})/);
        // 英語パターンも対応
        const checkinMatchEn = body.match(/Check-?in[:\s]*(\w+)\s+(\d{1,2}),?\s*(\d{4})/i);
        const checkoutMatchEn = body.match(/Check-?out[:\s]*(\w+)\s+(\d{1,2}),?\s*(\d{4})/i);

        let newCheckin = null, newCheckout = null;

        if (checkinMatch) {
          newCheckin = `${checkinMatch[1]}-${String(checkinMatch[2]).padStart(2, "0")}-${String(checkinMatch[3]).padStart(2, "0")}`;
        }
        if (checkoutMatch) {
          newCheckout = `${checkoutMatch[1]}-${String(checkoutMatch[2]).padStart(2, "0")}-${String(checkoutMatch[3]).padStart(2, "0")}`;
        }

        // ゲスト数の変更
        const guestMatch = body.match(/ゲスト[:\s]*(\d+)/);
        let newGuestCount = guestMatch ? parseInt(guestMatch[1]) : null;

        if (!newCheckin && !newCheckout && !newGuestCount) continue;

        console.log(`[modify] Found modified booking: ${confirmCode} (${existing.guestName})`);
        if (newCheckin) console.log(`[modify]   Check-in: ${existing.checkin} → ${newCheckin}`);
        if (newCheckout) console.log(`[modify]   Check-out: ${existing.checkout} → ${newCheckout}`);

        // カレンダーイベントを更新
        const calId = existing.room === "HIBA" ? ENGAWA_HIBA_CAL : existing.room === "TORISAWA" ? BC_TORISAWA_CAL : ENGAWA_UME_CAL;
        const timeMin = existing.checkin + "T00:00:00Z";
        const coD = new Date(existing.checkout + "T00:00:00Z");
        coD.setUTCDate(coD.getUTCDate() + 2);
        const timeMax = coD.toISOString();

        try {
          const evUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&maxResults=50`;
          const evResult = await googleApiRequest("GET", evUrl, null, gToken);
          if (evResult.items) {
            for (const ev of evResult.items) {
              const desc = ev.description || "";
              const summary = ev.summary || "";
              if (desc.includes(confirmCode) || summary.includes(existing.guestName)) {
                // イベント更新
                const updatedEvent = { ...ev };
                if (newCheckin) updatedEvent.start = { date: newCheckin };
                if (newCheckout) updatedEvent.end = { date: newCheckout };
                // descriptionに変更履歴を追記
                updatedEvent.description = (ev.description || "") + `\n[変更] ${new Date().toISOString().split("T")[0]}`;
                if (newGuestCount) {
                  updatedEvent.description = updatedEvent.description.replace(/ゲスト:\s*\d+/, `ゲスト: ${newGuestCount}`);
                }

                const updateUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${ev.id}`;
                await googleApiRequest("PUT", updateUrl, JSON.stringify(updatedEvent), gToken, "application/json");
                console.log(`[modify] Calendar event updated: ${existing.guestName} (${confirmCode})`);
              }
            }
          }
        } catch (e) {
          console.error(`[modify] Calendar update error (${confirmCode}):`, e.message);
        }

        // ローカルログ更新
        if (newCheckin) existing.checkin = newCheckin;
        if (newCheckout) existing.checkout = newCheckout;
        if (newGuestCount) existing.guestCount = newGuestCount;
        modified++;
      }

      if (modified > 0) {
        saveBookingsLog(currentBookings);
        console.log(`[modify] Updated ${modified} modified bookings`);
      }
    }
  } catch (modErr) {
    console.error("Modification check error:", modErr.message);
  }

  return { synced, skipped, cancelled, modified };
}

// Google Calendar 空き時間チェック
const SCHEDULE_KEYWORDS = /空(い|き)|日程調整|いつ(が|なら|だ|で|空|あ)|スケジュール|予定.*合わせ|打ち合わせ.*いつ|都合.*いい|候補日|アポ|ミーティング.*日|会え(る|そう)|来(週|月).*空|今週.*空/;

async function getCalendarBusy(startDate, endDate) {
  try {
    const gToken = await getGoogleAccessToken();
    // Ryo の主要カレンダーをチェック
    const calendarIds = [
      "r.inafuku@tonari2tomaru.com", // プライベート
      "9c0d4af92a70ced546b135411feda7120c9fd874beda1363874c03faf8953f18@group.calendar.google.com", // R&M共有
      "misocacoffee@gmail.com", // 三十日珈琲
      "4651f62429c52388651033e5b59f4cb81a418694431ab262748b231c663e461f@group.calendar.google.com", // えんがわHIBA
      "engawa.yanagawa@gmail.com", // えんがわUME
      "b6ff2100d451e679aa52c0afca510ce6268b673ddb904e7526c5bec7fb38836a@group.calendar.google.com", // 大広間
    ];

    const timeMin = new Date(startDate + "T00:00:00+09:00").toISOString();
    const timeMax = new Date(endDate + "T23:59:59+09:00").toISOString();

    // 各カレンダーのイベントを取得
    const allEvents = [];
    for (const calId of calendarIds) {
      try {
        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&fields=items(summary,start,end,status)`;
        const result = await googleApiRequest("GET", url, null, gToken);
        if (result.items) {
          for (const ev of result.items) {
            if (ev.status === "cancelled") continue;
            allEvents.push({
              title: ev.summary || "(予定)",
              start: ev.start.dateTime || ev.start.date,
              end: ev.end.dateTime || ev.end.date,
              allDay: !!ev.start.date,
            });
          }
        }
      } catch (e) {
        console.error(`Calendar fetch error (${calId}):`, e.message);
      }
    }

    // 日別に整理
    const days = {};
    const current = new Date(startDate + "T00:00:00+09:00");
    const last = new Date(endDate + "T00:00:00+09:00");
    const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

    while (current <= last) {
      const dateKey = current.toISOString().slice(0, 10);
      days[dateKey] = {
        label: `${current.getMonth() + 1}/${current.getDate()}(${weekdays[current.getDay()]})`,
        events: [],
      };
      current.setDate(current.getDate() + 1);
    }

    for (const ev of allEvents) {
      const evDate = ev.start.slice(0, 10);
      if (days[evDate]) {
        if (ev.allDay) {
          days[evDate].events.push({ title: ev.title, time: "終日" });
        } else {
          const startTime = new Date(ev.start).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
          const endTime = new Date(ev.end).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
          days[evDate].events.push({ title: ev.title, time: `${startTime}-${endTime}` });
        }
      }
    }

    // テキスト化
    let result = "";
    for (const [dateKey, day] of Object.entries(days)) {
      result += `${day.label}: `;
      if (day.events.length === 0) {
        result += "予定なし（終日OK）\n";
      } else {
        result += day.events.map(e => `${e.time} ${e.title}`).join(" / ") + "\n";
      }
    }
    return result.trim();
  } catch (e) {
    console.error("getCalendarBusy error:", e.message);
    return null;
  }
}

function detectScheduleDateRange(message) {
  const now = new Date();
  const today = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));

  if (/来週/.test(message)) {
    const dayOfWeek = today.getDay();
    const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
    const start = new Date(today);
    start.setDate(today.getDate() + daysUntilMonday);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start: fmtDate(start), end: fmtDate(end) };
  }
  if (/再来週/.test(message)) {
    const dayOfWeek = today.getDay();
    const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
    const start = new Date(today);
    start.setDate(today.getDate() + daysUntilMonday + 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start: fmtDate(start), end: fmtDate(end) };
  }
  if (/来月/.test(message)) {
    const start = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth() + 2, 0);
    return { start: fmtDate(start), end: fmtDate(end) };
  }
  if (/今週/.test(message)) {
    const dayOfWeek = today.getDay();
    const start = new Date(today);
    const end = new Date(today);
    end.setDate(today.getDate() + (6 - dayOfWeek));
    return { start: fmtDate(start), end: fmtDate(end) };
  }
  // デフォルト: 今日から14日間
  const start = new Date(today);
  const end = new Date(today);
  end.setDate(today.getDate() + 13);
  return { start: fmtDate(start), end: fmtDate(end) };
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 月別サブフォルダを取得 or 作成（例: "2026年03月"）
const _folderLocks = {};
async function getOrCreateMonthFolder(parentFolderId, token, dateStr) {
  // dateStr = "YYYY-MM-DD" or undefined (today)
  const d = dateStr ? new Date(dateStr + "T00:00:00") : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const folderName = `${year}年${month}月`;

  // 同時リクエストでフォルダ重複作成を防ぐロック
  if (_folderLocks[folderName]) {
    return _folderLocks[folderName];
  }

  const promise = (async () => {
    // Search for existing folder
    const query = encodeURIComponent(`name='${folderName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const searchResult = await googleApiRequest("GET",
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`,
      null, token, null);

    if (searchResult.files && searchResult.files.length > 0) {
      return searchResult.files[0].id;
    }

    // Create new folder
    const newFolder = await googleApiRequest("POST",
      "https://www.googleapis.com/drive/v3/files",
      JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder", parents: [parentFolderId] }),
      token, "application/json");
    console.log(`Created month folder: ${folderName} (${newFolder.id})`);
    return newFolder.id;
  })();

  _folderLocks[folderName] = promise;
  try {
    return await promise;
  } finally {
    delete _folderLocks[folderName];
  }
}

async function uploadToDrive(filePath, fileName, mimeType, folderId, token) {
  const fileData = fs.readFileSync(filePath);
  const boundary = "----ReceiptUpload" + Date.now();
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });

  const bodyParts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  ];
  const bodyEnd = `\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(bodyParts[0]),
    Buffer.from(bodyParts[1]),
    fileData,
    Buffer.from(bodyEnd),
  ]);

  const result = await new Promise((resolve, reject) => {
    const req = https.request("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`Drive upload ${res.statusCode}: ${data}`));
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  return result;
}

async function appendToSheet(sheetId, sheetName, values, token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}!A:Z:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  return googleApiRequest("POST", url, JSON.stringify({ values: [values] }), token, "application/json");
}

// Multipart parser (no external deps)
function parseMultipart(body, boundary) {
  const parts = [];
  const delimBuf = Buffer.from(`--${boundary}`);
  let start = body.indexOf(delimBuf) + delimBuf.length;

  while (true) {
    // Skip \r\n after delimiter
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    const nextDelim = body.indexOf(delimBuf, start);
    if (nextDelim === -1) break;

    const partBuf = body.slice(start, nextDelim - 2); // -2 for \r\n before delimiter
    const headerEnd = partBuf.indexOf("\r\n\r\n");
    if (headerEnd === -1) { start = nextDelim + delimBuf.length; continue; }

    const headers = partBuf.slice(0, headerEnd).toString();
    const data = partBuf.slice(headerEnd + 4);

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);

    parts.push({
      name: nameMatch ? nameMatch[1] : "",
      filename: filenameMatch ? filenameMatch[1] : null,
      data,
    });

    start = nextDelim + delimBuf.length;
  }
  return parts;
}

// 会話履歴の管理
const CONVERSATION_TIMEOUT = 5 * 60 * 1000;
let conversationHistory = [];
let lastMessageTime = 0;
let isProcessing = false;
let messageQueue = [];

function verifySignature(body, signature) {
  if (!CHANNEL_SECRET) return true;
  const hash = crypto
    .createHmac("SHA256", CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hash === signature;
}

function replyLineMessage(replyToken, text) {
  const maxLen = 4900;
  const messages = [];
  for (let i = 0; i < text.length; i += maxLen) {
    messages.push({ type: "text", text: text.slice(i, i + maxLen) });
  }
  const batch = messages.slice(0, 5);
  const data = JSON.stringify({ replyToken, messages: batch });
  const options = {
    hostname: "api.line.me",
    path: "/v2/bot/message/reply",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      "Content-Length": Buffer.byteLength(data),
    },
  };
  const req = https.request(options);
  req.write(data);
  req.end();
}

function pushLineMessage(text) {
  const maxLen = 4900;
  const messages = [];
  for (let i = 0; i < text.length; i += maxLen) {
    messages.push({ type: "text", text: text.slice(i, i + maxLen) });
  }
  const batch = messages.slice(0, 5);
  const data = JSON.stringify({ to: USER_ID, messages: batch });
  const options = {
    hostname: "api.line.me",
    path: "/v2/bot/message/push",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      "Content-Length": Buffer.byteLength(data),
    },
  };
  const req = https.request(options);
  req.write(data);
  req.end();
}

// Discord #notifications チャンネルへメッセージ送信（DXワークフロー通知用）
function pushDiscordMessage(text) {
  if (!DISCORD_BOT_TOKEN) {
    console.error("[Discord] Bot token not configured, falling back to LINE");
    pushLineMessage(text);
    return;
  }
  const maxLen = 2000; // Discord message limit
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  for (const chunk of chunks) {
    const data = JSON.stringify({ content: chunk });
    const options = {
      hostname: "discord.com",
      path: `/api/v10/channels/${DISCORD_NOTIFICATIONS_CHANNEL_ID}/messages`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        "Content-Length": Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      if (res.statusCode >= 400) {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => console.error(`[Discord] Send failed (${res.statusCode}): ${body}`));
      }
    });
    req.on("error", (e) => console.error("[Discord] Request error:", e.message));
    req.write(data);
    req.end();
  }
}

function buildPrompt(userMessage) {
  const now = Date.now();

  if (now - lastMessageTime > CONVERSATION_TIMEOUT) {
    conversationHistory = [];
  }
  lastMessageTime = now;

  conversationHistory.push({ role: "user", content: userMessage });
  appendChatLog("line", "user", userMessage);

  if (conversationHistory.length > 10) {
    conversationHistory = conversationHistory.slice(-10);
  }

  if (conversationHistory.length <= 1) {
    return userMessage;
  }

  let prompt = "以下はRyoとの会話の続きです。直前のやり取りを踏まえて回答してください。\n\n";
  prompt += "--- 会話履歴 ---\n";
  for (const msg of conversationHistory.slice(0, -1)) {
    const label = msg.role === "user" ? "Ryo" : "AI秘書";
    prompt += `${label}: ${msg.content}\n\n`;
  }
  prompt += "--- 最新のメッセージ ---\n";
  prompt += `Ryo: ${userMessage}\n\n`;
  prompt += "上記の会話の流れを踏まえて、最新のメッセージに回答してください。";

  return prompt;
}

function parseTasksFromCLAUDE(content) {
  const sections = [];
  let currentSection = null;
  let inTaskSection = false;

  for (const line of content.split("\n")) {
    if (line.startsWith("### 現在のタスク")) {
      inTaskSection = true;
      continue;
    }
    if (line.startsWith("### 完了タスク")) {
      inTaskSection = false;
      continue;
    }
    if (!inTaskSection) continue;

    if (line.startsWith("####")) {
      currentSection = { title: line.replace(/^#+\s*/, ""), tasks: [] };
      sections.push(currentSection);
      continue;
    }

    const todoMatch = line.match(/^- \[ \] (.+)/);
    const doneMatch = line.match(/^- \[x\] (.+)/);
    if (todoMatch && currentSection) {
      currentSection.tasks.push({ text: todoMatch[1], done: false });
    } else if (doneMatch && currentSection) {
      currentSection.tasks.push({ text: doneMatch[1], done: true });
    }
  }

  return sections;
}

const server = http.createServer((req, res) => {
  // クエリパラメータを除いたパス名を取得（POST の URL マッチングに使用）
  const pathname = req.url?.split("?")[0] || req.url;
  // DEBUG: リクエストログ（問題解決後に削除）
  if (req.method === "POST") console.log(`[DEBUG] ${req.method} url=${req.url} pathname=${pathname}`);
  // クエリパラメータ or Authorizationヘッダーからトークンを取得
  const _urlObj = new URL(req.url || "/", `http://localhost:${PORT}`);
  const qToken = _urlObj.searchParams.get("token") || (req.headers["authorization"] || "").replace("Bearer ", "") || "";

  // 統合APIハンドラー（/api/unified/* をすべて処理）
  if (unifiedApi.canHandle(pathname)) {
    return unifiedApi.handle(req, res, pathname, _urlObj.searchParams);
  }

  if (req.method === "POST" && pathname === "/webhook") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const signature = req.headers["x-line-signature"];
      if (CHANNEL_SECRET && !verifySignature(body, signature)) {
        res.writeHead(403);
        res.end("Invalid signature");
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");

      try {
        const data = JSON.parse(body);
        for (const event of data.events || []) {
          if (event.type !== "message" || event.message.type !== "text") continue;
          if (event.source.userId !== USER_ID) continue;

          const userMessage = event.message.text;
          const replyToken = event.replyToken;
          console.log(`[${new Date().toISOString()}] Received: ${userMessage}`);

          // フォローアップ応答チェック（カレンダー予定の「どうだった？」への返事）
          if (tryParseFollowupReply(userMessage)) return;

          if (userMessage === "リセット" || userMessage.toLowerCase() === "reset") {
            conversationHistory = [];
            replyLineMessage(replyToken, "会話履歴をリセットしました。");
            console.log(`[${new Date().toISOString()}] Conversation reset`);
            return;
          }

          if (isProcessing) {
            replyLineMessage(replyToken, "前のメッセージを処理中です。少々お待ちください。");
            messageQueue.push(userMessage);
            return;
          }

          replyLineMessage(replyToken, "処理中...");
          processMessage(userMessage);
        }
      } catch (e) {
        console.error("Error parsing webhook:", e.message);
      }
    });
  } else if (req.method === "POST" && pathname === "/api/receipt") {
    // レシート処理: 画像アップロード → OCR → Drive保存 → Sheet追記
    const origin = req.headers["origin"] || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const body = Buffer.concat(chunks);
        const contentType = req.headers["content-type"] || "";
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) {
          res.writeHead(400, corsHeaders);
          res.end(JSON.stringify({ error: "Invalid content type" }));
          return;
        }

        const parts = parseMultipart(body, boundaryMatch[1]);
        const tokenPart = parts.find(p => p.name === "token");
        if ((!tokenPart && !qToken) || (tokenPart ? tokenPart.data.toString() : qToken) !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const filePart = parts.find(p => p.name === "file");
        if (!filePart || !filePart.filename) {
          res.writeHead(400, corsHeaders);
          res.end(JSON.stringify({ error: "No file" }));
          return;
        }

        // Save file temporarily
        const uploadDir = path.join(REPO_DIR, "logs", ".uploads");
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        const ext = path.extname(filePart.filename) || ".jpg";
        const safeName = `receipt_${Date.now()}${ext}`;
        const filePath = path.join(uploadDir, safeName);
        fs.writeFileSync(filePath, filePart.data);

        console.log(`[${new Date().toISOString()}] Receipt uploaded: ${filePart.filename} (${filePart.data.length} bytes)`);

        // Step 1: OCR with claude -p
        const ocrPrompt = `以下のレシート画像を Read ツールで読み取り、内容を分析してください。
ファイルパス: ${filePath}

## 勘定科目の判定ルール（個人事業主・青色申告）
以下のルールに基づいて勘定科目を判定してください:

- 仕入高: コーヒー生豆、焙煎資材、民泊アメニティ仕入れ
- 地代家賃: 家賃、レンタルスペース利用料
- 水道光熱費: 電気、ガス、水道
- 旅費交通費: ガソリン、高速道路、ETC、電車、駐車場
- 通信費: 携帯電話、インターネット、サーバー、SaaS月額
- 広告宣伝費: 広告、チラシ、名刺印刷
- 接待交際費: 取引先との飲食、手土産、謝礼
- 消耗品費: 事務用品、10万円未満の備品、清掃用品
- 新聞図書費: 書籍、オンライン講座
- 支払手数料: 各種手数料、振込手数料
- 損害保険料: 火災保険、賠償責任保険
- 修繕費: 物件修繕、設備修理
- 車両費: 車検、整備、自動車税
- 外注工賃: 業務委託、クリーニング外注
- 租税公課: 印紙代、事業税
- 雑費: 上記に該当しないもの

## 店名ヒント
- ガソスタ/ENEOS/出光/コスモ → 旅費交通費 or 車両費
- コンビニ/スーパー → 内容により消耗品費/仕入高/雑費
- ホームセンター → 消耗品費 or 修繕費
- 飲食店 → 接待交際費（事業関連）

## 税区分
- 課税仕入10%: 標準税率の経費
- 課税仕入8%: 食品等（軽減税率）
- 非課税仕入: 保険料等
- 対象外: 租税公課等

以下のJSON形式で返してください（JSONのみ返すこと）:
{
  "date": "YYYY-MM-DD形式の日付",
  "store": "店名",
  "amount": 合計金額（数値、税込）,
  "items": "主な品目（カンマ区切り）",
  "account": "勘定科目（上記ルールに基づく）",
  "tax_class": "課税仕入10%/課税仕入8%/非課税仕入/対象外",
  "payment": "現金/クレジットカード/電子マネー/不明",
  "note": "特記事項",
  "business": "えんがわ/となりにとまる/三十日珈琲/SATOYAMA AI BASE/共通/プライベート/不明"
}

読み取れない項目は "不明" としてください。金額は必ず数値のみ（カンマ・円記号なし）。プライベートは事業経費ではなく個人支出。`;

        const promptFile = path.join(REPO_DIR, "logs", ".receipt-prompt.txt");
        fs.writeFileSync(promptFile, ocrPrompt, "utf-8");

        const execEnv = Object.assign({}, process.env, {
          PATH: `/Users/Inaryo/.local/share/mise/installs/node/24.14.0/bin:/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
          HOME: "/Users/ocmm",
        });
        delete execEnv.CLAUDECODE;

        let ocrResult;
        try {
          const raw = execSync(
            `cd "${REPO_DIR}" && cat "${promptFile}" | "${CLAUDE_PATH}" -p --model claude-sonnet-4-6 --dangerously-skip-permissions`,
            { encoding: "utf-8", timeout: CLAUDE_TIMEOUT, maxBuffer: 1024 * 1024, env: execEnv }
          );
          const jsonMatch = raw.match(/\{[\s\S]*?"date"[\s\S]*?\}/);
          if (jsonMatch) {
            // 不正なJSON値を修正（"amount": 不明 → "amount": "不明"）
            const fixed = jsonMatch[0].replace(/:\s*([^"\d\[\]{},\s][^,}\n]*)/g, (m, val) => {
              const trimmed = val.trim();
              if (trimmed === "true" || trimmed === "false" || trimmed === "null") return m;
              return `: "${trimmed}"`;
            });
            try { ocrResult = JSON.parse(fixed); } catch { ocrResult = JSON.parse(jsonMatch[0]); }
          }
        } catch (e) {
          console.error("OCR error:", e.message);
        }

        if (!ocrResult) {
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ error: "レシートの読み取りに失敗しました。もう一度撮影してみてね。" }));
          try { fs.unlinkSync(filePath); } catch {}
          return;
        }

        // フォームから事業区分を取得してOCR結果をオーバーライド
        const businessPart = parts.find(p => p.name === "business");
        const formBusiness = businessPart ? businessPart.data.toString().trim() : "";
        if (formBusiness) {
          ocrResult.business = formBusiness;
        }

        // Step 2: Upload to Google Drive (月別フォルダに整理)
        let driveLink = "";
        try {
          const token = await getGoogleAccessToken();
          const monthFolderId = await getOrCreateMonthFolder(env.GOOGLE_RECEIPT_FOLDER_ID, token, ocrResult.date);
          const mimeType = ext === ".pdf" ? "application/pdf" : "image/jpeg";
          const driveFileName = `${ocrResult.date || "unknown"}_${ocrResult.store || "receipt"}${ext}`;
          const driveResult = await uploadToDrive(filePath, driveFileName, mimeType, monthFolderId, token);
          driveLink = driveResult.webViewLink || `https://drive.google.com/file/d/${driveResult.id}`;
          console.log(`Drive uploaded: ${driveResult.id} -> month folder: ${monthFolderId}`);

          // Step 3: Append to both sheets
          const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
          const account = ocrResult.account || "雑費";
          const taxClass = ocrResult.tax_class || "課税仕入10%";
          const payment = ocrResult.payment || "不明";

          // 貸方科目の判定
          let creditAccount = "事業主借";
          if (payment === "JCBデビット" || payment === "Mastercardデビット") creditAccount = "普通預金";
          else if (payment === "現金") creditAccount = "現金";
          else if (payment === "PayPay") creditAccount = "事業主借";
          else if (payment === "クレジットカード") creditAccount = "未払金";

          // MF仕訳帳シートに追記
          await appendToSheet(env.GOOGLE_EXPENSE_SHEET_ID, "MF仕訳帳", [
            ocrResult.date || "不明",            // 取引日
            account,                              // 借方勘定科目
            "",                                   // 借方補助科目
            taxClass,                             // 借方税区分
            ocrResult.amount || 0,                // 借方金額
            creditAccount,                        // 貸方勘定科目
            "",                                   // 貸方補助科目
            taxClass,                             // 貸方税区分
            ocrResult.amount || 0,                // 貸方金額
            `${ocrResult.store || ""}${ocrResult.items ? " " + ocrResult.items : ""}`, // 摘要
            ocrResult.note || "",                 // 仕訳メモ
            ocrResult.business || "",             // タグ（事業区分）
          ], token);

          // レシート原本シートに追記
          await appendToSheet(env.GOOGLE_EXPENSE_SHEET_ID, "レシート原本", [
            ocrResult.date || "不明",
            ocrResult.store || "不明",
            ocrResult.amount || 0,
            ocrResult.items || "不明",
            account,
            taxClass,
            payment,
            ocrResult.note || "",
            driveLink,
            now,
            ocrResult.business || "不明",
          ], token);
          console.log("Both sheets appended");
        } catch (e) {
          console.error("Google API error:", e.message);
        }

        // Cleanup
        try { fs.unlinkSync(filePath); } catch {}

        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({
          success: true,
          data: ocrResult,
          driveLink,
          message: `レシート登録完了！\n\n**${ocrResult.store || "不明"}**\n- 日付: ${ocrResult.date || "不明"}\n- 金額: ${ocrResult.amount ? Number(ocrResult.amount).toLocaleString() + "円" : "不明"}\n- 勘定科目: ${account}\n- 税区分: ${taxClass}\n- 支払: ${payment} → ${creditAccount}\n- 事業: ${ocrResult.business || "不明"}\n\nDrive（月別フォルダ）とスプレッドシートに保存したよ。`,
        }));
      } catch (e) {
        console.error("Receipt error:", e.message);
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: "処理に失敗しました" }));
      }
    });
  } else if (req.method === "POST" && req.url?.startsWith("/api/receipt-quick")) {
    // iPhoneショートカット用: 即レスポンス→バックグラウンド処理→LINE通知
    const receiptUrl = new URL(req.url, `http://localhost:${PORT}`);
    const receiptBusiness = decodeURIComponent(receiptUrl.searchParams.get("business") || "");
    console.log(`[Receipt] business param: "${receiptBusiness}"`);
    const authHeader = req.headers["authorization"] || "";
    const authToken = authHeader.replace("Bearer ", "");
    if (authToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (body.length < 10000) {
        console.log(`[${new Date().toISOString()}] Skipped: too small (${body.length} bytes)`);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "画像データが小さすぎます" }));
        return;
      }

      // 即レスポンス（ショートカットがタイムアウトしない）
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true, message: "受付完了。処理結果はLINEで通知します。" }));

      // キューに入れて順次処理
      enqueueReceipt(async () => {
        const uploadDir = path.join(REPO_DIR, "logs", ".uploads");
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        const ts = Date.now();
        // ファイルヘッダーから形式を判定
        const isHEIC = body.length > 8 && body.toString("ascii", 4, 12).includes("ftyp");
        const isJPEG = body[0] === 0xFF && body[1] === 0xD8;
        const rawExt = isHEIC ? ".heic" : isJPEG ? ".jpg" : ".dat";
        const rawPath = path.join(uploadDir, `receipt_${ts}_raw${rawExt}`);
        const filePath = path.join(uploadDir, `receipt_${ts}.jpg`);
        fs.writeFileSync(rawPath, body);

        console.log(`[${new Date().toISOString()}] Quick receipt: ${body.length} bytes (${rawExt})`);

        // JPEG変換・リサイズ
        try {
          if (isJPEG && body.length <= 2 * 1024 * 1024) {
            // 小さいJPEGはそのまま使う
            fs.copyFileSync(rawPath, filePath);
          } else {
            execSync(`sips -s format jpeg --resampleWidth 2000 -s formatOptions 90 "${rawPath}" --out "${filePath}"`, { timeout: 15000 });
          }
          const newSize = fs.statSync(filePath).size;
          console.log(`Converted: ${body.length} -> ${newSize} bytes`);
        } catch (e) {
          console.error("Convert failed:", e.message);
          fs.copyFileSync(rawPath, filePath);
        }
        try { fs.unlinkSync(rawPath); } catch {}

        const ocrPrompt = `以下のレシート画像を Read ツールで読み取り、正確にOCRしてください。
ファイルパス: ${filePath}

## 最重要: 正確なOCR
画像内のテキストを一文字ずつ正確に読み取ること。推測や補完はしない。

### 日付の読み取り（最優先）
- レシートに印字されている日付を**そのまま**読み取る
- 必ずレシート上の年月日を確認する。今日の日付を入れてはいけない
- 「2025年12月19日」→ "2025-12-19"、「R7.3.7」→ "2025-03-07"、「25/12/21」→ "2025-12-21"
- 年が省略されている場合（例: 12/19）、レシートの文脈から年を推定する

### 金額の読み取り
- 「合計」「お買上合計」「ご利用金額」「請求額」欄の金額を正確に読み取る
- 小計ではなく必ず**税込合計金額**を採用する
- 数字を1桁ずつ慎重に読む。特に 1/7、3/8、5/6、0/8 の誤読に注意
- 金額が複数表示されている場合は最終的な支払金額（おつり計算の元になる額）を採用
- 読み取りに自信がない場合でも最も可能性の高い数値を入れる

### 店名の読み取り
- レシート最上部に印字されている正式な店名を読み取る
- 支店名は不要。本体の店名のみ（例: 「スターバックス」だけでOK、支店名は省略）

## 勘定科目の判定ルール（個人事業主・青色申告）
- 仕入高: コーヒー生豆、焙煎資材、民泊アメニティ仕入れ
- 地代家賃: 家賃、レンタルスペース利用料
- 水道光熱費: 電気、ガス、水道
- 旅費交通費: ガソリン、高速道路、ETC、電車、駐車場
- 通信費: 携帯電話、インターネット、サーバー、SaaS月額
- 広告宣伝費: 広告、チラシ、名刺印刷
- 接待交際費: 取引先との飲食、手土産、謝礼
- 消耗品費: 事務用品、10万円未満の備品、清掃用品
- 新聞図書費: 書籍、オンライン講座
- 支払手数料: 各種手数料、振込手数料
- 損害保険料: 火災保険、賠償責任保険
- 修繕費: 物件修繕、設備修理
- 車両費: 車検、整備、自動車税
- 外注工賃: 業務委託、クリーニング外注
- 租税公課: 印紙代、事業税
- 雑費: 上記に該当しないもの

## 店名ヒント
- ガソスタ/ENEOS/出光/コスモ → 旅費交通費
- コンビニ/スーパー → 内容により消耗品費/仕入高/雑費
- ホームセンター → 消耗品費 or 修繕費
- 飲食店 → 接待交際費（事業関連）

## 税区分
- 課税仕入10%: 標準税率の経費
- 課税仕入8%: 食品等（軽減税率 ※マーク付き）
- 非課税仕入: 保険料等
- 対象外: 租税公課等

## 支払方法の判定（最重要）
レシートの決済情報を注意深く読み取ること。Ryoの決済方法は以下の4つのみ:
- JCBデビット: レシートに JCB、デビット、J/デビット、DEBIT と記載 → "JCBデビット"
- Mastercardデビット: レシートに Mastercard、マスターカード、MC と記載 → "Mastercardデビット"
- PayPay: レシートに PayPay、ペイペイ、QR決済、バーコード決済 と記載 → "PayPay"
- 現金: レシートに お預り、おつり と記載、または上記に該当しない少額支払い → "現金"

判定のヒント:
- カード番号末尾4桁が印字されている → カード払い（JCBかMastercard）
- 「クレジット」「CREDIT」の文字がある → カード払い
- 電子マネー系の記載がある → PayPay の可能性大
- 「お預り」「おつり」の記載がある → 確実に現金

以下のJSON形式**のみ**を出力してください。説明文は不要です:
{
  "date": "YYYY-MM-DD",
  "store": "店名",
  "amount": 0,
  "items": "主な品目",
  "account": "勘定科目",
  "tax_class": "課税仕入10%",
  "payment": "現金",
  "note": "",
  "business": "不明"
}

ルール:
- amount は必ず数値型（整数）。カンマ・円記号なし。読めなくても0にして"不明"にしない
- date は必ず "YYYY-MM-DD" 文字列
- payment は必ず "JCBデビット"/"Mastercardデビット"/"PayPay"/"現金" のいずれか。"不明"にしない
- business は えんがわ/となりにとまる/三十日珈琲/SATOYAMA AI BASE/共通/プライベート/不明 のいずれか。プライベートは事業経費ではなく個人支出
- JSON以外のテキストは一切出力しないこと`;

        const promptFile = path.join(REPO_DIR, "logs", ".receipt-prompt.txt");
        fs.writeFileSync(promptFile, ocrPrompt, "utf-8");

        const execEnv = Object.assign({}, process.env, {
          PATH: `/Users/Inaryo/.local/share/mise/installs/node/24.14.0/bin:/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
          HOME: "/Users/ocmm",
        });
        delete execEnv.CLAUDECODE;

        let ocrResult;
        try {
          const raw = execSync(
            `cd "${REPO_DIR}" && cat "${promptFile}" | "${CLAUDE_PATH}" -p --model claude-sonnet-4-6 --dangerously-skip-permissions`,
            { encoding: "utf-8", timeout: CLAUDE_TIMEOUT, maxBuffer: 1024 * 1024, env: execEnv }
          );
          const jsonMatch = raw.match(/\{[\s\S]*?"date"[\s\S]*?\}/);
          if (jsonMatch) {
            // 不正なJSON値を修正（"amount": 不明 → "amount": "不明"）
            const fixed = jsonMatch[0].replace(/:\s*([^"\d\[\]{},\s][^,}\n]*)/g, (m, val) => {
              const trimmed = val.trim();
              if (trimmed === "true" || trimmed === "false" || trimmed === "null") return m;
              return `: "${trimmed}"`;
            });
            try { ocrResult = JSON.parse(fixed); } catch { ocrResult = JSON.parse(jsonMatch[0]); }
          }
        } catch (e) {
          console.error("OCR error:", e.message);
        }

        if (!ocrResult) {
          sendWebPush("レシート読み取り失敗", "もう一度撮影してみてね。");
          try { fs.unlinkSync(filePath); } catch {}
          return;
        }

        // ショートカットで選択した事業区分を常に優先
        console.log(`[Receipt] OCR business: "${ocrResult.business}", shortcut: "${receiptBusiness}"`);
        if (receiptBusiness) {
          ocrResult.business = receiptBusiness;
          console.log(`[Receipt] Overriding business → "${receiptBusiness}"`);
        }

        // Upload to Google Drive & Sheets
        let driveLink = "";
        try {
          const gToken = await getGoogleAccessToken();
          const monthFolderId = await getOrCreateMonthFolder(env.GOOGLE_RECEIPT_FOLDER_ID, gToken, ocrResult.date);
          const driveFileName = `${ocrResult.date || "unknown"}_${ocrResult.store || "receipt"}.jpg`;
          const driveResult = await uploadToDrive(filePath, driveFileName, "image/jpeg", monthFolderId, gToken);
          driveLink = driveResult.webViewLink || `https://drive.google.com/file/d/${driveResult.id}`;

          const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
          const account = ocrResult.account || "雑費";
          const taxClass = ocrResult.tax_class || "課税仕入10%";
          const payment = ocrResult.payment || "不明";
          let creditAccount = "事業主借";
          if (payment === "JCBデビット" || payment === "Mastercardデビット") creditAccount = "普通預金";
          else if (payment === "現金") creditAccount = "現金";
          else if (payment === "PayPay") creditAccount = "事業主借";
          else if (payment === "クレジットカード") creditAccount = "未払金";

          await appendToSheet(env.GOOGLE_EXPENSE_SHEET_ID, "MF仕訳帳", [
            ocrResult.date || "不明", account, "", taxClass, ocrResult.amount || 0,
            creditAccount, "", taxClass, ocrResult.amount || 0,
            `${ocrResult.store || ""}${ocrResult.items ? " " + ocrResult.items : ""}`,
            ocrResult.note || "", ocrResult.business || "",
          ], gToken);

          await appendToSheet(env.GOOGLE_EXPENSE_SHEET_ID, "レシート原本", [
            ocrResult.date || "不明", ocrResult.store || "不明", ocrResult.amount || 0,
            ocrResult.items || "不明", account, taxClass, payment,
            ocrResult.note || "", driveLink, now, ocrResult.business || "不明",
          ], gToken);
        } catch (e) {
          console.error("Google API error:", e.message);
        }

        try { fs.unlinkSync(filePath); } catch {}

        // Web Push通知で結果を送信
        const amount = ocrResult.amount ? Number(ocrResult.amount).toLocaleString() + "円" : "不明";
        sendWebPush(
          `${ocrResult.store || "不明"} ${amount}`,
          `${ocrResult.date || ""} / ${ocrResult.account || "雑費"} / ${ocrResult.payment || ""}`
        );
      });
    });
  } else if (req.method === "POST" && pathname === "/api/voice-input") {
    // 音声入力用の同期文字起こし（Whisper → テキスト返却）
    const origin = req.headers["origin"] || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const boundary = req.headers["content-type"]?.split("boundary=")[1];
      if (!boundary) {
        res.writeHead(400, corsHeaders);
        res.end(JSON.stringify({ error: "No boundary" }));
        return;
      }

      const parts = parseMultipart(raw, boundary);
      const tokenPart = parts.find(p => p.name === "token");
      if ((!tokenPart && !qToken) || (tokenPart ? tokenPart.data.toString() : qToken) !== env.SHIRATAMA_API_TOKEN) {
        res.writeHead(401, corsHeaders);
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      const filePart = parts.find(p => p.name === "file");
      if (!filePart) {
        res.writeHead(400, corsHeaders);
        res.end(JSON.stringify({ error: "No file" }));
        return;
      }

      const uploadDir = path.join(REPO_DIR, "logs", ".uploads");
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const ext = path.extname(filePart.filename || ".webm") || ".webm";
      const audioPath = path.join(uploadDir, `voice_${Date.now()}${ext}`);
      fs.writeFileSync(audioPath, filePart.data);

      console.log(`[${new Date().toISOString()}] Voice input: ${filePart.data.length} bytes`);

      try {
        const WHISPER = "/Users/Inaryo/Library/Python/3.9/bin/mlx_whisper";
        const outDir = path.join(uploadDir, `whisper_voice_${Date.now()}`);
        fs.mkdirSync(outDir, { recursive: true });

        execSync(
          `"${WHISPER}" "${audioPath}" --model mlx-community/whisper-small-mlx --language ja --output-dir "${outDir}" --output-format txt`,
          { encoding: "utf-8", timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
        );

        const txtFiles = fs.readdirSync(outDir).filter(f => f.endsWith(".txt"));
        const text = txtFiles.length > 0
          ? fs.readFileSync(path.join(outDir, txtFiles[0]), "utf-8").trim()
          : "";

        console.log(`[${new Date().toISOString()}] Voice transcribed: ${text.slice(0, 80)}...`);

        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ text }));

        // クリーンアップ
        try { fs.unlinkSync(audioPath); } catch {}
        try { fs.rmSync(outDir, { recursive: true }); } catch {}
      } catch (e) {
        console.error("Voice input error:", e.message);
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: "Transcription failed" }));
        try { fs.unlinkSync(audioPath); } catch {}
      }
    });

  } else if (req.method === "POST" && pathname === "/api/siri-input") {
    // Siri/iOSショートカットからのテキスト入力 → Discord #general に投稿
    // voice-chat-bot が拾ってClaude応答 + TTS再生する
    const corsH = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
    let bodyChunks = [];
    req.on("data", (chunk) => bodyChunks.push(chunk));
    req.on("end", () => {
      try {
        const rawBody = Buffer.concat(bodyChunks).toString();
        console.log(`[Siri] Raw body (${req.headers["content-type"]}): ${rawBody.slice(0, 200)}`);
        let body;
        try {
          body = JSON.parse(rawBody);
        } catch (jsonErr) {
          // iOSショートカットがform-urlencoded等で送る場合のフォールバック
          const params = new URLSearchParams(rawBody);
          body = Object.fromEntries(params.entries());
          console.log(`[Siri] Parsed as form-urlencoded:`, body);
        }
        const token = body.token || qToken;
        if (token !== env.SHIRATAMA_API_TOKEN) {
          console.log(`[Siri] Auth failed. Got: "${token}", Expected: "${env.SHIRATAMA_API_TOKEN}"`);
          res.writeHead(401, corsH);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        const text = (body.text || "").trim();
        if (!text) {
          res.writeHead(400, corsH);
          res.end(JSON.stringify({ error: "No text provided" }));
          return;
        }
        console.log(`[${new Date().toISOString()}] Siri input: ${text.slice(0, 100)}`);

        // Discord #general にWebhookで投稿（Bot以外の名前で投稿し、voice-chat-botが拾えるようにする）
        // Webhookが未設定の場合はBot APIで投稿（特別フォーマット）
        const GENERAL_CHANNEL_ID = "1486651095580282942";
        const discordMsg = `🎙️ **Ryo (Siri)**: ${text}\n\nしらたま、これに答えて。`;
        const msgData = JSON.stringify({ content: discordMsg });
        const discordReq = https.request({
          hostname: "discord.com",
          path: `/api/v10/channels/${GENERAL_CHANNEL_ID}/messages`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
            "Content-Length": Buffer.byteLength(msgData),
          },
        }, (discordRes) => {
          let dBody = "";
          discordRes.on("data", (d) => (dBody += d));
          discordRes.on("end", () => {
            if (discordRes.statusCode >= 200 && discordRes.statusCode < 300) {
              console.log(`[Siri] Discord message sent to #general`);
              res.writeHead(200, corsH);
              res.end(JSON.stringify({ success: true, text }));
            } else {
              console.error(`[Siri] Discord API error: ${discordRes.statusCode} ${dBody.slice(0, 200)}`);
              res.writeHead(502, corsH);
              res.end(JSON.stringify({ error: "Discord send failed" }));
            }
          });
        });
        discordReq.on("error", (e) => {
          console.error(`[Siri] Discord request error: ${e.message}`);
          res.writeHead(502, corsH);
          res.end(JSON.stringify({ error: e.message }));
        });
        discordReq.write(msgData);
        discordReq.end();

      } catch (e) {
        console.error("Siri input error:", e.message);
        res.writeHead(500, corsH);
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  } else if (req.method === "POST" && pathname === "/api/transcribe") {
    // 音声文字起こし（mlx-whisper）
    const origin = req.headers["origin"] || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const contentType = req.headers["content-type"] || "";
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        res.writeHead(400, corsHeaders);
        res.end(JSON.stringify({ error: "Invalid content type" }));
        return;
      }
      const parts = parseMultipart(body, boundaryMatch[1]);

      const tokenPart = parts.find(p => p.name === "token");
      if ((!tokenPart && !qToken) || (tokenPart ? tokenPart.data.toString() : qToken) !== env.SHIRATAMA_API_TOKEN) {
        res.writeHead(401, corsHeaders);
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      const filePart = parts.find(p => p.name === "file");
      if (!filePart || !filePart.filename) {
        res.writeHead(400, corsHeaders);
        res.end(JSON.stringify({ error: "No audio file provided" }));
        return;
      }

      // モード: "transcribe"(文字起こしのみ) or "summarize"(文字起こし+要約)
      const modePart = parts.find(p => p.name === "mode");
      const mode = modePart ? modePart.data.toString() : "summarize";

      const uploadDir = path.join(REPO_DIR, "logs", ".uploads");
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

      const ext = path.extname(filePart.filename) || ".m4a";
      const audioPath = path.join(uploadDir, `audio_${Date.now()}${ext}`);
      fs.writeFileSync(audioPath, filePart.data);

      console.log(`[${new Date().toISOString()}] Transcribe: ${filePart.filename} (${filePart.data.length} bytes, mode=${mode})`);

      // 即レスポンス → バックグラウンド処理 → Web Push通知
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ status: "processing", message: "文字起こし処理を開始しました" }));

      (async () => {
        try {
          const WHISPER = "/Users/Inaryo/Library/Python/3.9/bin/mlx_whisper";
          const outDir = path.join(uploadDir, `whisper_${Date.now()}`);
          fs.mkdirSync(outDir, { recursive: true });

          execSync(
            `"${WHISPER}" "${audioPath}" --model mlx-community/whisper-small-mlx --language ja --output-dir "${outDir}" --output-format txt`,
            { encoding: "utf-8", timeout: 600000, maxBuffer: 10 * 1024 * 1024 }
          );

          // 文字起こし結果を読み取り
          const txtFiles = fs.readdirSync(outDir).filter(f => f.endsWith(".txt"));
          const transcript = txtFiles.length > 0
            ? fs.readFileSync(path.join(outDir, txtFiles[0]), "utf-8").trim()
            : "(文字起こし結果なし)";

          let resultMessage = "";

          if (mode === "transcribe") {
            resultMessage = transcript;
            sendWebPush("文字起こし完了", transcript.slice(0, 100) + (transcript.length > 100 ? "..." : ""));
          } else {
            // Claude で要約
            const promptFile = path.join(REPO_DIR, "logs", ".transcribe-prompt.txt");
            const summaryPrompt = `以下は音声ファイル「${filePart.filename}」の文字起こしテキストです。\n\n---\n${transcript}\n---\n\n上記の内容を以下の形式でまとめてください：\n1. 要約（3〜5行）\n2. 重要なポイント（箇条書き）\n3. アクションアイテム（あれば）\n\n元の文字起こしテキストも最後に「--- 文字起こし全文 ---」として添付してください。`;
            fs.writeFileSync(promptFile, summaryPrompt, "utf-8");

            const execEnv = Object.assign({}, process.env, {
              PATH: `/Users/Inaryo/.local/share/mise/installs/node/24.14.0/bin:/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
              HOME: "/Users/ocmm",
            });
            delete execEnv.CLAUDECODE;

            const summary = execSync(
              `cd "${REPO_DIR}" && cat "${promptFile}" | "${CLAUDE_PATH}" -p --model claude-sonnet-4-6 --dangerously-skip-permissions`,
              { encoding: "utf-8", timeout: CLAUDE_TIMEOUT, maxBuffer: 1024 * 1024, env: execEnv }
            ).trim();

            resultMessage = summary || transcript;
            sendWebPush("文字起こし+要約完了", resultMessage.slice(0, 100) + "...");
          }

          // 文字起こし結果をファイル保存
          const now = new Date();
          const dateStr = now.toISOString().slice(0, 10);
          const timeStr = now.toISOString().slice(11, 16).replace(":", "");
          const safeName = filePart.filename.replace(/[^a-zA-Z0-9._\-\u3000-\u9fff]/g, "_").replace(/\.[^.]+$/, "");
          const transcriptDir = path.join(REPO_DIR, "logs", "transcripts");
          if (!fs.existsSync(transcriptDir)) fs.mkdirSync(transcriptDir, { recursive: true });
          const mdFilename = `${dateStr}_${timeStr}_${safeName}.md`;
          const mdContent = `# 文字起こし: ${filePart.filename}\n\n- 日時: ${now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}\n- モード: ${mode === "summarize" ? "文字起こし+要約" : "文字起こしのみ"}\n\n${resultMessage}\n`;
          fs.writeFileSync(path.join(transcriptDir, mdFilename), mdContent, "utf-8");
          console.log(`[${now.toISOString()}] Transcript saved: ${mdFilename}`);

          // チャット履歴に保存
          appendChatLog("pwa", "user", `[音声ファイル: ${filePart.filename}]`);
          appendChatLog("pwa", "assistant", resultMessage);

          // クリーンアップ
          try { fs.unlinkSync(audioPath); } catch {}
          try { fs.rmSync(outDir, { recursive: true }); } catch {}
        } catch (e) {
          console.error("Transcribe error:", e.message);
          sendWebPush("文字起こし失敗", "音声の処理に失敗しました。もう一度試してみてね。");
          try { fs.unlinkSync(audioPath); } catch {}
        }
      })();
    });
  } else if (req.method === "GET" && req.url?.startsWith("/api/quick-actions")) {
    // クイックアクション一覧
    const origin = req.headers["origin"] || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const token = parsedUrl.searchParams.get("token");
    if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const actionsPath = path.join(REPO_DIR, "config", "quick-actions.json");
    try {
      const actions = JSON.parse(fs.readFileSync(actionsPath, "utf-8"));
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ actions }));
    } catch {
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ actions: [] }));
    }

  } else if (req.method === "GET" && req.url?.startsWith("/api/transcripts")) {
    // 文字起こし一覧 & 個別取得
    const origin = req.headers["origin"] || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const token = parsedUrl.searchParams.get("token");
    if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const transcriptDir = path.join(REPO_DIR, "logs", "transcripts");
    const filename = parsedUrl.searchParams.get("file");

    if (filename) {
      // 個別取得
      const filePath = path.join(transcriptDir, path.basename(filename));
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, corsHeaders);
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ filename: path.basename(filename), content }));
    } else {
      // 一覧
      if (!fs.existsSync(transcriptDir)) {
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ transcripts: [] }));
        return;
      }
      const files = fs.readdirSync(transcriptDir)
        .filter(f => f.endsWith(".md"))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, 50)
        .map(f => {
          const content = fs.readFileSync(path.join(transcriptDir, f), "utf-8");
          const titleMatch = content.match(/^# 文字起こし: (.+)/m);
          const dateMatch = content.match(/- 日時: (.+)/m);
          return {
            filename: f,
            title: titleMatch ? titleMatch[1] : f,
            date: dateMatch ? dateMatch[1] : "",
            preview: content.split("\n").filter(l => l && !l.startsWith("#") && !l.startsWith("-")).slice(0, 2).join(" ").slice(0, 100),
          };
        });
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ transcripts: files }));
    }

  } else if (req.method === "POST" && pathname === "/api/upload") {
    // ファイルアップロード（画像・PDF等）
    const origin = req.headers["origin"] || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks);
        const contentType = req.headers["content-type"] || "";

        // Parse multipart/form-data
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) {
          res.writeHead(400, corsHeaders);
          res.end(JSON.stringify({ error: "Invalid content type" }));
          return;
        }
        const boundary = boundaryMatch[1];
        const parts = parseMultipart(body, boundary);

        // Check token
        const tokenPart = parts.find(p => p.name === "token");
        if ((!tokenPart && !qToken) || (tokenPart ? tokenPart.data.toString() : qToken) !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const filePart = parts.find(p => p.name === "file");
        if (!filePart || !filePart.filename) {
          res.writeHead(400, corsHeaders);
          res.end(JSON.stringify({ error: "No file provided" }));
          return;
        }

        // Save to temp directory
        const uploadDir = path.join(REPO_DIR, "logs", ".uploads");
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

        const ext = path.extname(filePart.filename) || ".bin";
        const safeName = `upload_${Date.now()}${ext}`;
        const filePath = path.join(uploadDir, safeName);
        fs.writeFileSync(filePath, filePart.data);

        console.log(`[${new Date().toISOString()}] File uploaded: ${filePart.filename} -> ${filePath} (${filePart.data.length} bytes)`);

        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ path: filePath, filename: filePart.filename, size: filePart.data.length }));
      } catch (e) {
        console.error("Upload error:", e.message);
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: "Upload failed" }));
      }
    });
  } else if (req.method === "POST" && pathname === "/api/chat") {
    // 秘書しらたま PWA 用エンドポイント（非同期：即レスポンス→バックグラウンド処理→Web Push通知）
    const origin = req.headers["origin"] || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { messages, token, attachments } = JSON.parse(body);

        // 簡易認証トークン
        if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        // 最新のユーザーメッセージを取得
        const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
        if (!lastUserMsg) {
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ message: "メッセージが見つかりませんでした。" }));
          return;
        }

        // チャットIDを生成して即レスポンス
        const chatId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const chatResponseDir = path.join(REPO_DIR, "logs", ".chat-responses");
        if (!fs.existsSync(chatResponseDir)) fs.mkdirSync(chatResponseDir, { recursive: true });

        // 処理中ステータスを保存
        fs.writeFileSync(
          path.join(chatResponseDir, `${chatId}.json`),
          JSON.stringify({ status: "processing", chatId, timestamp: Date.now() })
        );

        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ status: "processing", chatId }));

        // --- バックグラウンド処理 ---
        (async () => {
          try {
            // 会話履歴をプロンプトに組み立て（最新8件、エラー除外、長文圧縮）
            const MAX_HISTORY = 8;
            const MAX_MSG_CHARS = 500; // 各メッセージの最大文字数
            const MAX_PROMPT_CHARS = 6000; // プロンプト全体の最大文字数（履歴部分）
            const ERROR_PATTERNS = ["ごめんね、うまく応答できなかったみたい", "Mac mini が起動しているか確認"];

            // エラーメッセージを含むやり取りを除外
            const cleanedMessages = messages.filter(m => {
              if (m.role === "assistant" && ERROR_PATTERNS.some(p => m.content.includes(p))) return false;
              return true;
            });

            const trimmedMessages = cleanedMessages.length > MAX_HISTORY + 1
              ? cleanedMessages.slice(-(MAX_HISTORY + 1))
              : cleanedMessages;

            let prompt = "";
            if (trimmedMessages.length > 1) {
              prompt += "以下はRyoとの会話の続きです。直前のやり取りを踏まえて回答してください。\n\n";
              prompt += "--- 会話履歴 ---\n";
              let historyText = "";
              for (const msg of trimmedMessages.slice(0, -1)) {
                const label = msg.role === "user" ? "Ryo" : "しらたま";
                // 長文メッセージを圧縮
                let content = msg.content;
                if (content.length > MAX_MSG_CHARS) {
                  content = content.slice(0, MAX_MSG_CHARS) + "…（以下省略）";
                }
                historyText += `${label}: ${content}\n\n`;
              }
              // プロンプト全体の文字数制限（古い履歴から削る）
              while (historyText.length > MAX_PROMPT_CHARS && historyText.includes("\n\n")) {
                const firstBreak = historyText.indexOf("\n\n");
                if (firstBreak === -1) break;
                historyText = historyText.slice(firstBreak + 2);
              }
              prompt += historyText;
              prompt += "--- 最新のメッセージ ---\n";
              prompt += `Ryo: ${lastUserMsg.content}\n\n`;
              prompt += "上記の会話の流れを踏まえて、最新のメッセージに回答してください。";
            } else {
              prompt = lastUserMsg.content;
            }

            // 添付ファイルがある場合、Read指示を追加
            if (attachments && attachments.length > 0) {
              prompt += "\n\n--- 添付ファイル ---\n";
              prompt += "Ryoが以下のファイルを送ってきました。Read ツールを使って各ファイルの内容を読み取り、分析してください。\n";
              for (const att of attachments) {
                prompt += `- ファイル: ${att.filename} → パス: ${att.path}\n`;
              }
              prompt += "\nファイルの内容を読み取った上で、Ryoのメッセージに回答してください。";
            }

            // SNS投稿文作成検出 → スタイルガイド注入
            const SNS_KEYWORDS = /投稿|SNS|インスタ|Instagram|IG|キャプション|ポスト|post/i;
            if (SNS_KEYWORDS.test(lastUserMsg.content) || (attachments?.length > 0 && /投稿|SNS|インスタ/i.test(lastUserMsg.content))) {
              try {
                const styleGuide = JSON.parse(fs.readFileSync(path.join(REPO_DIR, "data", "sns-style-guide.json"), "utf-8"));
                prompt += `\n\n--- SNS投稿文スタイルガイド ---
あなたはRyoのゴーストライターです。以下のルールに従って投稿文を作成してください。

【最重要】AIが書いたとバレないこと。Ryoの文体を完璧に再現する。

【アカウント別文体】
${JSON.stringify(styleGuide.accounts, null, 2)}

【共通ルール】
- 写真の内容からアカウントを自動判定する（古民家・縁側→engawa_yanagawa、コーヒー→misoca_coffee、AI・DX→satoyama_ai_base、個人的な風景・思索→ryosuke_ina）
- Ryoに「どのアカウントで投稿する？」と聞いてから作成する。ただし写真から明らかな場合は判定結果を提案してよい
- ryosuke_inaの場合: 写真から感じたことを起点に内省的に深掘り。自問自答、話が逸れる、結論が軽い、がRyoの味。完璧すぎる文章はNG
- engawa_yanagawaの場合: 五感に訴える丁寧な描写。最後に予約案内を入れる
- ハッシュタグはアカウントごとの定番＋テーマ別を組み合わせる
- 投稿文は一つだけ出力し、「これでどう？」と確認する。修正があれば調整する
---`;
              } catch (e) {
                console.error("[SNS] Style guide load error:", e.message);
              }
            }

            // 日程調整検出 → カレンダー情報注入
            if (SCHEDULE_KEYWORDS.test(lastUserMsg.content)) {
              try {
                const range = detectScheduleDateRange(lastUserMsg.content);
                const busyInfo = await getCalendarBusy(range.start, range.end);
                if (busyInfo) {
                  prompt += `\n\n--- Ryoのカレンダー状況 (${range.start}〜${range.end}) ---\n${busyInfo}\n---`;
                }
              } catch (e) {
                console.error("Calendar fetch error in PWA:", e.message);
              }
              prompt += `\n\n【絶対ルール】以下を厳守せよ：
- 出力は「相手に送る返信メッセージ本文」のみ。それ以外は一文字も出力するな
- 「以下が返信テキストです」「返信例：」等の前置き・説明・補足は絶対に書くな
- 全体コピーしてそのままチャットに貼り付けられる形式にせよ
- 空いている日を簡潔に伝えるチャットメッセージとして出力せよ
- カジュアルなトーン（ビジネスメールではなくLINEチャット調）`;
            }

            const promptFile = path.join(REPO_DIR, "logs", ".shiratama-prompt.txt");
            fs.writeFileSync(promptFile, prompt, "utf-8");

            const execEnv = Object.assign({}, process.env, {
              PATH: `/Users/Inaryo/.local/share/mise/installs/node/24.14.0/bin:/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
              HOME: "/Users/ocmm",
            });
            delete execEnv.CLAUDECODE;

            const result = execSync(
              `cd "${REPO_DIR}" && cat "${promptFile}" | "${CLAUDE_PATH}" -p --model claude-sonnet-4-6 --dangerously-skip-permissions`,
              { encoding: "utf-8", timeout: CLAUDE_TIMEOUT, maxBuffer: 1024 * 1024, env: execEnv }
            );

            const response = result.trim() || "(応答なし)";
            console.log(`[${new Date().toISOString()}] Shiratama response: ${response.slice(0, 100)}...`);
            appendChatLog("pwa", "user", lastUserMsg.content);
            appendChatLog("pwa", "assistant", response);

            // Clean up uploaded files after processing
            if (attachments && attachments.length > 0) {
              for (const att of attachments) {
                try { fs.unlinkSync(att.path); } catch {}
              }
            }

            // 結果を保存
            fs.writeFileSync(
              path.join(chatResponseDir, `${chatId}.json`),
              JSON.stringify({ status: "done", chatId, message: response, timestamp: Date.now() })
            );

            // Web Push通知を送信（アプリ切り替え中でも気づける）
            const pushBody = response.length > 100 ? response.slice(0, 100) + "…" : response;
            sendWebPush("しらたま", pushBody).catch(e => console.error("Chat push error:", e.message));
          } catch (e) {
            console.error("Shiratama chat error:", e.message);
            // エラー結果を保存
            fs.writeFileSync(
              path.join(chatResponseDir, `${chatId}.json`),
              JSON.stringify({ status: "error", chatId, message: "ごめんね、うまく応答できなかったみたい。Mac mini が起動しているか確認してね。", timestamp: Date.now() })
            );
            sendWebPush("しらたま", "ごめんね、うまく応答できなかったみたい。").catch(() => {});
          }
        })();
      } catch (e) {
        console.error("Shiratama chat parse error:", e.message);
        res.writeHead(400, corsHeaders);
        res.end(JSON.stringify({ error: "Bad request" }));
      }
    });
  } else if (req.method === "GET" && req.url?.startsWith("/api/chat-result")) {
    // チャット結果取得エンドポイント（ポーリング用）
    const origin = req.headers["origin"] || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const chatId = urlObj.searchParams.get("id");
    const qToken = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");

    if (qToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (!chatId) {
      res.writeHead(400, corsHeaders);
      res.end(JSON.stringify({ error: "Missing chat ID" }));
      return;
    }

    const resultFile = path.join(REPO_DIR, "logs", ".chat-responses", `${chatId}.json`);
    if (!fs.existsSync(resultFile)) {
      res.writeHead(404, corsHeaders);
      res.end(JSON.stringify({ error: "Chat not found" }));
      return;
    }

    try {
      const result = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify(result));

      // 結果取得済みの完了/エラーファイルは削除（クリーンアップ）
      if (result.status === "done" || result.status === "error") {
        try { fs.unlinkSync(resultFile); } catch {}
      }
    } catch (e) {
      res.writeHead(500, corsHeaders);
      res.end(JSON.stringify({ error: "Failed to read result" }));
    }
  } else if (req.method === "GET" && req.url?.startsWith("/api/tasks")) {
    // タスク一覧を tasks.json から取得（新ストア）
    const origin = req.headers["origin"] || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Content-Type": "application/json",
    };

    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qTokenLocal = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
    if (qTokenLocal !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      const taskStoreModule = require("./task-store");
      const allTasks = taskStoreModule.loadTasks().tasks;

      // しらたまPWA互換形式: プロジェクト別セクションに変換
      const sectionMap = {};
      for (const t of allTasks) {
        if (t.status === "done") continue; // 完了済みは非表示（直近完了は別で見せる）
        if (!sectionMap[t.project]) sectionMap[t.project] = [];
        sectionMap[t.project].push({ text: t.title, done: false, id: t.id, priority: t.priority, dueDate: t.dueDate, status: t.status });
      }

      const tasks = Object.entries(sectionMap).map(([title, tasks]) => ({ title, tasks }));

      // 直近完了タスク（24時間以内）
      const recentDone = taskStoreModule.getRecentlyCompleted(1).map(t => ({
        text: t.title, done: true, id: t.id, completedAt: t.completedAt,
        completedBy: t.history?.find(h => h.action === "completed")?.by || "manual",
      }));

      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ tasks, recentlyCompleted: recentDone }));
    } catch (e) {
      console.error("Tasks API error:", e.message);
      res.writeHead(500, corsHeaders);
      res.end(JSON.stringify({ error: "Failed to load tasks" }));
    }
  } else if (req.method === "POST" && pathname === "/api/tasks/toggle") {
    // タスクの完了/未完了を tasks.json で管理
    const origin = req.headers["origin"] || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Content-Type": "application/json",
    };

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { token, taskText, done, taskId } = JSON.parse(body);
        if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const taskStoreModule = require("./task-store");

        // taskId があればそれで検索、なければtextで検索
        let task;
        if (taskId) {
          const data = taskStoreModule.loadTasks();
          task = data.tasks.find(t => t.id === taskId);
        }
        if (!task && taskText) {
          task = taskStoreModule.findTaskByTitle(taskText);
        }

        if (!task) {
          res.writeHead(404, corsHeaders);
          res.end(JSON.stringify({ error: "Task not found" }));
          return;
        }

        if (done) {
          taskStoreModule.completeTask(task.id, { by: "manual", note: "PWAから完了" });
        } else {
          taskStoreModule.updateTask(task.id, { status: "open", completedAt: null }, "manual", "PWAから未完了に戻す");
        }

        console.log(`[${new Date().toISOString()}] Task toggled: "${task.title}" → ${done ? "done" : "undone"}`);
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        console.error("Task toggle error:", e.message);
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: "Failed to toggle task" }));
      }
    });
  } else if (req.method === "GET" && req.url?.startsWith("/api/today")) {
    // today.json を返す（タスク統合エンジンの結果）
    const origin = req.headers["origin"] || "";
    const corsHeaders = { "Access-Control-Allow-Origin": origin, "Content-Type": "application/json" };
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qTokenLocal = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
    if (qTokenLocal !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const refresh = urlObj.searchParams.get("refresh") === "1";
    const todayFile = path.join(REPO_DIR, "data", "today.json");

    (async () => {
      try {
        // refreshパラメータがあるか、today.jsonが古い場合は再生成
        let needsRefresh = refresh;
        if (!needsRefresh) {
          try {
            const existing = JSON.parse(fs.readFileSync(todayFile, "utf-8"));
            const now = new Date();
            const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
            const todayDate = `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, "0")}-${String(jst.getDate()).padStart(2, "0")}`;
            if (existing.date !== todayDate) needsRefresh = true;
            // 1時間以上前の生成なら更新
            const age = Date.now() - new Date(existing.generatedAt).getTime();
            if (age > 60 * 60 * 1000) needsRefresh = true;
          } catch {
            needsRefresh = true;
          }
        }

        if (needsRefresh) {
          const { generateToday } = require("./task-engine");
          const data = await generateToday();
          // 秘書コメント生成（バックグラウンドで非同期実行、レスポンスは先に返す）
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify(data));
          // コメント生成後にtoday.jsonが更新される → 次回読み込み時に反映
          try {
            const { enrichToday } = require("./secretary-enrich");
            enrichToday().catch(e => console.error("[secretary-enrich] Error:", e.message));
          } catch {}
        } else {
          const data = JSON.parse(fs.readFileSync(todayFile, "utf-8"));
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify(data));
        }
      } catch (e) {
        console.error("Today API error:", e.message);
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    })();

  } else if (req.method === "GET" && req.url?.startsWith("/api/schedule")) {
    // 今日の予定を返す
    const origin = req.headers["origin"] || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Content-Type": "application/json",
    };

    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qToken = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
    if (qToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const who = urlObj.searchParams.get("who") || "ryo"; // "ryo" or "marie"
    const RM_SHARED_CAL = "9c0d4af92a70ced546b135411feda7120c9fd874beda1363874c03faf8953f18@group.calendar.google.com";

    // R&M共有カレンダーのイベントをフィルタ: (R)=Ryo, (M)=Marie
    function filterEventByWho(title, targetWho) {
      const isR = title.startsWith("(R)") || title.startsWith("（R）");
      const isM = title.startsWith("(M)") || title.startsWith("（M）");
      if (targetWho === "ryo") return !isM; // Ryo: (R)とタグなしを表示、(M)は除外
      if (targetWho === "marie") return !isR; // Marie: (M)とタグなしを表示、(R)は除外
      return true;
    }

    (async () => {
    try {
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const dailyLogPath = path.join(REPO_DIR, "logs", "daily", `${dateStr}.md`);

      // Marie の場合は常にカレンダーAPIから取得（日次ログはRyo向け）
      if (who === "ryo" && fs.existsSync(dailyLogPath)) {
        const content = fs.readFileSync(dailyLogPath, "utf-8");

        // Parse structured sections from daily log
        const sections = content.split(/^## /m).filter(Boolean);
        const events = [];
        const extras = []; // additional info cards
        const achievements = []; // 本日の実績 { category: string, items: string[] }

        for (const sec of sections) {
          const lines = sec.trim().split("\n");
          const heading = lines[0].trim();

          if (heading === "今日の予定") {
            for (let i = 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line.startsWith("- ")) continue;
              const text = line.slice(2).trim();

              // Parse time patterns: "10:00-11:30 ...", "終日: ...", "~11:00: ..."
              let time = "";
              let title = text;
              const timeMatch = text.match(/^(\d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?)\s+(.+)/);
              const allDayMatch = text.match(/^終日[:：]\s*(.+)/);
              const tildeMatch = text.match(/^~(\d{1,2}:\d{2})[:：]\s*(.+)/);
              const parenTimeMatch = text.match(/^\(.*?\)\s*(.+)/);

              if (timeMatch) {
                time = timeMatch[1];
                title = timeMatch[2];
              } else if (allDayMatch) {
                time = "終日";
                title = allDayMatch[1];
              } else if (tildeMatch) {
                time = `~${tildeMatch[1]}`;
                title = tildeMatch[2];
              } else if (parenTimeMatch) {
                // "(西) 陽介くん..." style - extract prefix as calendar hint
                time = "終日";
                title = text;
              }

              events.push({ time: time || "---", title, calendar: "ブリーフィング" });
            }
          } else if (heading.includes("宿泊状況") || heading.includes("えんがわ")) {
            const items = [];
            for (let i = 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (line.startsWith("- ")) items.push(line.slice(2).trim());
            }
            if (items.length > 0) {
              extras.push({ title: heading.replace(/\s*$/, ""), items });
            }
          } else if (heading === "本日の実績" || heading.includes("実績")) {
            // Parse achievements with ### sub-categories
            let currentCat = null;
            for (let i = 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (line.startsWith("### ")) {
                currentCat = { category: line.slice(4).trim(), items: [] };
                achievements.push(currentCat);
              } else if (line.startsWith("- ") && currentCat) {
                currentCat.items.push(line.slice(2).trim());
              } else if (line.startsWith("- ") && !currentCat) {
                // Items without sub-category
                if (achievements.length === 0 || achievements[achievements.length - 1].category !== "その他") {
                  achievements.push({ category: "その他", items: [] });
                }
                achievements[achievements.length - 1].items.push(line.slice(2).trim());
              }
            }
          } else if (heading === "継続タスク") {
            // Skip - handled by /api/tasks
          }
        }

        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({
          date: dateStr,
          events: events.length > 0 ? events : undefined,
          extras: extras.length > 0 ? extras : undefined,
          achievements: achievements.length > 0 ? achievements : undefined,
          source: "daily_log"
        }));
      } else {
        // カレンダーAPIから直接取得
        try {
          const gToken = await getGoogleAccessToken();
          // Ryo: 全カレンダー（R&M共有は(M)除外）
          // Marie: R&M共有カレンダーのみ（(R)除外）
          const calendarIds = who === "marie" ? [RM_SHARED_CAL] : [
            "r.inafuku@tonari2tomaru.com",
            RM_SHARED_CAL,
            "misocacoffee@gmail.com",
            "4651f62429c52388651033e5b59f4cb81a418694431ab262748b231c663e461f@group.calendar.google.com",
            "engawa.yanagawa@gmail.com",
            "b6ff2100d451e679aa52c0afca510ce6268b673ddb904e7526c5bec7fb38836a@group.calendar.google.com",
          ];
          const timeMin = new Date(dateStr + "T00:00:00+09:00").toISOString();
          const timeMax = new Date(dateStr + "T23:59:59+09:00").toISOString();
          const events = [];

          for (const calId of calendarIds) {
            try {
              const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&fields=items(summary,start,end,status)`;
              const result = await googleApiRequest("GET", url, null, gToken);
              if (result.items) {
                for (const ev of result.items) {
                  if (ev.status === "cancelled") continue;
                  const title = ev.summary || "(予定)";
                  // R&M共有カレンダーのイベントはwhoでフィルタ
                  if (calId === RM_SHARED_CAL && !filterEventByWho(title, who)) continue;
                  const allDay = !!ev.start.date;
                  let time = "終日";
                  if (!allDay) {
                    const s = new Date(ev.start.dateTime).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
                    const e = new Date(ev.end.dateTime).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
                    time = `${s}-${e}`;
                  }
                  events.push({ time, title, calendar: "Google Calendar" });
                }
              }
            } catch (e) {
              console.error(`Schedule calendar fetch error (${calId}):`, e.message);
            }
          }

          // 重複排除（同じタイトル＋同じ時間帯は1つだけ表示）
          const seen = new Set();
          const deduped = events.filter(ev => {
            const key = `${ev.time}|${ev.title.replace(/^\(R\)\s*/, "").replace(/^\(M\)\s*/, "")}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          // 時間順にソート
          deduped.sort((a, b) => {
            if (a.time === "終日") return -1;
            if (b.time === "終日") return 1;
            return a.time.localeCompare(b.time);
          });

          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ date: dateStr, events: deduped, source: "calendar" }));
        } catch (calErr) {
          console.error("Schedule calendar direct fetch error:", calErr.message);
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ date: dateStr, events: [], source: "empty" }));
        }
      }
    } catch (e) {
      console.error("Schedule API error:", e.message);
      res.writeHead(500, corsHeaders);
      res.end(JSON.stringify({ error: "Failed to fetch schedule" }));
    }
    })();
  } else if (req.method === "OPTIONS") {
    // CORS preflight for all /api/* routes
    res.writeHead(204, {
      "Access-Control-Allow-Origin": req.headers["origin"] || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
  } else if (req.method === "GET" && req.url?.startsWith("/api/chat-history")) {
    const corsHeaders = { "Access-Control-Allow-Origin": req.headers["origin"] || "*", "Content-Type": "application/json" };
    const urlParams = new (require("url").URL)(req.url, "http://localhost").searchParams;
    const token = urlParams.get("token");
    if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const limit = parseInt(urlParams.get("limit") || "50");
    const source = urlParams.get("source") || ""; // "line", "pwa", or "" for all
    const search = urlParams.get("q") || "";

    let history = loadChatHistory();

    if (source) history = history.filter(h => h.source === source);
    if (search) {
      const q = search.toLowerCase();
      history = history.filter(h => h.content.toLowerCase().includes(q));
    }

    // 最新のものから返す
    const result = history.slice(-limit).reverse();
    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ history: result, total: history.length }));
  } else if (req.method === "GET" && req.url?.startsWith("/api/finance")) {
    const corsHeaders = { "Access-Control-Allow-Origin": req.headers["origin"] || "*", "Content-Type": "application/json" };
    const urlParams = new (require("url").URL)(req.url, "http://localhost").searchParams;
    const token = urlParams.get("token");
    if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const filterMonth = urlParams.get("month") || ""; // "2026-03" or "" for current
    const filterBusiness = urlParams.get("business") || ""; // "えんがわ" or "" for all

    (async () => {
    try {
      const gToken = await getGoogleAccessToken();
      const sheetId = env.GOOGLE_EXPENSE_SHEET_ID;

      // レシート原本から全データ取得（支払方法の正確なデータを使う）
      const receiptUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent("レシート原本")}!A:K`;
      const receiptData = await googleApiRequest("GET", receiptUrl, null, gToken);
      const rows = receiptData.values || [];

      // ヘッダー行をスキップ（1行目がヘッダーの場合）
      const dataRows = rows.length > 0 && rows[0][0] === "取引日" ? rows.slice(1) : rows;
      // レシート原本の列: [0]取引日, [1]店名, [2]合計金額, [3]品目, [4]勘定科目, [5]税区分, [6]支払方法, [7]備考, [8]Drive画像, [9]登録日時, [10]事業区分

      // 全月のリストを作成（フィルター前）
      const availableMonths = new Set();
      const availableBusinesses = new Set();
      for (const row of dataRows) {
        const date = row[0] || "";
        const tag = row[10] || "";
        if (date && date.length >= 7) availableMonths.add(date.slice(0, 7));
        if (tag && tag !== "プライベート") availableBusinesses.add(tag);
      }

      // 月別・カテゴリ別・事業別に集計
      const monthlyTotals = {};  // { "2026-03": 12345 }
      const categoryTotals = {}; // { "食費": 5000 }
      const paymentTotals = {};  // { "JCBデビット": 8000 }
      const businessTotals = {}; // { "えんがわ": 7860 }
      const recentItems = [];
      const personalItems = []; // プライベート・不明の明細
      let totalExpense = 0;
      let personalTotal = 0; // プライベート支出合計
      let grandTotal = 0; // 全期間の事業経費合計（フィルター関係なく）

      for (const row of dataRows) {
        const date = row[0] || "";
        const store = row[1] || "";
        const amount = parseInt(String(row[2]).replace(/,/g, "")) || 0;
        const account = row[4] || "";
        const payment = row[6] || "不明";
        const memo = row[7] || "";
        const tag = row[10] || "";

        if (!date || amount === 0) continue;

        const monthKey = date.slice(0, 7);

        // プライベート・不明は事業経費から除外（ただし個人支出として別集計）
        if (tag === "プライベート" || tag === "不明") {
          if (!filterMonth || monthKey === filterMonth) {
            personalTotal += amount;
            personalItems.push({ date, account, amount, memo: store || memo, tag, payment });
          }
          continue;
        }

        // 全期間合計（フィルター前）
        grandTotal += amount;

        // 事業フィルター
        if (filterBusiness && tag !== filterBusiness) continue;

        totalExpense += amount;

        // 月別集計
        monthlyTotals[monthKey] = (monthlyTotals[monthKey] || 0) + amount;

        // 月フィルター（カテゴリ・支払方法・明細は選択月のみ）
        if (filterMonth && monthKey !== filterMonth) continue;

        // カテゴリ別集計
        categoryTotals[account] = (categoryTotals[account] || 0) + amount;

        // 事業別集計
        if (tag) businessTotals[tag] = (businessTotals[tag] || 0) + amount;

        // 支払方法別集計（レシート原本の実データを使用）
        paymentTotals[payment] = (paymentTotals[payment] || 0) + amount;

        // 直近の明細（最大20件、新しい順）
        recentItems.push({ date, account, amount, memo: store || memo, tag, payment });
      }

      // 直近20件（配列の末尾が新しい）
      const recent = recentItems.slice(-20).reverse();

      // 対象月の支出
      const now = new Date();
      const currentMonthKey = filterMonth || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const thisMonthTotal = monthlyTotals[currentMonthKey] || 0;

      // 前月の支出
      const [targetY, targetM] = currentMonthKey.split("-").map(Number);
      const prevMonth = targetM === 1 ? `${targetY - 1}-12` : `${targetY}-${String(targetM - 1).padStart(2, "0")}`;
      const lastMonthTotal = monthlyTotals[prevMonth] || 0;

      // 日別平均
      let dayOfMonth, daysInMonth;
      if (filterMonth) {
        daysInMonth = new Date(targetY, targetM, 0).getDate();
        const isCurrentMonth = currentMonthKey === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        dayOfMonth = isCurrentMonth ? now.getDate() : daysInMonth;
      } else {
        dayOfMonth = now.getDate();
        daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      }
      const dailyAvg = dayOfMonth > 0 ? Math.round(thisMonthTotal / dayOfMonth) : 0;

      // 月末予測
      const projectedTotal = Math.round(dailyAvg * daysInMonth);

      const responseData = {
        thisMonth: { total: thisMonthTotal, key: currentMonthKey, dailyAvg, projectedTotal, daysInMonth, dayOfMonth },
        lastMonth: { total: lastMonthTotal, key: prevMonth },
        totalExpense,
        grandTotal,
        monthlyTotals,
        categoryTotals,
        paymentTotals,
        businessTotals,
        recent,
        personal: { total: personalTotal, items: personalItems.slice(-10).reverse() },
        recordCount: dataRows.length,
        availableMonths: Array.from(availableMonths).sort().reverse(),
        availableBusinesses: Array.from(availableBusinesses).sort(),
        filters: { month: filterMonth, business: filterBusiness },
      };

      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify(responseData));

      // 統合DBにも経費データを流し込み（バックグラウンド）
      try {
        const unifiedDb = require("./unified-db");
        for (const row of dataRows) {
          const date = row[0] || "";
          const store = row[1] || "";
          const amount = parseInt(String(row[2]).replace(/,/g, "")) || 0;
          const account = row[4] || "";
          const payment = row[6] || "";
          const tag = row[10] || "";
          if (!date || amount === 0 || tag === "プライベート") continue;
          const id = `receipt_${date}_${(store || account).slice(0, 30).replace(/[^a-zA-Z0-9\u3040-\u9FFF]/g, "_")}`;
          await unifiedDb.upsertTransaction({
            id,
            date,
            amount: -Math.abs(amount),
            category: account,
            business: tag || null,
            source: "receipt",
            memo: store || account,
            payment_method: payment || null,
          });
        }
        console.log(`[finance→unified] ${dataRows.filter(r => r[0] && parseInt(r[2]) && r[10] !== "プライベート").length}件の経費を統合DBに同期`);
      } catch (syncErr) {
        console.error("[finance→unified] 同期エラー:", syncErr.message);
      }
    } catch (e) {
      console.error("Finance API error:", e.message);
      res.writeHead(500, corsHeaders);
      res.end(JSON.stringify({ error: "Failed to fetch finance data" }));
    }
    })();
  } else if (req.method === "GET" && pathname === "/api/vapid-public-key") {
    const corsHeaders = { "Access-Control-Allow-Origin": req.headers["origin"] || "*", "Content-Type": "application/json" };
    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ publicKey: env.VAPID_PUBLIC_KEY }));
  } else if (req.method === "POST" && pathname === "/api/push-subscribe") {
    const corsHeaders = { "Access-Control-Allow-Origin": req.headers["origin"] || "*", "Content-Type": "application/json" };
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const { subscription, token } = JSON.parse(Buffer.concat(chunks).toString());
        if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        const subs = loadSubscriptions();
        const exists = subs.some(s => s.endpoint === subscription.endpoint);
        if (!exists) {
          subs.push(subscription);
          saveSubscriptions(subs);
          console.log(`[${new Date().toISOString()}] Push subscription added (total: ${subs.length})`);
        }
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, corsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  // ========== POST /api/push-briefing — ブリーフィングをPWA Push通知で送信 ==========
  } else if (req.method === "POST" && pathname === "/api/push-briefing") {
    const corsHeaders = { "Access-Control-Allow-Origin": req.headers["origin"] || "*", "Content-Type": "application/json" };
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const { token, title, body } = JSON.parse(Buffer.concat(chunks).toString());
        if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        // ブリーフィング本文が長い場合は通知用に短縮
        const shortBody = body.length > 200 ? body.slice(0, 200) + "..." : body;
        await sendWebPush(title || "しらたま", shortBody);
        console.log(`[${new Date().toISOString()}] Briefing push sent`);
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  // ========== GET /api/daily-briefing — 今日のスキャン結果（提案・タスク更新）を返す ==========
  } else if (req.method === "GET" && req.url?.startsWith("/api/daily-briefing")) {
    const corsHeaders = { "Access-Control-Allow-Origin": req.headers["origin"] || "*", "Content-Type": "application/json" };
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qToken = urlObj.searchParams.get("token");
    if (qToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    try {
      const scanFile = path.join(__dirname, "..", "logs", ".daily-scan.json");
      if (fs.existsSync(scanFile)) {
        const data = JSON.parse(fs.readFileSync(scanFile, "utf-8"));
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify(data));
      } else {
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ calendar_suggestions: [], task_updates: [], date: null }));
      }
    } catch (e) {
      res.writeHead(500, corsHeaders);
      res.end(JSON.stringify({ error: e.message }));
    }
  // ========== POST /api/calendar-suggestion — カレンダー提案を承認/却下 ==========
  } else if (req.method === "POST" && pathname === "/api/calendar-suggestion") {
    const corsHeaders = { "Access-Control-Allow-Origin": req.headers["origin"] || "*", "Content-Type": "application/json" };
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const { token, suggestion, action } = JSON.parse(Buffer.concat(chunks).toString());
        if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        if (action === "approve" && suggestion) {
          // Google Calendar に登録
          const calendarId = "primary";
          const startDateTime = suggestion.time
            ? `${suggestion.date}T${suggestion.time}:00`
            : `${suggestion.date}T09:00:00`;
          const durationMin = suggestion.duration_min || 60;
          // 時刻文字列を直接計算（タイムゾーン変換を避ける）
          const [startH, startM] = (suggestion.time || "09:00").split(":").map(Number);
          const totalMin = startH * 60 + startM + durationMin;
          const endH = String(Math.floor(totalMin / 60)).padStart(2, "0");
          const endM = String(totalMin % 60).padStart(2, "0");
          const endDateTime = `${suggestion.date}T${endH}:${endM}:00`;

          const event = {
            summary: suggestion.title,
            description: `[しらたま提案] ${suggestion.reason || ""}\n出典: ${suggestion.source || ""}`,
            start: suggestion.time
              ? { dateTime: startDateTime, timeZone: "Asia/Tokyo" }
              : { date: suggestion.date },
            end: suggestion.time
              ? { dateTime: endDateTime, timeZone: "Asia/Tokyo" }
              : { date: suggestion.date },
          };

          // Google Calendar API で登録
          const accessToken = await getGoogleAccessToken();
          const calData = await googleApiRequest(
            "POST",
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
            JSON.stringify(event),
            accessToken,
            "application/json"
          );
          console.log(`[${new Date().toISOString()}] Calendar event created: ${suggestion.title}`);

          // スキャン結果から提案を削除
          const scanFile = path.join(__dirname, "..", "logs", ".daily-scan.json");
          if (fs.existsSync(scanFile)) {
            const scan = JSON.parse(fs.readFileSync(scanFile, "utf-8"));
            scan.calendar_suggestions = (scan.calendar_suggestions || []).filter(
              s => s.title !== suggestion.title || s.date !== suggestion.date
            );
            fs.writeFileSync(scanFile, JSON.stringify(scan, null, 2));
          }

          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ success: true, eventId: calData.id }));
        } else if (action === "dismiss") {
          // スキャン結果から提案を削除のみ
          const scanFile = path.join(__dirname, "..", "logs", ".daily-scan.json");
          if (fs.existsSync(scanFile)) {
            const scan = JSON.parse(fs.readFileSync(scanFile, "utf-8"));
            scan.calendar_suggestions = (scan.calendar_suggestions || []).filter(
              s => s.title !== suggestion.title || s.date !== suggestion.date
            );
            fs.writeFileSync(scanFile, JSON.stringify(scan, null, 2));
          }
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(400, corsHeaders);
          res.end(JSON.stringify({ error: "Invalid action" }));
        }
      } catch (e) {
        console.error("Calendar suggestion error:", e);
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  // ========== POST /api/task-action — タスク更新を承認 ==========
  } else if (req.method === "POST" && pathname === "/api/task-action") {
    const corsHeaders = { "Access-Control-Allow-Origin": req.headers["origin"] || "*", "Content-Type": "application/json" };
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const { token, task_update, action } = JSON.parse(Buffer.concat(chunks).toString());
        if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        // スキャン結果から該当タスクを削除
        const scanFile = path.join(__dirname, "..", "logs", ".daily-scan.json");
        if (action === "acknowledge" && fs.existsSync(scanFile)) {
          const scan = JSON.parse(fs.readFileSync(scanFile, "utf-8"));
          scan.task_updates = (scan.task_updates || []).filter(
            t => t.title !== task_update.title || t.project !== task_update.project
          );
          fs.writeFileSync(scanFile, JSON.stringify(scan, null, 2));
        }

        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  // ========== POST /api/sync-airbnb-bookings — Airbnb予約メール→カレンダー同期 ==========
  } else if (req.method === "POST" && pathname === "/api/sync-airbnb-bookings") {
    const origin = req.headers["origin"] || "";
    const corsHeaders = { "Access-Control-Allow-Origin": origin, "Content-Type": "application/json" };
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { token } = JSON.parse(body || "{}");
        if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      } catch {
        res.writeHead(401, corsHeaders);
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      // 即レスポンス → バックグラウンドで同期
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ status: "syncing" }));

      (async () => {
        try {
          const gToken = await getGoogleAccessToken();
          const result = await syncAirbnbBookings(gToken);
          console.log(`Airbnb booking sync: ${result.synced} new, ${result.skipped} skipped`);
        } catch (e) {
          console.error("Airbnb booking sync error:", e.message);
        }
      })();
    });

  // ========== GET /api/bookings — えんがわ予約一覧 ==========
  } else if (req.method === "GET" && req.url?.startsWith("/api/bookings")) {
    const origin = req.headers["origin"] || "";
    const corsHeaders = { "Access-Control-Allow-Origin": origin, "Content-Type": "application/json" };
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qToken = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
    if (qToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    (async () => {
      try {
        const bookings = loadBookingsLog();
        // tombstone(status:"cancelled")化した予約はここでも除外する（バグ①修正の副作用対応:
        // 物理削除→論理削除に変えたことで、除外しないとキャンセル済み予約が売上予測に混入する）
        const activeBookings = bookings.filter(b => b.status !== "cancelled");
        // 今後の予約のみ（今日以降）
        const today = new Date().toISOString().split("T")[0];
        const upcoming = activeBookings.filter(b => b.checkin >= today).sort((a, b) => a.checkin.localeCompare(b.checkin));
        const totalUpcomingRevenue = upcoming.reduce((s, b) => s + (b.hostEarnings || 0), 0);
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ upcoming, totalUpcomingRevenue, totalBookings: activeBookings.length }));
      } catch (e) {
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    })();

  // ========== GET /api/engawa-revenue — えんがわ売上実績 ==========
  } else if (req.method === "GET" && req.url?.startsWith("/api/engawa-revenue")) {
    const origin = req.headers["origin"] || "";
    const corsHeaders = { "Access-Control-Allow-Origin": origin, "Content-Type": "application/json" };
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qToken = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
    if (qToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    (async () => {
      try {
        const gToken = await getGoogleAccessToken();
        const ENGAWA_SHEET_ID = "1DsxV5PQT3Uj13UIOxCZAiOQhL2eZ1mmYKCy2040l5ng";
        const allRows = [];

        // 宿泊者名簿シートから個別予約データを取得
        // カラム: A=タイムスタンプ, B=氏名, F=チェックイン日, K=Room, O=滞在日数, P=滞在人数, Q=延べ人数, R=支払金額, S=入金額
        const nameboUrl = `https://sheets.googleapis.com/v4/spreadsheets/${ENGAWA_SHEET_ID}/values/${encodeURIComponent("宿泊者名簿!A2:S1000")}`;
        const nameboResult = await googleApiRequest("GET", nameboUrl, null, gToken);

        if (nameboResult.values) {
          for (const row of nameboResult.values) {
            const checkin = row[5] || ""; // F: チェックイン日 (e.g. "2025/08/10")
            const amountStr = (row[17] || "0").toString().replace(/[,¥￥\s]/g, "");
            const incomeStr = (row[18] || "0").toString().replace(/[,¥￥\s]/g, "");
            const amount = parseInt(amountStr, 10);
            const income = parseInt(incomeStr, 10);
            const room = row[10] || ""; // K: Room (UME/HIBA)
            if (!checkin || isNaN(amount) || amount === 0) continue;
            allRows.push({ checkin, amount, income: isNaN(income) ? 0 : income, room });
          }
        }

        // 月別集計
        const monthly = {};
        for (const r of allRows) {
          const m = r.checkin.slice(0, 7).replace(/\//g, "-"); // "2025-08"
          if (!monthly[m]) monthly[m] = { amount: 0, income: 0, stays: 0 };
          monthly[m].amount += r.amount;
          monthly[m].income += r.income;
          monthly[m].stays += 1;
        }

        // 今月の集計
        const now = new Date();
        const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const thisMonthData = monthly[thisMonth] || { amount: 0, income: 0, stays: 0 };

        // 全期間合計
        const total = allRows.reduce((acc, r) => ({ amount: acc.amount + r.amount, income: acc.income + r.income, stays: acc.stays + 1 }), { amount: 0, income: 0, stays: 0 });

        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({
          thisMonth: { month: thisMonth, ...thisMonthData },
          monthly: Object.entries(monthly).sort().map(([month, data]) => ({ month, ...data })),
          total,
        }));
      } catch (e) {
        console.error("Engawa revenue error:", e.message);
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    })();

  // ========== POST /api/expense-memo — ワンタップ経費メモ ==========
  } else if (req.method === "POST" && pathname === "/api/expense-memo") {
    const origin = req.headers["origin"] || "";
    const corsHeaders = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { token, text, business } = JSON.parse(body);
        if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        if (!text || typeof text !== "string") {
          res.writeHead(400, corsHeaders);
          res.end(JSON.stringify({ error: "text is required" }));
          return;
        }

        // 事業カテゴリ（タグ列に記録）
        const validBusinesses = ["えんがわ", "となりにとまる", "三十日珈琲", "SATOYAMA AI BASE", "共通", "プライベート"];
        const bizTag = validBusinesses.includes(business) ? business : "共通";

        // テキストから金額・支払方法・メモを抽出
        const amountMatch = text.match(/(\d[\d,]+)\s*円?/);
        if (!amountMatch) {
          res.writeHead(400, corsHeaders);
          res.end(JSON.stringify({ error: "金額が見つかりません" }));
          return;
        }
        const amount = parseInt(amountMatch[1].replace(/,/g, ""), 10);

        const paymentKeywords = ["現金", "PayPay", "JCBデビット", "Mastercardデビット"];
        let payment = "JCBデビット"; // デフォルト
        for (const kw of paymentKeywords) {
          if (text.includes(kw)) { payment = kw; break; }
        }

        // メモ: 金額と支払方法を除いた残り
        let memo = text
          .replace(/(\d[\d,]+)\s*円?/, "")
          .replace(/現金|PayPay|JCBデビット|Mastercardデビット/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (!memo) memo = "経費メモ";

        // 日付 (Asia/Tokyo)
        const now = new Date();
        const jstDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
        const date = `${jstDate.getFullYear()}/${String(jstDate.getMonth() + 1).padStart(2, "0")}/${String(jstDate.getDate()).padStart(2, "0")}`;

        // Google Sheets に追記
        (async () => {
          try {
            const gToken = await getGoogleAccessToken();
            // MF仕訳帳: A=日付, B=借方勘定科目, C=借方補助科目, D=借方部門, E=借方金額, F=借方税区分, G=貸方勘定科目, H=貸方補助科目, I=貸方部門, J=摘要, K=仕訳メモ, L=タグ, M=MF仕訳タイプ, N=決算整理仕訳
            await appendToSheet(env.GOOGLE_EXPENSE_SHEET_ID, "MF仕訳帳", [
              date, "消耗品費", "", "", amount, "対象外", "", payment, "", memo, "", bizTag, "", "",
            ], gToken);
            console.log(`[${new Date().toISOString()}] Expense memo: ${memo} ${amount}円 (${payment}) [${bizTag}]`);
            res.writeHead(200, corsHeaders);
            res.end(JSON.stringify({ success: true, amount, memo, payment, date, business: bizTag }));
          } catch (e) {
            console.error("Expense memo Sheets error:", e.message);
            res.writeHead(500, corsHeaders);
            res.end(JSON.stringify({ error: "スプレッドシートへの書き込みに失敗しました" }));
          }
        })();
      } catch (e) {
        res.writeHead(400, corsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  // ========== POST /api/condition — 体調記録 ==========
  } else if (req.method === "POST" && pathname === "/api/condition") {
    const origin = req.headers["origin"] || "";
    const corsHeaders = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { token, score, note } = JSON.parse(body);
        if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        if (!score || score < 1 || score > 5 || !Number.isInteger(score)) {
          res.writeHead(400, corsHeaders);
          res.end(JSON.stringify({ error: "score must be an integer between 1 and 5" }));
          return;
        }

        const conditionFile = path.join(REPO_DIR, "logs", "condition.json");
        let entries = [];
        try { entries = JSON.parse(fs.readFileSync(conditionFile, "utf-8")); } catch {}

        const now = new Date();
        const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
        const dateStr = `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, "0")}-${String(jst.getDate()).padStart(2, "0")}`;
        const timeStr = `${String(jst.getHours()).padStart(2, "0")}:${String(jst.getMinutes()).padStart(2, "0")}`;

        entries.push({ date: dateStr, time: timeStr, score, note: note || "" });

        // 最大365件保持
        if (entries.length > 365) entries.splice(0, entries.length - 365);
        fs.writeFileSync(conditionFile, JSON.stringify(entries, null, 2));

        console.log(`[${new Date().toISOString()}] Condition logged: score=${score} note="${note || ""}"`);
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ success: true, date: dateStr, time: timeStr, score, note: note || "" }));
      } catch (e) {
        res.writeHead(400, corsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  // ========== GET /api/condition — 体調履歴取得 ==========
  } else if (req.method === "GET" && req.url?.startsWith("/api/condition")) {
    const origin = req.headers["origin"] || "";
    const corsHeaders = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };

    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qToken = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
    if (qToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const days = parseInt(urlObj.searchParams.get("days") || "30", 10);
    const conditionFile = path.join(REPO_DIR, "logs", "condition.json");
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(conditionFile, "utf-8")); } catch {}

    // 直近N日分をフィルタ
    const now = new Date();
    const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    const cutoff = new Date(jst);
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;

    const filtered = entries.filter(e => e.date >= cutoffStr);
    const average = filtered.length > 0
      ? Math.round((filtered.reduce((sum, e) => sum + e.score, 0) / filtered.length) * 10) / 10
      : 0;

    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ entries: filtered, average }));

  // ========== GET /api/habits — 習慣トラッキング取得 ==========
  } else if (req.method === "GET" && req.url?.startsWith("/api/habits")) {
    const origin = req.headers["origin"] || "";
    const corsHeaders = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };

    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qToken = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
    if (qToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const now = new Date();
    const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    const dateStr = `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, "0")}-${String(jst.getDate()).padStart(2, "0")}`;
    const habits = loadHabits(dateStr);
    // 各習慣のstreak計算
    const items = habits.items.map(h => ({ ...h, streak: getStreak(h.id) }));

    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ date: habits.date, items }));

  // ========== POST /api/habits — 習慣トグル ==========
  } else if (req.method === "POST" && pathname === "/api/habits") {
    const origin = req.headers["origin"] || "";
    const corsHeaders = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const urlObj = new URL(req.url, `http://localhost:${PORT}`);
      const qToken = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
      if (qToken !== env.SHIRATAMA_API_TOKEN) {
        res.writeHead(401, corsHeaders);
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      try {
        const { id, done } = JSON.parse(body);
        const now = new Date();
        const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
        const dateStr = `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, "0")}-${String(jst.getDate()).padStart(2, "0")}`;
        const habits = loadHabits(dateStr);
        const item = habits.items.find(h => h.id === id);
        if (!item) {
          res.writeHead(404, corsHeaders);
          res.end(JSON.stringify({ error: "Habit not found" }));
          return;
        }
        item.done = typeof done === "boolean" ? done : !item.done;
        saveHabits(dateStr, habits);
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ ok: true, item: { ...item, streak: getStreak(item.id) } }));
      } catch (e) {
        res.writeHead(400, corsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  // ========== GET /api/templates — 定型文テンプレート取得 ==========
  } else if (req.method === "GET" && req.url?.startsWith("/api/templates") && !req.url?.startsWith("/api/templates/")) {
    const origin = req.headers["origin"] || "";
    const corsHeaders = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };

    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qToken = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
    if (qToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      const templatesFile = path.join(REPO_DIR, "config", "templates.json");
      const templates = JSON.parse(fs.readFileSync(templatesFile, "utf-8"));
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ templates }));
    } catch (e) {
      console.error("Templates read error:", e.message);
      res.writeHead(500, corsHeaders);
      res.end(JSON.stringify({ error: "テンプレートの読み込みに失敗しました" }));
    }

  // ========== POST /api/templates/use — テンプレート使用（変数置換） ==========
  } else if (req.method === "POST" && pathname === "/api/templates/use") {
    const origin = req.headers["origin"] || "";
    const corsHeaders = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { token, id, variables } = JSON.parse(body);
        if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        if (!id) {
          res.writeHead(400, corsHeaders);
          res.end(JSON.stringify({ error: "id is required" }));
          return;
        }

        const templatesFile = path.join(REPO_DIR, "config", "templates.json");
        const templates = JSON.parse(fs.readFileSync(templatesFile, "utf-8"));
        const template = templates.find(t => t.id === id);

        if (!template) {
          res.writeHead(404, corsHeaders);
          res.end(JSON.stringify({ error: `Template "${id}" not found` }));
          return;
        }

        let text = template.template || template.text;
        if (variables && typeof variables === "object") {
          for (const [key, value] of Object.entries(variables)) {
            text = text.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
          }
        }

        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ text }));
      } catch (e) {
        res.writeHead(400, corsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  // ========== GET /api/engawa-calendar — えんがわ予約状況 ==========
  } else if (req.method === "GET" && req.url?.startsWith("/api/engawa-calendar")) {
    const origin = req.headers["origin"] || "";
    const corsHeaders = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };

    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qToken = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
    if (qToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, corsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    (async () => {
      try {
        const gToken = await getGoogleAccessToken();
        const now = new Date();
        const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
        const thisYear = jst.getFullYear();
        const thisMonth = jst.getMonth(); // 0-indexed
        const nextMonth = thisMonth + 1;

        // 今月の開始・終了
        const thisMonthStart = new Date(thisYear, thisMonth, 1);
        const thisMonthEnd = new Date(thisYear, thisMonth + 1, 0);
        const thisMonthDays = thisMonthEnd.getDate();

        // 来月の開始・終了
        const nextMonthStart = new Date(thisYear, nextMonth, 1);
        const nextMonthEnd = new Date(thisYear, nextMonth + 1, 0);
        const nextMonthDays = nextMonthEnd.getDate();

        // 180日カウント用: 1月1日〜今日
        const yearStart = new Date(thisYear, 0, 1);

        const calendarIds = {
          hiba: "q6egg73q6ka263u3no3t04f0mvgtr249@import.calendar.google.com",
          ume: "coup51h4rn6uuuk9ausllt2etpc6i8a5@import.calendar.google.com",
        };

        async function fetchEvents(calId, timeMin, timeMax) {
          const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=250`;
          try {
            const result = await googleApiRequest("GET", url, null, gToken);
            return (result.items || []).filter(ev => ev.status !== "cancelled");
          } catch (e) {
            console.error(`Engawa calendar fetch error (${calId}):`, e.message);
            return [];
          }
        }

        function parseBookings(events, room) {
          return events.map(ev => ({
            start: ev.start.dateTime || ev.start.date,
            end: ev.end.dateTime || ev.end.date,
            summary: ev.summary || "(予約)",
            room,
          }));
        }

        function countBookedDays(events, monthStart, monthEnd) {
          const bookedDates = new Set();
          for (const ev of events) {
            const start = new Date(ev.start.dateTime || ev.start.date);
            const end = new Date(ev.end.dateTime || ev.end.date);
            // 終日イベントの場合、endは翌日の00:00なので1日引く
            const endAdj = ev.start.date ? new Date(end.getTime() - 86400000) : end;
            const cur = new Date(Math.max(start.getTime(), monthStart.getTime()));
            const last = new Date(Math.min(endAdj.getTime(), monthEnd.getTime()));
            while (cur <= last) {
              bookedDates.add(cur.toISOString().slice(0, 10));
              cur.setDate(cur.getDate() + 1);
            }
          }
          return bookedDates.size;
        }

        // 各カレンダーからイベント取得
        const thisMonthTimeMin = thisMonthStart.toISOString();
        const thisMonthTimeMax = new Date(thisYear, thisMonth + 1, 1).toISOString();
        const nextMonthTimeMin = nextMonthStart.toISOString();
        const nextMonthTimeMax = new Date(thisYear, nextMonth + 1, 1).toISOString();
        const yearTimeMin = yearStart.toISOString();
        const yearTimeMax = new Date(jst.getFullYear(), jst.getMonth(), jst.getDate() + 1).toISOString();

        // 並列取得
        const [hibaThisMonth, hibaNextMonth, hibaYear, umeThisMonth, umeNextMonth, umeYear] = await Promise.all([
          fetchEvents(calendarIds.hiba, thisMonthTimeMin, thisMonthTimeMax),
          fetchEvents(calendarIds.hiba, nextMonthTimeMin, nextMonthTimeMax),
          fetchEvents(calendarIds.hiba, yearTimeMin, yearTimeMax),
          fetchEvents(calendarIds.ume, thisMonthTimeMin, thisMonthTimeMax),
          fetchEvents(calendarIds.ume, nextMonthTimeMin, nextMonthTimeMax),
          fetchEvents(calendarIds.ume, yearTimeMin, yearTimeMax),
        ]);

        const hibaThisBookedDays = countBookedDays(hibaThisMonth, thisMonthStart, thisMonthEnd);
        const hibaNextBookedDays = countBookedDays(hibaNextMonth, nextMonthStart, nextMonthEnd);
        const hibaYearDays = countBookedDays(hibaYear, yearStart, jst);

        const umeThisBookedDays = countBookedDays(umeThisMonth, thisMonthStart, thisMonthEnd);
        const umeNextBookedDays = countBookedDays(umeNextMonth, nextMonthStart, nextMonthEnd);
        const umeYearDays = countBookedDays(umeYear, yearStart, jst);

        const result = {
          hiba: {
            thisMonth: {
              bookings: parseBookings(hibaThisMonth, "HIBA"),
              occupancyRate: Math.round((hibaThisBookedDays / thisMonthDays) * 100),
              bookedDays: hibaThisBookedDays,
            },
            nextMonth: {
              bookings: parseBookings(hibaNextMonth, "HIBA"),
              occupancyRate: Math.round((hibaNextBookedDays / nextMonthDays) * 100),
              bookedDays: hibaNextBookedDays,
            },
          },
          ume: {
            thisMonth: {
              bookings: parseBookings(umeThisMonth, "UME"),
              occupancyRate: Math.round((umeThisBookedDays / thisMonthDays) * 100),
              bookedDays: umeThisBookedDays,
            },
            nextMonth: {
              bookings: parseBookings(umeNextMonth, "UME"),
              occupancyRate: Math.round((umeNextBookedDays / nextMonthDays) * 100),
              bookedDays: umeNextBookedDays,
            },
          },
          yearTotal180: {
            hiba: hibaYearDays,
            ume: umeYearDays,
            combined: hibaYearDays + umeYearDays,
            remaining: 180 - (hibaYearDays + umeYearDays),
          },
        };

        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error("Engawa calendar API error:", e.message);
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: "えんがわカレンダーの取得に失敗しました" }));
      }
    })();

  } else if (req.method === "GET" && req.url?.startsWith("/api/drive-files")) {
    // Google Drive ファイル一覧（folderId対応: フォルダナビゲーション）
    const corsHeaders = { "Access-Control-Allow-Origin": req.headers["origin"] || "*", "Content-Type": "application/json" };
    const urlParams = new (require("url").URL)(req.url, "http://localhost").searchParams;
    const token = urlParams.get("token");
    if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) { res.writeHead(401, corsHeaders); res.end(JSON.stringify({ error: "Unauthorized" })); return; }
    const folderId = urlParams.get("folderId"); // null = 最近のファイル表示、指定あり = そのフォルダの中身
    (async () => {
      try {
        const gToken = await getGoogleAccessToken();
        let driveUrl;
        if (folderId) {
          // 指定フォルダ内のファイル・フォルダを取得
          const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
          driveUrl = `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=folder,name&pageSize=50&fields=files(id,name,mimeType,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
        } else {
          // フォルダ未指定 = 最近更新されたドキュメント・スプレッドシート・スライド・PDF＋フォルダ
          const q = encodeURIComponent("mimeType='application/vnd.google-apps.document' or mimeType='application/vnd.google-apps.spreadsheet' or mimeType='application/vnd.google-apps.presentation' or mimeType='application/pdf' or mimeType='application/vnd.google-apps.folder'");
          driveUrl = `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime+desc&pageSize=30&fields=files(id,name,mimeType,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
        }
        const result = await googleApiRequest("GET", driveUrl, null, gToken);
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ files: result.files || [] }));
      } catch (e) {
        console.error("Drive files error:", e.message);
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
  } else if (req.method === "GET" && req.url?.startsWith("/api/drive-read")) {
    // Google Drive ファイル内容取得
    const corsHeaders = { "Access-Control-Allow-Origin": req.headers["origin"] || "*", "Content-Type": "application/json" };
    const urlParams = new (require("url").URL)(req.url, "http://localhost").searchParams;
    const token = urlParams.get("token");
    const fileId = urlParams.get("fileId");
    if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) { res.writeHead(401, corsHeaders); res.end(JSON.stringify({ error: "Unauthorized" })); return; }
    if (!fileId) { res.writeHead(400, corsHeaders); res.end(JSON.stringify({ error: "fileId required" })); return; }
    (async () => {
      try {
        const gToken = await getGoogleAccessToken();
        // まずファイルのmimeTypeを確認
        const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`;
        const meta = await googleApiRequest("GET", metaUrl, null, gToken);
        let content = "";
        if (meta.mimeType === "application/vnd.google-apps.document") {
          // Google Docs → text/plain でエクスポート
          const exportUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text%2Fplain`;
          content = await googleApiRequest("GET", exportUrl, null, gToken);
          if (Buffer.isBuffer(content)) content = content.toString("utf-8");
        } else if (meta.mimeType === "application/vnd.google-apps.spreadsheet") {
          // Google Sheets → text/csv でエクスポート
          const exportUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text%2Fcsv`;
          content = await googleApiRequest("GET", exportUrl, null, gToken);
          if (Buffer.isBuffer(content)) content = content.toString("utf-8");
        } else if (meta.mimeType === "application/vnd.google-apps.presentation") {
          // Google Slides → text/plain でエクスポート
          const exportUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text%2Fplain`;
          content = await googleApiRequest("GET", exportUrl, null, gToken);
          if (Buffer.isBuffer(content)) content = content.toString("utf-8");
        } else {
          // その他（PDF等）→ ダウンロードしてテキスト抽出試行
          const dlUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
          const raw = await googleApiRequest("GET", dlUrl, null, gToken);
          content = typeof raw === "string" ? raw : (Buffer.isBuffer(raw) ? raw.toString("utf-8") : JSON.stringify(raw));
          content = content.slice(0, 8000); // PDF等は先頭部分のみ
        }
        // 長すぎる場合はトリミング
        if (typeof content === "string" && content.length > 20000) {
          content = content.slice(0, 20000) + "\n\n（以下省略: 長すぎるため先頭20000文字のみ）";
        }
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ content, filename: meta.name, mimeType: meta.mimeType }));
      } catch (e) {
        console.error("Drive read error:", e.message);
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
  // ========== GET /api/sns-drafts — SNS投稿案の取得 ==========
  // ?account=ryosuke_ina  特定アカウント
  // ?date=2026-03-11      特定日付
  // パラメータなし → 全アカウントの最新
  } else if (req.method === "GET" && req.url?.startsWith("/api/sns-drafts")) {
    const snsCorsHeaders = { "Access-Control-Allow-Origin": req.headers["origin"] || "*", "Content-Type": "application/json" };
    const params = new URL(req.url, "http://localhost").searchParams;
    const account = params.get("account");
    const date = params.get("date");
    const draftsDir = path.join(REPO_DIR, "logs", ".sns-drafts");

    try {
      if (!fs.existsSync(draftsDir)) {
        res.writeHead(200, snsCorsHeaders);
        res.end(JSON.stringify({ drafts: [], message: "No drafts yet" }));
        return;
      }

      const files = fs.readdirSync(draftsDir).filter(f => f.endsWith(".json") && !f.startsWith("summary"));
      const drafts = [];

      for (const file of files) {
        const match = file.match(/^(.+?)-(latest|\d{4}-\d{2}-\d{2})\.json$/);
        if (!match) continue;
        const fileAccount = match[1];
        const fileDate = match[2];

        if (account && fileAccount !== account) continue;
        if (date && fileDate !== date && fileDate !== "latest") continue;
        if (!date && fileDate !== "latest") continue; // デフォルトは latest のみ

        try {
          const data = JSON.parse(fs.readFileSync(path.join(draftsDir, file), "utf-8"));
          drafts.push({ file, account: fileAccount, date: fileDate, ...data });
        } catch {}
      }

      res.writeHead(200, snsCorsHeaders);
      res.end(JSON.stringify({ drafts }));
    } catch (e) {
      res.writeHead(500, snsCorsHeaders);
      res.end(JSON.stringify({ error: e.message }));
    }

  // ========== POST /api/sns-generate — SNS投稿案を生成（非同期） ==========
  } else if (req.method === "POST" && pathname === "/api/sns-generate") {
    const snsGenCorsHeaders = { "Access-Control-Allow-Origin": req.headers["origin"] || "*", "Content-Type": "application/json" };
    const bodyChunks = [];
    req.on("data", chunk => bodyChunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(bodyChunks).toString();
        const { token, account, theme, photoDescription, photo } = JSON.parse(body);
        if ((token || qToken) !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(403, snsGenCorsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        res.writeHead(202, snsGenCorsHeaders);
        res.end(JSON.stringify({ status: "generating", account: account || "all" }));

        // 写真が添付されている場合、ファイルに保存
        let photoPath = "";
        if (photo) {
          try {
            const photoBuffer = Buffer.from(photo, "base64");
            photoPath = `/tmp/sns-photo-${Date.now()}.jpg`;
            require("fs").writeFileSync(photoPath, photoBuffer);
            console.log(`Saved photo: ${photoPath} (${(photoBuffer.length / 1024).toFixed(0)}KB)`);
          } catch (e) {
            console.error("Failed to save photo:", e.message);
          }
        }

        // バックグラウンドで生成
        const scriptPath = path.join(__dirname, "sns-generate.sh");
        const args = [];
        if (account) args.push(account);
        // テーマ or 写真説明をコンテキストとして渡す
        let extraContext = "";
        if (theme) extraContext += `テーマ指定: ${theme}\n`;
        if (photoDescription) extraContext += `写真の補足説明: ${photoDescription}\n`;

        const envVars = {
          ...process.env,
          PATH: "/Users/Inaryo/.local/share/mise/installs/node/24.14.0/bin:/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        };
        if (extraContext) envVars.EXTRA_CONTEXT = extraContext;
        if (photoPath) envVars.PHOTO_PATH = photoPath;

        const cmd = `bash "${scriptPath}" ${args.join(" ")}`;
        const child = require("child_process").exec(cmd, {
          cwd: REPO_DIR,
          timeout: 600000,
          env: envVars,
        });
        child.on("close", (code) => {
          console.log(`sns-generate ${account || "all"} exited with code ${code}`);
          // 写真の一時ファイルを削除
          if (photoPath) {
            try { require("fs").unlinkSync(photoPath); } catch {}
          }
          sendWebPush(
            "SNS投稿案が完成しました",
            `@${account || "全アカウント"} の投稿案を生成しました。しらたまで確認してください。`
          );
        });
      } catch (e) {
        res.writeHead(400, snsGenCorsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  // ========== GET /api/dx-cases — DX案件一覧 ==========
  } else if (req.method === "GET" && pathname === "/api/dx-cases") {
    const dxCorsHeaders = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qToken = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
    if (qToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, dxCorsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      const hearingDir = path.join(REPO_DIR, "data", "dx-hearing");
      const proposalDir = path.join(hearingDir, "proposals");
      const cases = [];

      if (fs.existsSync(hearingDir)) {
        const files = fs.readdirSync(hearingDir).filter(f => f.endsWith(".json") && !f.includes("-status.json"));
        for (const file of files) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(hearingDir, file), "utf-8"));
            const caseId = file.match(/^(DX-[0-9]+-[a-zA-Z0-9_]+)/)?.[1] || file.replace(".json", "");

            // 提案書の存在チェック
            const proposalFiles = fs.existsSync(proposalDir)
              ? fs.readdirSync(proposalDir).filter(f => f.startsWith(caseId) && f.endsWith(".md"))
              : [];
            const hasProposal = proposalFiles.length > 0;

            // 提案書から金額抽出
            let estimatedAmount = null;
            if (hasProposal) {
              const proposalContent = fs.readFileSync(path.join(proposalDir, proposalFiles[0]), "utf-8");
              estimatedAmount = extractEstimateFromProposal(proposalContent);
            }

            // ステータスファイルがあれば読む、なければ推定
            const statusFile = path.join(hearingDir, `${caseId}-status.json`);
            let status = "問い合わせ";
            let deployUrl = null;
            let statusCaseType = null;
            if (fs.existsSync(statusFile)) {
              const sd = JSON.parse(fs.readFileSync(statusFile, "utf-8"));
              status = sd.status || status;
              deployUrl = sd.deployUrl || null;
              statusCaseType = sd.caseType || null;
            } else if (hasProposal) {
              status = "提案中";
            }

            const stat = fs.statSync(path.join(hearingDir, file));
            cases.push({
              caseId,
              name: data.name || "不明",
              company: data.company || "",
              consultationType: data.consultation_type || "",
              prefecture: data.prefecture || "",
              industry: data.industry || "",
              budget: data.budget || "",
              deadline: data.deadline || "",
              status,
              hasProposal,
              estimatedAmount,
              deployUrl,
              caseType: statusCaseType || classifyCaseType(data.consultation_type),
              createdAt: stat.birthtime || stat.mtime,
            });
          } catch (e) {
            console.error(`[DX Cases] Error reading ${file}:`, e.message);
          }
        }
      }

      // 新しい順にソート
      cases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      res.writeHead(200, dxCorsHeaders);
      res.end(JSON.stringify({ cases }));
    } catch (e) {
      res.writeHead(500, dxCorsHeaders);
      res.end(JSON.stringify({ error: e.message }));
    }

  // ========== GET /api/dx-cases/:caseId — DX案件詳細 ==========
  } else if (req.method === "GET" && pathname.startsWith("/api/dx-cases/") && pathname.split("/").length === 4) {
    const dxCorsHeaders = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qToken = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
    if (qToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, dxCorsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      const caseId = decodeURIComponent(pathname.split("/")[3]);
      const hearingDir = path.join(REPO_DIR, "data", "dx-hearing");
      const proposalDir = path.join(hearingDir, "proposals");

      // JSONファイルを探す
      const jsonFiles = fs.readdirSync(hearingDir).filter(f => f.startsWith(caseId) && f.endsWith(".json") && !f.includes("-status.json"));
      if (jsonFiles.length === 0) {
        res.writeHead(404, dxCorsHeaders);
        res.end(JSON.stringify({ error: "Case not found" }));
        return;
      }

      const hearing = JSON.parse(fs.readFileSync(path.join(hearingDir, jsonFiles[0]), "utf-8"));

      // 提案書を読む
      let proposal = null;
      if (fs.existsSync(proposalDir)) {
        const proposalFiles = fs.readdirSync(proposalDir).filter(f => f.startsWith(caseId) && f.endsWith(".md"));
        if (proposalFiles.length > 0) {
          proposal = fs.readFileSync(path.join(proposalDir, proposalFiles[0]), "utf-8");
        }
      }

      // ステータス
      const statusFile = path.join(hearingDir, `${caseId}-status.json`);
      let statusData = { status: proposal ? "提案中" : "問い合わせ" };
      if (fs.existsSync(statusFile)) {
        statusData = JSON.parse(fs.readFileSync(statusFile, "utf-8"));
      }

      // 案件タイプ
      const caseType = statusData.caseType || classifyCaseType(hearing.consultation_type);

      // 成果物ドキュメントの取得（プロジェクトディレクトリが存在する場合）
      const projectDir = path.join(DX_PROJECTS_DIR, caseId);
      let deliverables = {};
      if (fs.existsSync(projectDir)) {
        const docsDir = path.join(projectDir, "docs");
        if (fs.existsSync(docsDir)) {
          for (const docFile of fs.readdirSync(docsDir).filter(f => f.endsWith(".md"))) {
            const key = docFile.replace(".md", "").toLowerCase().replace(/-/g, "_");
            deliverables[key] = fs.readFileSync(path.join(docsDir, docFile), "utf-8");
          }
        }
        // README.md
        const readmePath = path.join(projectDir, "README.md");
        if (fs.existsSync(readmePath)) {
          deliverables.readme = fs.readFileSync(readmePath, "utf-8");
        }
      }

      // 共有URL生成
      const sharePassword = statusData.sharePassword || null;
      const SHARE_BASE = "https://api.tonari2tomaru.com";
      const shareUrls = sharePassword ? {
        proposal: `${SHARE_BASE}/proposal/${encodeURIComponent(caseId)}?pass=${sharePassword}`,
        preview: statusData.deployUrl ? `${SHARE_BASE}/preview/${encodeURIComponent(caseId)}?pass=${sharePassword}` : null,
      } : null;

      res.writeHead(200, dxCorsHeaders);
      res.end(JSON.stringify({
        caseId,
        hearing,
        proposal,
        status: statusData.status,
        caseType,
        deployUrl: statusData.deployUrl || null,
        revisionNote: statusData.revisionNote || null,
        revisionHistory: statusData.revisionHistory || [],
        deliverables,
        hasProject: fs.existsSync(projectDir),
        shareUrls,
      }));
    } catch (e) {
      res.writeHead(500, dxCorsHeaders);
      res.end(JSON.stringify({ error: e.message }));
    }

  // ========== POST /api/dx-cases/:caseId/status — DX案件ステータス更新 ==========
  } else if (req.method === "POST" && pathname.match(/^\/api\/dx-cases\/[^/]+\/status$/)) {
    const dxCorsHeaders = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qToken = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
    if (qToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, dxCorsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let bodyChunks = [];
    req.on("data", (chunk) => bodyChunks.push(chunk));
    req.on("end", async () => {
      try {
        const caseId = decodeURIComponent(pathname.split("/")[3]);
        const body = JSON.parse(Buffer.concat(bodyChunks).toString());
        const hearingDir = path.join(REPO_DIR, "data", "dx-hearing");
        const statusFile = path.join(hearingDir, `${caseId}-status.json`);

        // 既存ステータスを読む or 新規作成
        let statusData = { status: "問い合わせ", revisionHistory: [] };
        if (fs.existsSync(statusFile)) {
          statusData = JSON.parse(fs.readFileSync(statusFile, "utf-8"));
        }

        // ステータス更新
        if (body.status) {
          statusData.status = body.status;
          statusData.updatedAt = new Date().toISOString();
        }
        if (body.deployUrl) {
          statusData.deployUrl = body.deployUrl;
        }
        if (body.revisionNote) {
          statusData.revisionNote = body.revisionNote;
          if (!statusData.revisionHistory) statusData.revisionHistory = [];
          statusData.revisionHistory.push({
            note: body.revisionNote,
            timestamp: new Date().toISOString(),
          });
        }

        fs.writeFileSync(statusFile, JSON.stringify(statusData, null, 2), "utf-8");
        console.log(`[DX Cases] Status updated: ${caseId} → ${statusData.status}`);

        // Notion側のステータスも更新（非同期）
        updateNotionDXStatus(caseId, statusData.status).catch(err => {
          console.error("[DX Cases] Notion status update failed:", err.message);
        });

        // GOサインの場合 → 自動実装パイプライン起動
        if (body.status === "GO済み") {
          // pushLineMessage(`🚀 DX案件GOサイン\n\n案件ID: ${caseId}\n→ 自動実装を開始します`); // LINE通知（ロールバック用）
          pushDiscordMessage(`🚀 DX案件GOサイン\n\n案件ID: ${caseId}\n→ 自動実装を開始します`);
          // 非同期で実装パイプラインを起動（レスポンスはすぐ返す）
          runDxImplementation(caseId).catch(err => {
            console.error(`[DX Impl] Pipeline error: ${err.message}`);
          });
        }

        // 修正依頼の場合 → 修正パイプライン起動
        if (body.status === "修正中" && body.revisionNote) {
          // pushLineMessage(`🔧 DX案件修正依頼\n\n案件ID: ${caseId}\n修正内容: ${body.revisionNote.substring(0, 100)}`); // LINE通知（ロールバック用）
          pushDiscordMessage(`🔧 DX案件修正依頼\n\n案件ID: ${caseId}\n修正内容: ${body.revisionNote.substring(0, 100)}`);
          runDxRevision(caseId, body.revisionNote).catch(err => {
            console.error(`[DX Revision] Pipeline error: ${err.message}`);
          });
        }

        res.writeHead(200, dxCorsHeaders);
        res.end(JSON.stringify({ success: true, ...statusData }));
      } catch (e) {
        res.writeHead(500, dxCorsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  // ========== DELETE /api/dx-cases/:caseId — DX案件削除 ==========
  } else if (req.method === "DELETE" && pathname.startsWith("/api/dx-cases/") && pathname.split("/").length === 4) {
    const dxCorsHeaders = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const qToken = urlObj.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");
    if (qToken !== env.SHIRATAMA_API_TOKEN) {
      res.writeHead(401, dxCorsHeaders);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      const caseId = decodeURIComponent(pathname.split("/")[3]);
      const hearingDir = path.join(REPO_DIR, "data", "dx-hearing");
      const proposalDir = path.join(hearingDir, "proposals");

      // JSONファイル削除
      const jsonFiles = fs.readdirSync(hearingDir).filter(f => f.startsWith(caseId) && f.endsWith(".json") && !f.endsWith("-status.json"));
      for (const f of jsonFiles) {
        fs.unlinkSync(path.join(hearingDir, f));
      }

      // ステータスファイル削除
      const statusFile = path.join(hearingDir, `${caseId}-status.json`);
      if (fs.existsSync(statusFile)) {
        fs.unlinkSync(statusFile);
      }

      // 提案書削除
      if (fs.existsSync(proposalDir)) {
        const proposalFiles = fs.readdirSync(proposalDir).filter(f => f.startsWith(caseId));
        for (const f of proposalFiles) {
          fs.unlinkSync(path.join(proposalDir, f));
        }
      }

      console.log(`[DX Cases] Deleted case: ${caseId}`);
      res.writeHead(200, dxCorsHeaders);
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, dxCorsHeaders);
      res.end(JSON.stringify({ error: e.message }));
    }

  // ========== POST /api/dx-hearing — DXヒアリング回答受信 → AI提案書自動生成 + LINE通知 (v2) ==========
  } else if (req.method === "POST" && pathname === "/api/dx-hearing") {
    const dxCorsHeaders = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    let bodyChunks = [];
    req.on("data", (chunk) => bodyChunks.push(chunk));
    req.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(bodyChunks).toString());
        console.log(`[${new Date().toISOString()}] DX Hearing v2 received: ${body.name} - ${body.consultation_type}`);

        // 1. データ保存
        const hearingDir = path.join(REPO_DIR, "data", "dx-hearing");
        const proposalDir = path.join(hearingDir, "proposals");
        if (!fs.existsSync(hearingDir)) fs.mkdirSync(hearingDir, { recursive: true });
        if (!fs.existsSync(proposalDir)) fs.mkdirSync(proposalDir, { recursive: true });

        const now = new Date();
        const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
        const uniqueId = (body.form_response_id || "").slice(0, 6) || Math.random().toString(36).slice(2, 8);
        const caseId = `DX-${dateStr}-${uniqueId}`;
        const safeName = (body.name || "unknown").replace(/[\/\\:*?"<>|]/g, "_");
        const jsonFile = path.join(hearingDir, `${caseId}-${safeName}-${dateStr}.json`);

        fs.writeFileSync(jsonFile, JSON.stringify(body, null, 2), "utf-8");
        console.log(`Saved hearing data: ${jsonFile}`);

        // 1.5. 既存サイトURLがあれば自動分析（提案書の精度UP）
        let siteAnalysis = null;
        const siteUrl = body.existing_site_url || body.existing_url || body.reference_url;
        if (siteUrl) {
          console.log(`[DX Hearing] 既存サイト分析中: ${siteUrl}`);
          siteAnalysis = await fetchAndAnalyzeSite(siteUrl);
          if (siteAnalysis) {
            body._siteAnalysis = siteAnalysis;
            console.log(`[DX Hearing] サイト分析完了: ${siteAnalysis.title || "タイトルなし"}`);
          }
        }

        // 2. Claude API で提案書生成（フォールバック付き）
        console.log(`[DX Hearing] Claude APIで提案書生成中... 案件: ${body.name}`);
        const proposal = await generateDXProposalV2(body);

        // 3. 提案書保存
        const proposalFile = path.join(proposalDir, `${caseId}-提案書.md`);
        fs.writeFileSync(proposalFile, proposal, "utf-8");
        console.log(`Generated AI proposal: ${proposalFile}`);

        // 3.5. 共有パスワード生成 & ステータス保存
        const sharePassword = crypto.randomBytes(4).toString("hex"); // 8文字のランダム英数字
        const statusFile = path.join(hearingDir, `${caseId}-status.json`);
        const initialStatus = {
          status: "提案中",
          caseType: classifyCaseType(body.consultation_type),
          sharePassword,
          updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(statusFile, JSON.stringify(initialStatus, null, 2), "utf-8");

        const SHARE_BASE = "https://api.tonari2tomaru.com";
        const proposalShareUrl = `${SHARE_BASE}/proposal/${encodeURIComponent(caseId)}?pass=${sharePassword}`;

        // 4. 提案書から見積もり金額を抽出
        const estimatedAmount = extractEstimateFromProposal(proposal);

        // 5. 提案書から要約を抽出
        const summary = extractProposalSummary(proposal);

        // 6. 予算フィット判定
        const budgetFit = getBudgetFitMessage(body.budget, estimatedAmount);

        // 7. LINE通知
        const lineMsg = [
          `📋 新規DXヒアリング`,
          ``,
          `👤 ${body.name || "不明"}（${body.company || "個人"}）`,
          `📍 ${body.prefecture || "未回答"} / ${body.industry || "未回答"}`,
          `💬 ${body.consultation_type || "不明"}`,
          ``,
          `📝 ${(body.problem_detail || "詳細なし").substring(0, 100)}${(body.problem_detail || "").length > 100 ? "..." : ""}`,
          ``,
          `💰 予算: ${body.budget || "未回答"}`,
          `📊 概算見積もり: ${estimatedAmount ? `¥${estimatedAmount.toLocaleString()}` : "要確認"}`,
          budgetFit ? budgetFit : "",
          `📅 希望納期: ${body.deadline || "未回答"}`,
          `🏷 補助金: ${body.subsidy_interest || "未回答"}`,
          ``,
          `📄 AI提案書: 生成済み`,
          summary ? summary : "",
          ``,
          `🔗 提案書URL（お客様共有用）:`,
          proposalShareUrl,
        ].filter(Boolean).join("\n");

        // pushLineMessage(lineMsg); // LINE通知（Discord移行前・ロールバック用）
        pushDiscordMessage(lineMsg);

        // 8. Notion同期は無効化（GAS側でも同期していたため二重登録になる。しらたまのDXパネルで管理する）
        // createNotionDXHearing(body, caseId, estimatedAmount, proposalFile).catch(err => {
        //   console.error("[DX Hearing] Notion登録失敗:", err.message);
        // });

        res.writeHead(200, dxCorsHeaders);
        res.end(JSON.stringify({ success: true, case_id: caseId, proposal_path: proposalFile, estimated_amount: estimatedAmount }));

      } catch (e) {
        console.error("DX Hearing v2 error:", e.message);
        // エラー時もDiscord通知
        try {
          // pushLineMessage(`⚠️ DXヒアリング処理エラー\n${e.message}\n\nデータは保存済みの可能性あり。ターミナルで確認してください。`); // LINE通知（ロールバック用）
          pushDiscordMessage(`⚠️ DXヒアリング処理エラー\n${e.message}\n\nデータは保存済みの可能性あり。ターミナルで確認してください。`);
        } catch {}
        res.writeHead(500, dxCorsHeaders);
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  // ========== GET /proposal/:caseId — お客様向け提案書ページ ==========
  } else if (req.method === "GET" && pathname.match(/^\/proposal\/[^/]+$/)) {
    const caseId = decodeURIComponent(pathname.split("/")[2]);
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const pass = urlObj.searchParams.get("pass") || "";

    const hearingDir = path.join(REPO_DIR, "data", "dx-hearing");
    const statusFile = path.join(hearingDir, `${caseId}-status.json`);
    const proposalDir = path.join(hearingDir, "proposals");

    // パスワード検証
    let statusData = {};
    try { statusData = JSON.parse(fs.readFileSync(statusFile, "utf-8")); } catch {}
    if (!statusData.sharePassword || statusData.sharePassword !== pass) {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderPasswordPage(caseId, "proposal"));
      return;
    }

    // ヒアリングデータ読み込み
    const jsonFiles = fs.readdirSync(hearingDir).filter(f => f.startsWith(caseId) && f.endsWith(".json") && !f.includes("status"));
    let hearingData = {};
    if (jsonFiles.length > 0) {
      try { hearingData = JSON.parse(fs.readFileSync(path.join(hearingDir, jsonFiles[0]), "utf-8")); } catch {}
    }

    // 提案書読み込み
    const proposalFiles = fs.readdirSync(proposalDir).filter(f => f.startsWith(caseId) && f.endsWith(".md"));
    let proposalMd = "";
    if (proposalFiles.length > 0) {
      try { proposalMd = fs.readFileSync(path.join(proposalDir, proposalFiles[0]), "utf-8"); } catch {}
    }

    if (!proposalMd) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><p>提案書が見つかりません</p></body></html>");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderProposalHTML(hearingData, proposalMd, caseId));

  // ========== GET /preview/:caseId — お客様向けプレビュー確認ページ ==========
  } else if (req.method === "GET" && pathname.match(/^\/preview\/[^/]+$/)) {
    const caseId = decodeURIComponent(pathname.split("/")[2]);
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const pass = urlObj.searchParams.get("pass") || "";

    const hearingDir = path.join(REPO_DIR, "data", "dx-hearing");
    const statusFile = path.join(hearingDir, `${caseId}-status.json`);

    // パスワード検証
    let statusData = {};
    try { statusData = JSON.parse(fs.readFileSync(statusFile, "utf-8")); } catch {}
    if (!statusData.sharePassword || statusData.sharePassword !== pass) {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderPasswordPage(caseId, "preview"));
      return;
    }

    if (!statusData.deployUrl) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderMessagePage("まだデプロイが完了していません", "制作が完了次第、こちらのページでプレビューを確認いただけます。"));
      return;
    }

    // ヒアリングデータ
    const jsonFiles = fs.readdirSync(hearingDir).filter(f => f.startsWith(caseId) && f.endsWith(".json") && !f.includes("status"));
    let hearingData = {};
    if (jsonFiles.length > 0) {
      try { hearingData = JSON.parse(fs.readFileSync(path.join(hearingDir, jsonFiles[0]), "utf-8")); } catch {}
    }

    // コメント読み込み
    const commentsFile = path.join(hearingDir, `${caseId}-comments.json`);
    let comments = [];
    try { comments = JSON.parse(fs.readFileSync(commentsFile, "utf-8")); } catch {}

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPreviewHTML(hearingData, statusData, comments, caseId, pass));

  // ========== POST /api/dx-cases/:caseId/comments — コメント送信 ==========
  } else if (req.method === "POST" && pathname.match(/^\/api\/dx-cases\/[^/]+\/comments$/)) {
    const caseId = decodeURIComponent(pathname.split("/")[3]);
    const corsH = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

    let bodyChunks = [];
    req.on("data", (chunk) => bodyChunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(bodyChunks).toString());
        const hearingDir = path.join(REPO_DIR, "data", "dx-hearing");
        const statusFile = path.join(hearingDir, `${caseId}-status.json`);

        // パスワード検証
        let statusData = {};
        try { statusData = JSON.parse(fs.readFileSync(statusFile, "utf-8")); } catch {}
        if (!statusData.sharePassword || statusData.sharePassword !== body.pass) {
          res.writeHead(401, corsH);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        // コメント保存
        const commentsFile = path.join(hearingDir, `${caseId}-comments.json`);
        let comments = [];
        try { comments = JSON.parse(fs.readFileSync(commentsFile, "utf-8")); } catch {}
        const newComment = {
          id: crypto.randomBytes(4).toString("hex"),
          name: (body.name || "お客様").substring(0, 50),
          message: (body.message || "").substring(0, 1000),
          timestamp: new Date().toISOString(),
        };
        comments.push(newComment);
        fs.writeFileSync(commentsFile, JSON.stringify(comments, null, 2), "utf-8");

        // pushLineMessage(`💬 DX案件コメント\n\n案件: ${caseId}\n送信者: ${newComment.name}\n\n${newComment.message.substring(0, 200)}`); // LINE通知（ロールバック用）
        pushDiscordMessage(`💬 DX案件コメント\n\n案件: ${caseId}\n送信者: ${newComment.name}\n\n${newComment.message.substring(0, 200)}`);

        res.writeHead(200, corsH);
        res.end(JSON.stringify({ success: true, comment: newComment }));
      } catch (e) {
        res.writeHead(400, corsH);
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  // ========== OPTIONS for comments CORS ==========
  } else if (req.method === "OPTIONS" && pathname.match(/^\/api\/dx-cases\/[^/]+\/comments$/)) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();

  } else if (req.method === "GET" && pathname === "/health") {
    // 詳細ヘルスチェック
    const uptime = process.uptime();
    const memUsage = process.memoryUsage();
    const dbOk = (() => {
      try {
        const dbPath = path.join(REPO_DIR, "data", "unified.db");
        return fs.existsSync(dbPath);
      } catch { return false; }
    })();
    const health = {
      status: "ok",
      uptime: Math.round(uptime),
      uptimeHuman: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024) + "MB",
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + "MB",
      },
      db: dbOk ? "ok" : "missing",
      timestamp: new Date().toISOString(),
    };
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(health));
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

async function processMessage(userMessage) {
  isProcessing = true;
  try {
    let prompt = buildPrompt(userMessage);

    // 日程調整検出 → カレンダー情報を直接取得してプロンプトに注入
    // SNS投稿文作成検出（LINE側）
    const SNS_KW_LINE = /投稿|SNS|インスタ|Instagram|キャプション/i;
    if (SNS_KW_LINE.test(userMessage)) {
      try {
        const styleGuide = JSON.parse(fs.readFileSync(path.join(REPO_DIR, "data", "sns-style-guide.json"), "utf-8"));
        prompt += `\n\n--- SNS投稿文スタイルガイド ---
あなたはRyoのゴーストライターです。Ryoの文体を完璧に再現してください。
【アカウント別文体】
${JSON.stringify(styleGuide.accounts, null, 2)}
【ルール】AIが書いたとバレないこと。ryosuke_inaは内省的・自問自答。engawaは丁寧な空間描写。
---`;
      } catch (e) {
        console.error("[SNS] Style guide load error:", e.message);
      }
    }

    if (SCHEDULE_KEYWORDS.test(userMessage)) {
      try {
        const range = detectScheduleDateRange(userMessage);
        const busyInfo = await getCalendarBusy(range.start, range.end);
        if (busyInfo) {
          prompt += `\n\n--- Ryoのカレンダー状況 (${range.start}〜${range.end}) ---\n${busyInfo}\n---`;
        }
      } catch (e) {
        console.error("Calendar fetch error in LINE:", e.message);
      }
      prompt += `\n\n【絶対ルール】以下を厳守せよ：
- 出力は「相手に送る返信メッセージ本文」のみ。それ以外は一文字も出力するな
- 「以下が返信テキストです」「返信例：」等の前置き・説明・補足は絶対に書くな
- 全体コピーしてそのままチャットに貼り付けられる形式にせよ
- 空いている日を簡潔に伝えるチャットメッセージとして出力せよ
- カジュアルなトーン（ビジネスメールではなくLINEチャット調）`;
    }

    fs.writeFileSync(PROMPT_FILE, prompt, "utf-8");

    const execEnv = Object.assign({}, process.env, {
      PATH: `/Users/Inaryo/.local/share/mise/installs/node/24.14.0/bin:/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: "/Users/ocmm",
    });
    delete execEnv.CLAUDECODE;

    const result = execSync(
      `cd "${REPO_DIR}" && cat "${PROMPT_FILE}" | "${CLAUDE_PATH}" -p --model claude-sonnet-4-6 --dangerously-skip-permissions`,
      { encoding: "utf-8", timeout: CLAUDE_TIMEOUT, maxBuffer: 1024 * 1024, env: execEnv }
    );

    const response = result.trim() || "(応答なし)";
    console.log(`[${new Date().toISOString()}] Response: ${response.slice(0, 100)}...`);

    conversationHistory.push({ role: "assistant", content: response });
    appendChatLog("line", "assistant", response);

    pushLineMessage(response);
  } catch (e) {
    console.error("Error processing message:", e.message);
    if (e.message.includes("ETIMEDOUT")) {
      pushLineMessage("処理に時間がかかりすぎたため中断しました。もう少し具体的な指示にするか、タスクを分割してもらえると対応しやすいです。");
    } else {
      pushLineMessage("エラーが発生しました。もう一度試してください。");
    }
  }

  isProcessing = false;

  if (messageQueue.length > 0) {
    const next = messageQueue.shift();
    console.log(`[${new Date().toISOString()}] Processing queued: ${next}`);
    pushLineMessage("処理中...");
    processMessage(next);
  }
}

// ========== イベントリマインダー（5分ごと） ==========
// 送信済みリマインダーをファイルに永続化（サーバー再起動時の通知連打を防止）
const REMINDERS_FILE = path.join(__dirname, "..", "logs", ".sent-reminders.json");
let sentReminders = new Set();
let lastReminderDate = new Date().toDateString();

// 起動時にファイルから復元
try {
  if (fs.existsSync(REMINDERS_FILE)) {
    const data = JSON.parse(fs.readFileSync(REMINDERS_FILE, "utf-8"));
    if (data.date === lastReminderDate && Array.isArray(data.ids)) {
      sentReminders = new Set(data.ids);
      console.log(`[Reminder] Restored ${sentReminders.size} sent reminders from file`);
    }
  }
} catch (e) {
  console.error("[Reminder] Failed to restore sent reminders:", e.message);
}

function saveSentReminders() {
  try {
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify({
      date: lastReminderDate,
      ids: [...sentReminders],
    }));
  } catch (e) {
    console.error("[Reminder] Failed to save sent reminders:", e.message);
  }
}

async function checkEventReminders() {
  try {
    const now = new Date();
    // 日替わりで送信済みSetをリセット
    if (now.toDateString() !== lastReminderDate) {
      sentReminders.clear();
      lastReminderDate = now.toDateString();
      saveSentReminders();
    }

    const gToken = await getGoogleAccessToken();
    const calendarIds = [
      "r.inafuku@tonari2tomaru.com",
      "9c0d4af92a70ced546b135411feda7120c9fd874beda1363874c03faf8953f18@group.calendar.google.com",
      "misocacoffee@gmail.com",
      "4651f62429c52388651033e5b59f4cb81a418694431ab262748b231c663e461f@group.calendar.google.com",
      "engawa.yanagawa@gmail.com",
      "b6ff2100d451e679aa52c0afca510ce6268b673ddb904e7526c5bec7fb38836a@group.calendar.google.com",
    ];

    const timeMin = now.toISOString();
    const future = new Date(now.getTime() + 20 * 60 * 1000); // 20分先まで
    const timeMax = future.toISOString();

    for (const calId of calendarIds) {
      try {
        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&fields=items(id,summary,start,end,status)`;
        const result = await googleApiRequest("GET", url, null, gToken);
        if (!result.items) continue;
        for (const ev of result.items) {
          if (ev.status === "cancelled" || !ev.start.dateTime) continue;
          const eventStart = new Date(ev.start.dateTime);
          const diffMin = (eventStart.getTime() - now.getTime()) / 60000;
          // 15分前〜0分前の範囲で通知
          if (diffMin >= 0 && diffMin <= 15) {
            const reminderId = `${ev.id}_${ev.start.dateTime}`;
            if (!sentReminders.has(reminderId)) {
              sentReminders.add(reminderId);
              saveSentReminders();
              const timeStr = eventStart.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
              const title = ev.summary || "(予定)";
              const minLeft = Math.round(diffMin);
              await sendWebPush("まもなく予定", `${timeStr} ${title}（あと${minLeft}分）`);
              console.log(`[Reminder] Sent: ${title} at ${timeStr} (${minLeft}min left)`);
            }
          }
        }
      } catch (e) {
        console.error(`[Reminder] Calendar error (${calId}):`, e.message);
      }
    }
  } catch (e) {
    console.error("[Reminder] Check failed:", e.message);
  }
}

setInterval(checkEventReminders, 5 * 60 * 1000); // 5分ごと
setTimeout(checkEventReminders, 10 * 1000); // 起動10秒後に初回チェック

// ========== Gitスキャナー定期実行 ==========
const { scanAllRepos } = require("./git-scanner");
setInterval(scanAllRepos, 30 * 60 * 1000); // 30分ごと
setTimeout(scanAllRepos, 30 * 1000); // 起動30秒後に初回

// ========== カレンダーフォローアップ ==========
const FOLLOWUP_STATE_FILE = path.join(REPO_DIR, "data", ".followup-state.json");
const sentFollowups = new Set();

function loadFollowupState() {
  try { return JSON.parse(fs.readFileSync(FOLLOWUP_STATE_FILE, "utf-8")); } catch { return { pending: null, sentToday: [] }; }
}
function saveFollowupState(state) {
  fs.writeFileSync(FOLLOWUP_STATE_FILE, JSON.stringify(state, null, 2));
}

// 予定終了後にLINEで「どうだった？」と聞く
async function checkPostEventFollowup() {
  try {
    const state = loadFollowupState();
    // 日替わりリセット
    const today = new Date().toDateString();
    if (state.lastDate !== today) {
      state.sentToday = [];
      state.lastDate = today;
    }
    // pending中なら新しいフォローアップは送らない
    if (state.pending) return;

    const gToken = await getGoogleAccessToken();
    // プライマリとR&M共有のみ（Airbnb等は除外）
    const calendarIds = [
      "r.inafuku@tonari2tomaru.com",
      "9c0d4af92a70ced546b135411feda7120c9fd874beda1363874c03faf8953f18@group.calendar.google.com",
    ];

    const now = new Date();
    // 10〜70分前に終了したイベントを検出
    const timeMin = new Date(now.getTime() - 70 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

    // 除外キーワード
    const SKIP_KEYWORDS = ["ブロック", "予約", "Airbnb", "チェックイン", "チェックアウト"];

    for (const calId of calendarIds) {
      try {
        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${encodeURIComponent(new Date(now.getTime() - 120 * 60 * 1000).toISOString())}&timeMax=${encodeURIComponent(now.toISOString())}&singleEvents=true&orderBy=startTime&fields=items(id,summary,start,end,status)`;
        const result = await googleApiRequest("GET", url, null, gToken);
        if (!result.items) continue;

        for (const ev of result.items) {
          if (ev.status === "cancelled" || !ev.end?.dateTime || !ev.summary) continue;
          const eventEnd = new Date(ev.end.dateTime);
          const endedMinAgo = (now.getTime() - eventEnd.getTime()) / 60000;

          // 10〜70分前に終了したもののみ
          if (endedMinAgo < 10 || endedMinAgo > 70) continue;

          // 除外チェック
          if (SKIP_KEYWORDS.some(kw => ev.summary.includes(kw))) continue;
          // 終日イベントは除外（dateTimeがないものは既にスキップ済み）
          // 既に今日送信済みならスキップ
          if (state.sentToday.includes(ev.id)) continue;

          // タスクとの関連を探す
          const taskStore = require("./task-store");
          const relatedTask = taskStore.findTaskByTitle(ev.summary.replace(/^\(R\)\s*/, "").replace(/^\(M\)\s*/, ""));

          // LINEで聞く
          const title = ev.summary.replace(/^\(R\)\s*/, "").replace(/^\(M\)\s*/, "");
          pushLineMessage(`「${title}」おわった？どうだった？\n\n（例: 「終わった」「延期」「途中」など簡単に教えてね）`);

          state.pending = {
            eventId: ev.id,
            eventTitle: title,
            askedAt: now.toISOString(),
            relatedTaskId: relatedTask ? relatedTask.id : null,
          };
          state.sentToday.push(ev.id);
          saveFollowupState(state);
          console.log(`[followup] Asked about: ${title}`);
          return; // 1つずつ聞く
        }
      } catch (e) {
        console.error(`[followup] Calendar error:`, e.message);
      }
    }
  } catch (e) {
    console.error("[followup] Check failed:", e.message);
  }
}

// カレンダーフォローアップのLINE通知は停止（PWA集約方針）
// setInterval(checkPostEventFollowup, 5 * 60 * 1000);
// setTimeout(checkPostEventFollowup, 60 * 1000);

// ========== PWAバッジ定期更新 ==========
let lastBadgeCount = -1;

async function updatePwaBadge() {
  try {
    const { generateToday } = require("./task-engine");
    const data = await generateToday();
    // 秘書コメントも生成
    try { const { enrichToday } = require("./secretary-enrich"); await enrichToday(); } catch {}
    const badgeCount = data.stats.badgeCount || 0;

    // バッジ件数が変わった時だけ通知を送る
    if (badgeCount !== lastBadgeCount) {
      lastBadgeCount = badgeCount;

      if (badgeCount > 0) {
        const urgentItems = data.sections.find(s => s.type === "urgent");
        const firstUrgent = urgentItems?.items?.[0];
        const body = firstUrgent
          ? `${firstUrgent.title}`
          : `${badgeCount}件のアクションがあるよ`;

        await sendWebPush("しらたま", body, {
          badgeCount,
          tag: "today-badge",
          url: "/",
        });
        console.log(`[badge] Sent: ${badgeCount} items`);
      } else {
        // バッジクリア
        await sendWebPush("しらたま", "", {
          badgeCount: 0,
          tag: "badge-clear",
        });
        console.log("[badge] Cleared");
      }
    }
  } catch (e) {
    console.error("[badge] Update failed:", e.message);
  }
}

// 朝7:05（ブリーフィング直後）と、1時間ごとに更新
setInterval(updatePwaBadge, 60 * 60 * 1000); // 1時間ごと
setTimeout(updatePwaBadge, 60 * 1000); // 起動1分後に初回

// --- フォローアップ応答の解析（webhookハンドラから呼ばれる） ---
function tryParseFollowupReply(userMessage) {
  const state = loadFollowupState();
  if (!state.pending) return false;

  // 2時間以上前のpendingは無視
  const elapsed = Date.now() - new Date(state.pending.askedAt).getTime();
  if (elapsed > 2 * 60 * 60 * 1000) {
    state.pending = null;
    saveFollowupState(state);
    return false;
  }

  const msg = userMessage.trim().toLowerCase();
  const taskStore = require("./task-store");
  const taskId = state.pending.relatedTaskId;
  const eventTitle = state.pending.eventTitle;
  let handled = false;
  let replyText = "";

  // 完了パターン
  if (["終わ", "おわ", "ok", "完了", "うん", "はい", "done", "できた", "やった", "帰った", "帰って", "つきました", "戻った", "戻って"].some(kw => msg.includes(kw))) {
    if (taskId) {
      taskStore.completeTask(taskId, { by: "calendar-followup", note: `予定「${eventTitle}」完了 — Ryo回答` });
    }
    replyText = `了解！「${eventTitle}」完了にしたよ。おつかれさま！`;
    handled = true;
  }
  // 延期パターン
  else if (["延期", "まだ", "途中", "進行中", "半分"].some(kw => msg.includes(kw))) {
    if (taskId) {
      taskStore.updateTask(taskId, { status: "in_progress" }, "calendar-followup", `予定「${eventTitle}」進行中 — Ryo回答`);
    }
    replyText = `了解、「${eventTitle}」は進行中にしておくね。`;
    handled = true;
  }
  // キャンセルパターン
  else if (["やめた", "キャンセル", "なし", "不要"].some(kw => msg.includes(kw))) {
    if (taskId) {
      taskStore.updateTask(taskId, { status: "postponed" }, "calendar-followup", `予定「${eventTitle}」キャンセル — Ryo回答`);
    }
    replyText = `了解、「${eventTitle}」はキャンセルにしたよ。`;
    handled = true;
  }

  if (handled) {
    pushLineMessage(replyText);
    state.pending = null;
    saveFollowupState(state);
    console.log(`[followup] Resolved: ${eventTitle} → ${replyText}`);
    return true;
  }

  // パターンに明確にマッチしなくても、返事があった時点で完了扱い
  // （何か返してくれたなら予定は終わったと判断）
  if (taskId) {
    taskStore.completeTask(taskId, { by: "calendar-followup", note: `予定「${eventTitle}」— Ryo回答: ${userMessage.slice(0, 50)}` });
  }
  pushLineMessage(`了解！「${eventTitle}」おつかれさま！`);
  state.pending = null;
  saveFollowupState(state);
  console.log(`[followup] Auto-resolved (freeform reply): ${eventTitle}`);
  return true;
}

// ========== 習慣トラッキングAPI ==========
const HABITS_DIR = path.join(REPO_DIR, "logs", "habits");
const HABIT_CONFIG_FILE = path.join(REPO_DIR, "logs", ".habit-config.json");

function getDefaultHabits() {
  try {
    return JSON.parse(fs.readFileSync(HABIT_CONFIG_FILE, "utf-8"));
  } catch {
    return [
      { id: "exercise", label: "運動", icon: "🏃" },
      { id: "reading", label: "読書", icon: "📖" },
      { id: "journal", label: "日記", icon: "✍️" },
    ];
  }
}

function getTodayHabitsPath(dateStr) {
  return path.join(HABITS_DIR, `${dateStr}.json`);
}

function loadHabits(dateStr) {
  const filePath = getTodayHabitsPath(dateStr);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    // 新しい日 → デフォルトから生成
    const defaults = getDefaultHabits();
    return {
      date: dateStr,
      items: defaults.map(h => ({ ...h, done: false })),
    };
  }
}

function saveHabits(dateStr, data) {
  if (!fs.existsSync(HABITS_DIR)) fs.mkdirSync(HABITS_DIR, { recursive: true });
  fs.writeFileSync(getTodayHabitsPath(dateStr), JSON.stringify(data, null, 2));
}

function getStreak(habitId) {
  const today = new Date();
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const filePath = getTodayHabitsPath(dateStr);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const item = data.items.find(h => h.id === habitId);
      if (item && item.done) {
        streak++;
      } else {
        // 今日はまだ未完了でもOK（カウント続行）、昨日以前で途切れたらbreak
        if (i > 0) break;
      }
    } catch {
      if (i > 0) break;
    }
  }
  return streak;
}

// ========== DXヒアリング v2: 既存サイト自動分析 ==========

/**
 * 顧客の既存サイトURLをフェッチし、事業情報を自動抽出する
 * フォームの項目を増やさずに、URLだけで深い情報を取得する
 */
async function fetchAndAnalyzeSite(url) {
  if (!url || typeof url !== "string") return null;
  // URLの正規化
  let targetUrl = url.trim();
  if (!targetUrl.startsWith("http")) targetUrl = "https://" + targetUrl;

  try {
    console.log(`[Site Analysis] フェッチ開始: ${targetUrl}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SATOYAMA-AI-BASE/1.0; DX Hearing Bot)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "ja,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.log(`[Site Analysis] HTTP ${res.status} — スキップ`);
      return null;
    }

    const html = await res.text();
    if (!html || html.length < 100) return null;

    // HTML からメタ情報・テキストを抽出
    const analysis = {
      url: targetUrl,
      title: extractMeta(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
      description: extractMeta(html, /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)
        || extractMeta(html, /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i),
      ogTitle: extractMeta(html, /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i),
      ogDescription: extractMeta(html, /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i),
      ogImage: extractMeta(html, /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i),
      // SNSリンク
      socialLinks: extractSocialLinks(html),
      // ページ内テキスト（主要部分を抽出、最大3000文字）
      bodyText: extractBodyText(html, 3000),
      // 商品・価格情報のヒント
      priceHints: extractPriceHints(html),
      // 連絡先情報
      contactInfo: extractContactInfo(html),
      // ECプラットフォーム検出
      platform: detectPlatform(html),
    };

    console.log(`[Site Analysis] 完了: ${analysis.title || "タイトルなし"} (${analysis.bodyText.length}文字)`);
    return analysis;

  } catch (e) {
    console.error(`[Site Analysis] エラー: ${e.message}`);
    return null;
  }
}

function extractMeta(html, regex) {
  const m = html.match(regex);
  return m ? m[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#039;/g, "'").replace(/&quot;/g, '"') : "";
}

function extractSocialLinks(html) {
  const links = [];
  const patterns = [
    { name: "Instagram", regex: /href=["'](https?:\/\/(www\.)?instagram\.com\/[^"']+)["']/gi },
    { name: "Twitter/X", regex: /href=["'](https?:\/\/(www\.)?(twitter|x)\.com\/[^"']+)["']/gi },
    { name: "Facebook", regex: /href=["'](https?:\/\/(www\.)?facebook\.com\/[^"']+)["']/gi },
    { name: "LINE", regex: /href=["'](https?:\/\/lin\.ee\/[^"']+|https?:\/\/line\.me\/[^"']+)["']/gi },
    { name: "YouTube", regex: /href=["'](https?:\/\/(www\.)?youtube\.com\/(channel|c|@)[^"']+)["']/gi },
  ];
  for (const p of patterns) {
    const matches = html.matchAll(p.regex);
    for (const m of matches) links.push({ platform: p.name, url: m[1] });
  }
  return links;
}

function extractBodyText(html, maxLength) {
  // script, style, nav, footer, header を除去
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.substring(0, maxLength);
}

function extractPriceHints(html) {
  // 日本円の価格パターンを検出
  const prices = [];
  const priceRegex = /[¥￥][\s]?([0-9,]+)|([0-9,]+)\s*円/g;
  let match;
  while ((match = priceRegex.exec(html)) !== null && prices.length < 20) {
    const val = parseInt((match[1] || match[2]).replace(/,/g, ""), 10);
    if (val >= 100 && val <= 10000000) prices.push(val);
  }
  return [...new Set(prices)].sort((a, b) => a - b);
}

function extractContactInfo(html) {
  const info = {};
  // 電話番号
  const phone = html.match(/(?:tel|phone|電話)[^0-9]*([0-9]{2,4}[-\s]?[0-9]{2,4}[-\s]?[0-9]{3,4})/i);
  if (phone) info.phone = phone[1];
  // メール
  const email = html.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (email) info.email = email[0];
  // 住所パターン
  const address = html.match(/([\u4e00-\u9fa5]{2,3}[都道府県][\u4e00-\u9fa5\u30a0-\u30ff\u3040-\u309f0-9０-９\-ー－]+)/);
  if (address) info.address = address[1];
  return info;
}

function detectPlatform(html) {
  if (html.includes("Shopify") || html.includes("shopify")) return "Shopify";
  if (html.includes("base-next") || html.includes("thebase.in")) return "BASE";
  if (html.includes("stores.jp") || html.includes("STORES")) return "STORES";
  if (html.includes("wp-content") || html.includes("wordpress")) return "WordPress";
  if (html.includes("wix.com")) return "Wix";
  if (html.includes("jimdo")) return "Jimdo";
  if (html.includes("squarespace")) return "Squarespace";
  if (html.includes("_next") || html.includes("__next")) return "Next.js";
  return null;
}

/**
 * サイト分析結果を提案書プロンプト用のテキストに整形する
 */
function formatSiteAnalysisForPrompt(analysis) {
  if (!analysis) return "";

  const parts = [`\n## 既存サイト分析（自動取得）\n`];
  parts.push(`- URL: ${analysis.url}`);
  if (analysis.title) parts.push(`- サイト名: ${analysis.title}`);
  if (analysis.description) parts.push(`- 説明: ${analysis.description}`);
  if (analysis.platform) parts.push(`- 使用プラットフォーム: ${analysis.platform}`);

  if (analysis.socialLinks.length > 0) {
    parts.push(`- SNS: ${analysis.socialLinks.map(s => `${s.platform}(${s.url})`).join(", ")}`);
  }
  if (analysis.contactInfo.phone) parts.push(`- 電話: ${analysis.contactInfo.phone}`);
  if (analysis.contactInfo.email) parts.push(`- メール: ${analysis.contactInfo.email}`);
  if (analysis.contactInfo.address) parts.push(`- 住所: ${analysis.contactInfo.address}`);

  if (analysis.priceHints.length > 0) {
    const min = Math.min(...analysis.priceHints);
    const max = Math.max(...analysis.priceHints);
    parts.push(`- 価格帯: ¥${min.toLocaleString()} 〜 ¥${max.toLocaleString()}（${analysis.priceHints.length}件検出）`);
  }

  if (analysis.bodyText) {
    parts.push(`\n### サイト本文（抜粋）`);
    parts.push(analysis.bodyText.substring(0, 2000));
  }

  return parts.join("\n");
}

// ========== DXヒアリング v2: Claude API 提案書生成 ==========

const DX_PROPOSAL_SYSTEM_PROMPT = `あなたはSATOYAMA AI BASEの提案書作成AIです。
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
- 〜5万円: GAS中心の自動化、既存ツールの組み合わせ。コーディング最小限。予算が足りない場合はBASE/STORESなど既存プラットフォーム活用を提案
- 5〜15万円: シンプルなWebサイト or 業務自動化。テンプレート活用
- 15〜30万円: ECサイト基本構成 or 本格Webサイト。カスタムデザイン込み
- 30〜50万円: フル機能EC or 複合システム。管理画面カスタマイズ含む
- 50万円以上: エンタープライズ級。独自機能開発・API連携多数
- 補助金利用: IT導入補助金（最大450万円・補助率1/2〜3/4）活用で実質負担を大幅軽減

## ECサイト案件の追加考慮事項
ECサイトの相談の場合、以下を必ず提案に含めること:
- **食品EC特有の要件**: 冷蔵・冷凍配送の対応、食品表示法への準拠、特定商取引法ページ
- **配送・送料設計**: 顧客の配送エリア・方法に合った送料テーブル設計を提案
- **決済手段**: Stripe（クレカ+コンビニ）を基本に、顧客の希望に応じて追加
- **在庫管理**: 現状（手書き/Excel/なし）に合わせた移行プラン
- **プラットフォーム比較**: 予算〜10万ならBASE/STORESを推奨、15万以上でフルカスタム（Next.js+Stripe）を推奨。判断根拠を明記
- **既存サイトがある場合**: 分析結果から事業の雰囲気・商品特性・ブランドカラーを読み取り、デザイン提案に活かす
- **本番化ロードマップ**: デモ制作→確認→本番設定（Stripe実接続・商品データ投入・ドメイン設定）のステップを明示

## 既存サイト分析の活用
顧客の既存サイトURLが提供された場合、自動分析データが「既存サイト分析」セクションに含まれる。
この情報を以下のように活用すること:
- サイト名・事業内容から顧客のビジネスを深く理解して提案に反映
- 商品の価格帯があれば、ECの売上シミュレーションや送料設計の参考にする
- SNSアカウントがあれば、EC連携（Instagram Shopping等）を提案材料に
- 既存プラットフォーム（WordPress, BASE等）があれば、移行コスト or 連携を考慮
- デザインの雰囲気やブランドカラーは、新サイトでも踏襲する方向で提案

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
4. 制作開始

---

**SATOYAMA AI BASE**
山梨県大月市 ｜ Web: satoyama-ai-base.com
担当: 稲福 良祐 ｜ r.inafuku@tonari2tomaru.com`;

async function generateDXProposalV2(hearingData) {
  try {
    // サイト分析結果があればプロンプトに追加
    const siteAnalysisText = hearingData._siteAnalysis
      ? formatSiteAnalysisForPrompt(hearingData._siteAnalysis)
      : "";

    // _siteAnalysis はプロンプト用なのでJSONダンプからは除外
    const cleanData = { ...hearingData };
    delete cleanData._siteAnalysis;

    const fullPrompt = `${DX_PROPOSAL_SYSTEM_PROMPT}

---

以下のDXヒアリングフォームの回答データを分析し、提案書を生成してください。

## 回答データ
${JSON.stringify(cleanData, null, 2)}
${siteAnalysisText}

## 重要な注意点
- 予算「${hearingData.budget || "未回答"}」を必ず考慮してください
- 予算を大幅に超える提案はNGです。予算内で最大の価値を出すプランを考えてください
- 予算が低い場合は、スコープを絞って実現可能な提案にしてください
- 「まだ決めてない」の場合は、相談内容に応じた相場感を提示してください
- 補助金利用意向「${hearingData.subsidy_interest || "未回答"}」も考慮してください
${siteAnalysisText ? `- 「既存サイト分析」セクションの情報を最大限活用してください。顧客の事業内容・商品・価格帯・ブランドの雰囲気を分析に織り込み、顧客が「ちゃんと見てくれている」と感じる提案にしてください` : ""}
- 提案書のMarkdownだけを出力してください。前置きや説明は不要です`;

    // claude -p にパイプして提案書を生成
    const tmpPromptFile = path.join(REPO_DIR, "logs", ".dx-hearing-prompt.txt");
    fs.writeFileSync(tmpPromptFile, fullPrompt, "utf-8");

    const execEnv = Object.assign({}, process.env, {
      PATH: `/Users/Inaryo/.local/share/mise/installs/node/24.14.0/bin:/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: "/Users/ocmm",
    });
    delete execEnv.CLAUDECODE;

    const result = execSync(
      `cat "${tmpPromptFile}" | "${CLAUDE_PATH}" -p --model claude-sonnet-4-6 --dangerously-skip-permissions`,
      { encoding: "utf-8", timeout: 120000, maxBuffer: 1024 * 1024, env: execEnv, cwd: REPO_DIR }
    );

    // 一時ファイル削除
    try { fs.unlinkSync(tmpPromptFile); } catch {}

    const proposal = result.trim();
    if (!proposal || proposal.length < 50) {
      throw new Error("Claude CLIからの応答が不十分です");
    }

    console.log(`[DX Hearing] Claude CLI提案書生成完了 (${proposal.length}文字)`);
    return proposal;

  } catch (e) {
    console.error("[DX Hearing] Claude CLI失敗、フォールバック提案書で代替:", e.message);
    return generateFallbackProposal(hearingData);
  }
}

function generateFallbackProposal(data) {
  const estimate = estimateDXBudgetFallback(data);
  return `# ${data.company || data.name || "お客"} 様 DX支援 ご提案書

| 項目 | 内容 |
|---|---|
| 作成日 | ${new Date().toLocaleDateString("ja-JP")} |
| ステータス | 初回提案（簡易版） |

## お客様情報
- お名前: ${data.name || "不明"}
- 会社名: ${data.company || "個人"}
- 業種: ${data.industry || "不明"}
- 所在地: ${data.prefecture || "不明"}

## ご相談内容
**${data.consultation_type || "不明"}**

${data.problem_detail || "（詳細はヒアリングで確認）"}

## ご予算
${data.budget || "未回答"}

## 概算見積もり
¥${estimate.toLocaleString()}

## 次のステップ
1. オンラインヒアリング（30分程度）で詳細を確認
2. 正式見積もり・スケジュール提示
3. ご契約・着手

---
⚠️ この提案書はAI生成に失敗したため簡易版です。
詳細な提案書はRyoが確認の上、改めて作成します。

---

**SATOYAMA AI BASE**
山梨県大月市 ｜ Web: satoyama-ai-base.com
担当: 稲福 良祐 ｜ r.inafuku@tonari2tomaru.com`;
}

// フォールバック用の簡易見積もり
function estimateDXBudgetFallback(data) {
  let base = 0;
  const type = data.consultation_type || "";

  if (type.includes("EC")) {
    base = 200000;
    if (data.product_count === "21〜50点") base += 50000;
    if (data.product_count === "51点以上") base += 100000;
    if (data.subscription_need === "あり") base += 50000;
    if (data.shipping_fee_type === "地域別") base += 30000;
  } else if (type.includes("Web") || type.includes("サイト")) {
    base = 100000;
    if (data.page_count === "6〜10ページ") base += 50000;
    if (data.page_count === "10ページ以上") base += 100000;
    if (data.logo_status === "ない（作ってほしい）") base += 30000;
  } else if (type.includes("業務") || type.includes("効率") || type.includes("改善")) {
    base = 50000;
    const taskCount = Array.isArray(data.tasks_to_simplify) ? data.tasks_to_simplify.length : 1;
    base += (taskCount - 1) * 30000;
  } else {
    base = 100000;
  }

  return base;
}

// ========== DXヒアリング v2: ヘルパー関数 ==========

// 提案書Markdownから見積もり金額を抽出
// ========== Notion DXヒアリング登録 ==========
async function createNotionDXHearing(data, caseId, estimatedAmount, proposalPath) {
  if (!NOTION_API_KEY || !NOTION_DX_HEARING_DB_ID) {
    console.log("[Notion] API key or DB ID not configured, skipping");
    return;
  }

  // フォームデータ → Notionプロパティのマッピング
  const properties = {
    // title: お名前
    "お名前": { title: [{ text: { content: data.name || "不明" } }] },
  };

  // テキスト系
  if (data.company) properties["会社名・屋号"] = { rich_text: [{ text: { content: data.company } }] };
  if (data.problem_detail) properties["具体的なお困りごと"] = { rich_text: [{ text: { content: data.problem_detail.substring(0, 2000) } }] };
  if (data.other_requests) properties["その他ご要望"] = { rich_text: [{ text: { content: data.other_requests.substring(0, 2000) } }] };
  if (estimatedAmount) properties["技術スタック（AI提案）"] = { rich_text: [{ text: { content: `概算: ¥${estimatedAmount.toLocaleString()}` } }] };

  // メール
  if (data.email) properties["メールアドレス"] = { email: data.email };

  // URL系
  if (data.reference_url) properties["参考サイト・イメージ"] = { url: data.reference_url };
  if (data.existing_site_url) properties["既存WebサイトURL"] = { url: data.existing_site_url };

  // select系（値がNotionのオプションに存在する場合のみ）
  const selectFields = {
    "ご相談内容": data.consultation_type,
    "予算感": data.budget,
    "希望納期": data.deadline,
    "所在地": data.prefecture,
    "業種": data.industry,
    "補助金の利用意向": data.subsidy_interest,
    "チーム規模": data.team_size,
    "商品数の目安": data.product_count,
    "ロゴの有無": data.has_logo,
    "一番嬉しいこと": data.most_wanted,
    "作業の頻度": data.task_frequency,
    "1回あたりの時間": data.task_duration,
    "コンテンツの準備状況": data.content_status,
    "商品写真の準備状況": data.photo_status,
    "在庫管理の現状": data.inventory_management,
    "定期購入・サブスクの必要性": data.subscription_need,
    "ページ数の目安": data.page_count,
    "独自ドメインの有無": data.has_domain,
    "配送エリア": data.delivery_area,
    "月間の注文数（目安）": data.monthly_orders,
    "送料の考え方": data.shipping_policy,
    "返品・交換への対応": data.return_policy,
    "計算式やルール": data.has_formulas,
  };
  for (const [prop, val] of Object.entries(selectFields)) {
    if (val) properties[prop] = { select: { name: val } };
  }

  // multi_select系
  const multiSelectFields = {
    "サイトの目的": data.site_purposes,
    "ラクにしたい作業": data.tasks_to_automate,
    "一番イヤなところ": data.pain_points,
    "今のやり方": data.current_methods,
    "使用サービス": data.current_services,
    "使用デバイス": data.devices,
    "商品の発送方法": data.shipping_methods,
  };
  for (const [prop, val] of Object.entries(multiSelectFields)) {
    if (val && Array.isArray(val) && val.length > 0) {
      properties[prop] = { multi_select: val.map(v => ({ name: v })) };
    } else if (val && typeof val === "string") {
      properties[prop] = { multi_select: val.split(",").map(v => ({ name: v.trim() })).filter(v => v.name) };
    }
  }

  // ステータスは「問い合わせ」で初期登録
  properties["ステータス"] = { select: { name: "問い合わせ" } };

  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DX_HEARING_DB_ID },
      properties,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Notion API error ${response.status}: ${errBody}`);
  }

  const result = await response.json();
  console.log(`[Notion] DXヒアリング登録成功: ${result.url}`);
  return result;
}

// Notion DXヒアリング ステータス更新
async function updateNotionDXStatus(caseId, newStatus) {
  if (!NOTION_API_KEY || !NOTION_DX_HEARING_DB_ID) return;

  // まずDB内で該当ページを検索（お名前 or 案件IDで）
  const searchRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DX_HEARING_DB_ID}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      page_size: 5,
      sorts: [{ property: "回答日", direction: "descending" }],
    }),
  });

  if (!searchRes.ok) return;
  const searchData = await searchRes.json();
  if (!searchData.results || searchData.results.length === 0) return;

  // 最新のページのステータスを更新
  const pageId = searchData.results[0].id;
  const updateRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      properties: {
        "ステータス": { select: { name: newStatus } },
      },
    }),
  });

  if (updateRes.ok) {
    console.log(`[Notion] ステータス更新: ${caseId} → ${newStatus}`);
  }
}

// ========== DX自動実装パイプライン (Phase 2) ==========
const DX_PROJECTS_DIR = "/Users/Inaryo/dx-projects";

function updateDxStatus(caseId, updates) {
  const hearingDir = path.join(REPO_DIR, "data", "dx-hearing");
  const statusFile = path.join(hearingDir, `${caseId}-status.json`);
  let statusData = { status: "問い合わせ", revisionHistory: [] };
  if (fs.existsSync(statusFile)) {
    statusData = JSON.parse(fs.readFileSync(statusFile, "utf-8"));
  }
  Object.assign(statusData, updates, { updatedAt: new Date().toISOString() });
  fs.writeFileSync(statusFile, JSON.stringify(statusData, null, 2), "utf-8");
  // Notion同期
  if (updates.status) {
    updateNotionDXStatus(caseId, updates.status).catch(() => {});
  }
  return statusData;
}

// 案件タイプの判定
function classifyCaseType(consultationType) {
  const t = (consultationType || "").trim();
  if (t.includes("Webサイト") || t.includes("ウェブサイト") || t.includes("LP") || t.includes("ホームページ")) return "website";
  if (t.includes("EC") || t.includes("ネットショップ") || t.includes("通販")) return "ec";
  if (t.includes("業務") || t.includes("効率化") || t.includes("自動化") || t.includes("改善")) return "automation";
  if (t.includes("SNS") || t.includes("発信") || t.includes("マーケティング")) return "sns";
  return "website"; // デフォルト
}

const CASE_TYPE_LABELS = {
  website: "Webサイト制作",
  ec: "ECサイト構築",
  automation: "業務改善・自動化",
  sns: "SNS運用支援",
};

async function runDxImplementation(caseId) {
  const hearingDir = path.join(REPO_DIR, "data", "dx-hearing");
  const proposalDir = path.join(hearingDir, "proposals");

  try {
    // 1. ステータスを「実装中」に更新
    updateDxStatus(caseId, { status: "実装中" });

    // 2. ヒアリングデータと提案書を読み込む
    const jsonFiles = fs.readdirSync(hearingDir).filter(f => f.startsWith(caseId) && f.endsWith(".json") && !f.includes("status"));
    if (jsonFiles.length === 0) throw new Error("ヒアリングデータが見つかりません");
    const hearingData = JSON.parse(fs.readFileSync(path.join(hearingDir, jsonFiles[0]), "utf-8"));

    const proposalFiles = fs.readdirSync(proposalDir).filter(f => f.startsWith(caseId) && f.endsWith(".md"));
    const proposal = proposalFiles.length > 0
      ? fs.readFileSync(path.join(proposalDir, proposalFiles[0]), "utf-8")
      : "";

    // 3. 案件タイプ判定
    const caseType = classifyCaseType(hearingData.consultation_type);
    const caseTypeLabel = CASE_TYPE_LABELS[caseType];
    console.log(`[DX Impl] ${caseId}: タイプ=${caseTypeLabel}`);
    pushLineMessage(`⚙️ ${caseId}: ${caseTypeLabel}の自動実装を開始しました`);

    // 4. プロジェクトディレクトリ作成
    const projectDir = path.join(DX_PROJECTS_DIR, caseId);
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });

    // 5. 案件タイプ別の実装指示書を配置
    const claudeMd = buildImplementationPrompt(hearingData, proposal, caseId, caseType);
    fs.writeFileSync(path.join(projectDir, "CLAUDE.md"), claudeMd, "utf-8");

    // 6. Claude Code CLIで実装
    console.log(`[DX Impl] ${caseId}: Claude Code CLI実装開始...`);
    const implPrompt = buildImplPromptByCaseType(caseType);

    const tmpFile = path.join(REPO_DIR, "logs", `.dx-impl-${caseId}.txt`);
    fs.writeFileSync(tmpFile, implPrompt, "utf-8");

    const execEnv = { ...process.env, HOME: "/Users/ocmm", PATH: process.env.PATH };

    // spawn（非同期）でClaude Code CLIを実行 — サーバーをブロックしない
    await runClaudeCLI(tmpFile, projectDir, execEnv, 600000);
    try { fs.unlinkSync(tmpFile); } catch {}

    console.log(`[DX Impl] ${caseId}: 実装完了。`);

    // 7. 案件タイプ別の後処理
    // 共有パスワードを取得（ステータスファイルから）
    const hearingDir = path.join(REPO_DIR, "data", "dx-hearing");
    const currentStatusFile = path.join(hearingDir, `${caseId}-status.json`);
    let sharePassword = "";
    try {
      const sd = JSON.parse(fs.readFileSync(currentStatusFile, "utf-8"));
      sharePassword = sd.sharePassword || crypto.randomBytes(4).toString("hex");
    } catch { sharePassword = crypto.randomBytes(4).toString("hex"); }

    const SHARE_BASE = "https://api.tonari2tomaru.com";

    let deployUrl = null;
    if (caseType === "website" || caseType === "ec") {
      // Webサイト/EC → Vercelデプロイ
      pushLineMessage(`✅ ${caseId}: 実装完了。Vercelデプロイ中...`);
      deployUrl = await deployToVercel(projectDir, caseId);
      updateDxStatus(caseId, { status: "デプロイ済み", deployUrl, caseType, sharePassword });
      const previewShareUrl = `${SHARE_BASE}/preview/${encodeURIComponent(caseId)}?pass=${sharePassword}`;
      // pushLineMessage(`🎉 ${caseId}: デプロイ完了！\n\nプレビュー: ${deployUrl}\n\n🔗 お客様共有用:\n${previewShareUrl}\n\nしらたまのDXタブで確認・修正指示ができます`); // LINE通知（ロールバック用）
      pushDiscordMessage(`🎉 ${caseId}: デプロイ完了！\n\nプレビュー: ${deployUrl}\n\n🔗 お客様共有用:\n${previewShareUrl}\n\nしらたまのDXタブで確認・修正指示ができます`);
    } else {
      // 業務改善/SNS → デプロイなし、納品物一式で完了
      updateDxStatus(caseId, { status: "デプロイ済み", caseType, projectDir, sharePassword });
      // pushLineMessage(`✅ ${caseId}: ${caseTypeLabel}の成果物が完成しました\n\n📁 ${projectDir}\n\nしらたまのDXタブで確認・修正指示ができます`); // LINE通知（ロールバック用）
      pushDiscordMessage(`✅ ${caseId}: ${caseTypeLabel}の成果物が完成しました\n\n📁 ${projectDir}\n\nしらたまのDXタブで確認・修正指示ができます`);
    }

  } catch (error) {
    console.error(`[DX Impl] ${caseId}: エラー:`, error.message);
    updateDxStatus(caseId, { status: "GO済み", implError: error.message });
    // pushLineMessage(`❌ ${caseId}: 自動実装でエラーが発生しました\n\n${error.message.substring(0, 200)}\n\nターミナルで確認してください`); // LINE通知（ロールバック用）
    pushDiscordMessage(`❌ ${caseId}: 自動実装でエラーが発生しました\n\n${error.message.substring(0, 200)}\n\nターミナルで確認してください`);
  }
}

// 案件タイプ別のClaude CLI実行プロンプト
function buildImplPromptByCaseType(caseType) {
  const common = `このディレクトリにCLAUDE.mdの指示に従ってプロジェクトを実装してください。
まずCLAUDE.mdを読み、その指示通りに構築してください。`;

  switch (caseType) {
    case "website":
      return `${common}
Webサイトを構築してください。
- すべてのファイルを作成し、npm installも実行してください
- npm run buildでビルドが通ることを確認してください
- ビジュアル・デザインを最重視してください。見た目の美しさが最優先です
- ダミーテキストではなく、クライアントの業種に合った実用的なテキストを入れてください
- 画像はプレースホルダーでOKですが、適切なalt属性を付けてください
- 最後に docs/SETUP-GUIDE.md（本番構築手順書）を必ず生成してください`;

    case "ec":
      return `${common}
ECサイトのデモを構築してください。

## 基本要件
- すべてのファイルを作成し、npm installも実行してください
- npm run buildでビルドが通ることを確認してください
- 決済はモックで実装（Stripeは.env.exampleにキー名だけ記載）
- カート・注文フローはUI上で完全に動作させる（決済部分はモック）

## 商品データ
- CLAUDE.mdに記載のヒアリングデータ・既存サイト分析から、顧客の実際の商品に近いデモデータを作成
- 商品名・説明・価格は顧客の業種に合ったリアルなものにする（「商品A」のようなダミーは禁止）
- 既存サイトから価格帯が分かっている場合はそれに合わせる
- 商品画像はunsplashのプレースホルダーで、業種に合った写真を選ぶ

## デザイン
- 顧客の業種・ブランドイメージに合ったデザイン
- 既存サイトの分析結果がある場合は、色合い・雰囲気を踏襲する
- 商品が映えるレイアウト（大きな写真、清潔感、余白）
- モバイルファースト・レスポンシブ

## 必須ページ
- トップページ（ヒーロー + おすすめ商品 + ストーリー）
- 商品一覧
- 商品詳細（カートに追加）
- カート
- 注文フロー（配送先入力 → 注文確認 → 完了）
- 特定商取引法に基づく表記（テンプレート）
- 配送・送料について（ヒアリングの配送エリア・送料タイプを反映）
- お問い合わせ

## 必須ドキュメント
- docs/SETUP-GUIDE.md:
  - Stripeアカウント作成・APIキー取得手順（スクショレベル）
  - 商品データの登録方法（管理画面 or データファイル編集）
  - 配送設定（送料テーブル、配送エリア）
  - 決済テスト方法（Stripeテストモード）
  - 本番切り替え手順（テスト→ライブキー）
  - ドメイン・ホスティング設定
- docs/CREDENTIALS-CHECKLIST.md:
  - 必要なアカウント一覧と作成手順リンク
  - 環境変数一覧と取得方法`;

    case "automation":
      return `${common}
業務改善・自動化のための成果物を構築してください。

重要: この案件はVercelにデプロイするWebサイトではありません。
クライアントの環境にセットアップして使うツール・スクリプトを納品します。

成果物として以下を作成してください:
1. スクリプト一式（GAS、Python、Node.js等、提案内容に応じて最適なもの）
2. docs/SETUP-GUIDE.md — クライアントが自分の環境にセットアップするための詳細手順書
   - 手順は技術者でない人にも分かるように、画面の操作手順レベルで書く
   - 「このURLにアクセス → この画面でこのボタンを押す → ここにこの値を貼り付ける」レベル
   - GASの場合: スプレッドシートの作り方、スクリプトエディタの開き方、コードの貼り付け方、トリガー設定
   - 外部APIの場合: アカウント作成、APIキー取得の手順
3. docs/CREDENTIALS-CHECKLIST.md — 必要な認証情報・アカウントの一覧表
4. docs/CUSTOMIZATION-GUIDE.md — クライアント固有の設定をカスタマイズするポイント
   - 「ここの値を自社のメールアドレスに変えてください」等
5. README.md — 全体概要と各ファイルの説明

package.jsonは不要です（GASスクリプトの場合など）。必要な場合のみ作成してください。`;

    case "sns":
      return `${common}
SNS運用支援の成果物を構築してください。

成果物として以下を作成してください:
1. テンプレート一式（投稿テンプレート、画像サイズガイド、ハッシュタグリスト等）
2. docs/SETUP-GUIDE.md — 使用ツールのセットアップ手順書
3. docs/OPERATION-MANUAL.md — 日常の運用マニュアル（投稿頻度、時間帯、反応対応等）
4. docs/CONTENT-CALENDAR.md — 1ヶ月分のコンテンツカレンダーのテンプレート
5. README.md — 全体概要

Webサイトの構築は不要です。`;

    default:
      return `${common}
すべてのファイルを作成し、必要に応じてnpm installも実行してください。
最後に docs/SETUP-GUIDE.md を必ず生成してください。`;
  }
}

async function runDxRevision(caseId, revisionNote) {
  const projectDir = path.join(DX_PROJECTS_DIR, caseId);

  try {
    if (!fs.existsSync(projectDir)) {
      throw new Error("プロジェクトディレクトリが見つかりません。先にGOサインで実装を完了してください。");
    }

    updateDxStatus(caseId, { status: "実装中" });
    // pushLineMessage(`🔧 ${caseId}: 修正を開始しました\n\n${revisionNote.substring(0, 100)}`); // LINE通知（ロールバック用）
    pushDiscordMessage(`🔧 ${caseId}: 修正を開始しました\n\n${revisionNote.substring(0, 100)}`);

    // Claude Code CLIで修正
    const revisionPrompt = `以下の修正を行ってください。修正後にnpm run buildでビルドが通ることを確認してください。

## 修正内容
${revisionNote}

## 注意
- 既存のコードベースを壊さないでください
- 修正箇所以外は変更しないでください
- ビルドエラーが出たら修正してください`;

    const tmpFile = path.join(REPO_DIR, "logs", `.dx-revision-${caseId}.txt`);
    fs.writeFileSync(tmpFile, revisionPrompt, "utf-8");

    const execEnv = { ...process.env, HOME: "/Users/ocmm", PATH: process.env.PATH };

    // spawn（非同期）でClaude Code CLIを実行 — サーバーをブロックしない
    await runClaudeCLI(tmpFile, projectDir, execEnv, 300000);
    try { fs.unlinkSync(tmpFile); } catch {}

    console.log(`[DX Revision] ${caseId}: 修正完了。再デプロイ開始...`);

    // 再デプロイ
    const deployUrl = await deployToVercel(projectDir, caseId);

    updateDxStatus(caseId, { status: "デプロイ済み", deployUrl });
    // pushLineMessage(`✅ ${caseId}: 修正＆再デプロイ完了！\n\nプレビュー: ${deployUrl}`); // LINE通知（ロールバック用）
    pushDiscordMessage(`✅ ${caseId}: 修正＆再デプロイ完了！\n\nプレビュー: ${deployUrl}`);

  } catch (error) {
    console.error(`[DX Revision] ${caseId}: エラー:`, error.message);
    updateDxStatus(caseId, { status: "デプロイ済み", implError: error.message });
    // pushLineMessage(`❌ ${caseId}: 修正でエラーが発生しました\n\n${error.message.substring(0, 200)}`); // LINE通知（ロールバック用）
    pushDiscordMessage(`❌ ${caseId}: 修正でエラーが発生しました\n\n${error.message.substring(0, 200)}`);
  }
}

// ========== 非同期シェルコマンド実行ヘルパー ==========

/**
 * Claude Code CLIを非同期で実行する（サーバーをブロックしない）
 * stdinからプロンプトを流し込む形式
 */
function runClaudeCLI(promptFile, cwd, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", `cat "${promptFile}" | "${CLAUDE_PATH}" -p --model claude-sonnet-4-6 --dangerously-skip-permissions`], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude CLI timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.substring(0, 500)}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 汎用シェルコマンドを非同期で実行する（サーバーをブロックしない）
 */
function runShellCommand(command, cwd, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command exited with code ${code}: ${stderr.substring(0, 500)}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function deployToVercel(projectDir, caseId) {
  const execEnv = { ...process.env, HOME: "/Users/ocmm", PATH: process.env.PATH };
  const safeName = caseId.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  try {
    // spawn（非同期）でVercelデプロイ — サーバーをブロックしない
    const result = await runShellCommand(`npx vercel deploy --prod --yes --name "${safeName}" 2>&1`, projectDir, execEnv, 180000);

    // デプロイURLを抽出（Vercel CLIの出力から）
    const lines = result.trim().split("\n");
    const urlLine = lines.find(l => l.includes("https://") && l.includes(".vercel.app"));
    if (urlLine) {
      const match = urlLine.match(/(https:\/\/[^\s]+\.vercel\.app[^\s]*)/);
      if (match) return match[1];
    }

    // フォールバック: プロジェクト名からURL推測
    return `https://${safeName}.vercel.app`;
  } catch (error) {
    console.error(`[Vercel Deploy] ${caseId}: デプロイエラー:`, error.message);
    // エラーでもURLを推測して返す
    return `https://${safeName}.vercel.app`;
  }
}

function buildImplementationPrompt(hearingData, proposal, caseId, caseType) {
  const clientName = hearingData.company || hearingData.name || "クライアント";
  const caseTypeLabel = CASE_TYPE_LABELS[caseType] || "不明";

  const clientInfo = `# ${clientName} 様向け ${caseTypeLabel} 実装指示書

## 案件ID: ${caseId}
## 案件タイプ: ${caseTypeLabel}

## クライアント情報
- お名前: ${hearingData.name || "不明"}
- 会社名: ${hearingData.company || "個人"}
- 業種: ${hearingData.industry || "不明"}
- ご相談内容: ${hearingData.consultation_type || "不明"}
- 予算: ${hearingData.budget || "未回答"}
- 希望納期: ${hearingData.deadline || "未回答"}
${hearingData.current_methods ? `- 現在のやり方: ${Array.isArray(hearingData.current_methods) ? hearingData.current_methods.join(", ") : hearingData.current_methods}` : ""}
${hearingData.current_services ? `- 使用中のサービス: ${Array.isArray(hearingData.current_services) ? hearingData.current_services.join(", ") : hearingData.current_services}` : ""}
${hearingData.devices ? `- 使用デバイス: ${Array.isArray(hearingData.devices) ? hearingData.devices.join(", ") : hearingData.devices}` : ""}

## お困りごと
${hearingData.problem_detail || "詳細なし"}
${hearingData._siteAnalysis ? formatSiteAnalysisForPrompt(hearingData._siteAnalysis) : ""}

## AI提案書（この内容に沿って実装する）

${proposal}
`;

  // 案件タイプ別の実装ルール
  const typeRules = {
    website: `## 実装ルール（Webサイト制作）

### 最重要: ビジュアル・デザイン品質
- **見た目の美しさが最優先**。テクノロジー感は控えめに、温かみと親しみやすさを重視
- クライアントの業種・ターゲット客層に合ったデザインにする
- ヒーロー画像、配色、フォント選定はクライアントの事業イメージに合わせる
- ダミーテキストは使わない。業種に合った実用的なテキストを書く
- 画像はunsplash等のプレースホルダーURLでOKだが、適切なalt属性を付ける

### 技術スタック
- Next.js + Tailwind CSS + TypeScript
- デプロイ先: Vercel
- SEO基本対応（メタタグ、OGP、構造化データ）
- モバイルファースト・レスポンシブデザイン

### プロジェクト構成
- package.jsonに "build" スクリプト必須
- .gitignore を適切に設定
- 環境変数が必要な場合は .env.example を作成

### 必須納品ドキュメント
docs/SETUP-GUIDE.md に以下を含める:
- 本番環境への移行手順（独自ドメイン設定、DNS設定）
- 各種ホスティングパターン別の手順:
  1. Vercelでそのまま運用する場合
  2. 既存サーバーに移行する場合
  3. 新規にサーバー・ドメインを取得する場合
- コンテンツ（テキスト・画像）の差し替え方法
- Google Analytics等のトラッキング設定方法
- お問い合わせフォームがある場合はメール送信設定の手順`,

    ec: `## 実装ルール（ECサイト構築）

### デモサイトとして構築
- 実際の決済は行わないデモ版を構築する
- カート・注文フローはUI上で完全に動作させる（決済部分はモック）
- Stripe等の決済キーは .env.example にキー名のみ記載

### 商品データ（最重要）
- **「商品A」「サンプル商品」のようなダミーは絶対禁止**
- ヒアリングデータと既存サイト分析から、顧客の実際の商品に近いデモデータを作成する
- 商品名・説明文・価格は業種に合ったリアルなものにする
- 既存サイトの価格帯が分かっている場合はそれに合わせる
- 商品画像はunsplashから業種に合った写真のプレースホルダーを使用
- 商品数は提案書のプランに合わせる（最低5点）

### 技術スタック
- Next.js + Tailwind CSS + TypeScript
- 決済: Stripe（モック）
- デプロイ先: Vercel

### ビジュアル
- 商品が映えるデザイン。写真を大きく、清潔感のあるレイアウト
- モバイルファースト・レスポンシブデザイン
- クライアントの業種・ブランドに合った配色・トーン
- 既存サイトの分析結果がある場合は、デザインの雰囲気を踏襲する

### 必須ページ
- トップ（ヒーロー + おすすめ商品 + ブランドストーリー）
- 商品一覧（カテゴリフィルター付き）
- 商品詳細（カートに追加、数量選択）
- カート（数量変更、削除、小計表示）
- 注文フロー（配送先 → 確認 → 完了）
- 特定商取引法に基づく表記（テンプレート。クライアント情報を埋めておく）
- 配送・送料について（ヒアリングの配送エリア・送料タイプを反映）
- お問い合わせ

### 必須納品ドキュメント
docs/SETUP-GUIDE.md:
- Stripeアカウント作成・APIキー取得の手順（スクショレベルで）
- 商品データの登録方法（管理画面 or CSVインポート）
- 配送設定（送料テーブル、配送エリア）
- 決済テスト方法（Stripeテストモード）
- 本番切り替え手順
- ドメイン・ホスティング設定

docs/CREDENTIALS-CHECKLIST.md:
- 必要なアカウント一覧（Stripe, Vercel, ドメイン等）
- 各アカウントの作成手順リンク
- 必要な環境変数一覧と取得方法`,

    automation: `## 実装ルール（業務改善・自動化）

### 重要: これはWebサイトではない
- Vercelにデプロイするサイトは作らない
- クライアントの既存環境（Google Workspace、使用中ツール等）に組み込むスクリプト・ツールを作る
- クライアントの使用中サービスとの連携を重視する

### 成果物の構成
\`\`\`
{projectDir}/
├── README.md                    # 全体概要・ファイル説明
├── scripts/                     # スクリプト本体
│   ├── main.gs (or .js/.py)    # メインスクリプト
│   └── ...
├── templates/                   # テンプレートファイル（スプレッドシート設計等）
├── docs/
│   ├── SETUP-GUIDE.md          # セットアップ手順書（最重要）
│   ├── CREDENTIALS-CHECKLIST.md # 必要な認証情報一覧
│   └── CUSTOMIZATION-GUIDE.md  # カスタマイズポイント
└── .env.example                 # 必要な環境変数（ある場合）
\`\`\`

### SETUP-GUIDE.md の書き方（最重要）
- 技術者でない人でも実行できるレベルで書く
- 各手順に番号を振り、一つずつ丁寧に説明する
- 「このURLにアクセス → ログイン → 左メニューの○○をクリック → △△の画面で□□を入力」レベル
- GASの場合:
  - Googleスプレッドシートの新規作成方法
  - 拡張機能 → Apps Script の開き方
  - コードの貼り付け方（ファイルごとに）
  - トリガー設定（時計アイコン → トリガーを追加 → 設定値）
  - 初回実行時の権限承認の手順
- 外部API（Slack, LINE, ChatGPT等）を使う場合:
  - アカウント作成手順
  - APIキー・Webhook URL取得手順
  - 設定値の記入場所
- スプレッドシートのテンプレートは templates/ にCSVまたはJSON形式で保存

### CUSTOMIZATION-GUIDE.md
- クライアント固有の設定値を変更するポイントを列挙
- 「○○.gs の XX行目の "メールアドレス" を自社のアドレスに変更」等
- 業務フローに合わせた調整ポイント`,

    sns: `## 実装ルール（SNS運用支援）

### 重要: これはWebサイトではない
- コード実装よりも運用テンプレート・マニュアルが主な成果物

### 成果物の構成
\`\`\`
{projectDir}/
├── README.md                        # 全体概要
├── templates/
│   ├── post-templates/              # 投稿テンプレート集
│   ├── image-specs.md               # 画像サイズ・フォーマットガイド
│   └── hashtag-library.md           # ハッシュタグライブラリ
├── docs/
│   ├── SETUP-GUIDE.md              # ツール設定手順書
│   ├── OPERATION-MANUAL.md         # 日常運用マニュアル
│   └── CONTENT-CALENDAR.md         # コンテンツカレンダーテンプレート
└── scripts/                         # 自動化スクリプト（あれば）
\`\`\`

### ドキュメントの品質
- 初心者でも分かるように書く
- 具体的な投稿例を複数パターン含める
- 業種に合ったトーン・内容にカスタマイズ`,
  };

  // 全案件タイプ共通: Ryo用の内部納品手順書
  const deliveryProcedure = `

## 【内部用】docs/DELIVERY-PROCEDURE.md を必ず生成すること

これはクライアントには渡さない、Ryo（担当者）用の納品作業手順書。
以下の内容を案件タイプに合わせて具体的に書く:

### 記載内容
1. **納品前チェックリスト**
   - 動作確認項目（実際にテストすべきこと）
   - コード・ドキュメントの最終確認ポイント
   - クライアント固有の設定値で差し替えが必要な箇所のリスト

2. **納品方法**
   - ファイルの渡し方（Zip送付 / Google Drive共有 / GitHub招待 等）
   - 推奨する共有形式とその手順
   - Vercelデプロイ済みの場合: ドメイン移管やプロジェクト譲渡の手順

3. **セットアップサポートの進め方**
   - クライアントとのすり合わせMTGで確認すべき事項
   - 画面共有しながら一緒にやるべき設定項目
   - クライアントに事前準備してもらうもの（アカウント作成等）

4. **納品後のフォロー**
   - 初期不具合が出やすいポイント
   - サポート期間中に聞かれそうな質問と回答
   - 月額伴走サポートへの誘導ポイント

5. **請求・事務**
   - 請求書発行のタイミング（納品完了時 / 分割の場合のスケジュール）
   - 補助金利用の場合の注意事項

### トーンと粒度
- Ryoが読んでそのまま行動できるレベルで書く
- 「次はこれをやる」が明確にわかるチェックリスト形式
- 案件固有の情報（クライアント名、使用ツール、API等）を具体的に含める`;

  return clientInfo + "\n" + (typeRules[caseType] || typeRules.website) + deliveryProcedure;
}

function extractEstimateFromProposal(proposalMarkdown) {
  // 行単位で「概算」「合計」を含む行から金額を抽出
  const lines = proposalMarkdown.split("\n");

  // 1. 「概算」「合計」を含む行の金額を優先
  for (const keyword of ["合計", "概算"]) {
    for (const line of lines) {
      if (line.includes(keyword)) {
        const amounts = [...line.matchAll(/[¥￥]([0-9,]+)/g)]
          .map(m => parseInt(m[1].replace(/,/g, ""), 10))
          .filter(n => n >= 1000);
        if (amounts.length > 0) {
          return amounts[amounts.length - 1]; // 最後の金額（範囲なら上限値）
        }
      }
    }
  }

  // 2. 「概算」パターン（概算: ¥XXX）
  const directMatch = proposalMarkdown.match(/概算[:：]\s*[¥￥]([0-9,]+)/);
  if (directMatch) {
    return parseInt(directMatch[1].replace(/,/g, ""), 10);
  }

  // 3. プランA近辺の金額を探す
  const planAIdx = proposalMarkdown.indexOf("プランA");
  if (planAIdx !== -1) {
    const planASection = proposalMarkdown.substring(planAIdx, planAIdx + 1500);
    const amounts = [...planASection.matchAll(/[¥￥]([0-9,]+)/g)]
      .map(m => parseInt(m[1].replace(/,/g, ""), 10))
      .filter(n => n >= 10000);
    if (amounts.length > 0) {
      return amounts[amounts.length - 1];
    }
  }

  // 4. フォールバック: 全金額の中央値
  const allAmounts = [...proposalMarkdown.matchAll(/[¥￥]([0-9,]+)/g)]
    .map(m => parseInt(m[1].replace(/,/g, ""), 10))
    .filter(n => n >= 10000 && n <= 10000000);
  if (allAmounts.length > 0) {
    allAmounts.sort((a, b) => a - b);
    return allAmounts[Math.floor(allAmounts.length / 2)];
  }

  return null;
}

// 提案書から「ご提案概要」セクションを抜粋
function extractProposalSummary(proposal) {
  const overviewMatch = proposal.match(/## ご提案概要\n([\s\S]*?)(?=\n##)/);
  if (overviewMatch) {
    return overviewMatch[1].trim().substring(0, 150);
  }
  return "";
}

// 予算と見積もりの乖離メッセージ
function getBudgetFitMessage(budget, estimate) {
  if (!budget || !estimate) return "";
  const budgetMap = {
    "〜5万円": 50000,
    "5〜15万円": 150000,
    "15〜30万円": 300000,
    "30〜50万円": 500000,
    "50万円以上": 1000000,
  };
  const budgetMax = budgetMap[budget];
  if (!budgetMax) return "";

  if (estimate <= budgetMax) {
    return "✅ 予算内に収まります";
  } else if (estimate <= budgetMax * 1.3) {
    return "⚠️ 予算をやや超過（補助金で調整可能）";
  } else {
    return "🔴 予算超過 → ミニマムプランを推奨";
  }
}

// ========== 以下、旧テンプレート生成関数（v2では未使用・将来削除予定） ==========
function _legacyGenerateDXProposal(data, caseId, estimate) {
  const type = data.consultation_type || "不明";
  const today = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });

  let techStack = "";
  let features = "";
  let currentAnalysis = "";
  let schedule = "";

  if (type.includes("EC")) {
    const payments = Array.isArray(data.payment_methods) ? data.payment_methods.join("・") : "クレジットカード";
    const shipping = Array.isArray(data.shipping_method) ? data.shipping_method.join("・") : "常温";
    const salesCh = Array.isArray(data.sales_channels) ? data.sales_channels.join("・") : "未回答";

    currentAnalysis = [
      `- 現在の販売チャネル: ${salesCh}`,
      `- 商品数: ${data.product_count || "未回答"}`,
      `- 発送方法: ${shipping}`,
      `- 配送エリア: ${data.delivery_area || "未回答"}`,
      `- 送料体系: ${data.shipping_fee_type || "未回答"}`,
      `- 月間注文数: ${data.monthly_orders || "未回答"}`,
      `- 在庫管理: ${data.inventory_management || "未回答"}`,
      `- 商品写真: ${data.photo_status || "未回答"}`,
    ].join("\n");

    techStack = [
      `- フレームワーク: Next.js（高速・SEO対応）`,
      `- 決済: Stripe（${payments} 対応）`,
      `- データベース: Supabase（管理画面付き・無料枠で運用可能）`,
      `- メール: Brevo（顧客管理+メルマガ配信）`,
      `- ホスティング: Vercel（自動デプロイ・高速配信）`,
    ].join("\n");

    const featureList = [
      "- [ ] 商品一覧・詳細ページ",
      "- [ ] カート・購入フロー",
      `- [ ] 決済連携（${payments}）`,
      "- [ ] 注文管理（Supabase管理画面）",
      "- [ ] 顧客管理",
      "- [ ] メルマガ配信",
    ];
    if (data.subscription_need === "あり" || data.subscription_need === "将来的に検討") {
      featureList.push("- [ ] 定期購入機能");
    }
    if (data.return_policy === "対応する") {
      featureList.push("- [ ] 返品・交換管理");
    }
    features = featureList.join("\n");

    schedule = [
      `- フェーズ1（設計）: 2週間`,
      `- フェーズ2（実装）: 3〜4週間`,
      `- フェーズ3（テスト・調整）: 1〜2週間`,
      `- 納品目標: ${data.deadline || "要相談"} 以内`,
    ].join("\n");

  } else if (type.includes("Web") || type.includes("サイト")) {
    const purposes = Array.isArray(data.site_purpose) ? data.site_purpose.join("・") : "会社紹介";

    currentAnalysis = [
      `- サイトの目的: ${purposes}`,
      `- ページ数: ${data.page_count || "未回答"}`,
      `- コンテンツ準備状況: ${data.content_status || "未回答"}`,
      `- ロゴ: ${data.logo_status || "未回答"}`,
      `- ドメイン: ${data.domain_status || "未回答"}`,
    ].join("\n");

    techStack = [
      `- フレームワーク: Next.js（高速・SEO対応）`,
      `- ホスティング: Vercel（自動デプロイ・高速配信）`,
      `- CMS: Notion API（更新の手軽さ重視の場合）`,
      `- お問い合わせ: Google Forms or カスタムフォーム`,
    ].join("\n");

    const featureList = [
      "- [ ] トップページ",
      "- [ ] 会社/事業紹介ページ",
      "- [ ] お問い合わせフォーム",
      "- [ ] スマホ対応（レスポンシブ）",
      "- [ ] SEO基本設定",
    ];
    if (purposes.includes("集客") || purposes.includes("ブログ")) {
      featureList.push("- [ ] ブログ/お知らせ機能");
    }
    if (data.logo_status === "ない（作ってほしい）") {
      featureList.push("- [ ] ロゴデザイン");
    }
    features = featureList.join("\n");

    schedule = [
      `- フェーズ1（設計・ワイヤーフレーム）: 1〜2週間`,
      `- フェーズ2（実装）: 2〜3週間`,
      `- フェーズ3（調整・公開）: 1週間`,
      `- 納品目標: ${data.deadline || "要相談"} 以内`,
    ].join("\n");

  } else {
    // 業務改善・効率化 or その他
    const tasks = Array.isArray(data.tasks_to_simplify) ? data.tasks_to_simplify.join("・") : "未指定";
    const pains = Array.isArray(data.pain_points) ? data.pain_points.join("・") : "未回答";
    const methods = Array.isArray(data.current_method) ? data.current_method.join("・") : "未回答";

    currentAnalysis = [
      `- 効率化したい業務: ${tasks}`,
      `- 頻度: ${data.frequency || "未回答"}`,
      `- 1回あたりの所要時間: ${data.time_per_task || "未回答"}`,
      `- 現在のやり方: ${methods}`,
      `- ルール・手順書: ${data.has_rules || "未回答"}`,
      `- 困っていること: ${pains}`,
      `- 期待する効果: ${data.desired_outcome || "未回答"}`,
    ].join("\n");

    // タスクに応じた技術スタック提案
    const stackItems = [`- ワークフロー自動化: Google Apps Script (GAS)`];
    if (tasks.includes("見積") || tasks.includes("請求")) {
      stackItems.push("- 見積書・請求書: GAS + テンプレート自動生成");
    }
    if (tasks.includes("スケジュール") || tasks.includes("予約")) {
      stackItems.push("- 予約管理: Google Calendar API + Webフォーム");
    }
    if (tasks.includes("顧客") || tasks.includes("連絡先")) {
      stackItems.push("- 顧客管理: スプレッドシート + GAS or Supabase");
    }
    if (tasks.includes("データ") || tasks.includes("集計") || tasks.includes("入力")) {
      stackItems.push("- データ入力・集計: GAS + スプレッドシート自動化");
    }
    if (tasks.includes("SNS") || tasks.includes("メール") || tasks.includes("配信")) {
      stackItems.push("- 配信自動化: Make or GAS + メールサービス連携");
    }
    techStack = stackItems.join("\n");

    const featureList = [
      "- [ ] 現行業務フローの整理・可視化",
      "- [ ] 自動化スクリプト構築",
      "- [ ] テスト・動作確認",
      "- [ ] 運用マニュアル作成",
      "- [ ] 操作レクチャー（オンライン）",
    ];
    features = featureList.join("\n");

    schedule = [
      `- フェーズ1（ヒアリング・設計）: 1週間`,
      `- フェーズ2（構築・テスト）: 1〜2週間`,
      `- フェーズ3（レクチャー・引き渡し）: 1週間`,
      `- 納品目標: ${data.deadline || "要相談"} 以内`,
    ].join("\n");
  }

  const subsidyNote = data.subsidy_interest === "興味はある" || data.subsidy_interest === "申請予定"
    ? `\n> 💡 **補助金のご活用について**\n> IT導入補助金（補助率1/2）や小規模事業者持続化補助金（補助率2/3、上限50万円）の活用で、実質負担を大幅に軽減できます。申請サポートも行っておりますので、お気軽にご相談ください。\n`
    : "";

  return [
    `# DX支援 提案書`,
    ``,
    `| 項目 | 内容 |`,
    `|---|---|`,
    `| 案件ID | ${caseId} |`,
    `| 作成日 | ${today} |`,
    `| ステータス | 初回提案 |`,
    ``,
    `---`,
    ``,
    `## お客様情報`,
    ``,
    `- お名前: ${data.name || "不明"}`,
    `- 会社名: ${data.company || "不明"}`,
    `- 業種: ${data.industry || "不明"}`,
    `- 所在地: ${data.prefecture || "不明"}`,
    `- チーム規模: ${data.team_size || "不明"}`,
    `- ご連絡先: ${data.email || ""} / ${data.phone_or_line || ""}`,
    ``,
    `## ご相談内容`,
    ``,
    `**${type}**`,
    ``,
    `${data.problem_detail || "詳細なし"}`,
    ``,
    data.reference_url ? `参考URL: ${data.reference_url}\n` : "",
    data.existing_url ? `既存サイト/SNS: ${data.existing_url}\n` : "",
    `## 現状分析`,
    ``,
    currentAnalysis,
    ``,
    `## ご提案`,
    ``,
    `### 技術スタック`,
    ``,
    techStack,
    ``,
    `### 機能一覧`,
    ``,
    features,
    ``,
    `### 概算見積もり`,
    ``,
    `| 項目 | 金額 |`,
    `|---|---|`,
    `| ${type}（設計+実装） | ¥${estimate.toLocaleString()} |`,
    `| 運用レクチャー | 含む |`,
    `| **合計** | **¥${estimate.toLocaleString()}** |`,
    ``,
    `※ 正式な見積もりはヒアリング後に作成いたします`,
    subsidyNote,
    `### スケジュール案`,
    ``,
    schedule,
    ``,
    `---`,
    ``,
    `## 次のステップ`,
    ``,
    `1. オンラインヒアリング（30分〜1時間）で詳細を確認`,
    `2. 正式見積もり・スケジュール提示`,
    `3. ご契約・着手`,
    ``,
    `---`,
    ``,
    `**SATOYAMA AI BASE**`,
    `山梨県大月市 ｜ Web: satoyama-ai-base.com`,
    `担当: 稲福 良祐 ｜ r.inafuku@tonari2tomaru.com`,
  ].filter(line => line !== "").join("\n");
}

// ========== 共有ページ HTML生成関数 ==========

const BRAND_CSS = `
  :root {
    --green: #2d5016;
    --green-light: #f0f5ec;
    --gold: #b8963e;
    --gold-light: #faf6ee;
    --text: #333;
    --text-muted: #777;
    --border: #e5e5e5;
    --bg: #fafaf8;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif; color: var(--text); background: var(--bg); line-height: 1.8; }
  .container { max-width: 800px; margin: 0 auto; padding: 24px 20px; }
  h1, h2, h3 { font-weight: 600; line-height: 1.4; }
  .brand-header { background: var(--green); color: #fff; padding: 20px 0; text-align: center; }
  .brand-header h1 { font-size: 14px; letter-spacing: 0.15em; font-weight: 400; }
  .brand-header .sub { font-size: 11px; opacity: 0.7; margin-top: 4px; letter-spacing: 0.1em; }
  .card { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  .badge { display: inline-block; background: var(--gold-light); color: var(--gold); font-size: 11px; padding: 3px 10px; border-radius: 20px; font-weight: 600; letter-spacing: 0.05em; }
  .section-title { font-size: 18px; color: var(--green); margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid var(--green-light); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  th { background: var(--green-light); color: var(--green); font-weight: 600; font-size: 12px; white-space: nowrap; }
  ul, ol { padding-left: 20px; }
  li { margin-bottom: 6px; font-size: 14px; }
  .footer { text-align: center; padding: 32px 20px; color: var(--text-muted); font-size: 12px; }
  .footer a { color: var(--green); text-decoration: none; }
  .btn { display: inline-block; background: var(--green); color: #fff; border: none; padding: 12px 32px; border-radius: 8px; font-size: 14px; cursor: pointer; text-decoration: none; letter-spacing: 0.05em; }
  .btn:hover { opacity: 0.9; }
  .btn-outline { background: transparent; color: var(--green); border: 1px solid var(--green); }
  .btn-outline:hover { background: var(--green-light); }
  @media (max-width: 600px) { .container { padding: 16px 12px; } .card { padding: 16px; } }
  @media print { .no-print { display: none; } .card { border: none; box-shadow: none; } }
`;

function renderPasswordPage(caseId, type) {
  const title = type === "proposal" ? "ご提案書" : "プレビュー確認";
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - SATOYAMA AI BASE</title>
<style>${BRAND_CSS}
  .pass-form { max-width: 360px; margin: 80px auto; text-align: center; }
  .pass-input { width: 100%; padding: 14px; border: 1px solid var(--border); border-radius: 8px; font-size: 16px; text-align: center; letter-spacing: 0.2em; margin: 16px 0; }
  .pass-input:focus { outline: none; border-color: var(--green); }
</style></head><body>
<div class="brand-header"><h1>SATOYAMA AI BASE</h1><div class="sub">DX支援サービス</div></div>
<div class="pass-form">
  <p style="font-size:14px;color:var(--text-muted);margin-bottom:8px">${title}の閲覧にはパスワードが必要です</p>
  <form onsubmit="location.href='/${type}/${encodeURIComponent(caseId)}?pass='+document.getElementById('p').value;return false;">
    <input id="p" class="pass-input" type="text" placeholder="パスワードを入力" autocomplete="off">
    <button type="submit" class="btn" style="width:100%">確認する</button>
  </form>
</div></body></html>`;
}

function renderMessagePage(title, message) {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - SATOYAMA AI BASE</title>
<style>${BRAND_CSS}</style></head><body>
<div class="brand-header"><h1>SATOYAMA AI BASE</h1><div class="sub">DX支援サービス</div></div>
<div class="container" style="text-align:center;padding-top:60px;">
  <h2 style="font-size:20px;margin-bottom:12px;">${title}</h2>
  <p style="color:var(--text-muted);font-size:14px;">${message}</p>
</div></body></html>`;
}

function markdownToHTML(md) {
  // 軽量Markdown→HTML変換（外部ライブラリ不要）
  let html = md;
  // 見出し
  html = html.replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="section-title">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 style="font-size:22px;color:var(--green);margin:24px 0 16px;">$1</h1>');
  // 太字
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // テーブル
  html = html.replace(/^\|(.+)\|$/gm, (match) => {
    const cells = match.split("|").filter(c => c.trim());
    return "<tr>" + cells.map(c => {
      const content = c.trim();
      if (content.match(/^[-:]+$/)) return null; // セパレーター行
      return `<td>${content}</td>`;
    }).filter(Boolean).join("") + "</tr>";
  });
  html = html.replace(/(<tr>[\s\S]*?<\/tr>\n?)+/g, (match) => {
    // セパレーター行を除去
    const rows = match.split("\n").filter(r => r.trim() && !r.includes("---"));
    if (rows.length === 0) return "";
    // 最初の行をヘッダーに
    const headerRow = rows[0].replace(/<td>/g, "<th>").replace(/<\/td>/g, "</th>");
    return `<table>${headerRow}${rows.slice(1).join("\n")}</table>`;
  });
  // リスト
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // 水平線
  html = html.replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid var(--border);margin:24px 0;">');
  // コードブロック
  html = html.replace(/```[\s\S]*?```/g, (match) => {
    const content = match.replace(/```\w*\n?/g, "").replace(/```/g, "");
    return `<pre style="background:var(--green-light);padding:16px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.6;"><code>${content}</code></pre>`;
  });
  // 段落（空行区切り）
  html = html.replace(/\n\n/g, '</p><p>');
  // 残りの改行
  html = html.replace(/\n/g, '<br>');
  return `<p>${html}</p>`;
}

function renderProposalHTML(hearingData, proposalMd, caseId) {
  const clientName = hearingData.company || hearingData.name || "お客様";
  const proposalHTML = markdownToHTML(proposalMd);
  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${clientName} 様 ご提案書 - SATOYAMA AI BASE</title>
<style>${BRAND_CSS}
  .md-h3 { font-size: 16px; color: var(--green); margin: 20px 0 10px; }
  .proposal-header { text-align: center; padding: 40px 20px 24px; }
  .proposal-header .to { font-size: 20px; color: var(--green); margin-bottom: 8px; }
  .proposal-header .date { font-size: 12px; color: var(--text-muted); }
  .proposal-body p { font-size: 14px; margin-bottom: 12px; }
  .proposal-body ul { margin-bottom: 16px; }
  .proposal-body table { margin: 12px 0 20px; }
</style></head><body>
<div class="brand-header">
  <h1>SATOYAMA AI BASE</h1>
  <div class="sub">AI活用 DX支援サービス</div>
</div>
<div class="container">
  <div class="proposal-header">
    <div class="to">${clientName} 様</div>
    <h2 style="font-size: 24px; color: var(--green); margin: 8px 0;">ご提案書</h2>
    <div class="date">作成日: ${dateStr}</div>
  </div>
  <div class="card proposal-body">
    ${proposalHTML}
  </div>
  <div class="card no-print" style="text-align:center;">
    <p style="font-size:14px;color:var(--text-muted);margin-bottom:16px;">ご不明な点やご要望がございましたら、お気軽にご連絡ください。</p>
    <a href="mailto:r.inafuku@tonari2tomaru.com" class="btn">お問い合わせ</a>
  </div>
  <div class="footer">
    <p><strong>SATOYAMA AI BASE</strong></p>
    <p>山梨県大月市 ｜ <a href="https://satoyama-ai-base.com">satoyama-ai-base.com</a></p>
    <p>担当: 稲福 良祐 ｜ r.inafuku@tonari2tomaru.com</p>
  </div>
</div></body></html>`;
}

function renderPreviewHTML(hearingData, statusData, comments, caseId, pass) {
  const clientName = hearingData.company || hearingData.name || "お客様";
  const deployUrl = statusData.deployUrl || "";
  const commentsHtml = comments.map(c => {
    const d = new Date(c.timestamp);
    const time = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `<div style="padding:12px 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <strong style="font-size:13px;">${c.name}</strong>
        <span style="font-size:11px;color:var(--text-muted);">${time}</span>
      </div>
      <p style="font-size:14px;white-space:pre-wrap;">${c.message}</p>
    </div>`;
  }).join("");

  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${clientName} 様 プレビュー確認 - SATOYAMA AI BASE</title>
<style>${BRAND_CSS}
  .preview-frame { width: 100%; height: 70vh; min-height: 500px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .device-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
  .device-tab { padding: 6px 16px; border: 1px solid var(--border); border-radius: 6px; background: #fff; cursor: pointer; font-size: 13px; }
  .device-tab.active { background: var(--green); color: #fff; border-color: var(--green); }
  textarea { width: 100%; padding: 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; resize: vertical; min-height: 100px; font-family: inherit; }
  textarea:focus { outline: none; border-color: var(--green); }
  .comment-input { display: flex; gap: 8px; margin-bottom: 12px; }
  .comment-input input { flex: 1; padding: 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; }
  .comment-input input:focus { outline: none; border-color: var(--green); }
  .status-pill { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .success-msg { display: none; background: var(--green-light); color: var(--green); padding: 12px; border-radius: 8px; font-size: 14px; margin-top: 12px; }
</style></head><body>
<div class="brand-header">
  <h1>SATOYAMA AI BASE</h1>
  <div class="sub">プレビュー確認ページ</div>
</div>
<div class="container">
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div>
        <h2 style="font-size:18px;color:var(--green);">${clientName} 様</h2>
        <p style="font-size:12px;color:var(--text-muted);">案件ID: ${caseId}</p>
      </div>
      <span class="status-pill" style="background:var(--green-light);color:var(--green);">プレビュー確認中</span>
    </div>
    <p style="font-size:14px;color:var(--text-muted);margin-bottom:16px;">
      下記がお客様のWebサイトのプレビューです。デザインや内容をご確認いただき、<br>
      修正のご要望がありましたら、下のコメント欄からお送りください。
    </p>

    <div class="device-tabs no-print">
      <button class="device-tab active" onclick="setDevice('100%')">PC</button>
      <button class="device-tab" onclick="setDevice('430px')">スマホ</button>
      <button class="device-tab" onclick="setDevice('768px')">タブレット</button>
    </div>
    <div style="display:flex;justify-content:center;background:#f5f5f5;border-radius:12px;padding:8px;">
      <iframe id="previewFrame" src="${deployUrl}" class="preview-frame" style="transition:width 0.3s;"></iframe>
    </div>
    <p style="font-size:12px;color:var(--text-muted);margin-top:8px;text-align:center;">
      <a href="${deployUrl}" target="_blank" style="color:var(--green);">新しいタブで開く</a>
    </p>
  </div>

  <div class="card">
    <h3 class="section-title">修正・ご要望</h3>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">気になる点やご要望をお気軽にお書きください。担当者に直接届きます。</p>
    <div class="comment-input">
      <input type="text" id="commentName" placeholder="お名前" value="${hearingData.name || ""}">
    </div>
    <textarea id="commentMsg" placeholder="例: トップ画像をもう少し明るい雰囲気にしてほしい、メニューの順番を変えたい、など"></textarea>
    <div style="margin-top:12px;display:flex;justify-content:flex-end;">
      <button class="btn" onclick="sendComment()">送信する</button>
    </div>
    <div id="successMsg" class="success-msg">コメントを送信しました。担当者が確認次第、対応いたします。</div>
  </div>

  ${comments.length > 0 ? `<div class="card">
    <h3 class="section-title">これまでのコメント</h3>
    ${commentsHtml}
  </div>` : ""}

  <div class="footer">
    <p><strong>SATOYAMA AI BASE</strong></p>
    <p>山梨県大月市 ｜ <a href="https://satoyama-ai-base.com">satoyama-ai-base.com</a></p>
    <p>担当: 稲福 良祐 ｜ r.inafuku@tonari2tomaru.com</p>
  </div>
</div>

<script>
function setDevice(w) {
  document.getElementById('previewFrame').style.width = w;
  document.querySelectorAll('.device-tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
}
async function sendComment() {
  const name = document.getElementById('commentName').value.trim();
  const message = document.getElementById('commentMsg').value.trim();
  if (!message) { alert('コメントを入力してください'); return; }
  try {
    const res = await fetch('/api/dx-cases/${encodeURIComponent(caseId)}/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, message, pass: '${pass}' }),
    });
    if (res.ok) {
      document.getElementById('commentMsg').value = '';
      document.getElementById('successMsg').style.display = 'block';
      setTimeout(() => { document.getElementById('successMsg').style.display = 'none'; }, 5000);
    } else { alert('送信に失敗しました。もう一度お試しください。'); }
  } catch (e) { alert('通信エラーが発生しました。'); }
}
</script></body></html>`;
}

// 統合DB初期化 → データ取り込み → 自律判断エンジン
unifiedApi.init().then(async () => {
  console.log("[startup] 統合DB初期化完了");
  // プッシュ通知コールバック（action_needed以上の気づきを通知）
  const onInsight = async (insight) => {
    const typeLabel = { anomaly: "📊", suggestion: "💡", reminder: "🔔", alert: "⚠️" };
    const icon = typeLabel[insight.type] || "📋";
    await sendWebPush(
      `${icon} ${insight.title}`,
      insight.detail || "",
      { url: "/" }
    );
    console.log(`[push] 気づき通知送信: ${insight.title}`);
  };

  // 起動時にデータを取り込み（プッシュ通知なし — 再起動のたびに通知が飛ぶのを防ぐ）
  await dataIngester.ingestAll();
  await agentEvaluator.evaluate(); // onInsightなし = プッシュ通知なし
  console.log("[startup] データ取り込み＋判断エンジン完了（起動時は通知なし）");

  // 定期実行: 15分ごとにデータ取り込み＋判断
  setInterval(async () => {
    try {
      await dataIngester.ingestAll();
      await agentEvaluator.evaluate({ onInsight });
    } catch (err) {
      console.error("[periodic] 定期取り込みエラー:", err.message);
    }
  }, 15 * 60 * 1000);
}).catch(err => {
  console.error("[startup] 統合DB初期化エラー（サーバーは起動を継続）:", err.message);
});

server.listen(PORT, () => {
  console.log(`LINE Webhook server running on port ${PORT}`);
  console.log(`Conversation timeout: ${CONVERSATION_TIMEOUT / 1000}s`);
  console.log(`Claude timeout: ${CLAUDE_TIMEOUT / 1000}s`);
  console.log(`Event reminders: every 5 minutes`);
});
