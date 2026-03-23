/**
 * Google Calendar → openclaw-vault 同期スクリプト
 * GitHub Actions から実行される（vault ディレクトリで実行すること）
 *
 * 必要な GitHub Secret:
 * - GOOGLE_SERVICE_ACCOUNT_KEY: Google Service Account の JSON キー
 *
 * セットアップ手順:
 * 1. Google Cloud Console でサービスアカウントを作成
 * 2. カレンダーAPIを有効化
 * 3. サービスアカウントのメールアドレスを各カレンダーの共有設定に追加（閲覧権限）
 * 4. JSONキーをダウンロードし、GitHub Secrets に GOOGLE_SERVICE_ACCOUNT_KEY として登録
 */

const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

// CLAUDE.md に定義されているカレンダーID
const CALENDARS = {
  プライベート: "r.inafuku@tonari2tomaru.com",
  "R&M共有":
    "9c0d4af92a70ced546b135411feda7120c9fd874beda1363874c03faf8953f18@group.calendar.google.com",
  三十日珈琲: "misocacoffee@gmail.com",
  "えんがわ（HIBA）":
    "4651f62429c52388651033e5b59f4cb81a418694431ab262748b231c663e461f@group.calendar.google.com",
  "えんがわ（UME）": "engawa.yanagawa@gmail.com",
  大広間:
    "b6ff2100d451e679aa52c0afca510ce6268b673ddb904e7526c5bec7fb38836a@group.calendar.google.com",
  ADDress上野原:
    "a17f4edc4a1d1a8c6996a16d59835693a49292e954c273bd88f6868028c4090e@group.calendar.google.com",
};

async function main() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    console.log(
      "GOOGLE_SERVICE_ACCOUNT_KEY not set. Skipping calendar sync."
    );
    return;
  }

  const key = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });

  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  // 1週間先まで取得
  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + 7);

  let todayOutput = "";
  let weekOutput = "";

  for (const [name, calendarId] of Object.entries(CALENDARS)) {
    try {
      // 今日の予定
      const todayEvents = await calendar.events.list({
        calendarId,
        timeMin: todayStart.toISOString(),
        timeMax: todayEnd.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        timeZone: "Asia/Tokyo",
      });

      if (todayEvents.data.items && todayEvents.data.items.length > 0) {
        todayOutput += `\n#### ${name}\n\n`;
        for (const event of todayEvents.data.items) {
          const start = event.start.dateTime
            ? new Date(event.start.dateTime).toLocaleTimeString("ja-JP", {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "Asia/Tokyo",
              })
            : "終日";
          todayOutput += `- ${start} ${event.summary || "(タイトルなし)"}\n`;
        }
      }

      // 今週の予定
      const weekEvents = await calendar.events.list({
        calendarId,
        timeMin: todayStart.toISOString(),
        timeMax: weekEnd.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        timeZone: "Asia/Tokyo",
      });

      if (weekEvents.data.items && weekEvents.data.items.length > 0) {
        weekOutput += `\n#### ${name}\n\n`;
        for (const event of weekEvents.data.items) {
          const startDate = event.start.dateTime
            ? new Date(event.start.dateTime).toLocaleDateString("ja-JP", {
                month: "numeric",
                day: "numeric",
                timeZone: "Asia/Tokyo",
              })
            : event.start.date;
          const startTime = event.start.dateTime
            ? new Date(event.start.dateTime).toLocaleTimeString("ja-JP", {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "Asia/Tokyo",
              })
            : "終日";
          weekOutput += `- ${startDate} ${startTime} ${event.summary || "(タイトルなし)"}\n`;
        }
      }
    } catch (err) {
      console.error(`Error fetching ${name}: ${err.message}`);
    }
  }

  // 今日の予定ファイル
  const todayFile = todayOutput || "\n予定なし\n";
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/calendar-today.md", todayFile);

  // 今週の予定ファイル
  const weekFile = weekOutput || "\n予定なし\n";
  fs.writeFileSync("data/calendar-week.md", weekFile);

  console.log("Calendar sync completed.");
}

main().catch(console.error);
