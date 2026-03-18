/**
 * task-engine.js — タスク統合エンジン
 *
 * 複数の情報ソースから「今日のアクション」を自動収集し、today.json を生成する。
 * 実行タイミング: 朝7時（ブリーフィング前）+ 手動トリガー
 *
 * Phase 1: Calendar + Airbnb Bookings + deadlines.json
 * Phase 2: Git repos + Notion
 * Phase 3: Gmail + Drive
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const REPO_DIR = path.join(__dirname, "..");
const TODAY_FILE = path.join(REPO_DIR, "data", "today.json");
const BOOKINGS_FILE = path.join(REPO_DIR, "logs", ".airbnb-bookings.json");
const DEADLINES_FILE = path.join(REPO_DIR, "data", "deadlines.json");

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

function genId() {
  return "act_" + crypto.randomBytes(4).toString("hex");
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

        const urgency = days === 0 ? "today" : days === 1 ? "today" : "upcoming";

        items.push({
          id: genId(),
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

  for (const b of bookings) {
    const ciDays = daysFromToday(b.checkin);
    const coDays = daysFromToday(b.checkout);

    // チェックイン今日
    if (ciDays === 0) {
      items.push({
        id: genId(),
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
    // チェックイン明日
    else if (ciDays === 1) {
      items.push({
        id: genId(),
        source: "airbnb",
        title: `明日ゲスト到着: ${b.guestName}（${b.guests}名・${b.room}）`,
        detail: `チェックイン ${b.checkin}`,
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
        id: genId(),
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

// --- Source: Deadlines ---
function extractDeadlineActions() {
  const items = [];

  let deadlines = [];
  try { deadlines = JSON.parse(fs.readFileSync(DEADLINES_FILE, "utf-8")).deadlines || []; } catch { return items; }

  for (const dl of deadlines) {
    if (dl.status === "完了") continue;
    const days = daysFromToday(dl.date);
    if (days < 0) {
      // 期限超過
      items.push({
        id: genId(),
        source: "deadline",
        title: `期限超過: ${dl.title}`,
        detail: `${dl.business} — ${dl.date}`,
        action: "acknowledge",
        actionLabel: "対応する",
        urgency: "urgent",
        date: dl.date,
        sortKey: `${dl.date}00:00`,
      });
    } else if (days <= 7) {
      items.push({
        id: genId(),
        source: "deadline",
        title: `${dl.title}（あと${days}日）`,
        detail: `${dl.business} — 期限 ${dl.date}`,
        action: null,
        actionLabel: null,
        urgency: days <= 2 ? "today" : "upcoming",
        date: dl.date,
        sortKey: `${dl.date}00:00`,
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
          id: genId(),
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
            id: genId(),
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

  const deadlineItems = extractDeadlineActions();
  allItems.push(...deadlineItems);
  console.log(`[task-engine] Deadlines: ${deadlineItems.length} items`);

  const gitItems = extractGitSummary();
  allItems.push(...gitItems);
  console.log(`[task-engine] Git: ${gitItems.length} items`);

  // セクションに分類
  const sections = [
    { type: "urgent", title: "今すぐ対応", items: allItems.filter(i => i.urgency === "urgent").sort((a, b) => a.sortKey.localeCompare(b.sortKey)) },
    { type: "today", title: "今日やること", items: allItems.filter(i => i.urgency === "today").sort((a, b) => a.sortKey.localeCompare(b.sortKey)) },
    { type: "upcoming", title: "近日中", items: allItems.filter(i => i.urgency === "upcoming").sort((a, b) => a.sortKey.localeCompare(b.sortKey)) },
    { type: "fyi", title: "参考情報", items: allItems.filter(i => i.urgency === "fyi") },
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
