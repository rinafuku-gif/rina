#!/usr/bin/env node
// マネーフォワード クラウド OAuth2 認証フロー — アクセストークン & リフレッシュトークン取得用
const http = require("http");
const https = require("https");
const { URL } = require("url");
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

const CLIENT_ID = env.MF_CLIENT_ID;
const CLIENT_SECRET = env.MF_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:9876/callback";

// スコープ: まず広めに取得して利用可能なAPIを確認
const SCOPES = [
  "openid",
  "mfc/admin/tenant.read",
  "mfc/accounting/journal.write",
  "mfc/accounting/journal.read",
  "mfc/accounting/account_item.read",
].join(" ");

const PORT = 9876;

// MF OAuth endpoints
const AUTH_URL = "https://api.biz.moneyforward.com/authorize";
const TOKEN_URL = "https://api.biz.moneyforward.com/token";

// Step 1: Generate auth URL
const authUrl = `${AUTH_URL}?` +
  `client_id=${CLIENT_ID}&` +
  `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
  `response_type=code&` +
  `scope=${encodeURIComponent(SCOPES)}&` +
  `prompt=consent`;

console.log("\n=== マネーフォワード クラウド OAuth2 認証 ===\n");
console.log("以下のURLをブラウザで開いてください:\n");
console.log(authUrl);
console.log("\n認証後、自動でトークンを取得します...\n");

// Step 2: Local server to receive callback
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    console.error("❌ 認証エラー:", error, url.searchParams.get("error_description"));
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h2>認証エラー: ${error}</h2><p>${url.searchParams.get("error_description") || ""}</p>`);
    server.close();
    process.exit(1);
    return;
  }

  if (!code) {
    res.writeHead(400);
    res.end("No code received");
    return;
  }

  console.log("認可コード取得。トークンを交換中...\n");

  // Exchange code for tokens (Basic認証)
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const postData = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  }).toString();

  const tokenUrl = new URL(TOKEN_URL);
  const tokenReq = https.request({
    hostname: tokenUrl.hostname,
    path: tokenUrl.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${basicAuth}`,
      "Content-Length": Buffer.byteLength(postData),
    },
  }, (tokenRes) => {
    let body = "";
    tokenRes.on("data", (chunk) => (body += chunk));
    tokenRes.on("end", () => {
      try {
        const tokens = JSON.parse(body);
        if (tokens.access_token) {
          console.log("✅ トークン取得成功!\n");
          console.log("Access Token:", tokens.access_token.substring(0, 30) + "...");
          console.log("Refresh Token:", tokens.refresh_token || "なし");
          console.log("Scope:", tokens.scope);
          console.log("Expires in:", tokens.expires_in, "秒");

          // .env に保存
          let envLines = fs.readFileSync(envPath, "utf-8");

          // MF_ACCESS_TOKEN
          if (envLines.includes("MF_ACCESS_TOKEN=")) {
            envLines = envLines.replace(/MF_ACCESS_TOKEN=.*/, `MF_ACCESS_TOKEN=${tokens.access_token}`);
          } else {
            envLines = envLines.trimEnd() + `\nMF_ACCESS_TOKEN=${tokens.access_token}\n`;
          }

          // MF_REFRESH_TOKEN
          if (tokens.refresh_token) {
            if (envLines.includes("MF_REFRESH_TOKEN=")) {
              envLines = envLines.replace(/MF_REFRESH_TOKEN=.*/, `MF_REFRESH_TOKEN=${tokens.refresh_token}`);
            } else {
              envLines = envLines.trimEnd() + `\nMF_REFRESH_TOKEN=${tokens.refresh_token}\n`;
            }
          }

          fs.writeFileSync(envPath, envLines);
          console.log("\n✅ .env に保存しました。このウィンドウは閉じてOKです。\n");

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h2>マネーフォワード認証成功！このタブは閉じてOKです。</h2>");
        } else {
          console.error("❌ トークン取得失敗:", body);
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h2>エラー</h2><pre>" + body + "</pre>");
        }
      } catch (e) {
        console.error("❌ パースエラー:", e.message, body);
        res.writeHead(500);
        res.end("Token parse error");
      }
      server.close();
      process.exit(0);
    });
  });

  tokenReq.on("error", (e) => {
    console.error("❌ リクエストエラー:", e.message);
    res.writeHead(500);
    res.end("Request error");
    server.close();
    process.exit(1);
  });

  tokenReq.write(postData);
  tokenReq.end();
});

server.listen(PORT, () => {
  console.log(`コールバックサーバー起動中 (port ${PORT})...\n`);
});
