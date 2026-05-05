/**
 * lib/ab_test.js — A/B Test 引擎
 *
 * createAbTest(...)       — 建立 draft，預先建兩個 draft broadcasts
 * launchAbTest(id)        — 分眾、隨機切組、送出雙廣播
 * getAbResults(id)        — 即時統計，不寫 DB
 * computeAbResults(id)    — 同上，純運算回傳物件
 * decideWinner(id, manual) — 決定勝者，寫入 DB
 * sendWinnerToRest(id)    — 把勝者版本送給剩下沒收到的人
 */

import { db } from './db.js';
import { resolveSegment, prepareBroadcast, executeBroadcast } from './broadcast.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'ab_test' });

// ─── Schema Migration ───
export const ensureAbTestSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ab_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      hypothesis TEXT,
      channel TEXT NOT NULL,
      segment_filter TEXT,

      variant_a_content TEXT NOT NULL,
      variant_b_content TEXT NOT NULL,
      variant_a_label TEXT DEFAULT 'A',
      variant_b_label TEXT DEFAULT 'B',

      split_strategy TEXT DEFAULT 'random_50_50',
      test_size_percent INTEGER DEFAULT 30,

      primary_metric TEXT DEFAULT 'positive_feedback',
      min_sample_per_variant INTEGER DEFAULT 20,

      status TEXT DEFAULT 'draft',
      total_targets INTEGER DEFAULT 0,
      test_size_targets INTEGER DEFAULT 0,

      broadcast_a_id INTEGER,
      broadcast_b_id INTEGER,

      started_at INTEGER,
      decision_at INTEGER,
      winner_variant TEXT,
      winner_lift_percent REAL,

      rest_sent_at INTEGER,
      rest_broadcast_id INTEGER,

      created_by INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (rest_broadcast_id) REFERENCES broadcasts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_abtests_client_status ON ab_tests(client_id, status);
  `);

  // broadcasts 表加 ab_test_id + ab_variant 欄位
  try { db.exec('ALTER TABLE broadcasts ADD COLUMN ab_test_id INTEGER'); } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }
  try { db.exec("ALTER TABLE broadcasts ADD COLUMN ab_variant TEXT"); } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }
};

// ─── 建立 A/B Test（draft）───
export const createAbTest = ({
  client_id,
  name,
  hypothesis = null,
  channel,
  segment_filter = null,
  variant_a_content,
  variant_b_content,
  variant_a_label = 'A',
  variant_b_label = 'B',
  split_strategy = 'random_50_50',
  test_size_percent = 30,
  primary_metric = 'positive_feedback',
  min_sample_per_variant = 20,
  created_by = null,
}) => {
  if (!client_id || !name || !channel || !variant_a_content || !variant_b_content) {
    throw new Error('缺少必要欄位：client_id / name / channel / variant_a_content / variant_b_content');
  }
  const now = Date.now();
  const segStr = segment_filter
    ? (typeof segment_filter === 'string' ? segment_filter : JSON.stringify(segment_filter))
    : null;

  // 建 ab_test 本體（broadcast_a_id / broadcast_b_id 稍後填）
  const testId = db.prepare(`
    INSERT INTO ab_tests
      (client_id, name, hypothesis, channel, segment_filter,
       variant_a_content, variant_b_content, variant_a_label, variant_b_label,
       split_strategy, test_size_percent, primary_metric, min_sample_per_variant,
       status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
  `).run(
    client_id, name, hypothesis, channel, segStr,
    variant_a_content, variant_b_content, variant_a_label, variant_b_label,
    split_strategy, test_size_percent, primary_metric, min_sample_per_variant,
    created_by, now, now
  ).lastInsertRowid;

  // 預建兩個 broadcast draft（綁 ab_test_id + ab_variant）
  const bcastA = db.prepare(`
    INSERT INTO broadcasts
      (client_id, name, channel, content_type, content, segment_filter,
       status, ab_test_id, ab_variant, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'text', ?, ?, 'draft', ?, 'A', ?, ?, ?)
  `).run(
    client_id, `${name} — ${variant_a_label}`, channel,
    variant_a_content, segStr, testId, created_by, now, now
  ).lastInsertRowid;

  const bcastB = db.prepare(`
    INSERT INTO broadcasts
      (client_id, name, channel, content_type, content, segment_filter,
       status, ab_test_id, ab_variant, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'text', ?, ?, 'draft', ?, 'B', ?, ?, ?)
  `).run(
    client_id, `${name} — ${variant_b_label}`, channel,
    variant_b_content, segStr, testId, created_by, now, now
  ).lastInsertRowid;

  // 回填兩個 broadcast_id
  db.prepare(`UPDATE ab_tests SET broadcast_a_id = ?, broadcast_b_id = ?, updated_at = ? WHERE id = ?`)
    .run(bcastA, bcastB, now, testId);

  log.info({ test_id: testId, broadcast_a: bcastA, broadcast_b: bcastB }, 'ab_test created');
  return { id: testId, broadcast_a_id: bcastA, broadcast_b_id: bcastB };
};

// ─── 分流比例解析 ───
// 回傳 [ratioA, ratioB]，總和 = 1
const parseSplitRatio = (strategy) => {
  switch (strategy) {
    case 'random_30_70': return [0.3, 0.7];
    case 'random_70_30': return [0.7, 0.3];
    case 'sequential':
    case 'random_50_50':
    default: return [0.5, 0.5];
  }
};

// ─── Fisher-Yates shuffle（in-place）───
const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

// ─── 啟動 A/B Test ───
export const launchAbTest = async (testId) => {
  const test = db.prepare('SELECT * FROM ab_tests WHERE id = ?').get(testId);
  if (!test) throw new Error(`ab_test ${testId} 不存在`);
  if (test.status !== 'draft') throw new Error(`ab_test ${testId} 狀態為 ${test.status}，只有 draft 可以 launch`);

  let filter = {};
  try { filter = JSON.parse(test.segment_filter || '{}'); } catch {}

  // 1. 撈全部目標分眾
  const allTargets = resolveSegment(test.client_id, filter);
  const totalTargets = allTargets.length;

  if (totalTargets === 0) throw new Error('分眾條件符合 0 人，無法啟動');

  // 2. 隨機抽 test_size_percent% 做測試
  const testSizeCount = Math.max(1, Math.round(totalTargets * test.test_size_percent / 100));
  const shuffled = shuffle([...allTargets]);
  const testGroup = shuffled.slice(0, testSizeCount);

  // 3. 依 split_strategy 分 A / B 組（確保不重疊）
  const [ratioA] = parseSplitRatio(test.split_strategy);
  const countA = Math.max(1, Math.round(testGroup.length * ratioA));
  const groupA = testGroup.slice(0, countA);
  const groupB = testGroup.slice(countA);

  log.info({
    test_id: testId,
    total: totalTargets,
    test_size: testSizeCount,
    group_a: groupA.length,
    group_b: groupB.length,
  }, 'ab_test launching');

  const now = Date.now();

  // 4. 塞 recipients 給兩個 broadcasts
  const insertRecipient = db.prepare(`
    INSERT OR IGNORE INTO broadcast_recipients (broadcast_id, customer_id, channel, status)
    VALUES (?, ?, ?, 'pending')
  `);

  const setTargets = db.prepare(`
    UPDATE broadcasts SET total_targets = ?, updated_at = ? WHERE id = ?
  `);

  // 使用 transaction 確保一致性
  const txn = db.transaction(() => {
    // 清除之前的 pending（重新 launch 場景）
    db.prepare("DELETE FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'pending'")
      .run(test.broadcast_a_id);
    db.prepare("DELETE FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'pending'")
      .run(test.broadcast_b_id);

    for (const cust of groupA) {
      insertRecipient.run(test.broadcast_a_id, cust.id, test.channel);
    }
    for (const cust of groupB) {
      insertRecipient.run(test.broadcast_b_id, cust.id, test.channel);
    }

    setTargets.run(groupA.length, now, test.broadcast_a_id);
    setTargets.run(groupB.length, now, test.broadcast_b_id);

    db.prepare(`
      UPDATE ab_tests
        SET status = 'running', total_targets = ?, test_size_targets = ?, started_at = ?, updated_at = ?
      WHERE id = ?
    `).run(totalTargets, testSizeCount, now, now, testId);
  });
  txn();

  // 5. 非同步送出兩個廣播（不等完成）
  executeBroadcast(test.broadcast_a_id)
    .catch(e => log.error({ err: e.message, broadcast_id: test.broadcast_a_id }, 'ab_test variant A send error'));
  executeBroadcast(test.broadcast_b_id)
    .catch(e => log.error({ err: e.message, broadcast_id: test.broadcast_b_id }, 'ab_test variant B send error'));

  return {
    total_targets: totalTargets,
    test_size: testSizeCount,
    group_a: groupA.length,
    group_b: groupB.length,
  };
};

// ─── 統計顯著性判斷（差距 > 10 個百分點且各 >= min_sample）───
const isSignificant = (a, b, minSample = 20) => {
  if (a.total < minSample || b.total < minSample) return false;
  const aRate = a.total > 0 ? a.success / a.total : 0;
  const bRate = b.total > 0 ? b.success / b.total : 0;
  return Math.abs(aRate - bRate) > 0.1;
};

// ─── 計算兩個 variant 的指標 ───
export const computeAbResults = (testId) => {
  const test = db.prepare('SELECT * FROM ab_tests WHERE id = ?').get(testId);
  if (!test) throw new Error(`ab_test ${testId} 不存在`);

  const getMetrics = (broadcastId) => {
    if (!broadcastId) return null;
    const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(broadcastId);
    if (!broadcast) return null;

    const recips = db.prepare('SELECT * FROM broadcast_recipients WHERE broadcast_id = ?').all(broadcastId);
    const total = recips.length;
    const sent = recips.filter(r => r.status === 'sent' || r.sent_at).length;
    const read = recips.filter(r => r.read_at).length;
    const clicked = recips.filter(r => r.clicked_at).length;

    // 正面評價（從 broadcast_feedback 表）
    let positiveFeedback = 0;
    let totalFeedback = 0;
    let unsubscribe = 0;
    try {
      const fbRows = db.prepare(
        "SELECT feedback, COUNT(*) AS cnt FROM broadcast_feedback WHERE broadcast_id = ? GROUP BY feedback"
      ).all(broadcastId);
      for (const row of fbRows) {
        totalFeedback += row.cnt;
        if (row.feedback === 'useful') positiveFeedback += row.cnt;
        if (row.feedback === 'unsubscribe') unsubscribe += row.cnt;
      }
    } catch {}

    // 回覆率：送出後 24h 內，recipient customers 有回覆（conversation 有 inbound message）
    let replyCount = 0;
    if (sent > 0 && broadcast.sent_at) {
      const windowEnd = broadcast.sent_at + 24 * 3600 * 1000;
      const customerIds = recips.filter(r => r.sent_at).map(r => r.customer_id);
      if (customerIds.length > 0) {
        const placeholders = customerIds.map(() => '?').join(',');
        try {
          const replied = db.prepare(`
            SELECT COUNT(DISTINCT c.customer_id) AS cnt
            FROM conversations c
            JOIN messages m ON m.conversation_id = c.id
            WHERE c.customer_id IN (${placeholders})
              AND c.client_id = ?
              AND m.direction = 'inbound'
              AND m.created_at BETWEEN ? AND ?
          `).get(...customerIds, test.client_id, broadcast.sent_at, windowEnd);
          replyCount = replied?.cnt || 0;
        } catch {}
      }
    }

    const deliveryRate = total > 0 ? sent / total : 0;
    const openRate = sent > 0 ? read / sent : 0;
    const clickRate = sent > 0 ? clicked / sent : 0;
    const replyRate = sent > 0 ? replyCount / sent : 0;
    const positiveFeedbackRate = totalFeedback > 0 ? positiveFeedback / totalFeedback : 0;
    const unsubRate = totalFeedback > 0 ? unsubscribe / totalFeedback : 0;

    return {
      broadcast_id: broadcastId,
      total,
      sent,
      read,
      clicked,
      reply_count: replyCount,
      positive_feedback: positiveFeedback,
      total_feedback: totalFeedback,
      unsubscribe,
      delivery_rate: deliveryRate,
      open_rate: openRate,
      click_rate: clickRate,
      reply_rate: replyRate,
      positive_feedback_rate: positiveFeedbackRate,
      unsub_rate: unsubRate,
    };
  };

  const metricA = getMetrics(test.broadcast_a_id);
  const metricB = getMetrics(test.broadcast_b_id);

  // 選 primary_metric 決定勝負
  const metricKey = {
    positive_feedback: 'positive_feedback_rate',
    reply_rate: 'reply_rate',
    click_rate: 'click_rate',
    open_rate: 'open_rate',
    delivery_rate: 'delivery_rate',
  }[test.primary_metric] || 'positive_feedback_rate';

  let winner = null;
  let liftPct = null;
  let significant = false;

  if (metricA && metricB) {
    const aVal = metricA[metricKey] || 0;
    const bVal = metricB[metricKey] || 0;

    const aStats = { total: metricA.total_feedback || metricA.sent || 0, success: Math.round((metricA[metricKey] || 0) * (metricA.total_feedback || metricA.sent || 0)) };
    const bStats = { total: metricB.total_feedback || metricB.sent || 0, success: Math.round((metricB[metricKey] || 0) * (metricB.total_feedback || metricB.sent || 0)) };

    significant = isSignificant(aStats, bStats, test.min_sample_per_variant);

    if (significant) {
      if (aVal > bVal) {
        winner = 'A';
        liftPct = bVal > 0 ? Math.round((aVal - bVal) / bVal * 100 * 10) / 10 : null;
      } else if (bVal > aVal) {
        winner = 'B';
        liftPct = aVal > 0 ? Math.round((bVal - aVal) / aVal * 100 * 10) / 10 : null;
      } else {
        winner = 'tie';
        liftPct = 0;
      }
    } else {
      winner = 'inconclusive';
    }
  }

  return {
    test,
    variant_a: metricA ? { ...metricA, label: test.variant_a_label } : null,
    variant_b: metricB ? { ...metricB, label: test.variant_b_label } : null,
    primary_metric: test.primary_metric,
    metric_key: metricKey,
    winner,
    lift_pct: liftPct,
    significant,
  };
};

// ─── 決定勝者（寫 DB）───
export const decideWinner = (testId, manualWinner = null) => {
  const test = db.prepare('SELECT * FROM ab_tests WHERE id = ?').get(testId);
  if (!test) throw new Error(`ab_test ${testId} 不存在`);
  if (!['running', 'draft'].includes(test.status)) throw new Error(`ab_test 狀態 ${test.status} 不可決定勝者`);

  // 驗證 manual_winner
  if (manualWinner && !['A', 'B'].includes(manualWinner)) {
    throw new Error('manual_winner 只接受 A 或 B');
  }

  let winner, liftPct;

  if (manualWinner) {
    winner = manualWinner;
    liftPct = null;
  } else {
    const results = computeAbResults(testId);
    winner = results.winner;
    liftPct = results.lift_pct;
  }

  const now = Date.now();
  db.prepare(`
    UPDATE ab_tests
      SET status = 'completed', winner_variant = ?, winner_lift_percent = ?,
          decision_at = ?, updated_at = ?
    WHERE id = ?
  `).run(winner, liftPct, now, now, testId);

  log.info({ test_id: testId, winner, lift_pct: liftPct, manual: !!manualWinner }, 'ab_test winner decided');
  return { winner, lift_pct: liftPct };
};

// ─── 把勝者版本送給剩下沒收到的人 ───
export const sendWinnerToRest = async (testId) => {
  const test = db.prepare('SELECT * FROM ab_tests WHERE id = ?').get(testId);
  if (!test) throw new Error(`ab_test ${testId} 不存在`);
  if (test.status !== 'completed') throw new Error('請先呼叫 decide-winner 完成測試再送出');
  if (!test.winner_variant || !['A', 'B'].includes(test.winner_variant)) {
    throw new Error(`勝者未決定或為 ${test.winner_variant}，無法送出`);
  }
  if (test.rest_sent_at) throw new Error('已經送過勝者廣播了');

  // 決定勝者 content + broadcast_id
  const winnerBroadcastId = test.winner_variant === 'A' ? test.broadcast_a_id : test.broadcast_b_id;
  const winnerContent = test.winner_variant === 'A' ? test.variant_a_content : test.variant_b_content;
  const winnerLabel = test.winner_variant === 'A' ? test.variant_a_label : test.variant_b_label;

  // 撈所有已發送過的 customer_id（A + B 組都算）
  const sentCustomerIds = db.prepare(`
    SELECT DISTINCT br.customer_id
    FROM broadcast_recipients br
    WHERE br.broadcast_id IN (?, ?)
      AND br.status IN ('sent', 'failed')
  `).all(test.broadcast_a_id, test.broadcast_b_id).map(r => r.customer_id);

  // 撈完整分眾
  let filter = {};
  try { filter = JSON.parse(test.segment_filter || '{}'); } catch {}
  const allTargets = resolveSegment(test.client_id, filter);

  // 差集：排除已送過的人
  const sentSet = new Set(sentCustomerIds);
  const restTargets = allTargets.filter(c => !sentSet.has(c.id));

  if (restTargets.length === 0) {
    throw new Error('剩下沒收到的人數為 0，所有分眾已在 A/B 測試中接收過');
  }

  const now = Date.now();

  // 建新 broadcast
  const restBroadcastId = db.prepare(`
    INSERT INTO broadcasts
      (client_id, name, channel, content_type, content, segment_filter,
       status, ab_test_id, ab_variant, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'text', ?, ?, 'draft', ?, ?, ?, ?, ?)
  `).run(
    test.client_id,
    `${test.name} — 勝者 ${winnerLabel}（剩餘分眾）`,
    test.channel,
    winnerContent,
    test.segment_filter,
    testId,
    `${test.winner_variant}_rest`,
    test.created_by,
    now, now
  ).lastInsertRowid;

  // 直接插入 recipients（不走 resolveSegment，因為已過濾）
  const insertRecipient = db.prepare(`
    INSERT OR IGNORE INTO broadcast_recipients (broadcast_id, customer_id, channel, status)
    VALUES (?, ?, ?, 'pending')
  `);
  const txn = db.transaction(() => {
    for (const cust of restTargets) {
      insertRecipient.run(restBroadcastId, cust.id, test.channel);
    }
    db.prepare('UPDATE broadcasts SET total_targets = ?, updated_at = ? WHERE id = ?')
      .run(restTargets.length, now, restBroadcastId);
  });
  txn();

  // 記錄 rest_broadcast_id
  db.prepare(`
    UPDATE ab_tests SET rest_broadcast_id = ?, rest_sent_at = ?, updated_at = ? WHERE id = ?
  `).run(restBroadcastId, now, now, testId);

  // 非同步送出
  executeBroadcast(restBroadcastId)
    .catch(e => log.error({ err: e.message, broadcast_id: restBroadcastId }, 'ab_test rest send error'));

  log.info({
    test_id: testId,
    winner: test.winner_variant,
    rest_broadcast_id: restBroadcastId,
    rest_count: restTargets.length,
  }, 'ab_test winner sent to rest');

  return {
    rest_broadcast_id: restBroadcastId,
    rest_count: restTargets.length,
  };
};

export default { ensureAbTestSchema, createAbTest, launchAbTest, computeAbResults, decideWinner, sendWinnerToRest };
