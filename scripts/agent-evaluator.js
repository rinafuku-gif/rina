/**
 * 自律判断エンジン（Agent Evaluator）
 *
 * 統合DBのデータを分析し、異常検知・提案・リマインドを生成。
 * 検知だけでなく「対策案」まで提示する。考えてくれる秘書。
 */

const db = require("./unified-db");
const crypto = require("crypto");

function genId() {
  return `insight_${crypto.randomUUID().slice(0, 8)}`;
}

function today() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

function thisMonthJST() {
  const d = new Date();
  const jst = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, "0")}`;
}

function lastMonthJST() {
  const d = new Date();
  const jst = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const m = jst.getMonth();
  return m === 0
    ? `${jst.getFullYear() - 1}-12`
    : `${jst.getFullYear()}-${String(m).padStart(2, "0")}`;
}

// ===== ルールエンジン =====

const RULES = [
  {
    name: "revenue_drought",
    evaluate: async () => {
      const client = db.getClient();
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const result = await client.execute({
        sql: "SELECT COUNT(*) as cnt FROM money_transactions WHERE amount > 0 AND date >= ?",
        args: [weekAgo],
      });
      if (result.rows[0]?.cnt === 0) {
        const totalResult = await client.execute("SELECT COUNT(*) as cnt FROM money_transactions WHERE amount > 0");
        if (totalResult.rows[0]?.cnt === 0) return null;

        // 直近の売上パターンを分析
        const lastRevenue = await client.execute(
          "SELECT date, amount, business FROM money_transactions WHERE amount > 0 ORDER BY date DESC LIMIT 3"
        );
        const lastBiz = lastRevenue.rows.map(r => r.business).filter(Boolean);
        const mainBiz = lastBiz[0] || "えんがわ";

        return {
          type: "anomaly",
          title: "売上が7日間ゼロです",
          detail: `直近の売上は${mainBiz}が中心でした。\n\n【対策案】\nA. えんがわの料金設定・写真を見直して予約率を上げる\nB. SATOYAMAのDXパッケージを既存顧客に案内する\nC. 三十日珈琲の出店予定を確認し、直近の売上機会を作る\n\nおすすめ: A（既存の稼働率を上げるのが最速）`,
          urgency: "action_needed",
        };
      }
      return null;
    },
  },
  {
    name: "expense_spike",
    evaluate: async () => {
      const client = db.getClient();
      const thisMonth = thisMonthJST();
      const lastMonth = lastMonthJST();

      const [thisResult, lastResult, topCategories] = await Promise.all([
        client.execute({ sql: "SELECT SUM(ABS(amount)) as total FROM money_transactions WHERE amount < 0 AND date LIKE ?", args: [`${thisMonth}%`] }),
        client.execute({ sql: "SELECT SUM(ABS(amount)) as total FROM money_transactions WHERE amount < 0 AND date LIKE ?", args: [`${lastMonth}%`] }),
        client.execute({ sql: "SELECT category, SUM(ABS(amount)) as total FROM money_transactions WHERE amount < 0 AND date LIKE ? GROUP BY category ORDER BY total DESC LIMIT 3", args: [`${thisMonth}%`] }),
      ]);

      const thisTotal = thisResult.rows[0]?.total || 0;
      const lastTotal = lastResult.rows[0]?.total || 0;

      if (lastTotal > 0 && thisTotal > lastTotal * 1.3) {
        const pct = Math.round(((thisTotal - lastTotal) / lastTotal) * 100);
        const topList = topCategories.rows.map(r => `${r.category}: ¥${(r.total || 0).toLocaleString()}`).join("、");

        return {
          type: "anomaly",
          title: `今月の経費が先月比+${pct}%`,
          detail: `今月: ¥${thisTotal.toLocaleString()} / 先月: ¥${lastTotal.toLocaleString()}\n主な出費: ${topList}\n\n【対策案】\nA. 上位カテゴリの明細を確認し、不要な出費を特定する\nB. サブスクの棚卸し（使っていないサービスがないか）\nC. 来月の予算上限を設定する\n\nおすすめ: A（まず事実確認）`,
          urgency: "info",
        };
      }
      return null;
    },
  },
  {
    name: "tomorrow_booking",
    evaluate: async () => {
      const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
      const client = db.getClient();
      const result = await client.execute({
        sql: "SELECT * FROM schedule_events WHERE start_at LIKE ? AND source = 'airbnb' AND status != 'cancelled'",
        args: [`${tomorrow}%`],
      });
      if (result.rows.length > 0) {
        const guests = result.rows.map(r => `${r.guest_name || "ゲスト"}（${r.calendar_name || "えんがわ"}）`).join("、");
        return {
          type: "reminder",
          title: `明日チェックイン: ${result.rows.map(r => r.guest_name || "ゲスト").join("、")}`,
          detail: `${guests}\n\n【準備チェックリスト】\n□ 清掃完了の確認\n□ アメニティ補充\n□ Wi-Fiパスワード掲示\n□ ゲストへのウェルカムメッセージ送信\n□ チェックイン時間の最終確認`,
          urgency: "action_needed",
          related_table: "schedule_events",
        };
      }
      return null;
    },
  },
  {
    name: "overdue_tasks",
    evaluate: async () => {
      const client = db.getClient();
      const todayStr = today();
      const result = await client.execute({
        sql: "SELECT title, project, due_date FROM tasks WHERE status IN ('pending', 'in_progress') AND due_date IS NOT NULL AND due_date < ? ORDER BY due_date LIMIT 5",
        args: [todayStr],
      });
      const count = result.rows.length;
      if (count > 0) {
        const taskList = result.rows.map(r => `• ${r.title}${r.project ? `（${r.project}）` : ""} — 期限: ${r.due_date}`).join("\n");
        return {
          type: "reminder",
          title: `期限切れタスクが${count}件`,
          detail: `${taskList}\n\n【対策案】\nA. 今日中に片付ける（優先度高いものから）\nB. 期限を来週に延期する\nC. 不要なものは削除する\n\nおすすめ: まず一覧を確認して、5分で終わるものから片付ける`,
          urgency: count >= 3 ? "action_needed" : "info",
          related_table: "tasks",
        };
      }
      return null;
    },
  },
  {
    name: "no_followup",
    evaluate: async () => {
      const client = db.getClient();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const result = await client.execute({
        sql: `SELECT name, business, first_contact FROM customers
              WHERE first_contact IS NOT NULL AND first_contact <= ?
              AND (last_contact IS NULL OR last_contact = first_contact)
              LIMIT 5`,
        args: [thirtyDaysAgo],
      });
      if (result.rows.length > 0) {
        const names = result.rows.map(r => r.name).join("、");
        return {
          type: "suggestion",
          title: `フォローアップ未実施: ${result.rows.length}件`,
          detail: `${names}\n\n【対策案】\nA. Airbnbのレビュー依頼メッセージを送る（テンプレートあり）\nB. 三十日珈琲の焙煎体験の案内を送る（リピーター獲得）\nC. 今回は見送り（次の30日後にまた確認）\n\nおすすめ: A（レビューは今後の予約に直結する）`,
          urgency: "info",
          related_table: "customers",
        };
      }
      return null;
    },
  },
  {
    name: "cashflow_warning",
    evaluate: async () => {
      const client = db.getClient();
      const thisMonth = thisMonthJST();

      const [revResult, expResult] = await Promise.all([
        client.execute({ sql: "SELECT SUM(amount) as total FROM money_transactions WHERE amount > 0 AND date LIKE ?", args: [`${thisMonth}%`] }),
        client.execute({ sql: "SELECT SUM(ABS(amount)) as total FROM money_transactions WHERE amount < 0 AND date LIKE ?", args: [`${thisMonth}%`] }),
      ]);

      const revenue = revResult.rows[0]?.total || 0;
      const expenses = expResult.rows[0]?.total || 0;

      if (revenue === 0 && expenses === 0) return null;

      if (expenses > revenue && expenses > 0) {
        const gap = expenses - revenue;
        return {
          type: "anomaly",
          title: "経費が売上を上回っています",
          detail: `売上: ¥${revenue.toLocaleString()} / 経費: ¥${expenses.toLocaleString()} (差額: -¥${gap.toLocaleString()})\n\n【対策案】\nA. 蔵サウナPMの月額報酬(¥100,000)の入金日を確認\nB. えんがわの今月残り予約を確認し、追加の売上見込みを把握\nC. 経費の中で延期可能なものがないか確認\n\nおすすめ: まず入金予定を確認して、月末の着地を予測する`,
          urgency: "action_needed",
        };
      }
      return null;
    },
  },
  {
    name: "weekly_no_bookings",
    evaluate: async () => {
      const client = db.getClient();
      const nextWeekStart = new Date(Date.now() + 86400000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
      const nextWeekEnd = new Date(Date.now() + 8 * 86400000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
      const result = await client.execute({
        sql: "SELECT COUNT(*) as cnt FROM schedule_events WHERE source = 'airbnb' AND start_at >= ? AND start_at <= ? AND status != 'cancelled'",
        args: [nextWeekStart, nextWeekEnd],
      });
      if (result.rows[0]?.cnt === 0) {
        // 過去データがあるか確認（初期化直後除外）
        const totalBookings = await client.execute("SELECT COUNT(*) as cnt FROM schedule_events WHERE source = 'airbnb'");
        if (totalBookings.rows[0]?.cnt === 0) return null;

        return {
          type: "suggestion",
          title: "来週のえんがわ予約がゼロです",
          detail: `${nextWeekStart}〜${nextWeekEnd}の予約がありません。\n\n【対策案】\nA. Airbnbの価格を10-15%下げて直前割を設定する\nB. Instagramで空き状況を投稿して認知を上げる\nC. SpaceMarket/インスタベースのハウススタジオ枠を開放する\n\nおすすめ: A（価格調整は即効性が高い）`,
          urgency: "info",
        };
      }
      return null;
    },
  },
];

// ===== エバリュエーター実行 =====

/**
 * @param {Object} options
 * @param {Function} [options.onInsight] - 気づき生成時のコールバック（プッシュ通知等）
 */
async function evaluate(options = {}) {
  console.log("[evaluator] ========== 自律判断エンジン開始 ==========");
  const start = Date.now();

  // 直近24時間以内の全insightを確認（status問わず重複を防ぐ）
  const client = db.getClient();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const recentInsights = await client.execute({
    sql: "SELECT title FROM agent_insights WHERE created_at >= ?",
    args: [dayAgo],
  });
  const existingTitles = new Set(recentInsights.rows.map(i => i.title));

  let generated = 0;
  let skipped = 0;

  for (const rule of RULES) {
    try {
      const insight = await rule.evaluate();
      if (insight) {
        if (existingTitles.has(insight.title)) {
          skipped++;
          continue;
        }
        await db.addInsight({ id: genId(), ...insight });
        generated++;
        console.log(`[evaluator] 気づき生成: [${insight.urgency}] ${insight.title}`);

        if ((insight.urgency === "action_needed" || insight.urgency === "critical") && options.onInsight) {
          try {
            await options.onInsight(insight);
          } catch (err) {
            console.error("[evaluator] プッシュ通知エラー:", err.message);
          }
        }
      }
    } catch (err) {
      console.error(`[evaluator] ルール "${rule.name}" エラー:`, err.message);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[evaluator] ========== 完了 (${elapsed}秒) — ${generated}件生成, ${skipped}件重複スキップ ==========`);
  return { generated, skipped };
}

module.exports = { evaluate, RULES };
