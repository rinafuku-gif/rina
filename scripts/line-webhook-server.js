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
        const { messages, token } = JSON.parse(body);

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
        res.end(JSON.stringify({ message: response }));
      } catch (e) {
        console.error("Shiratama chat error:", e.message);
        res.end(JSON.stringify({ message: "ごめんね、うまく応答できなかったみたい。もう一度試してみて。" }));
      }
    });
  } else if (req.method === "OPTIONS" && req.url === "/api/chat") {
    // CORS preflight
    res.writeHead(204, {
      "Access-Control-Allow-Origin": req.headers["origin"] || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
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
