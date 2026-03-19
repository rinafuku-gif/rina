/**
 * 自律判断エンジン（Agent Evaluator）
 *
 * 統合DBのデータを分析し、異常検知・提案・リマインドを生成。
 * 結果はagent_insightsテーブルに書き込まれ、
 * しらたまのホーム画面やプッシュ通知で表示される。
 *
 * データ取り込み（ingester）の後に実行する。
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
  const m = jst.getMonth(); // 0-indexed
  return m === 0
    ? `${jst.getFullYear() - 1}-12`
    : `${jst.getFullYear()}-${String(m).padStart(2, "0")}`;
}

// ===== ルールエンジン =====

const RULES = [
  {
    name: "revenue_drought",
    description: "売上が7日間ゼロ",
    evaluate: async () => {
      const client = db.getClient();
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const result = await client.execute({
        sql: "SELECT COUNT(*) as cnt FROM money_transactions WHERE amount > 0 AND date >= ?",
        args: [weekAgo],
      });
      if (result.rows[0]?.cnt === 0) {
        // まだこの期間の売上データ自体がなければスキップ（DB初期化直後）
        const totalResult = await client.execute("SELECT COUNT(*) as cnt FROM money_transactions WHERE amount > 0");
        if (totalResult.rows[0]?.cnt === 0) return null;

        return {
          type: "anomaly",
          title: "売上が7日間ゼロです",
          detail: "直近7日間に売上の記録がありません。各事業の状況を確認しましょう。えんがわの予約状況やSATOYAMAの問い合わせをチェックしてみてください。",
          urgency: "action_needed",
        };
      }
      return null;
    },
  },
  {
    name: "expense_spike",
    description: "今月の経費が先月比30%以上増加",
    evaluate: async () => {
      const client = db.getClient();
      const thisMonth = thisMonthJST();
      const lastMonth = lastMonthJST();

      const [thisResult, lastResult] = await Promise.all([
        client.execute({ sql: "SELECT SUM(ABS(amount)) as total FROM money_transactions WHERE amount < 0 AND date LIKE ?", args: [`${thisMonth}%`] }),
        client.execute({ sql: "SELECT SUM(ABS(amount)) as total FROM money_transactions WHERE amount < 0 AND date LIKE ?", args: [`${lastMonth}%`] }),
      ]);

      const thisTotal = thisResult.rows[0]?.total || 0;
      const lastTotal = lastResult.rows[0]?.total || 0;

      if (lastTotal > 0 && thisTotal > lastTotal * 1.3) {
        const pct = Math.round(((thisTotal - lastTotal) / lastTotal) * 100);
        return {
          type: "anomaly",
          title: `今月の経費が先月比+${pct}%`,
          detail: `今月: ¥${thisTotal.toLocaleString()} / 先月: ¥${lastTotal.toLocaleString()}。大きな出費がないか確認しましょう。`,
          urgency: "info",
        };
      }
      return null;
    },
  },
  {
    name: "tomorrow_booking",
    description: "明日のAirbnb予約にリマインド",
    evaluate: async () => {
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const client = db.getClient();
      const result = await client.execute({
        sql: "SELECT * FROM schedule_events WHERE start_at LIKE ? AND source = 'airbnb' AND status != 'cancelled'",
        args: [`${tomorrow}%`],
      });
      if (result.rows.length > 0) {
        const guests = result.rows.map(r => r.guest_name || "ゲスト").join("、");
        return {
          type: "reminder",
          title: `明日チェックイン: ${guests}`,
          detail: `${result.rows.length}件の宿泊予約があります。清掃・準備を確認してください。`,
          urgency: "action_needed",
          related_table: "schedule_events",
        };
      }
      return null;
    },
  },
  {
    name: "overdue_tasks",
    description: "期限切れタスクの検出",
    evaluate: async () => {
      const client = db.getClient();
      const todayStr = today();
      const result = await client.execute({
        sql: "SELECT COUNT(*) as cnt FROM tasks WHERE status IN ('pending', 'in_progress') AND due_date IS NOT NULL AND due_date < ?",
        args: [todayStr],
      });
      const count = result.rows[0]?.cnt || 0;
      if (count > 0) {
        return {
          type: "reminder",
          title: `期限切れタスクが${count}件あります`,
          detail: "優先度を見直して、対応するか延期するか判断してください。",
          urgency: count >= 3 ? "action_needed" : "info",
          related_table: "tasks",
        };
      }
      return null;
    },
  },
  {
    name: "no_followup",
    description: "初回接触から30日経過しフォローなしの顧客",
    evaluate: async () => {
      const client = db.getClient();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const result = await client.execute({
        sql: `SELECT * FROM customers
              WHERE first_contact IS NOT NULL AND first_contact <= ?
              AND (last_contact IS NULL OR last_contact = first_contact)
              LIMIT 5`,
        args: [thirtyDaysAgo],
      });
      if (result.rows.length > 0) {
        const names = result.rows.map(r => r.name).join("、");
        return {
          type: "suggestion",
          title: `フォローアップ未実施の顧客: ${result.rows.length}件`,
          detail: `${names} — 初回接触から30日以上経過。フォローメールを送りませんか？`,
          urgency: "info",
          related_table: "customers",
        };
      }
      return null;
    },
  },
  {
    name: "cashflow_warning",
    description: "キャッシュフロー警告（経費が売上を上回っている）",
    evaluate: async () => {
      const client = db.getClient();
      const thisMonth = thisMonthJST();

      const [revResult, expResult] = await Promise.all([
        client.execute({ sql: "SELECT SUM(amount) as total FROM money_transactions WHERE amount > 0 AND date LIKE ?", args: [`${thisMonth}%`] }),
        client.execute({ sql: "SELECT SUM(ABS(amount)) as total FROM money_transactions WHERE amount < 0 AND date LIKE ?", args: [`${thisMonth}%`] }),
      ]);

      const revenue = revResult.rows[0]?.total || 0;
      const expenses = expResult.rows[0]?.total || 0;

      // データが少ない場合はスキップ
      if (revenue === 0 && expenses === 0) return null;

      if (expenses > revenue && expenses > 0) {
        const gap = expenses - revenue;
        return {
          type: "anomaly",
          title: "今月の経費が売上を上回っています",
          detail: `売上: ¥${revenue.toLocaleString()} / 経費: ¥${expenses.toLocaleString()} (差額: -¥${gap.toLocaleString()})。入金予定や経費の見直しを検討してください。`,
          urgency: "action_needed",
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

  // 既存のpending insightを確認（同じルールの重複を防ぐ）
  const existing = await db.getPendingInsights();
  const existingTitles = new Set(existing.map(i => i.title));

  let generated = 0;
  let skipped = 0;

  for (const rule of RULES) {
    try {
      const insight = await rule.evaluate();
      if (insight) {
        // 同じタイトルのinsightが既にpendingならスキップ
        if (existingTitles.has(insight.title)) {
          skipped++;
          continue;
        }
        await db.addInsight({ id: genId(), ...insight });
        generated++;
        console.log(`[evaluator] 気づき生成: [${insight.urgency}] ${insight.title}`);

        // action_needed以上の気づきはプッシュ通知
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
