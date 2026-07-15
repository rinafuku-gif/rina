/**
 * task-engine.js — タスク統合エンジン
 *
 * 複数の情報ソースから「今日のアクション」を自動収集し、today.json を生成する。
 * 実行タイミング: 朝7時（ブリーフィング前）+ 手動トリガー
 *
 * Sources: Calendar + Airbnb Bookings + Notion Task DB + Git + Gmail
 * Notion Task DB が期限・タスクの唯一の正本（deadlines.json は廃止済み）
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const REPO_DIR = path.join(__dirname, "..");
const TODAY_FILE = path.join(REPO_DIR, "data", "today.json");
const BOOKINGS_FILE = path.join(REPO_DIR, "logs", ".airbnb-bookings.json");
// .env
const envContent = fs.readFileSync(path.join(REPO_DIR, ".env"), "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

// --- Helpers ---
function todayStr() {
  const d = new Date();
  const jst = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, "0")}-${String(jst.getDate()).padStart(2, "0")}`;
}

function daysFromToday(dateStr) {
  const today = new Date(todayStr() + "T00:00:00+09:00");
  const target = new Date(dateStr + "T00:00:00+09:00");
  return Math.round((target - today) / 86400000);
}

function genId(source, title) {
  // 確定的ID: source + title + 今日の日付からハッシュ生成
  // 同じアイテムは何度生成しても同じIDを返す（dismiss永続化のため）
  const seed = `${source || ""}|${title || ""}|${todayStr()}`;
  return "act_" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8);
}

// --- Google API ---
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
        try { const d = JSON.parse(body); d.access_token ? resolve(d.access_token) : reject(new Error("No access token")); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function googleApiGet(url, token) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else { reject(new Error(`API ${res.statusCode}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// --- Notion API ---
function notionApiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const urlObj = new URL(`https://api.notion.com/v1/${endpoint}`);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NOTION_API_KEY}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
        "Content-Length": Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else { reject(new Error(`Notion API ${res.statusCode}: ${data.slice(0, 300)}`)); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// --- Source: Google Calendar ---
async function extractCalendarActions(gToken) {
  const items = [];
  const today = todayStr();
  const threeDaysLater = new Date(new Date(today + "T00:00:00+09:00").getTime() + 3 * 86400000);
  const timeMin = new Date(today + "T00:00:00+09:00").toISOString();
  const timeMax = threeDaysLater.toISOString();

  const calendarIds = [
    { id: "r.inafuku@tonari2tomaru.com", name: "プライベート" },
    { id: "9c0d4af92a70ced546b135411feda7120c9fd874beda1363874c03faf8953f18@group.calendar.google.com", name: "R&M共有" },
    { id: "misocacoffee@gmail.com", name: "三十日珈琲" },
  ];

  const seen = new Set();

  for (const cal of calendarIds) {
    try {
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&fields=items(id,summary,start,end,status)`;
      const result = await googleApiGet(url, gToken);
      if (!result.items) continue;

      for (const ev of result.items) {
        if (ev.status === "cancelled" || !ev.summary) continue;
        // (M)はRyoには関係ないのでスキップ
        if (ev.summary.startsWith("(M)") || ev.summary.startsWith("（M）")) continue;

        const title = ev.summary.replace(/^\(R\)\s*/, "").replace(/^\（R）\s*/, "");
        const isAllDay = !!ev.start.date;
        const eventDate = isAllDay ? ev.start.date : ev.start.dateTime.split("T")[0];
        const days = daysFromToday(eventDate);

        // 重複排除
        const dedup = `${title}|${eventDate}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);

        let time = "終日";
        if (!isAllDay) {
          const s = new Date(ev.start.dateTime).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
          const e = new Date(ev.end.dateTime).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
          time = `${s}-${e}`;
        }

        const urgency = days === 0 ? "today" : "upcoming";

        items.push({
          id: genId("calendar", `${eventDate}_${title}`),
          source: "calendar",
          title: days === 0 ? `${time} ${title}` : `${eventDate} ${time} ${title}`,
          detail: `${cal.name}`,
          action: days === 0 ? "acknowledge" : null,
          actionLabel: days === 0 ? "確認" : null,
          urgency,
          date: eventDate,
          sortKey: `${eventDate}${isAllDay ? "00:00" : time}`,
        });
      }
    } catch (e) {
      console.error(`[task-engine] Calendar error (${cal.name}):`, e.message);
    }
  }

  return items;
}

// --- Source: Airbnb Bookings ---
function extractBookingActions() {
  const items = [];
  const today = todayStr();

  let bookings = [];
  try { bookings = JSON.parse(fs.readFileSync(BOOKINGS_FILE, "utf-8")); } catch { return items; }
  // tombstone(status:"cancelled")化した予約は除外（legacyでstatus無しは有効扱いを維持）
  bookings = bookings.filter(b => b.status !== "cancelled");

  for (const b of bookings) {
    const ciDays = daysFromToday(b.checkin);
    const coDays = daysFromToday(b.checkout);

    // チェックイン今日
    if (ciDays === 0) {
      items.push({
        id: genId("airbnb", `ゲスト到着: ${b.guestName}（${b.guests}名・${b.room}）`),
        source: "airbnb",
        title: `ゲスト到着: ${b.guestName}（${b.guests}名・${b.room}）`,
        detail: `チェックイン今日`,
        action: "acknowledge",
        actionLabel: "準備OK",
        urgency: "urgent",
        date: b.checkin,
        sortKey: `${b.checkin}09:00`,
      });
    }
    // チェックイン明日（前日に清掃・リネン・買い出し等の物理的準備が必要）
    else if (ciDays === 1) {
      items.push({
        id: genId("airbnb", `明日ゲスト到着: ${b.guestName}（${b.guests}名・${b.room}）`),
        source: "airbnb",
        title: `明日ゲスト到着: ${b.guestName}（${b.guests}名・${b.room}）`,
        detail: `チェックイン ${b.checkin} — 今日のうちに準備`,
        action: null,
        actionLabel: null,
        urgency: "today",
        date: b.checkin,
        sortKey: `${b.checkin}09:00`,
      });
    }
    // チェックアウト今日
    if (coDays === 0) {
      items.push({
        id: genId("airbnb", `チェックアウト: ${b.guestName}（${b.room}）`),
        source: "airbnb",
        title: `チェックアウト: ${b.guestName}（${b.room}）`,
        detail: `清掃・リセット`,
        action: "acknowledge",
        actionLabel: "完了",
        urgency: "today",
        date: b.checkout,
        sortKey: `${b.checkout}11:00`,
      });
    }
  }

  return items;
}

// --- Source: Git Activity Summary ---
function extractGitSummary() {
  const items = [];
  const { execSync } = require("child_process");

  const REPOS = [
    { path: "/Users/Inaryo/hisho-shiratama", name: "しらたまPWA" },
    { path: "/Users/Inaryo/satoyama-ai-base", name: "SATOYAMA" },
    { path: "/Users/Inaryo/misoca-coffee", name: "三十日珈琲" },
    { path: "/Users/Inaryo/fate-decoder", name: "CoreCompass" },
    { path: "/Users/Inaryo/rina", name: "rina" },
  ];

  for (const repo of REPOS) {
    if (!fs.existsSync(repo.path)) continue;
    try {
      // 昨日のコミット数
      const count = execSync(
        `cd "${repo.path}" && git log --since="24 hours ago" --oneline 2>/dev/null | wc -l`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      const n = parseInt(count) || 0;

      if (n > 0) {
        const latest = execSync(
          `cd "${repo.path}" && git log -1 --format="%s" 2>/dev/null`,
          { encoding: "utf-8", timeout: 5000 }
        ).trim();
        items.push({
          id: genId("git", `${repo.name}: 直近${n}件のコミット`),
          source: "git",
          title: `${repo.name}: 直近${n}件のコミット`,
          detail: `最新: ${latest.slice(0, 60)}`,
          action: null,
          actionLabel: null,
          urgency: "fyi",
          date: todayStr(),
          sortKey: `${todayStr()}23:00`,
        });
      }

      // 7日以上コミットなし → 放置警告
      const lastCommitDate = execSync(
        `cd "${repo.path}" && git log -1 --format="%ai" 2>/dev/null`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      if (lastCommitDate) {
        const daysSince = daysFromToday(lastCommitDate.split(" ")[0]);
        if (daysSince < -14 && repo.name !== "rina") {
          items.push({
            id: genId("git", `${repo.name}: ${Math.abs(daysSince)}日間更新なし`),
            source: "git",
            title: `${repo.name}: ${Math.abs(daysSince)}日間更新なし`,
            detail: `最終コミット: ${lastCommitDate.split(" ")[0]}`,
            action: null,
            actionLabel: null,
            urgency: "fyi",
            date: todayStr(),
            sortKey: `${todayStr()}23:30`,
          });
        }
      }
    } catch {}
  }

  return items;
}

// --- Source: Notion Databases ---
async function extractNotionActions() {
  const items = [];
  if (!env.NOTION_API_KEY) {
    console.error("[task-engine] NOTION_API_KEY not set, skipping Notion");
    return items;
  }

  // 1. DXヒアリングDB — 完了・見送り以外のアクティブ案件
  const DX_HEARING_DB = "970d40a58c9f4db8b562c0d9196be4c4";
  try {
    const result = await notionApiPost(`databases/${DX_HEARING_DB}/query`, {
      filter: {
        and: [
          { property: "ステータス", select: { does_not_equal: "完了" } },
          { property: "ステータス", select: { does_not_equal: "見送り" } },
        ],
      },
    });
    for (const page of (result.results || [])) {
      const props = page.properties || {};
      // タイトル取得（名前 or タイトルプロパティを探す）
      let title = "DX案件";
      for (const key of Object.keys(props)) {
        const prop = props[key];
        if (prop.type === "title" && prop.title && prop.title.length > 0) {
          title = prop.title.map(t => t.plain_text).join("");
          break;
        }
      }
      // ステータス取得
      let status = "";
      if (props["ステータス"] && props["ステータス"].select) {
        status = props["ステータス"].select.name || "";
      }

      items.push({
        id: genId("notion", `DX案件: ${title}`),
        source: "notion",
        title: `DX案件: ${title}`,
        detail: status ? `ステータス: ${status}` : "アクティブ案件",
        action: null,
        actionLabel: null,
        urgency: "fyi",
        date: todayStr(),
        sortKey: `${todayStr()}22:00`,
      });
    }
  } catch (e) {
    console.error("[task-engine] Notion DX Hearing error:", e.message);
  }

  // 2. コンテンツDB — 下書き・非公開のアイテム
  const CONTENT_DB = "5db17e69ab3045bdb5099e33fbf4155f";
  try {
    const result = await notionApiPost(`databases/${CONTENT_DB}/query`, {
      filter: {
        or: [
          { property: "ステータス", select: { equals: "下書き" } },
          { property: "ステータス", select: { equals: "非公開" } },
        ],
      },
    });
    for (const page of (result.results || [])) {
      const props = page.properties || {};
      let title = "コンテンツ";
      for (const key of Object.keys(props)) {
        const prop = props[key];
        if (prop.type === "title" && prop.title && prop.title.length > 0) {
          title = prop.title.map(t => t.plain_text).join("");
          break;
        }
      }
      items.push({
        id: genId("notion", `下書き: ${title}`),
        source: "notion",
        title: `下書き: ${title}`,
        detail: "コンテンツDB — 公開待ち",
        action: null,
        actionLabel: null,
        urgency: "fyi",
        date: todayStr(),
        sortKey: `${todayStr()}22:10`,
      });
    }
  } catch (e) {
    // コンテンツDBにアクセスできない場合はスキップ（graceful failure）
    console.error("[task-engine] Notion Content DB error (skipped):", e.message);
  }

  // 3. 学習教材DB — 非公開のアイテム
  const LEARNING_DB = "fca921d948e7425396128e1fa135baf1";
  try {
    const result = await notionApiPost(`databases/${LEARNING_DB}/query`, {
      filter: {
        property: "ステータス",
        select: { equals: "非公開" },
      },
    });
    for (const page of (result.results || [])) {
      const props = page.properties || {};
      let title = "教材";
      for (const key of Object.keys(props)) {
        const prop = props[key];
        if (prop.type === "title" && prop.title && prop.title.length > 0) {
          title = prop.title.map(t => t.plain_text).join("");
          break;
        }
      }
      items.push({
        id: genId("notion", `下書き教材: ${title}`),
        source: "notion",
        title: `下書き教材: ${title}`,
        detail: "学習教材DB — 公開待ち",
        action: null,
        actionLabel: null,
        urgency: "fyi",
        date: todayStr(),
        sortKey: `${todayStr()}22:20`,
      });
    }
  } catch (e) {
    console.error("[task-engine] Notion Learning DB error (skipped):", e.message);
  }

  return items;
}

// --- Source: Gmail (未読重要メール) ---
async function extractGmailActions(gToken) {
  const items = [];
  if (!gToken) return items;

  try {
    const query = encodeURIComponent("is:unread is:important -from:automated@airbnb.com -from:noreply");
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=5`;
    const listResult = await googleApiGet(url, gToken);

    if (!listResult.messages || listResult.messages.length === 0) return items;

    for (const msg of listResult.messages) {
      try {
        const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`;
        const msgData = await googleApiGet(msgUrl, gToken);

        let subject = "(件名なし)";
        let from = "";
        if (msgData.payload && msgData.payload.headers) {
          for (const h of msgData.payload.headers) {
            if (h.name === "Subject") subject = h.value || subject;
            if (h.name === "From") from = h.value || "";
          }
        }

        // From表示を短くする（メールアドレス部分を省略）
        const fromName = from.replace(/<[^>]+>/, "").trim() || from;

        items.push({
          id: genId("gmail", subject),
          source: "gmail",
          title: subject,
          detail: fromName ? `From: ${fromName}` : "未読・重要メール",
          action: null,
          actionLabel: null,
          urgency: "today",
          date: todayStr(),
          sortKey: `${todayStr()}08:00`,
        });
      } catch (e) {
        console.error(`[task-engine] Gmail message fetch error:`, e.message);
      }
    }
  } catch (e) {
    console.error("[task-engine] Gmail search error:", e.message);
  }

  return items;
}

// --- Source: Notion Task DB (GTDタスク管理 — 唯一の正本) ---
async function extractNotionTaskActions() {
  const items = [];
  if (!env.NOTION_API_KEY) return items;

  const TASK_DB = "500a3ff0900d4933ba83b511102f6779";
  const today = todayStr();

  // アクティブなGTDステータスのフィルタ（完了系を除外）
  const activeGtdFilter = {
    or: [
      { property: "GTD", status: { equals: "次にやること" } },
      { property: "GTD", status: { equals: "進行中" } },
      { property: "GTD", status: { equals: "日付指定" } },
      { property: "GTD", status: { equals: "Inbox" } },
    ],
  };

  // Notionページからタスク情報を抽出する共通関数
  function parseTaskPage(page) {
    const props = page.properties || {};

    let title = "タスク";
    for (const key of Object.keys(props)) {
      const prop = props[key];
      if (prop.type === "title" && prop.title && prop.title.length > 0) {
        title = prop.title.map(t => t.plain_text).join("");
        break;
      }
    }

    let gtd = "";
    if (props["GTD"] && props["GTD"].status) {
      gtd = props["GTD"].status.name || "";
    }

    let actionDate = null;
    if (props["行動予定日"] && props["行動予定日"].date && props["行動予定日"].date.start) {
      actionDate = props["行動予定日"].date.start;
    }

    let tags = [];
    if (props["タグ"] && props["タグ"].multi_select) {
      tags = props["タグ"].multi_select.map(t => t.name);
    }

    let category = "";
    if (props["カテゴリ"] && props["カテゴリ"].select) {
      category = props["カテゴリ"].select.name || "";
    }

    return { title, gtd, actionDate, tags, category };
  }

  // Query 1: 期限超過タスク（行動予定日が今日より前 + アクティブ）
  try {
    const overdueResult = await notionApiPost(`databases/${TASK_DB}/query`, {
      filter: {
        and: [
          activeGtdFilter,
          { property: "行動予定日", date: { before: today } },
        ],
      },
      sorts: [{ property: "行動予定日", direction: "ascending" }],
    });

    for (const page of (overdueResult.results || [])) {
      const { title, gtd, actionDate, tags } = parseTaskPage(page);
      if (!actionDate) continue;

      const days = daysFromToday(actionDate);
      const tagStr = tags.length > 0 ? `[${tags.join("/")}] ` : "";

      items.push({
        id: genId("notion-task", title),
        source: "notion-task",
        title: `${tagStr}${title}`,
        detail: `${gtd} — 期限超過（D${days}） ${actionDate}`,
        action: "acknowledge",
        actionLabel: "対応する",
        urgency: "urgent",
        date: actionDate,
        sortKey: `${actionDate}00:00`,
      });
    }
    console.log(`[task-engine] Notion Tasks (overdue): ${overdueResult.results?.length || 0} items`);
  } catch (e) {
    console.error("[task-engine] Notion Task DB (overdue) error:", e.message);
  }

  // Query 2: 今日以降のタスク（既存ロジック）
  try {
    const result = await notionApiPost(`databases/${TASK_DB}/query`, {
      filter: {
        and: [
          activeGtdFilter,
          { property: "行動予定日", date: { on_or_after: today } },
        ],
      },
      sorts: [{ property: "行動予定日", direction: "ascending" }],
    });

    for (const page of (result.results || [])) {
      const { title, gtd, actionDate, tags } = parseTaskPage(page);
      const date = actionDate || today;

      const days = daysFromToday(date);
      const urgency = gtd === "次にやること" ? "today" : days === 0 ? "today" : "upcoming";
      const tagStr = tags.length > 0 ? `[${tags.join("/")}] ` : "";

      items.push({
        id: genId("notion-task", title),
        source: "notion-task",
        title: `${tagStr}${title}`,
        detail: `${gtd} — ${date}`,
        action: gtd === "次にやること" ? "acknowledge" : null,
        actionLabel: gtd === "次にやること" ? "着手" : null,
        urgency,
        date,
        sortKey: `${date}${urgency === "today" ? "10:00" : "18:00"}`,
      });
    }
    console.log(`[task-engine] Notion Tasks (current): ${result.results?.length || 0} items`);
  } catch (e) {
    console.error("[task-engine] Notion Task DB error:", e.message);
  }

  return items;
}

// --- Main Engine ---
async function generateToday() {
  console.log("[task-engine] Generating today.json...");
  const today = todayStr();

  let gToken;
  try {
    gToken = await getGoogleAccessToken();
  } catch (e) {
    console.error("[task-engine] Google auth failed:", e.message);
    gToken = null;
  }

  // 各ソースから収集
  const allItems = [];

  if (gToken) {
    const calItems = await extractCalendarActions(gToken);
    allItems.push(...calItems);
    console.log(`[task-engine] Calendar: ${calItems.length} items`);
  }

  const bookingItems = extractBookingActions();
  allItems.push(...bookingItems);
  console.log(`[task-engine] Bookings: ${bookingItems.length} items`);

  const gitItems = extractGitSummary();
  allItems.push(...gitItems);
  console.log(`[task-engine] Git: ${gitItems.length} items`);

  // Notion (DX/Content/Learning DBs)
  try {
    const notionItems = await extractNotionActions();
    allItems.push(...notionItems);
    console.log(`[task-engine] Notion: ${notionItems.length} items`);
  } catch (e) {
    console.error("[task-engine] Notion failed:", e.message);
  }

  // Notion Task DB (GTDタスク管理)
  try {
    const taskDbItems = await extractNotionTaskActions();
    allItems.push(...taskDbItems);
    console.log(`[task-engine] Notion Tasks: ${taskDbItems.length} items`);
  } catch (e) {
    console.error("[task-engine] Notion Tasks failed:", e.message);
  }

  // Gmail
  if (gToken) {
    try {
      const gmailItems = await extractGmailActions(gToken);
      allItems.push(...gmailItems);
      console.log(`[task-engine] Gmail: ${gmailItems.length} items`);
    } catch (e) {
      console.error("[task-engine] Gmail failed:", e.message);
    }
  }

  // セクションに分類
  const sections = [
    { type: "urgent", title: "今すぐ対応", items: allItems.filter(i => i.urgency === "urgent").sort((a, b) => a.sortKey.localeCompare(b.sortKey)) },
    { type: "today", title: "今日やること", items: allItems.filter(i => i.urgency === "today").sort((a, b) => a.sortKey.localeCompare(b.sortKey)) },
    { type: "upcoming", title: "近日中", items: allItems.filter(i => i.urgency === "upcoming").sort((a, b) => a.sortKey.localeCompare(b.sortKey)) },
    // fyi（参考情報）はホーム画面に表示しない。ブリーフィングのみで使用
  ].filter(s => s.items.length > 0);

  const urgentCount = allItems.filter(i => i.urgency === "urgent").length;
  const todayCount = allItems.filter(i => i.urgency === "today").length;

  const data = {
    date: today,
    generatedAt: new Date().toISOString(),
    acknowledged: false,
    sections,
    stats: {
      urgent: urgentCount,
      today: todayCount,
      upcoming: allItems.filter(i => i.urgency === "upcoming").length,
      total: allItems.length,
      badgeCount: urgentCount + todayCount,
    },
  };

  fs.writeFileSync(TODAY_FILE, JSON.stringify(data, null, 2));
  console.log(`[task-engine] Generated: ${allItems.length} items (urgent: ${urgentCount}, today: ${todayCount})`);

  return data;
}

module.exports = { generateToday };

// CLI
if (require.main === module) {
  generateToday()
    .then(data => {
      console.log(`\n=== today.json ===`);
      for (const s of data.sections) {
        console.log(`\n[${s.title}] ${s.items.length}件`);
        for (const item of s.items) {
          const action = item.actionLabel ? ` → [${item.actionLabel}]` : "";
          console.log(`  ${item.source}: ${item.title}${action}`);
        }
      }
    })
    .catch(e => console.error("Failed:", e.message));
}
