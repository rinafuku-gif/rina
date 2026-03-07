const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

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
const REPO_DIR = path.join(__dirname, "..");
const PROMPT_FILE = path.join(REPO_DIR, "logs", ".current-prompt.txt");
const CLAUDE_PATH = "/Users/Inaryo/.local/bin/claude";
const CLAUDE_TIMEOUT = 300000; // 5分

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

function buildPrompt(userMessage) {
  const now = Date.now();

  if (now - lastMessageTime > CONVERSATION_TIMEOUT) {
    conversationHistory = [];
  }
  lastMessageTime = now;

  conversationHistory.push({ role: "user", content: userMessage });

  if (conversationHistory.length > 20) {
    conversationHistory = conversationHistory.slice(-20);
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
  if (req.method === "POST" && req.url === "/webhook") {
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
  } else if (req.method === "POST" && req.url === "/api/receipt") {
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
        if (!tokenPart || tokenPart.data.toString() !== env.SHIRATAMA_API_TOKEN) {
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
  "business": "えんがわ/三十日珈琲/SATOYAMA AI BASE/共通/不明"
}

読み取れない項目は "不明" としてください。金額は必ず数値のみ（カンマ・円記号なし）。`;

        const promptFile = path.join(REPO_DIR, "logs", ".receipt-prompt.txt");
        fs.writeFileSync(promptFile, ocrPrompt, "utf-8");

        const execEnv = Object.assign({}, process.env, {
          PATH: `/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
          HOME: "/Users/Inaryo",
        });
        delete execEnv.CLAUDECODE;

        let ocrResult;
        try {
          const raw = execSync(
            `cd "${REPO_DIR}" && cat "${promptFile}" | "${CLAUDE_PATH}" -p --dangerously-skip-permissions`,
            { encoding: "utf-8", timeout: CLAUDE_TIMEOUT, maxBuffer: 1024 * 1024, env: execEnv }
          );
          const jsonMatch = raw.match(/\{[\s\S]*?"date"[\s\S]*?\}/);
          ocrResult = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        } catch (e) {
          console.error("OCR error:", e.message);
        }

        if (!ocrResult) {
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ error: "レシートの読み取りに失敗しました。もう一度撮影してみてね。" }));
          try { fs.unlinkSync(filePath); } catch {}
          return;
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
          let creditAccount = "事業主借"; // デフォルト（個人立替）
          if (payment === "クレジットカード") creditAccount = "未払金";
          else if (payment === "現金") creditAccount = "現金";
          else if (payment === "口座引落") creditAccount = "普通預金";
          else if (payment === "電子マネー") creditAccount = "事業主借";

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
  } else if (req.method === "POST" && req.url === "/api/receipt-quick") {
    // iPhoneショートカット用: 即レスポンス→バックグラウンド処理→LINE通知
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
      if (body.length < 100) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No image data" }));
        return;
      }

      // 即レスポンス（ショートカットがタイムアウトしない）
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true, message: "受付完了。処理結果はLINEで通知します。" }));

      // バックグラウンドで処理
      (async () => {
        const uploadDir = path.join(REPO_DIR, "logs", ".uploads");
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        const ext = ".jpg";
        const safeName = `receipt_${Date.now()}${ext}`;
        const filePath = path.join(uploadDir, safeName);
        fs.writeFileSync(filePath, body);

        console.log(`[${new Date().toISOString()}] Quick receipt: ${body.length} bytes`);

        // 画像が大きすぎる場合はリサイズ（OCRの精度と速度向上）
        try {
          const stats = fs.statSync(filePath);
          if (stats.size > 2 * 1024 * 1024) {
            execSync(`sips --resampleWidth 1600 --setProperty formatOptions 70 "${filePath}" --out "${filePath}"`, { timeout: 10000 });
            const newSize = fs.statSync(filePath).size;
            console.log(`Resized: ${stats.size} -> ${newSize} bytes`);
          }
        } catch (e) { console.error("Resize failed:", e.message); }

        const ocrPrompt = `以下のレシート画像を Read ツールで読み取り、内容を分析してください。
ファイルパス: ${filePath}

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
  "business": "えんがわ/三十日珈琲/SATOYAMA AI BASE/共通/不明"
}

読み取れない項目は "不明" としてください。金額は必ず数値のみ（カンマ・円記号なし）。`;

        const promptFile = path.join(REPO_DIR, "logs", ".receipt-prompt.txt");
        fs.writeFileSync(promptFile, ocrPrompt, "utf-8");

        const execEnv = Object.assign({}, process.env, {
          PATH: `/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
          HOME: "/Users/Inaryo",
        });
        delete execEnv.CLAUDECODE;

        let ocrResult;
        try {
          const raw = execSync(
            `cd "${REPO_DIR}" && cat "${promptFile}" | "${CLAUDE_PATH}" -p --dangerously-skip-permissions`,
            { encoding: "utf-8", timeout: CLAUDE_TIMEOUT, maxBuffer: 1024 * 1024, env: execEnv }
          );
          const jsonMatch = raw.match(/\{[\s\S]*?"date"[\s\S]*?\}/);
          ocrResult = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        } catch (e) {
          console.error("OCR error:", e.message);
        }

        // LINE Push で結果通知
        const sendLine = (text) => {
          const payload = JSON.stringify({
            to: USER_ID,
            messages: [{ type: "text", text }],
          });
          const lineReq = https.request("https://api.line.me/v2/bot/message/push", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}`,
              "Content-Length": Buffer.byteLength(payload),
            },
          });
          lineReq.write(payload);
          lineReq.end();
        };

        if (!ocrResult) {
          sendLine("レシートの読み取りに失敗しました。もう一度撮影してみてね。");
          try { fs.unlinkSync(filePath); } catch {}
          return;
        }

        // Upload to Google Drive & Sheets
        let driveLink = "";
        try {
          const gToken = await getGoogleAccessToken();
          const monthFolderId = await getOrCreateMonthFolder(env.GOOGLE_RECEIPT_FOLDER_ID, gToken, ocrResult.date);
          const driveFileName = `${ocrResult.date || "unknown"}_${ocrResult.store || "receipt"}${ext}`;
          const driveResult = await uploadToDrive(filePath, driveFileName, "image/jpeg", monthFolderId, gToken);
          driveLink = driveResult.webViewLink || `https://drive.google.com/file/d/${driveResult.id}`;

          const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
          const account = ocrResult.account || "雑費";
          const taxClass = ocrResult.tax_class || "課税仕入10%";
          const payment = ocrResult.payment || "不明";
          let creditAccount = "事業主借";
          if (payment === "クレジットカード") creditAccount = "未払金";
          else if (payment === "現金") creditAccount = "現金";
          else if (payment === "口座引落") creditAccount = "普通預金";

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

        // LINE通知で結果を送信
        const amount = ocrResult.amount ? Number(ocrResult.amount).toLocaleString() + "円" : "不明";
        sendLine(`レシート登録完了\n\n${ocrResult.store || "不明"}\n${ocrResult.date || "不明"} / ${amount}\n勘定科目: ${ocrResult.account || "雑費"}\n税区分: ${ocrResult.tax_class || "不明"}\n事業: ${ocrResult.business || "不明"}`);
      })().catch(e => console.error("Background receipt error:", e.message));
    });
  } else if (req.method === "POST" && req.url === "/api/upload") {
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
        if (!tokenPart || tokenPart.data.toString() !== env.SHIRATAMA_API_TOKEN) {
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
  } else if (req.method === "POST" && req.url === "/api/chat") {
    // 秘書しらたま PWA 用エンドポイント
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
        if (token !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        res.writeHead(200, corsHeaders);

        // 最新のユーザーメッセージを取得
        const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
        if (!lastUserMsg) {
          res.end(JSON.stringify({ message: "メッセージが見つかりませんでした。" }));
          return;
        }

        // 会話履歴をプロンプトに組み立て
        let prompt = "";
        if (messages.length > 1) {
          prompt += "以下はRyoとの会話の続きです。直前のやり取りを踏まえて回答してください。\n\n";
          prompt += "--- 会話履歴 ---\n";
          for (const msg of messages.slice(0, -1)) {
            const label = msg.role === "user" ? "Ryo" : "しらたま";
            prompt += `${label}: ${msg.content}\n\n`;
          }
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

        const promptFile = path.join(REPO_DIR, "logs", ".shiratama-prompt.txt");
        fs.writeFileSync(promptFile, prompt, "utf-8");

        const execEnv = Object.assign({}, process.env, {
          PATH: `/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
          HOME: "/Users/Inaryo",
        });
        delete execEnv.CLAUDECODE;

        const result = execSync(
          `cd "${REPO_DIR}" && cat "${promptFile}" | "${CLAUDE_PATH}" -p --dangerously-skip-permissions`,
          { encoding: "utf-8", timeout: CLAUDE_TIMEOUT, maxBuffer: 1024 * 1024, env: execEnv }
        );

        const response = result.trim() || "(応答なし)";
        console.log(`[${new Date().toISOString()}] Shiratama response: ${response.slice(0, 100)}...`);

        // Clean up uploaded files after processing
        if (attachments && attachments.length > 0) {
          for (const att of attachments) {
            try { fs.unlinkSync(att.path); } catch {}
          }
        }

        res.end(JSON.stringify({ message: response }));
      } catch (e) {
        console.error("Shiratama chat error:", e.message);
        res.end(JSON.stringify({ message: "ごめんね、うまく応答できなかったみたい。もう一度試してみて。" }));
      }
    });
  } else if (req.method === "GET" && req.url?.startsWith("/api/tasks")) {
    // タスク一覧を CLAUDE.md からパース
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

    try {
      const claudeMd = fs.readFileSync(path.join(REPO_DIR, "CLAUDE.md"), "utf-8");
      const tasks = parseTasksFromCLAUDE(claudeMd);
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ tasks }));
    } catch (e) {
      console.error("Tasks API error:", e.message);
      res.writeHead(500, corsHeaders);
      res.end(JSON.stringify({ error: "Failed to parse tasks" }));
    }
  } else if (req.method === "POST" && req.url === "/api/tasks/toggle") {
    // タスクの完了/未完了を切り替え
    const origin = req.headers["origin"] || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Content-Type": "application/json",
    };

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { token, taskText, done } = JSON.parse(body);
        if (token !== env.SHIRATAMA_API_TOKEN) {
          res.writeHead(401, corsHeaders);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const claudeMdPath = path.join(REPO_DIR, "CLAUDE.md");
        let content = fs.readFileSync(claudeMdPath, "utf-8");

        const escapedText = taskText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (done) {
          // [ ] → [x]
          content = content.replace(
            new RegExp(`- \\[ \\] ${escapedText}`),
            `- [x] ${taskText}`
          );
        } else {
          // [x] → [ ]
          content = content.replace(
            new RegExp(`- \\[x\\] ${escapedText}`),
            `- [ ] ${taskText}`
          );
        }

        fs.writeFileSync(claudeMdPath, content, "utf-8");
        console.log(`[${new Date().toISOString()}] Task toggled: "${taskText}" → ${done ? "done" : "undone"}`);

        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        console.error("Task toggle error:", e.message);
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: "Failed to toggle task" }));
      }
    });
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

    try {
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const dailyLogPath = path.join(REPO_DIR, "logs", "daily", `${dateStr}.md`);

      if (fs.existsSync(dailyLogPath)) {
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
        // ブリーフィングがなければ claude -p で生成
        res.writeHead(200, corsHeaders);

        const promptFile = path.join(REPO_DIR, "logs", ".schedule-prompt.txt");
        fs.writeFileSync(promptFile, `今日${dateStr}の予定をGoogle Calendarから確認して、簡潔にまとめてください。JSON形式で返してください: {"events": [{"time": "HH:MM", "title": "予定名", "calendar": "カレンダー名"}]}。終日イベントのtimeは"終日"としてください。予定がなければ空配列を返してください。`, "utf-8");

        const execEnv = Object.assign({}, process.env, {
          PATH: `/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
          HOME: "/Users/Inaryo",
        });
        delete execEnv.CLAUDECODE;

        const result = execSync(
          `cd "${REPO_DIR}" && cat "${promptFile}" | "${CLAUDE_PATH}" -p --dangerously-skip-permissions`,
          { encoding: "utf-8", timeout: CLAUDE_TIMEOUT, maxBuffer: 1024 * 1024, env: execEnv }
        );

        // JSONを抽出
        const jsonMatch = result.match(/\{[\s\S]*"events"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          res.end(JSON.stringify({ date: dateStr, events: parsed.events, source: "calendar" }));
        } else {
          res.end(JSON.stringify({ date: dateStr, content: result.trim(), source: "raw" }));
        }
      }
    } catch (e) {
      console.error("Schedule API error:", e.message);
      res.writeHead(500, corsHeaders);
      res.end(JSON.stringify({ error: "Failed to fetch schedule" }));
    }
  } else if (req.method === "OPTIONS") {
    // CORS preflight for all /api/* routes
    res.writeHead(204, {
      "Access-Control-Allow-Origin": req.headers["origin"] || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
  } else if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

async function processMessage(userMessage) {
  isProcessing = true;
  try {
    const prompt = buildPrompt(userMessage);

    fs.writeFileSync(PROMPT_FILE, prompt, "utf-8");

    const execEnv = Object.assign({}, process.env, {
      PATH: `/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: "/Users/Inaryo",
    });
    delete execEnv.CLAUDECODE;

    const result = execSync(
      `cd "${REPO_DIR}" && cat "${PROMPT_FILE}" | "${CLAUDE_PATH}" -p --dangerously-skip-permissions`,
      { encoding: "utf-8", timeout: CLAUDE_TIMEOUT, maxBuffer: 1024 * 1024, env: execEnv }
    );

    const response = result.trim() || "(応答なし)";
    console.log(`[${new Date().toISOString()}] Response: ${response.slice(0, 100)}...`);

    conversationHistory.push({ role: "assistant", content: response });

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

server.listen(PORT, () => {
  console.log(`LINE Webhook server running on port ${PORT}`);
  console.log(`Conversation timeout: ${CONVERSATION_TIMEOUT / 1000}s`);
  console.log(`Claude timeout: ${CLAUDE_TIMEOUT / 1000}s`);
});
