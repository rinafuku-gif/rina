#!/usr/bin/env node
/**
 * receipt-watcher.js — レシート画像のローカルDriveフォルダ監視 → Claude CLI OCR → Sheets/Drive記入
 *
 * iOSショートカットがGoogle Driveの「受信箱」フォルダに画像を保存
 * → Google Driveデスクトップアプリがローカルに同期
 * → このスクリプトが検知してOCR処理 → Sheets書き込み → 処理済みフォルダに移動
 */

const chokidar = require("chokidar");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");

// ── 設定 ──────────────────────────────────────────
const REPO_DIR = path.join(__dirname, "..");
const envPath = path.join(REPO_DIR, ".env");
const envContent = fs.readFileSync(envPath, "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

const DRIVE_BASE = "/Users/ocmm/Library/CloudStorage/GoogleDrive-r.inafuku@tonari2tomaru.com/マイドライブ/60_経理・財務/経費レシート（AI秘書管理）";
const INBOX_DIR = path.join(DRIVE_BASE, "📥レシート受信箱");
const CLAUDE_PATH = "/Users/ocmm/.local/share/mise/installs/node/24.14.0/bin/claude";
const CLAUDE_TIMEOUT = 480000; // 8分

// 処理状態管理
const LOCK_DIR = path.join(REPO_DIR, "logs", ".receipt-locks");
if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });

// 処理キュー（Claude CLIは同時1つまで）
const queue = [];
let processing = false;

// Web Push
let webpush;
try {
  webpush = require("web-push");
  webpush.setVapidDetails(
    "mailto:r.inafuku@tonari2tomaru.com",
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );
} catch { webpush = null; }

const SUBSCRIPTIONS_FILE = path.join(REPO_DIR, "logs", ".push-subscriptions.json");

// ── ユーティリティ ──────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function isImageFile(filePath) {
  return /\.(jpg|jpeg|heic|png)$/i.test(filePath);
}

/** ファイル名からbusiness名を抽出: "{business}_{timestamp}.jpg" */
function extractBusiness(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const parts = base.split("_");
  if (parts.length >= 2) return parts[0];
  return "";
}

/** ロックファイルで二重処理防止 */
function tryLock(filePath) {
  const lockFile = path.join(LOCK_DIR, crypto.createHash("md5").update(filePath).digest("hex") + ".lock");
  if (fs.existsSync(lockFile)) {
    // 1時間以上前のロックは古いので削除
    const stat = fs.statSync(lockFile);
    if (Date.now() - stat.mtimeMs > 3600000) {
      fs.unlinkSync(lockFile);
    } else {
      return false;
    }
  }
  fs.writeFileSync(lockFile, new Date().toISOString());
  return true;
}

function releaseLock(filePath) {
  const lockFile = path.join(LOCK_DIR, crypto.createHash("md5").update(filePath).digest("hex") + ".lock");
  try { fs.unlinkSync(lockFile); } catch {}
}

// ── Google API ──────────────────────────────────

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

const _folderLocks = {};
async function getOrCreateMonthFolder(parentFolderId, token, dateStr) {
  const d = dateStr ? new Date(dateStr + "T00:00:00") : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const folderName = `${year}年${month}月`;

  if (_folderLocks[folderName]) return _folderLocks[folderName];

  const promise = (async () => {
    const query = encodeURIComponent(`name='${folderName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const searchResult = await googleApiRequest("GET",
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`,
      null, token, null);

    if (searchResult.files && searchResult.files.length > 0) return searchResult.files[0].id;

    const newFolder = await googleApiRequest("POST",
      "https://www.googleapis.com/drive/v3/files",
      JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder", parents: [parentFolderId] }),
      token, "application/json");
    log(`Created month folder: ${folderName} (${newFolder.id})`);
    return newFolder.id;
  })();

  _folderLocks[folderName] = promise;
  try { return await promise; } finally { delete _folderLocks[folderName]; }
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

  return new Promise((resolve, reject) => {
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
}

async function appendToSheet(sheetId, sheetName, values, token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}!A:Z:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  return googleApiRequest("POST", url, JSON.stringify({ values: [values] }), token, "application/json");
}

// ── 通知 ──────────────────────────────────────

async function sendWebPushNotification(title, body) {
  if (!webpush) return;
  let subs;
  try { subs = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, "utf-8")); } catch { return; }
  const payload = JSON.stringify({ title, body });
  const expired = [];
  for (let i = 0; i < subs.length; i++) {
    try { await webpush.sendNotification(subs[i], payload); }
    catch (e) { if (e.statusCode === 410 || e.statusCode === 404) expired.push(i); }
  }
  if (expired.length > 0) {
    const cleaned = subs.filter((_, i) => !expired.includes(i));
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(cleaned, null, 2));
  }
}

// Discord Bot API でメッセージ送信
const DISCORD_BOT_TOKEN = (() => {
  try {
    const envFile = fs.readFileSync(path.join(require("os").homedir(), ".claude", "channels", "discord", ".env"), "utf-8");
    const m = envFile.match(/^DISCORD_BOT_TOKEN=(.+)$/m);
    return m ? m[1].trim() : "";
  } catch { return ""; }
})();
// const DISCORD_CHANNEL_ID = "1485836971191566488"; // 旧チャンネル（ロールバック用）
const DISCORD_CHANNEL_ID = "1486651097157472307"; // #notifications チャンネル

function sendDiscordMessage(text) {
  if (!DISCORD_BOT_TOKEN) { log("Discord token not found, skipping notification"); return; }
  const data = JSON.stringify({ content: text.slice(0, 2000) });
  const req = https.request({
    hostname: "discord.com",
    path: `/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Length": Buffer.byteLength(data),
    },
  }, (res) => {
    if (res.statusCode >= 400) {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => log(`Discord API error ${res.statusCode}: ${body.slice(0, 200)}`));
    }
  });
  req.on("error", (e) => log(`Discord send error: ${e.message}`));
  req.write(data);
  req.end();
}

// ── Claude CLI OCR ──────────────────────────────

function runClaudeCLI(promptFile, cwd) {
  return new Promise((resolve, reject) => {
    const execEnv = { ...process.env,
      PATH: `/Users/ocmm/.local/share/mise/installs/node/24.14.0/bin:/Users/ocmm/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: "/Users/ocmm",
    };
    delete execEnv.CLAUDECODE;
    delete execEnv.ANTHROPIC_API_KEY; // 無効なAPIキーがあるとOAuth認証が使われないため除外

    const child = spawn("sh", ["-c", `cat "${promptFile}" | "${CLAUDE_PATH}" -p --model claude-sonnet-4-6 --dangerously-skip-permissions`], {
      cwd,
      env: execEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Claude CLI timeout"));
    }, CLAUDE_TIMEOUT);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Claude CLI exit ${code}: ${stderr.slice(0, 500)}`));
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// ── OCRプロンプト生成 ──────────────────────────

function buildOcrPrompt(imagePath) {
  return `以下のレシート画像を Read ツールで読み取り、正確にOCRしてください。
ファイルパス: ${imagePath}

## 最重要: 正確なOCR
画像内のテキストを一文字ずつ正確に読み取ること。推測や補完はしない。

### 手書き・古い形式の領収証への対応
- 手書き文字は慎重に読む。不明瞭な文字は前後の文脈から判断する
- 領収証（手書き伝票形式）の場合、一番上に大きく書かれた施設名・店名を必ず読み取る
- 印鑑・ゴム印に含まれる文字も店名の手がかりになる
- 手書きの数字は特に注意: 0/6、1/7、5/6、2/3 の区別を慎重に

### 日付の読み取り（最優先）
- レシートに印字されている日付を**そのまま**読み取る
- 必ずレシート上の年月日を確認する。今日の日付を入れてはいけない
- 今日は${new Date().toISOString().split("T")[0]}。最近のレシートなら2026年の可能性が高い
- 令和の変換: R7 = 2025年、R8 = 2026年。「R7」「令和7年」は2025、「R8」「令和8年」は2026
- 「2025年12月19日」→ "2025-12-19"、「R8.3.7」→ "2026-03-07"、「26/03/21」→ "2026-03-21"
- 年が省略されている場合（例: 3/19）、現在が2026年3月なので "2026-03-19" とする
- 手書きの年号は特に注意: 5と6、7と8を慎重に区別すること

### 金額の読み取り
- 「合計」「お買上合計」「ご利用金額」「請求額」欄の金額を正確に読み取る
- 小計ではなく必ず**税込合計金額**を採用する
- 数字を1桁ずつ慎重に読む。特に 1/7、3/8、5/6、0/8 の誤読に注意
- 金額が複数表示されている場合は最終的な支払金額（おつり計算の元になる額）を採用
- 読み取りに自信がない場合でも最も可能性の高い数値を入れる

### 店名の読み取り（重要 — 誤認注意）
- レシートの**最上部**に最も大きく・目立つフォントで印字されている名前が店名
- 以下は店名では**ない**。絶対に店名にしないこと:
  - 電話番号（0554-xx-xxxx 等の数字列）
  - 住所（〇〇県〇〇市〇〇町...）
  - 郵便番号（〒xxx-xxxx）
  - 「TEL」「FAX」「〒」の後に続く文字列
  - 「登録番号」「T+数字」（インボイス番号）
- 店名の判定順序:
  1. レシート最上部のロゴや大文字テキスト
  2. 「株式会社〇〇」「有限会社〇〇」「〇〇店」等の屋号
  3. 上記が見つからなければ、レシートヘッダー部分（住所・電話番号より上）のテキスト
- 病院名・クリニック名はそのまま店名として採用する（例: 「けやき歯科医院」）
- 支店名は不要。本体の店名のみ（例: 「カインズ」だけでOK、「カインズ大月店」は不要）
- 住所に含まれる地名（大月市、上野原市等）を店名にしてはいけない

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
}

// ── メイン処理 ──────────────────────────────

async function processReceipt(filePath) {
  const fileName = path.basename(filePath);
  log(`Processing: ${fileName}`);

  if (!tryLock(filePath)) {
    log(`Skipped (locked): ${fileName}`);
    return;
  }

  try {
    // ファイルが完全に書き込まれるまで少し待つ（Drive同期の完了待ち）
    await new Promise(r => setTimeout(r, 3000));

    // ファイルがまだ存在するか確認
    if (!fs.existsSync(filePath)) {
      log(`File disappeared: ${fileName}`);
      return;
    }

    const fileSize = fs.statSync(filePath).size;
    if (fileSize < 10000) {
      log(`Skipped (too small: ${fileSize} bytes): ${fileName}`);
      return;
    }

    // business名をファイル名から抽出
    const business = extractBusiness(filePath);
    log(`Business: "${business}", Size: ${fileSize} bytes`);

    // 画像の前処理: Drive File Streamからローカルにコピー → EXIF適用 → 縦長に自動回転
    const { execSync } = require("child_process");
    const localCopy = path.join(REPO_DIR, "logs", ".receipt-local-copy.jpg");
    const processedPath = path.join(REPO_DIR, "logs", ".receipt-processing.jpg");

    // Step 1: Drive File Streamのファイルをローカルにコピー
    // Drive File Providerはダウンロード中に "Resource deadlock avoided" エラーを出すのでリトライ
    let copyOk = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        execSync(`cat "${filePath}" > "${localCopy}"`, { timeout: 30000 });
        const localSize = fs.statSync(localCopy).size;
        if (localSize > 10000) { copyOk = true; break; }
      } catch {}
      if (attempt < 7) await new Promise(r => setTimeout(r, 15000)); // 15秒間隔（最大約2分）
    }
    if (!copyOk) {
      log(`Failed to copy from Drive after 8 attempts: ${fileName}`);
      // ファイルが存在しなくなっていたら諦める
      if (!fs.existsSync(filePath)) { log(`File no longer exists, giving up`); return; }
      // 再キューは最大2回まで（retryCountで管理）
      const retryKey = filePath + "_retries";
      const retries = (global._driveRetries = global._driveRetries || {});
      retries[retryKey] = (retries[retryKey] || 0) + 1;
      if (retries[retryKey] <= 2) {
        log(`Will retry in 2 minutes (attempt ${retries[retryKey]}/2)`);
        releaseLock(filePath);
        setTimeout(() => enqueue(filePath), 120000);
      } else {
        log(`Giving up after 3 rounds of retries`);
        delete retries[retryKey];
        sendDiscordMessage(`❌ レシート読み込み失敗: ${fileName}\nDriveからの読み込みが繰り返し失敗しました。手動で確認してください。`);
      }
      return;
    }
    // 成功したらリトライカウントをリセット
    if (global._driveRetries) delete global._driveRetries[filePath + "_retries"];

    // Step 2: sipsでJPEG変換 + 横長なら90度回転
    try {
      execSync(`sips -s format jpeg -s formatOptions 90 "${localCopy}" --out "${processedPath}"`, { timeout: 15000 });

      const sizeOutput = execSync(`sips -g pixelWidth -g pixelHeight "${processedPath}"`, { encoding: "utf-8" });
      const wMatch = sizeOutput.match(/pixelWidth:\s*(\d+)/);
      const hMatch = sizeOutput.match(/pixelHeight:\s*(\d+)/);
      if (wMatch && hMatch) {
        const w = parseInt(wMatch[1]), h = parseInt(hMatch[1]);
        if (w > h) {
          execSync(`sips -r 90 "${processedPath}"`, { timeout: 10000 });
          log(`Rotated image 90° (${w}x${h} → portrait)`);
        }
      }
    } catch (e) {
      log(`Image preprocessing failed: ${e.message}, using local copy as-is`);
      try { fs.copyFileSync(localCopy, processedPath); } catch { /* processedPath = localCopy */ }
    }
    try { fs.unlinkSync(localCopy); } catch {}

    // Claude CLI で OCR（前処理済み画像を使用）
    const promptFile = path.join(REPO_DIR, "logs", ".receipt-watcher-prompt.txt");
    fs.writeFileSync(promptFile, buildOcrPrompt(processedPath), "utf-8");

    let ocrResult;
    try {
      const raw = await runClaudeCLI(promptFile, REPO_DIR);
      const jsonMatch = raw.match(/\{[\s\S]*?"date"[\s\S]*?\}/);
      if (jsonMatch) {
        const fixed = jsonMatch[0].replace(/:\s*([^"\d\[\]{},\s][^,}\n]*)/g, (m, val) => {
          const trimmed = val.trim();
          if (trimmed === "true" || trimmed === "false" || trimmed === "null") return m;
          return `: "${trimmed}"`;
        });
        try { ocrResult = JSON.parse(fixed); } catch { ocrResult = JSON.parse(jsonMatch[0]); }
      }
    } catch (e) {
      log(`OCR error: ${e.message}`);
    }
    try { fs.unlinkSync(promptFile); } catch {}
    try { fs.unlinkSync(processedPath); } catch {}

    if (!ocrResult) {
      log(`OCR failed for: ${fileName}`);
      sendWebPushNotification("レシート読み取り失敗", `${fileName} — もう一度撮影してみてね。`);
      sendDiscordMessage(`❌ レシート読み取り失敗: ${fileName}`);
      return;
    }

    // ショートカットで選択したbusinessを優先
    if (business) {
      log(`Overriding business: "${ocrResult.business}" → "${business}"`);
      ocrResult.business = business;
    }

    // Google Drive にアップロード & Sheets に書き込み
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
      log(`Google API error: ${e.message}`);
    }

    // 処理済み → ファイルを受信箱から削除（Drive上にはアップロード済み）
    try {
      fs.unlinkSync(filePath);
      log(`Deleted from inbox: ${fileName}`);
    } catch (e) {
      log(`Failed to delete: ${e.message}`);
    }

    // 通知
    const amount = ocrResult.amount ? Number(ocrResult.amount).toLocaleString() + "円" : "不明";
    const notifTitle = `${ocrResult.store || "不明"} ${amount}`;
    const notifBody = `${ocrResult.date || ""} / ${ocrResult.account || "雑費"} / ${ocrResult.payment || ""}`;

    sendWebPushNotification(notifTitle, notifBody);
    sendDiscordMessage(`✅ レシート登録完了\n\n${ocrResult.store || "不明"} ${amount}\n${ocrResult.date || ""} / ${ocrResult.account || "雑費"} / ${ocrResult.payment || ""}\n事業: ${ocrResult.business || "不明"}`);

    log(`Done: ${ocrResult.store} ${amount} (${ocrResult.date})`);

  } catch (e) {
    log(`Error processing ${fileName}: ${e.message}`);
    sendDiscordMessage(`❌ レシート処理エラー: ${fileName}\n${e.message.substring(0, 200)}`);
  } finally {
    releaseLock(filePath);
  }
}

// キュー処理（Claude CLIは同時1つまで）
function enqueue(filePath) {
  queue.push(filePath);
  processQueue();
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;
  const filePath = queue.shift();
  try {
    await processReceipt(filePath);
  } catch (e) {
    log(`Queue error: ${e.message}`);
  }
  processing = false;
  processQueue();
}

// ── 起動 ──────────────────────────────────

// 受信箱フォルダ存在確認
if (!fs.existsSync(INBOX_DIR)) {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  log(`Created inbox: ${INBOX_DIR}`);
}

log("=== Receipt Watcher Starting ===");
log(`Watching: ${INBOX_DIR}`);
log(`Claude CLI: ${CLAUDE_PATH}`);

// 起動時に既存の未処理ファイルをチェック
const existing = fs.readdirSync(INBOX_DIR).filter(f => isImageFile(f));
if (existing.length > 0) {
  log(`Found ${existing.length} existing file(s) in inbox`);
  for (const f of existing) {
    enqueue(path.join(INBOX_DIR, f));
  }
}

// chokidarでファイル監視
const watcher = chokidar.watch(INBOX_DIR, {
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 2000, // ファイル書き込み完了を2秒間の無変更で判定
    pollInterval: 500,
  },
  ignored: [
    /(^|[\/\\])\../, // 隠しファイル
    /\.icloud$/,      // iCloud placeholder
  ],
});

watcher
  .on("add", (filePath) => {
    if (!isImageFile(filePath)) return;
    log(`New file detected: ${path.basename(filePath)}`);
    enqueue(filePath);
  })
  .on("error", (err) => {
    log(`Watcher error: ${err.message}`);
  });

log("Watching for new receipt images...");

// グレースフルシャットダウン
process.on("SIGTERM", () => {
  log("Shutting down...");
  watcher.close().then(() => process.exit(0));
});
process.on("SIGINT", () => {
  log("Shutting down...");
  watcher.close().then(() => process.exit(0));
});
