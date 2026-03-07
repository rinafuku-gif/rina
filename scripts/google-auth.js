#!/usr/bin/env node
// Google OAuth2 認証フロー — Drive & Sheets のリフレッシュトークン取得用
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

const CLIENT_ID = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:9876/callback";
const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
].join(" ");

// Step 1: Generate auth URL
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${CLIENT_ID}&` +
  `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
  `response_type=code&` +
  `scope=${encodeURIComponent(SCOPES)}&` +
  `access_type=offline&` +
  `prompt=consent`;

console.log("\n=== Google OAuth2 認証 ===\n");
console.log("以下のURLをブラウザで開いてください:\n");
console.log(authUrl);
console.log("\n認証後、自動でトークンを取得します...\n");

// Step 2: Local server to receive callback
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:9876`);
  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("No code received");
    return;
  }

  // Exchange code for tokens
  const postData = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  }).toString();

  const tokenReq = https.request("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(postData),
    },
  }, (tokenRes) => {
    let body = "";
    tokenRes.on("data", (chunk) => (body += chunk));
    tokenRes.on("end", () => {
      try {
        const tokens = JSON.parse(body);
        if (tokens.refresh_token) {
          console.log("✅ トークン取得成功!\n");
          console.log("Refresh Token:", tokens.refresh_token);
          console.log("\n.env に GOOGLE_REFRESH_TOKEN を追加します...\n");

          // Append to .env
          const envLines = fs.readFileSync(envPath, "utf-8");
          if (envLines.includes("GOOGLE_REFRESH_TOKEN")) {
            // Replace existing
            const updated = envLines.replace(/GOOGLE_REFRESH_TOKEN=.*/, `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
            fs.writeFileSync(envPath, updated);
          } else {
            fs.appendFileSync(envPath, `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
          }
          console.log("✅ .env に保存しました。このウィンドウは閉じてOKです。\n");

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h2>認証成功！このタブは閉じてOKです。</h2>");
        } else {
          console.error("❌ リフレッシュトークンが取得できませんでした:", body);
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h2>エラー: リフレッシュトークンが取得できませんでした</h2><pre>" + body + "</pre>");
        }
      } catch (e) {
        console.error("❌ トークンのパースに失敗:", e.message);
        res.writeHead(500);
        res.end("Token parse error");
      }
      server.close();
      process.exit(0);
    });
  });

  tokenReq.write(postData);
  tokenReq.end();
});

server.listen(9876, () => {
  console.log("コールバックサーバー起動中 (port 9876)...\n");
});
