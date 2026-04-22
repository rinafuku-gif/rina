#!/usr/bin/env node
/**
 * notion-task-inject.js — テキストからNotionタスクを作成
 *
 * 用途:
 *   - 音声文字起こし or iPhoneテキスト入力 → Notion Task DB にタスク投入
 *   - voice-webhook.sh / voice-pipeline.sh から呼ばれる
 *
 * 検出ルール:
 *   行頭に「タスク:」「TODO:」「やること:」「todo:」のいずれかがあれば task と判定
 *   マーカー以降を本文として扱う（最初の改行までをタイトル、それ以降は本文）
 *
 * 日付抽出（タイトルから）:
 *   今日 / 明日 / 明後日 / N日後 / 来週◯曜 / M/D / M月D日
 *
 * GTD自動判定:
 *   日付あり + 7日以内 → 次にやること
 *   日付あり + 8日以上先 → 日付指定
 *   日付なし → Inbox
 *
 * Usage:
 *   node notion-task-inject.js "タスク: 明日までに都留信金に電話"
 *   echo "..." | node notion-task-inject.js --stdin
 *   node notion-task-inject.js --check "text"  # 判定のみ、Notion投入しない
 *
 * Exit codes:
 *   0 — タスク投入成功 or タスクではない（通常フロー続行可）
 *   1 — エラー
 *   2 — タスクとして検出したが投入失敗（呼び出し側でハンドリング）
 *
 * Return (stdout JSON):
 *   { detected: true/false, created?: true, page_url?, title?, gtd?, date? }
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

const ENV_FILE = path.join(os.homedir(), "rina", ".env");
const DATABASE_ID = "500a3ff0-900d-4933-ba83-b511102f6779";

function loadEnv() {
  const env = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const ENV = loadEnv();
// しらたま専用integration secretを優先。フォールバックで共有キー
const NOTION_API_KEY =
  ENV.SHIRATAMA_NOTION_API_KEY || process.env.SHIRATAMA_NOTION_API_KEY ||
  ENV.NOTION_API_KEY || process.env.NOTION_API_KEY;

// ---- Task marker detection ----
const TASK_MARKER_RE = /^\s*(?:タスク|ToDo|TODO|todo|やること|やる事|task|Task|TASK)\s*[:：]\s*(.+)$/s;

function detectTask(text) {
  const m = TASK_MARKER_RE.exec(text || "");
  if (!m) return null;
  const body = m[1].trim();
  const lines = body.split(/\n/);
  const title = lines[0].trim();
  const detail = lines.slice(1).join("\n").trim();
  return { title, detail };
}

// ---- Date extraction ----
function pad(n) { return String(n).padStart(2, "0"); }
function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function extractDate(title) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // 今日 / 本日
  if (/今日|本日/.test(title)) return toISO(today);
  // 明日
  if (/明日|あした|あす/.test(title)) { const d = new Date(today); d.setDate(d.getDate() + 1); return toISO(d); }
  // 明後日
  if (/明後日|あさって/.test(title)) { const d = new Date(today); d.setDate(d.getDate() + 2); return toISO(d); }
  // N日後
  let m = title.match(/(\d+)日後/);
  if (m) { const d = new Date(today); d.setDate(d.getDate() + parseInt(m[1])); return toISO(d); }
  // 来週◯曜
  m = title.match(/来週[のの]*([月火水木金土日])曜?/);
  if (m) {
    const targetDow = "日月火水木金土".indexOf(m[1]);
    const d = new Date(today); d.setDate(d.getDate() + 7);
    while (d.getDay() !== targetDow) d.setDate(d.getDate() + 1);
    return toISO(d);
  }
  // 今週◯曜
  m = title.match(/今週[のの]*([月火水木金土日])曜?/);
  if (m) {
    const targetDow = "日月火水木金土".indexOf(m[1]);
    const d = new Date(today);
    while (d.getDay() !== targetDow) d.setDate(d.getDate() + 1);
    return toISO(d);
  }
  // M/D or M月D日（年またぎ対応: 過去日なら翌年とみなす）
  m = title.match(/(\d{1,2})\s*[\/／月]\s*(\d{1,2})日?/);
  if (m) {
    const month = parseInt(m[1]);
    const day = parseInt(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let year = today.getFullYear();
      const candidate = new Date(year, month - 1, day);
      if (candidate < today) { year += 1; candidate.setFullYear(year); }
      return toISO(candidate);
    }
  }
  return null;
}

function daysBetween(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate + "T00:00:00+09:00");
  const today = new Date(toISO(new Date()) + "T00:00:00+09:00");
  return Math.round((d - today) / 86400000);
}

function determineGtd(isoDate) {
  if (!isoDate) return "Inbox";
  const diff = daysBetween(isoDate);
  if (diff < 0 || diff <= 7) return "次にやること";
  return "日付指定";
}

// ---- Tag inference ----
const TAG_KEYWORDS = {
  "三十日珈琲": ["三十日", "misoca", "焙煎", "コーヒー", "珈琲"],
  "えんがわ": ["えんがわ", "engawa", "古民家", "ハウススタジオ", "梁川"],
  "蔵サウナ": ["蔵サウナ", "任屋", "都留信金", "大神田", "蔵"],
  "Basecamp Torisawa": ["basecamp", "鳥沢", "Airbnb登録", "OTA"],
  "SATOYAMA AI BASE": ["satoyama", "SAB", "AIベース", "DX", "ハヤリ"],
  "プライベート": ["まりえ", "個人", "プライベート", "西神"],
  "全般": [],
};
function inferTags(text) {
  const tags = [];
  for (const [tag, keywords] of Object.entries(TAG_KEYWORDS)) {
    if (keywords.some((k) => text.includes(k))) tags.push(tag);
  }
  return tags.length ? tags : [];
}

// ---- Notion API ----
function notionCreate(page) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(page);
    const req = https.request({
      hostname: "api.notion.com",
      path: "/v1/pages",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(buf);
          if (res.statusCode >= 400) reject(new Error(`Notion ${res.statusCode}: ${buf.slice(0, 300)}`));
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function injectTask(detected) {
  const isoDate = extractDate(detected.title);
  const gtd = determineGtd(isoDate);
  const tags = inferTags(detected.title + " " + (detected.detail || ""));

  const properties = {
    "タスク名": { title: [{ text: { content: detected.title.slice(0, 200) } }] },
    "GTD": { status: { name: gtd } },
    "担当者": { select: { name: "稲福" } },
    "対応場所": { select: { name: "オンライン" } },
    "カテゴリ": { select: { name: "その他" } },
  };
  if (isoDate) properties["行動予定日"] = { date: { start: isoDate } };
  if (tags.length) properties["タグ"] = { multi_select: tags.map((name) => ({ name })) };

  const children = [];
  if (detected.detail) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: "【音声メモより】\n" + detected.detail } }] },
    });
  }
  children.push({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: `投入時刻: ${new Date().toISOString()} (Catchy経由)` } }] },
  });

  const page = {
    parent: { database_id: DATABASE_ID },
    properties,
    children,
  };
  const result = await notionCreate(page);
  return { page_url: result.url, page_id: result.id, gtd, date: isoDate, tags };
}

// ---- Main ----
async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const fromStdin = args.includes("--stdin");

  let text = "";
  if (fromStdin) {
    text = fs.readFileSync(0, "utf8");
  } else {
    text = args.filter((a) => !a.startsWith("--")).join(" ");
  }
  text = (text || "").trim();

  const detected = detectTask(text);
  if (!detected) {
    console.log(JSON.stringify({ detected: false }));
    process.exit(0);
  }

  if (checkOnly) {
    const isoDate = extractDate(detected.title);
    console.log(JSON.stringify({
      detected: true,
      title: detected.title,
      detail: detected.detail || null,
      date: isoDate,
      gtd: determineGtd(isoDate),
      tags: inferTags(detected.title + " " + (detected.detail || "")),
    }));
    process.exit(0);
  }

  if (!NOTION_API_KEY) {
    console.error("NOTION_API_KEY not found");
    process.exit(1);
  }

  try {
    const result = await injectTask(detected);
    console.log(JSON.stringify({
      detected: true,
      created: true,
      title: detected.title,
      ...result,
    }));
    process.exit(0);
  } catch (err) {
    console.error("Task inject failed:", err.message);
    console.log(JSON.stringify({
      detected: true,
      created: false,
      error: err.message,
    }));
    process.exit(2);
  }
}

main();
