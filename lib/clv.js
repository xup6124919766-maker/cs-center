/**
 * clv.js — 顧客生命週期計算（RFM）
 *
 * ensureClvSchema()           — 建立 schema migration
 * computeLifecycle(clientId)  — 重算指定業主所有顧客
 * scheduleClvJob()            — 每天 04:00 UTC 跑
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';
import { checkAndEnrollJourneyTrigger } from './journey.js';

const log = rootLogger.child({ module: 'clv' });

// ─── Schema Migration ───
export const ensureClvSchema = () => {
  const safeAlter = (sql) => {
    try { db.exec(sql); } catch (e) {
      if (!e.message?.includes('duplicate column')) throw e;
    }
  };

  safeAlter("ALTER TABLE customers ADD COLUMN lifecycle_stage TEXT DEFAULT 'new'");
  safeAlter('ALTER TABLE customers ADD COLUMN last_active_at INTEGER');
  safeAlter('ALTER TABLE customers ADD COLUMN total_messages INTEGER DEFAULT 0');
  safeAlter('ALTER TABLE customers ADD COLUMN total_orders INTEGER DEFAULT 0');
  safeAlter('ALTER TABLE customers ADD COLUMN total_spent REAL DEFAULT 0');
  safeAlter('ALTER TABLE customers ADD COLUMN lifecycle_updated_at INTEGER');

  // clients 補貨週期
  safeAlter('ALTER TABLE clients ADD COLUMN replenish_cycle_days INTEGER DEFAULT 30');

  log.info('CLV schema ready');
};

// ─── RFM 評分 → lifecycle_stage ───
// stage: new / active / vip / at_risk / lost
const calcStage = ({ recencyDays, frequency, monetary, createdDays, vipThreshold, vipOrders }) => {
  // VIP 條件：消費超過閾值 OR 訂單超過 10 筆
  if (monetary >= vipThreshold || frequency >= vipOrders) return 'vip';

  // 流失：超過 90 天無互動且曾活躍
  if (recencyDays > 90 && frequency >= 3) return 'lost';

  // 流失預警：超過 30 天無互動且曾活躍
  if (recencyDays > 30 && frequency >= 3) return 'at_risk';

  // 新客：建立 < 30 天 + 互動 < 3 次
  if (createdDays < 30 && frequency < 3) return 'new';

  // 活躍：近 7 天有互動 + 累計 >= 3 次
  if (recencyDays <= 7 && frequency >= 3) return 'active';

  // 其他視為新客
  return 'new';
};

// ─── 重算單一業主 ───
export const computeLifecycle = (clientId) => {
  const now = Date.now();
  const DAY_MS = 86400000;

  // 取業主設定
  const client = db.prepare('SELECT replenish_cycle_days FROM clients WHERE id = ?').get(clientId);
  const replenishDays = client?.replenish_cycle_days ?? 30;

  // VIP 閾值（預設：消費 > 5000 OR 訂單 > 10）
  const vipThreshold = 5000;
  const vipOrders = 10;

  // 取所有顧客
  const customers = db.prepare('SELECT * FROM customers WHERE client_id = ?').all(clientId);
  let updated = 0;

  for (const cust of customers) {
    try {
      // 最後互動（對話 last_message_at）
      const lastConv = db.prepare(`
        SELECT MAX(last_message_at) AS lat FROM conversations WHERE client_id = ? AND customer_id = ?
      `).get(clientId, cust.id);
      const lastActiveAt = lastConv?.lat || cust.created_at;

      // 訊息數（inbound）
      const msgCount = db.prepare(`
        SELECT COUNT(*) AS cnt FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.client_id = ? AND c.customer_id = ? AND m.direction = 'inbound'
      `).get(clientId, cust.id)?.cnt ?? 0;

      // 訂單
      const orderRow = db.prepare(`
        SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS total
        FROM orders WHERE client_id = ? AND customer_id = ?
      `).get(clientId, cust.id);
      const orderCount = orderRow?.cnt ?? 0;
      const totalSpent = orderRow?.total ?? 0;

      // RFM
      const recencyDays  = Math.floor((now - lastActiveAt) / DAY_MS);
      const createdDays  = Math.floor((now - cust.created_at) / DAY_MS);
      const frequency    = msgCount + orderCount;
      const monetary     = totalSpent;

      const stage = calcStage({ recencyDays, frequency, monetary, createdDays, vipThreshold, vipOrders });

      db.prepare(`
        UPDATE customers SET
          lifecycle_stage = ?,
          last_active_at = ?,
          total_messages = ?,
          total_orders = ?,
          total_spent = ?,
          lifecycle_updated_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run(stage, lastActiveAt, msgCount, orderCount, totalSpent, now, now, cust.id);

      // 流失預警 → enroll 沉默喚醒旅程
      if (stage === 'at_risk' && cust.lifecycle_stage !== 'at_risk') {
        try {
          checkAndEnrollJourneyTrigger('custom_event', {
            client_id: clientId,
            customer_id: cust.id,
            event: 'inactive_30d',
          });
        } catch {}
      }

      // 補貨提醒：active/vip 顧客，上次下單滿 25 天（±1 天視窗）→ 觸發旅程
      if (orderCount > 0 && (stage === 'active' || stage === 'vip')) {
        const lastOrder = db.prepare(`
          SELECT MAX(ordered_at) AS lat FROM orders WHERE client_id = ? AND customer_id = ?
        `).get(clientId, cust.id);
        if (lastOrder?.lat) {
          const daysSinceOrder = (now - lastOrder.lat) / DAY_MS;
          // 目標：25 天（也尊重業主自訂 replenishDays * 0.85，取二者較小值確保提前提醒）
          const targetDays = Math.min(25, replenishDays * 0.85);
          // 在 ±1 天範圍內觸發
          if (Math.abs(daysSinceOrder - targetDays) < 1) {
            try {
              checkAndEnrollJourneyTrigger('replenish_due', {
                client_id: clientId,
                customer_id: cust.id,
              });
            } catch {}
          }
        }
      }

      updated++;
    } catch (e) {
      log.warn({ err: e.message, customer_id: cust.id }, 'CLV 計算單顧客失敗，略過');
    }
  }

  log.info({ client_id: clientId, updated }, 'CLV recompute done');
  return updated;
};

// ─── 排程：每天 04:00 UTC ───
export const scheduleClvJob = () => {
  const runClvForAllClients = () => {
    const clients = db.prepare('SELECT id FROM clients').all();
    for (const c of clients) {
      try {
        computeLifecycle(c.id);
      } catch (e) {
        log.error({ err: e.message, client_id: c.id }, 'CLV 排程執行失敗');
      }
    }
  };

  // 計算距離今天 04:00 UTC 還有幾 ms
  const msUntilNextRun = () => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 0, 0, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  };

  const scheduleNext = () => {
    const delay = msUntilNextRun();
    log.info({ next_run_ms: delay }, `CLV 排程下次執行：${new Date(Date.now() + delay).toISOString()}`);
    setTimeout(() => {
      runClvForAllClients();
      setInterval(runClvForAllClients, 86400000); // 之後每 24 小時
    }, delay);
  };

  scheduleNext();
};

// ─── KPI 統計 ───
export const getClvOverview = (clientId) => {
  const stages = db.prepare(`
    SELECT lifecycle_stage AS stage, COUNT(*) AS cnt
    FROM customers WHERE client_id = ?
    GROUP BY lifecycle_stage
  `).all(clientId);

  const total = db.prepare('SELECT COUNT(*) AS cnt FROM customers WHERE client_id = ?').get(clientId)?.cnt ?? 0;
  const stageMap = Object.fromEntries(stages.map(r => [r.stage, r.cnt]));

  return {
    total,
    new:     stageMap['new']     ?? 0,
    active:  stageMap['active']  ?? 0,
    vip:     stageMap['vip']     ?? 0,
    at_risk: stageMap['at_risk'] ?? 0,
    lost:    stageMap['lost']    ?? 0,
  };
};

// ─── 顧客列表（依 stage）───
export const getClvCustomers = (clientId, { stage = null, limit = 50, offset = 0 } = {}) => {
  const where = ['c.client_id = ?'];
  const args = [clientId];
  if (stage) { where.push('c.lifecycle_stage = ?'); args.push(stage); }

  const sql = `
    SELECT c.*,
           cc.channel_display_name,
           cc.channel_avatar_url,
           cc.channel
    FROM customers c
    LEFT JOIN customer_channels cc ON cc.customer_id = c.id
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE c.lifecycle_stage WHEN 'vip' THEN 0 WHEN 'active' THEN 1 WHEN 'at_risk' THEN 2 WHEN 'new' THEN 3 ELSE 4 END,
      c.last_active_at DESC NULLS LAST
    LIMIT ? OFFSET ?
  `;
  args.push(limit, offset);
  return db.prepare(sql).all(...args);
};

export default { ensureClvSchema, computeLifecycle, scheduleClvJob, getClvOverview, getClvCustomers };
