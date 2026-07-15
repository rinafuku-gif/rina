/**
 * secretary-enrich.js — しらたまの秘書コメント付与
 *
 * today.json の各アクション項目に、AIが秘書視点のコメントを追加する。
 * Claude CLI を使って、ゲスト情報・チャット履歴・期日情報を踏まえた
 * 1行コメントを生成し、secretaryNote フィールドに格納する。
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_DIR = path.join(__dirname, "..");
const TODAY_FILE = path.join(REPO_DIR, "data", "today.json");
const BOOKINGS_FILE = path.join(REPO_DIR, "logs", ".airbnb-bookings.json");
const CHAT_HISTORY_FILE = path.join(REPO_DIR, "logs", ".chat-history.json");
const DEADLINES_FILE = path.join(REPO_DIR, "data", "deadlines.json");

const CLAUDE_BIN = "/Users/Inaryo/.local/bin/claude";
const ENV_PATH = "/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

/**
 * ファイルを安全に読み込む（存在しなければデフォルト値を返す）
 */
function safeReadJSON(filePath, defaultValue) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

/**
 * today.json の全アクション項目をフラットに取得
 */
function getAllItems(todayData) {
  const items = [];
  if (!todayData.sections) return items;
  for (const section of todayData.sections) {
    if (section.items) {
      for (const item of section.items) {
        items.push(item);
      }
    }
  }
  return items;
}

/**
 * コンテキスト情報を収集してプロンプトを組み立てる
 */
function buildPrompt(todayData) {
  const items = getAllItems(todayData);
  if (items.length === 0) return null;

  // Airbnb予約情報（今日〜3日以内のもの）
  // tombstone(status:"cancelled")化した予約は除外（legacyでstatus無しは有効扱いを維持）
  const bookings = safeReadJSON(BOOKINGS_FILE, []).filter(b => b.status !== "cancelled");
  const today = todayData.date || new Date().toISOString().slice(0, 10);
  const relevantBookings = bookings.filter((b) => {
    const diff = (new Date(b.checkin) - new Date(today)) / 86400000;
    return diff >= -1 && diff <= 3;
  });

  // チャット履歴（直近10件）
  const chatHistory = safeReadJSON(CHAT_HISTORY_FILE, []);
  const recentChats = chatHistory.slice(-10);

  // 期限情報
  const deadlinesData = safeReadJSON(DEADLINES_FILE, { deadlines: [] });
  const deadlines = deadlinesData.deadlines || [];
  const upcomingDeadlines = deadlines.filter((d) => {
    if (d.status === "完了") return false;
    const diff = (new Date(d.date) - new Date(today)) / 86400000;
    return diff >= 0 && diff <= 14;
  });

  // プロンプト組み立て
  const prompt = `あなたはRyoの専属AI秘書「しらたま」です。
今日のアクション項目それぞれに、優秀な秘書が一言添えるコメントを付けてください。

## ルール
- 各項目に secretaryNote を追加（1文以内、短く）
- コメント不要な項目は secretaryNote を null にする
- 口調: 丁寧だけど堅すぎない、親しみやすいトーン（敬語は使わず「だよ」「だね」系）
- 準備が必要なこと、忘れがちなこと、気をつけるべきことを指摘する
- 過剰なコメントは不要。本当に役立つことだけ

## 今日の日付
${today}

## 今日のアクション項目
${JSON.stringify(items, null, 2)}

## 直近のAirbnb予約情報
${relevantBookings.length > 0 ? JSON.stringify(relevantBookings, null, 2) : "なし"}

## 2週間以内の期限
${upcomingDeadlines.length > 0 ? JSON.stringify(upcomingDeadlines, null, 2) : "なし"}

## 最近の会話（参考）
${recentChats.length > 0 ? recentChats.map((c) => `[${c.role}] ${c.content}`).join("\n").slice(0, 1500) : "なし"}

## 出力形式
以下のJSON配列のみを出力してください。余計なテキストは不要です。
[
  { "id": "act_xxx", "secretaryNote": "コメント" },
  { "id": "act_yyy", "secretaryNote": null }
]`;

  return prompt;
}

/**
 * Claude CLI でコメントを生成
 */
function callClaude(prompt) {
  const tmpFile = path.join(REPO_DIR, "logs", ".secretary-prompt.tmp");
  try {
    fs.writeFileSync(tmpFile, prompt, "utf-8");

    const result = execSync(
      `cat "${tmpFile}" | "${CLAUDE_BIN}" -p --model claude-sonnet-4-6 --dangerously-skip-permissions`,
      {
        timeout: 60000,
        encoding: "utf-8",
        env: { ...process.env, PATH: ENV_PATH },
        maxBuffer: 1024 * 1024,
      }
    );

    return result.trim();
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  }
}

/**
 * Claude の応答からJSON配列を抽出
 */
function parseResponse(response) {
  // コードブロック内のJSONを抽出
  const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : response.trim();

  // JSON配列部分を抽出
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return null;

  return JSON.parse(arrayMatch[0]);
}

/**
 * today.json にコメントを付与して保存
 */
function enrichToday() {
  // today.json 読み込み
  const todayData = safeReadJSON(TODAY_FILE, null);
  if (!todayData || !todayData.sections) {
    console.log("[secretary-enrich] today.json が見つからないか空です。スキップ。");
    return todayData;
  }

  const items = getAllItems(todayData);
  if (items.length === 0) {
    console.log("[secretary-enrich] アクション項目がありません。スキップ。");
    return todayData;
  }

  // プロンプト組み立て
  const prompt = buildPrompt(todayData);
  if (!prompt) {
    console.log("[secretary-enrich] プロンプト生成失敗。スキップ。");
    return todayData;
  }

  console.log(`[secretary-enrich] ${items.length}件のアクション項目にコメント生成中...`);

  let notes;
  try {
    const response = callClaude(prompt);
    notes = parseResponse(response);
    if (!notes || !Array.isArray(notes)) {
      console.log("[secretary-enrich] Claude応答のパースに失敗。today.jsonをそのまま保存。");
      console.log("[secretary-enrich] 応答:", response.slice(0, 300));
      return todayData;
    }
  } catch (err) {
    console.error("[secretary-enrich] Claude CLI エラー:", err.message);
    console.log("[secretary-enrich] today.jsonをそのまま保存。");
    return todayData;
  }

  // notes をマップに変換
  const noteMap = {};
  for (const n of notes) {
    if (n.id) noteMap[n.id] = n.secretaryNote || null;
  }

  // today.json のアイテムに secretaryNote を付与
  let enriched = 0;
  for (const section of todayData.sections) {
    if (!section.items) continue;
    for (const item of section.items) {
      if (item.id in noteMap) {
        item.secretaryNote = noteMap[item.id];
        if (noteMap[item.id]) enriched++;
      } else {
        item.secretaryNote = null;
      }
    }
  }

  // 保存
  fs.writeFileSync(TODAY_FILE, JSON.stringify(todayData, null, 2) + "\n", "utf-8");
  console.log(`[secretary-enrich] 完了: ${enriched}/${items.length}件にコメント付与。`);

  return todayData;
}

module.exports = { enrichToday };

// CLI実行
if (require.main === module) {
  enrichToday();
}
