/**
 * sns-weekly-draft.js — 毎週月曜の朝ブリーフィングにSNS下書きを生成
 *
 * daily-scan.sh から月曜のみ呼び出される。
 * マーケ戦略 + SNSブランド設定を読んで、今週の投稿2本（水曜・金曜）の下書きを生成。
 *
 * 出力: 標準出力にMarkdownセクション、ファイルに data/sns-drafts/YYYY-WNN.md
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_DIR = path.join(__dirname, "..");
const MARKETING_STRATEGY = "/Users/Inaryo/agents/marketer/launch-marketing-final.md";
const SNS_RULEBOOK = "/Users/Inaryo/agents/marketer/sns-weekly-template.md";
const SNS_BRANDS_DIR = path.join(REPO_DIR, "config", "sns-brands");
const DRAFTS_DIR = path.join(REPO_DIR, "data", "sns-drafts");

// --- Helpers ---
function todayStr() {
  const d = new Date();
  const jst = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, "0")}-${String(jst.getDate()).padStart(2, "0")}`;
}

function getWeekId() {
  const d = new Date(todayStr() + "T00:00:00+09:00");
  const year = d.getFullYear();
  const start = new Date(year, 0, 1);
  const weekNum = Math.ceil(((d - start) / 86400000 + start.getDay() + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, "0")}`;
}

function getCurrentMonth() {
  const d = new Date(todayStr() + "T00:00:00+09:00");
  return d.getMonth() + 1; // 1-12
}

function safeReadFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    console.error(`[sns-draft] Failed to read ${filePath}: ${e.message}`);
    return null;
  }
}

// --- 今月の集中2事業を特定 ---
function identifyFocusBusinesses(strategyContent) {
  const month = getCurrentMonth();
  const lines = strategyContent.split("\n");

  // テーブルから月ごとの集中事業を抽出
  for (const line of lines) {
    const match = line.match(/\|\s*(\d+)月\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (match && parseInt(match[1]) === month) {
      const biz1 = match[2].replace(/（.*?）/g, "").trim();
      const biz2 = match[3].replace(/（.*?）/g, "").trim();
      return [biz1, biz2];
    }
  }

  // テーブルに今月がなければ直近の2事業をフォールバック
  return ["三十日珈琲", "SATOYAMA AI BASE"];
}

// --- ブランド設定ファイルを事業名から探す ---
function findBrandFile(businessName) {
  const nameMap = {
    "三十日珈琲": "misoca_coffee.md",
    "Basecamp Torisawa": "tonari2tomaru.md",
    "SATOYAMA AI BASE": "satoyama_ai_base.md",
    "星の図書館": null, // 専用アカウントなし
    "えんがわ": "engawa_yanagawa.md",
  };

  const fileName = nameMap[businessName];
  if (!fileName) return null;

  const filePath = path.join(SNS_BRANDS_DIR, fileName);
  return safeReadFile(filePath);
}

// --- プラットフォーム判定 ---
function getPlatform(businessName) {
  const platformMap = {
    "三十日珈琲": "Instagram",
    "Basecamp Torisawa": "Instagram",
    "SATOYAMA AI BASE": "X",
    "星の図書館": "X",
    "えんがわ": "Instagram",
  };
  return platformMap[businessName] || "Instagram";
}

// --- Claude CLIで下書き生成（1回の呼び出しで2本分） ---
function generateDrafts(focusBusinesses, brandConfigs, strategyExcerpt) {
  const biz1 = focusBusinesses[0];
  const biz2 = focusBusinesses[1];
  const platform1 = getPlatform(biz1);
  const platform2 = getPlatform(biz2);

  const brand1 = brandConfigs[0] || "(ブランド設定なし)";
  const brand2 = brandConfigs[1] || "(ブランド設定なし)";

  // ルールブック読み込み
  const rulebook = safeReadFile(SNS_RULEBOOK);
  const rulebookExcerpt = rulebook ? extractRulebookSections(rulebook, focusBusinesses) : "";

  const prompt = `あなたはSNS投稿の下書きを作るマーケターです。以下のルールブック・ブランド設定に厳密に従って、今週の投稿2本+ストーリーズ1本の下書きを作ってください。

## 今月の集中事業
1. ${biz1}（${platform1}）
2. ${biz2}（${platform2}）

## ルールブック（トーンガイド・NG集・ハッシュタグ）
${rulebookExcerpt.slice(0, 3000)}

## マーケ戦略（抜粋）
${strategyExcerpt.slice(0, 1500)}

## ${biz1} ブランド設定
${brand1.slice(0, 1200)}

## ${biz2} ブランド設定
${brand2.slice(0, 1200)}

## 出力フォーマット（これ以外は出力しないでください）

### 水曜 — ${biz1}（${platform1}）
**形式**: フィード / カルーセル / リール
**テーマ**: （1行で）
**キャプション案**:
（投稿文。改行あり。${platform1 === "Instagram" ? "本文3-8行" : "140文字以内"}）

（ハッシュタグ。固定タグ必須+ローテタグから選択。${platform1 === "Instagram" ? "合計15-20個" : "2-3個"}）
**画像の方向性**: （どんな写真を撮ればいいか。1-2行）
**CTA**: （自然な誘導を1つだけ）

---

### 金曜 — ${biz2}（${platform2}）
**形式**: フィード / カルーセル / リール
**テーマ**: （1行で）
**キャプション案**:
（投稿文。改行あり。${platform2 === "Instagram" ? "本文3-8行" : "140文字以内"}）

（ハッシュタグ。固定タグ必須+ローテタグから選択。${platform2 === "Instagram" ? "合計15-20個" : "2-3個"}）
**画像の方向性**: （どんな写真を撮ればいいか。1-2行）
**CTA**: （自然な誘導を1つだけ）

---

### ストーリーズ — ${biz1}（水曜に投稿）
**内容**: （何を見せるか）
**テキスト**: （1-2行）

## 厳守ルール
- NG集に記載の表現は絶対に使わない（煽り、値引き訴求、「！」多用、架空の体験談）
- 各事業のトーンガイドに厳密に従う
- ハッシュタグは固定タグを必ず含める
- 宣伝感を出さない。共感や発見を起点に
- 季節感を入れる（今は${getCurrentMonth()}月）
- AIが書いた感のある完璧すぎる文章にしない。少し不完全でいい`;

  try {
    // プロンプトを一時ファイル経由で渡す（shellのエスケープ問題を回避）
    const tmpPrompt = path.join(REPO_DIR, "data", ".sns-prompt.tmp");
    fs.writeFileSync(tmpPrompt, prompt, "utf-8");

    const result = execSync(
      `cat "${tmpPrompt}" | claude -p --dangerously-skip-permissions 2>/dev/null`,
      {
        encoding: "utf-8",
        timeout: 120000, // 2分タイムアウト
        cwd: REPO_DIR,
        env: { ...process.env, PATH: "/Users/Inaryo/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
      }
    ).trim();

    // 一時ファイル削除
    try { fs.unlinkSync(tmpPrompt); } catch {}

    return result;
  } catch (e) {
    console.error(`[sns-draft] Claude generation failed: ${e.message}`);
    return null;
  }
}

// --- Main ---
function main() {
  console.error("[sns-draft] Generating weekly SNS drafts...");

  // 1. マーケ戦略を読む
  const strategy = safeReadFile(MARKETING_STRATEGY);
  if (!strategy) {
    console.error("[sns-draft] Marketing strategy not found, skipping");
    process.exit(0);
  }

  // 2. 今月の集中事業を特定
  const focusBusinesses = identifyFocusBusinesses(strategy);
  console.error(`[sns-draft] Focus businesses: ${focusBusinesses.join(", ")}`);

  // 3. ブランド設定を読む
  const brandConfigs = focusBusinesses.map(biz => findBrandFile(biz));

  // 4. 戦略の該当セクション抜粋
  const strategyExcerpt = extractBusinessSections(strategy, focusBusinesses);

  // 5. Claude CLIで下書き生成
  const drafts = generateDrafts(focusBusinesses, brandConfigs, strategyExcerpt);

  if (!drafts) {
    console.error("[sns-draft] Draft generation failed");
    // 失敗してもブリーフィングを壊さない
    console.log("## 今週のSNS下書き\n\n（生成に失敗しました。手動で `node ~/rina/scripts/sns-weekly-draft.js` を再実行してください）\n");
    process.exit(0);
  }

  // 6. ファイルに保存
  const weekId = getWeekId();
  const draftFile = path.join(DRAFTS_DIR, `${weekId}.md`);

  const fileContent = `# SNS下書き ${weekId}\n\n生成日: ${todayStr()}\n集中事業: ${focusBusinesses.join("、")}\n\n---\n\n${drafts}\n`;

  try {
    fs.writeFileSync(draftFile, fileContent, "utf-8");
    console.error(`[sns-draft] Saved to ${draftFile}`);
  } catch (e) {
    console.error(`[sns-draft] Failed to save draft file: ${e.message}`);
  }

  // 7. 標準出力にブリーフィング用セクション
  const output = `## 今週のSNS下書き（確認してください）

${drafts}

→ OKならそのまま予約投稿。修正があればrinaに「ここ変えて」と伝えてください。
→ 下書きファイル: data/sns-drafts/${weekId}.md
`;

  console.log(output);
}

// --- ルールブックから該当セクションを抽出 ---
function extractRulebookSections(rulebook, businesses) {
  const sections = [];

  // トーンガイド（事業別）を抽出
  const toneSection = rulebook.match(/## 3\. 投稿トーンガイド[\s\S]*?(?=\n---)/);
  if (toneSection) {
    // 該当事業のトーンガイドのみ抽出
    const toneLines = toneSection[0].split("\n");
    let include = false;
    for (const line of toneLines) {
      if (line.startsWith("### ")) {
        include = businesses.some(biz => line.includes(biz)) || line.includes("全事業");
        if (include) sections.push(line);
        continue;
      }
      if (include) sections.push(line);
    }
  }

  // ハッシュタグリスト（事業別）を抽出
  const hashSection = rulebook.match(/## 4\. ハッシュタグリスト[\s\S]*?(?=\n---)/);
  if (hashSection) {
    const hashLines = hashSection[0].split("\n");
    let include = false;
    for (const line of hashLines) {
      if (line.startsWith("### ")) {
        include = businesses.some(biz => line.includes(biz)) || line.includes("タグ運用ルール");
        if (include) sections.push(line);
        continue;
      }
      if (include) sections.push(line);
    }
  }

  // NG集（全文含める — 重要なので）
  const ngSection = rulebook.match(/## 5\. 投稿のNG集[\s\S]*?(?=\n---)/);
  if (ngSection) {
    sections.push(ngSection[0]);
  }

  // 今月の投稿テーマカレンダーから該当月を抽出
  const month = getCurrentMonth();
  const calMatch = rulebook.match(new RegExp(`### ${month}月[^]*?(?=###|$)`));
  if (calMatch) {
    sections.push("\n## 今月の投稿テーマカレンダー");
    sections.push(calMatch[0]);
  }
  // 来月も参照（月末の場合）
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextCalMatch = rulebook.match(new RegExp(`### ${nextMonth}月[^]*?(?=###|$)`));
  if (nextCalMatch) {
    sections.push(`\n## 来月の投稿テーマカレンダー`);
    sections.push(nextCalMatch[0]);
  }

  return sections.join("\n");
}

// --- 戦略から該当事業セクションを抽出 ---
function extractBusinessSections(strategy, businesses) {
  const lines = strategy.split("\n");
  const sections = [];
  let currentSection = null;
  let depth = 0;

  for (const line of lines) {
    // ## セクション見出しを検出
    const h2Match = line.match(/^## \d+\.\s+(.+)/);
    if (h2Match) {
      const sectionName = h2Match[1];
      const isRelevant = businesses.some(biz => sectionName.includes(biz));
      currentSection = isRelevant ? sectionName : null;
      if (isRelevant) {
        sections.push(line);
        depth = 0;
      }
      continue;
    }

    if (currentSection) {
      // 次の ## に達したら終了
      if (line.match(/^## /)) {
        currentSection = null;
        continue;
      }
      sections.push(line);
      depth++;
      // 各セクション最大50行
      if (depth > 50) {
        currentSection = null;
      }
    }
  }

  return sections.join("\n");
}

main();
