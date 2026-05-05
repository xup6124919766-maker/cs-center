/**
 * lib/billing.js — LINE/FB 訊息計費 LOG + 月額度警示
 *
 * recordBilling({ client_id, channel, api_type, recipient_count, message_id?, conversation_id?, metadata? })
 * getMonthlyUsage(client_id)
 * getQuotaForPlan(plan)
 * checkQuotaThreshold(client_id)
 * scanAllClientsQuota()
 * previewCost(broadcast)
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';
import { emitToClient } from './realtime.js';
import { dispatchEvent } from './webhooks_out.js';

const log = rootLogger.child({ module: 'billing' });

// ─── Schema Migration ───
export const ensureBillingSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_billing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      message_id INTEGER,
      conversation_id INTEGER,
      channel TEXT NOT NULL,
      api_type TEXT NOT NULL,
      is_billable INTEGER DEFAULT 0,
      cost_units INTEGER DEFAULT 0,
      recipient_count INTEGER DEFAULT 1,
      external_message_id TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );
    CREATE INDEX IF NOT EXISTS idx_billing_client_date ON message_billing(client_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_billing_billable ON message_billing(client_id, is_billable, created_at);
  `);

  // clients 表加新欄位
  const safeAlter = (sql) => {
    try { db.exec(sql); } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
  };
  safeAlter("ALTER TABLE clients ADD COLUMN line_plan TEXT DEFAULT 'light'");
  safeAlter("ALTER TABLE clients ADD COLUMN line_quota_warning_threshold INTEGER DEFAULT 80");
  safeAlter("ALTER TABLE clients ADD COLUMN line_alert_sent_80 INTEGER DEFAULT 0");
  safeAlter("ALTER TABLE clients ADD COLUMN line_alert_sent_95 INTEGER DEFAULT 0");
  safeAlter("ALTER TABLE clients ADD COLUMN line_alert_sent_100 INTEGER DEFAULT 0");

  log.info('billing schema ready');
};

// ─── 方案額度表 ───
const LINE_PLANS = {
  light:  { name: 'Light', free: 200,   price_per_extra: 0.01 },
  medium: { name: 'Medium', free: 4000,  price_per_extra: 0.005 },
  heavy:  { name: 'Heavy', free: 25000, price_per_extra: 0.003 },
};

export const getQuotaForPlan = (plan = 'light') => {
  return LINE_PLANS[plan] || LINE_PLANS.light;
};

// ─── 判斷 reply window（24h 內有無 inbound）───
const isWithin24hWindow = (clientId, conversationId) => {
  if (!conversationId) return false;
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const row = db.prepare(`
      SELECT MAX(created_at) AS last_in FROM messages
      WHERE conversation_id = ? AND direction = 'inbound' AND created_at >= ?
    `).get(conversationId, cutoff);
    return !!row?.last_in;
  } catch {
    return false;
  }
};

// ─── 計費紀錄 ───
export const recordBilling = ({
  client_id, channel, api_type,
  recipient_count = 1,
  message_id = null,
  conversation_id = null,
  external_message_id = null,
  metadata = null,
}) => {
  let is_billable = 0;
  let cost_units = 0;

  if (channel === 'line') {
    if (api_type === 'incoming') {
      // Inbound：記錄 reply window，不計費
      is_billable = 0; cost_units = 0;
    } else if (api_type === 'reply') {
      // Reply：24h 內免費
      const inWindow = isWithin24hWindow(client_id, conversation_id);
      is_billable = inWindow ? 0 : 1;
      cost_units = inWindow ? 0 : recipient_count;
    } else {
      // push / broadcast / multicast / narrowcast → 計費
      is_billable = 1;
      cost_units = recipient_count;
    }
  } else if (channel === 'fb') {
    if (api_type === 'incoming') {
      is_billable = 0; cost_units = 0;
    } else if (api_type === 'reply') {
      const inWindow = isWithin24hWindow(client_id, conversation_id);
      is_billable = inWindow ? 0 : 1;
      cost_units = inWindow ? 0 : recipient_count;
    } else {
      is_billable = 1;
      cost_units = recipient_count;
    }
  }

  try {
    db.prepare(`
      INSERT INTO message_billing
        (client_id, message_id, conversation_id, channel, api_type, is_billable, cost_units, recipient_count, external_message_id, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      client_id, message_id, conversation_id,
      channel, api_type, is_billable, cost_units, recipient_count,
      external_message_id,
      metadata ? JSON.stringify(metadata) : null,
      Date.now()
    );

    log.debug({ client_id, channel, api_type, is_billable, cost_units }, 'billing recorded');
  } catch (e) {
    log.error({ err: e.message }, 'recordBilling failed');
  }
};

// ─── 當月用量 ───
export const getMonthlyUsage = (clientId) => {
  const now = new Date();
  const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const to   = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);

  try {
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(cost_units), 0) AS total_units,
        COALESCE(SUM(CASE WHEN channel='line' THEN cost_units ELSE 0 END), 0) AS line_units,
        COALESCE(SUM(CASE WHEN channel='fb'   THEN cost_units ELSE 0 END), 0) AS fb_units,
        COUNT(*) AS total_records,
        COALESCE(SUM(CASE WHEN is_billable=1 THEN 1 ELSE 0 END), 0) AS billable_records
      FROM message_billing
      WHERE client_id = ? AND created_at >= ? AND created_at < ? AND is_billable = 1
    `).get(clientId, from, to);
    return { ...row, from, to };
  } catch {
    return { total_units: 0, line_units: 0, fb_units: 0, total_records: 0, billable_records: 0, from, to };
  }
};

// ─── 額度閾值檢查（單一 client）───
export const checkQuotaThreshold = async (clientId) => {
  try {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    if (!client) return;

    const plan = client.line_plan || 'light';
    const quota = getQuotaForPlan(plan);
    const usage = getMonthlyUsage(clientId);
    const used = usage.line_units;
    const limit = quota.free;
    const pct = limit > 0 ? Math.round(used / limit * 100) : 0;

    const threshold = client.line_quota_warning_threshold || 80;

    // 80% 警告
    if (pct >= threshold && !client.line_alert_sent_80) {
      db.prepare('UPDATE clients SET line_alert_sent_80 = 1 WHERE id = ?').run(clientId);
      const payload = { client_id: clientId, plan, used, limit, pct, level: 'warn' };
      emitToClient(clientId, 'quota:warning', payload);
      await dispatchEvent(clientId, 'quota:warning', payload).catch(() => {});
      log.warn({ client_id: clientId, pct, used, limit }, 'LINE quota 80% warning');
    }
    // 95% 警告
    if (pct >= 95 && !client.line_alert_sent_95) {
      db.prepare('UPDATE clients SET line_alert_sent_95 = 1 WHERE id = ?').run(clientId);
      const payload = { client_id: clientId, plan, used, limit, pct, level: 'critical' };
      emitToClient(clientId, 'quota:warning', payload);
      await dispatchEvent(clientId, 'quota:critical', payload).catch(() => {});
      log.error({ client_id: clientId, pct }, 'LINE quota 95% critical');
    }
    // 100% 超量
    if (pct >= 100 && !client.line_alert_sent_100) {
      db.prepare('UPDATE clients SET line_alert_sent_100 = 1 WHERE id = ?').run(clientId);
      const payload = { client_id: clientId, plan, used, limit, pct, level: 'exceeded' };
      emitToClient(clientId, 'quota:exceeded', payload);
      await dispatchEvent(clientId, 'quota:exceeded', payload).catch(() => {});
      log.error({ client_id: clientId, pct }, 'LINE quota EXCEEDED');
    }

    return { clientId, pct, used, limit };
  } catch (e) {
    log.error({ err: e.message, client_id: clientId }, 'checkQuotaThreshold error');
  }
};

// ─── 掃描所有 clients（排程用）───
export const scanAllClientsQuota = async () => {
  try {
    const clients = db.prepare('SELECT id FROM clients').all();
    for (const c of clients) {
      await checkQuotaThreshold(c.id);
    }
    // 每月 1 號 reset alert flags
    const now = new Date();
    if (now.getUTCDate() === 1 && now.getUTCHours() === 0) {
      db.prepare(`UPDATE clients SET line_alert_sent_80 = 0, line_alert_sent_95 = 0, line_alert_sent_100 = 0`).run();
      log.info('monthly quota alert flags reset');
    }
  } catch (e) {
    log.error({ err: e.message }, 'scanAllClientsQuota error');
  }
};

// ─── 廣播前預估費用 ───
export const previewCost = (broadcast) => {
  if (!broadcast) return { cost_units: 0, is_billable: false, message: '廣播資料遺失' };
  const channel = broadcast.channel || 'line';
  const total = broadcast.total_targets || 0;

  // broadcast/multicast 全部計費
  const is_billable = true;
  const cost_units = total;

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(broadcast.client_id);
  const plan = client?.line_plan || 'light';
  const quota = getQuotaForPlan(plan);
  const usage = getMonthlyUsage(broadcast.client_id);
  const remaining = Math.max(0, quota.free - usage.line_units);
  const extra = Math.max(0, cost_units - remaining);
  const extra_cost_usd = channel === 'line' ? extra * quota.price_per_extra : 0;

  return {
    channel,
    cost_units,
    is_billable,
    current_month_used: usage.line_units,
    quota_limit: quota.free,
    quota_remaining: remaining,
    will_exceed_by: extra,
    estimated_extra_cost_usd: extra_cost_usd,
    plan,
    warning: extra > 0 ? `此廣播將超出免費額度 ${extra} 則，預估超量費用 $${extra_cost_usd.toFixed(4)} USD` : null,
  };
};

export default { ensureBillingSchema, recordBilling, getMonthlyUsage, getQuotaForPlan, checkQuotaThreshold, scanAllClientsQuota, previewCost };
