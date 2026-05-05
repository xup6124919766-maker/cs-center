/**
 * routes/ecommerce.js — 電商 API stub
 *
 * GET  /api/orders
 * GET  /api/orders/:id
 * POST /api/orders
 * PUT  /api/orders/:id
 * POST /api/webhooks/ecommerce/:client_id  (掛在 server.js 根層)
 * GET  /api/cart-events
 * POST /api/cart-events/:id/send-reminder
 */

import { Router } from 'express';
import { db, getCustomer, insertAuditLog, getClient } from '../lib/db.js';
import { emitToClient } from '../lib/realtime.js';
import { logger as rootLogger } from '../lib/logger.js';
import { checkAndEnrollJourneyTrigger } from '../lib/journey.js';
import { decrypt } from '../lib/crypto.js';
import { syncOrdersForClient } from '../lib/bvshop.js';

const log = rootLogger.child({ module: 'routes/ecommerce' });

const resolveClientId = (req) => {
  const sess = req.session;
  if (sess?.role === 'admin' && sess.client_id === null) {
    return req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  }
  return sess?.client_id ?? null;
};

const router = Router();

// ─── 列訂單 ───
router.get('/orders', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const where = ['o.client_id = ?'];
  const args = [clientId];
  if (req.query.customer_id) { where.push('o.customer_id = ?'); args.push(parseInt(req.query.customer_id, 10)); }
  if (req.query.status) { where.push('o.status = ?'); args.push(req.query.status); }

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  args.push(limit, offset);

  const orders = db.prepare(`
    SELECT o.*, c.name AS customer_name
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE ${where.join(' AND ')}
    ORDER BY o.ordered_at DESC
    LIMIT ? OFFSET ?
  `).all(...args);

  res.json({ orders });
});

// ─── 取單筆訂單 ───
router.get('/orders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!order) return res.status(404).json({ error: '訂單不存在或無權限' });

  let items = [];
  try { items = JSON.parse(order.items_json || '[]'); } catch {}
  res.json({ order: { ...order, items } });
});

// ─── 手動建單 ───
router.post('/orders', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const {
    customer_id, external_order_id, source = 'manual',
    status = 'pending', total_amount, currency = 'TWD',
    items, tracking_number, carrier, shipping_address, notes,
    ordered_at,
  } = req.body || {};

  if (!external_order_id) return res.status(400).json({ error: '缺少 external_order_id' });

  const now = Date.now();
  let id;
  try {
    id = db.prepare(`
      INSERT INTO orders
        (client_id, customer_id, external_order_id, source, status, total_amount, currency,
         items_json, tracking_number, carrier, shipping_address, notes,
         ordered_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      clientId,
      customer_id ?? null,
      external_order_id, source, status,
      total_amount ?? null, currency,
      items ? JSON.stringify(items) : null,
      tracking_number ?? null, carrier ?? null,
      shipping_address ?? null, notes ?? null,
      ordered_at ?? now, now, now
    ).lastInsertRowid;
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: '訂單號已存在' });
    }
    log.error({ err: e.message }, 'create order failed');
    return res.status(500).json({ error: '建立訂單失敗' });
  }

  insertAuditLog({ user_id: req.session?.user_id, action: 'create_order', entity_type: 'order', entity_id: id, ip: req.ip });
  emitToClient(clientId, 'order:new', { order_id: id, external_order_id, status });
  log.info({ id, client_id: clientId, external_order_id }, 'order created');
  res.json({ id, ok: true });
});

// ─── 更新訂單 ───
router.put('/orders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!order) return res.status(404).json({ error: '訂單不存在或無權限' });

  const allowed = ['status', 'tracking_number', 'carrier', 'shipping_address', 'notes',
    'paid_at', 'shipped_at', 'delivered_at', 'total_amount'];
  const fields = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) fields[k] = req.body[k];
  }
  if (Object.keys(fields).length === 0) return res.json({ ok: true });

  const entries = Object.entries(fields);
  db.prepare(
    `UPDATE orders SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND client_id = ?`
  ).run(...entries.map(([, v]) => v), Date.now(), id, clientId);

  insertAuditLog({ user_id: req.session?.user_id, action: 'update_order', entity_type: 'order', entity_id: id, details: JSON.stringify({ status: req.body.status }), ip: req.ip });
  emitToClient(clientId, 'order:updated', { order_id: id, fields });

  // 旅程觸發：order_paid — 狀態從非 paid 變 paid 才觸發
  if (fields.status === 'paid' && order.status !== 'paid' && order.customer_id) {
    checkAndEnrollJourneyTrigger('order_paid', {
      client_id: clientId,
      customer_id: order.customer_id,
      order_id: id,
      total_amount: order.total_amount,
    });
  }

  // P8：出貨通知 — 狀態從 paid → shipped 時自動發 LINE push 訊息給顧客
  if (fields.status === 'shipped' && order.status !== 'shipped' && order.customer_id) {
    Promise.resolve().then(async () => {
      try {
        const client = getClient(clientId);
        if (!client?.line_access_token_enc) {
          log.info({ order_id: id }, '出貨通知：LINE token 未設定，略過');
          return;
        }

        // 找顧客的 LINE channel_user_id
        const chRow = db.prepare(
          "SELECT channel_user_id FROM customer_channels WHERE customer_id = ? AND channel = 'line' LIMIT 1"
        ).get(order.customer_id);
        if (!chRow?.channel_user_id) {
          log.info({ order_id: id, customer_id: order.customer_id }, '出貨通知：找不到 LINE user_id，略過');
          return;
        }

        const { sendText: lineSend } = await import('../lib/line.js');
        const accessToken = decrypt(client.line_access_token_enc);
        const tracking = fields.tracking_number || order.tracking_number;
        const trackingText = tracking ? `\n物流追蹤號：${tracking}` : '';
        const msgText = `您的訂單 ${order.external_order_id} 已出貨！${trackingText}\n有任何問題請隨時告知，感謝您的支持。`;

        await lineSend(accessToken, chRow.channel_user_id, msgText);
        log.info({ order_id: id, customer_id: order.customer_id, line_user: chRow.channel_user_id }, 'P8 出貨通知已發送');
      } catch (e) {
        log.error({ err: e.message, order_id: id }, 'P8 出貨通知發送失敗');
      }
    });
  }

  res.json({ ok: true });
});

// ─── P8：BV 立即同步（admin only）───
router.post('/clients/:id/bv-sync-now', async (req, res) => {
  if (req.session?.role !== 'admin') return res.status(403).json({ error: '需要 admin 權限' });
  const clientId = parseInt(req.params.id, 10);
  const client = getClient(clientId);
  if (!client) return res.status(404).json({ error: '業主不存在' });

  try {
    const result = await syncOrdersForClient(clientId);
    log.info({ client_id: clientId, result }, 'BV 立即同步完成');
    res.json({ ok: true, ...result });
  } catch (e) {
    log.error({ err: e.message, client_id: clientId }, 'BV 立即同步失敗');
    res.status(500).json({ error: '同步失敗：' + e.message });
  }
});

// ─── P8：留言自動回覆紀錄查詢 ───
router.get('/post-replies', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const where = ['client_id = ?'];
  const args = [clientId];
  if (req.query.channel) { where.push('channel = ?'); args.push(req.query.channel); }
  if (req.query.from) { where.push('created_at >= ?'); args.push(parseInt(req.query.from, 10)); }
  if (req.query.to) { where.push('created_at <= ?'); args.push(parseInt(req.query.to, 10)); }

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  args.push(limit);

  const rows = db.prepare(`
    SELECT * FROM post_replies WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC LIMIT ?
  `).all(...args);

  res.json({ post_replies: rows });
});

// ─── P8：留言自動回覆統計 ───
router.get('/post-replies/stats', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const now = Date.now();
  const todayStart = now - (now % 86400000);
  const monthStart = new Date(new Date().setDate(1)).setHours(0, 0, 0, 0);

  const total = db.prepare('SELECT COUNT(*) AS cnt FROM post_replies WHERE client_id = ?').get(clientId).cnt;
  const todayDm = db.prepare(
    "SELECT COUNT(*) AS cnt FROM post_replies WHERE client_id = ? AND action_taken LIKE '%dm%' AND created_at >= ?"
  ).get(clientId, todayStart).cnt;
  const monthDm = db.prepare(
    "SELECT COUNT(*) AS cnt FROM post_replies WHERE client_id = ? AND action_taken LIKE '%dm%' AND created_at >= ?"
  ).get(clientId, monthStart).cnt;

  // 各規則績效
  const byRule = db.prepare(`
    SELECT matched_rule_id, COUNT(*) AS trigger_count,
           SUM(CASE WHEN action_taken LIKE '%dm%' THEN 1 ELSE 0 END) AS dm_count
    FROM post_replies
    WHERE client_id = ? AND matched_rule_id IS NOT NULL
    GROUP BY matched_rule_id
    ORDER BY trigger_count DESC
  `).all(clientId);

  res.json({ total, today_dm: todayDm, month_dm: monthDm, by_rule: byRule });
});

// ─── 廢棄購物車列表 ───
router.get('/cart-events', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const where = ['ce.client_id = ?'];
  const args = [clientId];
  if (req.query.abandoned === 'true') { where.push("ce.event_type = 'abandoned'"); }
  if (req.query.since) { where.push('ce.created_at >= ?'); args.push(parseInt(req.query.since, 10)); }

  args.push(Math.min(parseInt(req.query.limit || '50', 10), 200));

  const events = db.prepare(`
    SELECT ce.*, c.name AS customer_name
    FROM cart_events ce
    LEFT JOIN customers c ON c.id = ce.customer_id
    WHERE ${where.join(' AND ')}
    ORDER BY ce.created_at DESC LIMIT ?
  `).all(...args);

  res.json({ cart_events: events });
});

// ─── 廢棄購物車 → 觸發提醒 ───
router.post('/cart-events/:id/send-reminder', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const event = db.prepare('SELECT * FROM cart_events WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!event) return res.status(404).json({ error: '購物車事件不存在或無權限' });
  if (!event.customer_id) return res.status(400).json({ error: '無對應顧客，無法發送提醒' });

  // TODO: 實際透過 LINE/FB 發送廢棄購物車提醒訊息
  // 目前：寫 messages 表 + 更新 reminder_sent_at
  const reminderText = req.body?.content || `您有尚未結帳的商品（共 ${event.total_amount ?? '?'} 元），記得回來完成購買喔！`;

  // 取最近 open conversation
  const conv = db.prepare(
    "SELECT id FROM conversations WHERE client_id = ? AND customer_id = ? AND status = 'open' ORDER BY last_message_at DESC LIMIT 1"
  ).get(clientId, event.customer_id);

  if (conv) {
    db.prepare(`
      INSERT INTO messages (conversation_id, direction, sender_type, content_type, content, created_at)
      VALUES (?, 'outbound', 'system', 'text', ?, ?)
    `).run(conv.id, reminderText, Date.now());
  }

  db.prepare('UPDATE cart_events SET reminder_sent_at = ? WHERE id = ?').run(Date.now(), id);
  emitToClient(clientId, 'cart:reminder_sent', { cart_event_id: id, customer_id: event.customer_id });

  log.info({ cart_event_id: id, customer_id: event.customer_id }, 'cart reminder sent (stub)');
  res.json({ ok: true, note: 'LINE/FB 實際送出為 stub，等 token 後啟用' });
});

export default router;
