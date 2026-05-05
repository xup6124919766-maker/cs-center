/**
 * sla.js
 * SLA 警示邏輯（首次回覆時間 + 解決時間）
 *
 * - computeSlaStatus()：計算單筆對話的 SLA 狀態
 * - runSlaCheck()：掃全部 open 對話，狀態變化時 emit / dispatch webhook
 * - startSlaScheduler()：每分鐘定時執行
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';
import { emitToClient } from './realtime.js';
import { dispatchEvent } from './webhooks_out.js';

const log = rootLogger.child({ module: 'sla' });

// ─── Schema Migration ───
export const ensureSlaSchema = () => {
  // clients 表：SLA 設定
  const clientAlters = [
    "ALTER TABLE clients ADD COLUMN sla_first_reply_minutes INTEGER DEFAULT 30",
    "ALTER TABLE clients ADD COLUMN sla_resolution_hours INTEGER DEFAULT 24",
    "ALTER TABLE clients ADD COLUMN sla_business_hours TEXT",
  ];
  for (const sql of clientAlters) {
    try { db.exec(sql); } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
  }

  // conversations 表：SLA 追蹤
  const convAlters = [
    "ALTER TABLE conversations ADD COLUMN first_inbound_at INTEGER",
    "ALTER TABLE conversations ADD COLUMN first_outbound_at INTEGER",
    "ALTER TABLE conversations ADD COLUMN sla_status TEXT DEFAULT 'within'",
  ];
  for (const sql of convAlters) {
    try { db.exec(sql); } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
  }

  log.info('SLA schema 確認完成');
};

/**
 * 取得業主的 SLA 設定（有 cache 避免重複查 DB）
 * @param {number} clientId
 * @returns {{ firstReplyMinutes: number, resolutionHours: number, businessHours: object|null }}
 */
const getSlaConfig = (clientId) => {
  const row = db.prepare('SELECT sla_first_reply_minutes, sla_resolution_hours, sla_business_hours FROM clients WHERE id = ?').get(clientId);
  if (!row) return { firstReplyMinutes: 30, resolutionHours: 24, businessHours: null };

  let businessHours = null;
  try { businessHours = row.sla_business_hours ? JSON.parse(row.sla_business_hours) : null; } catch {}

  return {
    firstReplyMinutes: row.sla_first_reply_minutes ?? 30,
    resolutionHours:   row.sla_resolution_hours   ?? 24,
    businessHours,
  };
};

/**
 * 判斷現在是否在營業時間內
 * @param {object|null} businessHours - { mon: ['09:00','18:00'], ... }，null 代表 24hr
 * @returns {boolean}
 */
const isInBusinessHours = (businessHours) => {
  if (!businessHours) return true;

  const now = new Date();
  const dayNames = ['sun','mon','tue','wed','thu','fri','sat'];
  const dayKey = dayNames[now.getDay()];
  const hours = businessHours[dayKey];
  if (!hours || !Array.isArray(hours) || hours.length < 2) return false;

  const [startStr, endStr] = hours;
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = sh * 60 + sm;
  const endMin   = eh * 60 + em;
  return nowMin >= startMin && nowMin < endMin;
};

/**
 * 計算對話的 SLA 狀態
 * @param {object} conv - conversations 資料列
 * @param {object} slaConfig - { firstReplyMinutes, resolutionHours, businessHours }
 * @returns {{ status: 'within'|'warning'|'breached', waitMinutes: number }}
 */
export const computeSlaStatus = (conv, slaConfig) => {
  const { firstReplyMinutes, businessHours } = slaConfig;

  // 已有 outbound → SLA 達成，不用繼續計算
  if (conv.first_outbound_at) {
    return { status: 'within', waitMinutes: 0 };
  }

  // 尚無 inbound → 初始狀態
  if (!conv.first_inbound_at) {
    return { status: 'within', waitMinutes: 0 };
  }

  // 若有營業時間設定，非上班時間不計 SLA
  if (businessHours && !isInBusinessHours(businessHours)) {
    return { status: 'within', waitMinutes: 0 };
  }

  const waitMs = Date.now() - conv.first_inbound_at;
  const waitMinutes = Math.floor(waitMs / 60000);
  const slaMs = firstReplyMinutes * 60000;

  if (waitMs >= slaMs) {
    return { status: 'breached', waitMinutes };
  }
  if (waitMs >= slaMs * 0.5) {
    return { status: 'warning', waitMinutes };
  }
  return { status: 'within', waitMinutes };
};

/**
 * 掃全部 open 對話，更新 SLA 狀態，有變化時 emit
 */
export const runSlaCheck = async () => {
  const openConvs = db.prepare(`
    SELECT c.id, c.client_id, c.first_inbound_at, c.first_outbound_at, c.sla_status,
           c.status, c.customer_id
    FROM conversations c
    WHERE c.status = 'open'
      AND c.first_inbound_at IS NOT NULL
      AND c.first_outbound_at IS NULL
  `).all();

  for (const conv of openConvs) {
    try {
      const slaConfig = getSlaConfig(conv.client_id);
      const { status, waitMinutes } = computeSlaStatus(conv, slaConfig);

      if (status !== conv.sla_status) {
        db.prepare("UPDATE conversations SET sla_status = ? WHERE id = ?").run(status, conv.id);

        // Emit 給前端
        emitToClient(conv.client_id, 'conversation:sla_change', {
          conversation_id: conv.id,
          sla_status: status,
          wait_minutes: waitMinutes,
        });

        log.info({ conv_id: conv.id, client_id: conv.client_id, prev: conv.sla_status, next: status, wait_minutes: waitMinutes }, 'SLA 狀態變更');

        // breached → 觸發 webhook（讓老闆 LINE 等管道收到通知）
        if (status === 'breached') {
          try {
            await dispatchEvent(conv.client_id, 'sla.breached', {
              conversation_id: conv.id,
              customer_id: conv.customer_id,
              wait_minutes: waitMinutes,
              breached_at: Date.now(),
            });
          } catch (e) {
            log.warn({ err: e.message, conv_id: conv.id }, 'SLA breach webhook dispatch 失敗');
          }
        }
      }
    } catch (e) {
      log.error({ err: e.message, conv_id: conv.id }, 'SLA 單筆對話計算失敗');
    }
  }
};

/**
 * 啟動 SLA 排程器（每分鐘跑一次）
 */
export const startSlaScheduler = () => {
  setInterval(() => {
    runSlaCheck().catch((e) => {
      log.error({ err: e.message }, 'SLA 排程執行失敗');
    });
  }, 60_000);

  log.info('SLA 排程器已啟動（每 1 分鐘）');
};

/**
 * 取得 SLA 設定 API helper
 */
export const getSlaConfigForApi = (clientId) => {
  const row = db.prepare('SELECT sla_first_reply_minutes, sla_resolution_hours, sla_business_hours FROM clients WHERE id = ?').get(clientId);
  if (!row) return { sla_first_reply_minutes: 30, sla_resolution_hours: 24, sla_business_hours: null };
  return {
    sla_first_reply_minutes: row.sla_first_reply_minutes ?? 30,
    sla_resolution_hours:    row.sla_resolution_hours    ?? 24,
    sla_business_hours:      row.sla_business_hours      ? JSON.parse(row.sla_business_hours) : null,
  };
};

/**
 * 取得 SLA 面板統計
 */
export const getSlaDashboard = (clientId) => {
  const rows = db.prepare(`
    SELECT sla_status, COUNT(*) as cnt
    FROM conversations
    WHERE client_id = ? AND status = 'open'
    GROUP BY sla_status
  `).all(clientId);

  const result = { within: 0, warning: 0, breached: 0 };
  for (const r of rows) {
    const key = r.sla_status || 'within';
    if (key in result) result[key] = r.cnt;
  }
  return result;
};
