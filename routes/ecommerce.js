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
import {
  syncOrdersForClient, verifyCredentials as bvVerifyCreds, verifyToken as bvVerifyToken,
  sendCustomerPoint, updateBvCustomer, updateBvOrder, createEcpayLogistic,
  fetchOrder as bvFetchOrder, fetchInventory as bvFetchInventory,
  searchBvCustomers, fetchCustomer as bvFetchCustomer,
} from '../lib/bvshop.js';
import { recordBilling } from '../lib/billing.js';

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

  // ─── 物流全鏈 LINE 主動通知 ───
  const STATUS_MESSAGES = {
    paid:      '🌸 收到您的訂單囉～我們準備出貨中，預計 1-2 個工作天 ✨',
    shipped:   '📦 您的訂單已出貨！{tracking}預計 2-3 天送達，有問題隨時跟我說 💝',
    delivered: '🎁 您的訂單已送達{location}～記得去取貨喔！\n\n有任何問題隨時跟我說 💝',
  };

  if (
    fields.status &&
    fields.status !== order.status &&
    STATUS_MESSAGES[fields.status] &&
    order.customer_id
  ) {
    Promise.resolve().then(async () => {
      try {
        const client = getClient(clientId);
        if (!client?.line_access_token_enc) {
          log.warn({ order_id: id, status: fields.status }, '物流通知：LINE token 未設定，略過');
          return;
        }

        const chRow = db.prepare(
          "SELECT channel_user_id FROM customer_channels WHERE customer_id = ? AND channel = 'line' LIMIT 1"
        ).get(order.customer_id);
        if (!chRow?.channel_user_id) {
          log.warn({ order_id: id, customer_id: order.customer_id }, '物流通知：找不到 LINE user_id，略過');
          return;
        }

        const { sendText: lineSend } = await import('../lib/line.js');
        const accessToken = decrypt(client.line_access_token_enc);

        let msgText = STATUS_MESSAGES[fields.status];

        if (fields.status === 'shipped') {
          const tracking = fields.tracking_number || order.tracking_number;
          msgText = msgText.replace('{tracking}', tracking ? `物流追蹤號：${tracking}，` : '');
        } else if (fields.status === 'delivered') {
          const addr = order.shipping_address;
          msgText = msgText.replace('{location}', addr ? `（${addr}）` : '');
        }

        await lineSend(accessToken, chRow.channel_user_id, msgText, clientId);

        // 計費追蹤
        recordBilling({
          client_id: clientId,
          channel: 'line',
          api_type: 'push',
          recipient_count: 1,
          metadata: JSON.stringify({ source: 'order_status', order_id: id, status: fields.status }),
        });

        log.info({ order_id: id, status: fields.status, customer_id: order.customer_id }, '物流通知已發送');
      } catch (e) {
        log.error({ err: e.message, order_id: id, status: fields.status }, '物流通知發送失敗');
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

// ─── BV 憑證即時驗證（admin only）─── email + password 換 token 試打
router.post('/clients/:id/bv-test-token', async (req, res) => {
  if (req.session?.role !== 'admin') return res.status(403).json({ error: '需要 admin 權限' });
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '').trim();
  const type = String(req.body?.type || 'store').trim();
  const baseUrl = String(req.body?.base_url || 'https://bvshop-manage.bv-shop.tw').trim();
  // 向下相容：如果只給 token 就用舊驗證
  const tokenOnly = String(req.body?.token || '').trim();
  try {
    if (tokenOnly && !email) {
      const r = await bvVerifyToken(tokenOnly, baseUrl);
      return res.json({ ok: r.ok, status: r.status,
        message: r.ok ? `✅ Token 有效` : `❌ HTTP ${r.status}：${(r.error||'').slice(0,200)}` });
    }
    if (!email || !password) return res.status(400).json({ error: '請提供 email + password' });
    const r = await bvVerifyCreds(email, password, type, baseUrl);
    res.json({
      ok: r.ok, status: r.status,
      message: r.ok
        ? `✅ 登入成功，user=${r.user?.name} storeId=${r.user?.storeId}`
        : `❌ HTTP ${r.status}：${(r.error||'').slice(0,200)}`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── 客服動作：取本地顧客資料 helper ───
const requireAgent = (req, res) => {
  const role = req.session?.role;
  if (role !== 'admin' && role !== 'agent') {
    res.status(403).json({ error: '需 agent / admin 權限' });
    return null;
  }
  return role;
};

const getClientForCustomer = (customerId) => {
  const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!cust) return { error: '顧客不存在' };
  const client = getClient(cust.client_id);
  if (!client) return { error: '業主不存在' };
  if (!client.bv_email && !client.bv_api_key_enc) return { error: '業主未設定 BV 憑證' };
  return { cust, client };
};

const getClientForOrder = (orderId) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { error: '訂單不存在' };
  if (order.source !== 'bvshop') return { error: '此訂單非 BV 來源' };
  const client = getClient(order.client_id);
  if (!client) return { error: '業主不存在' };
  if (!client.bv_email && !client.bv_api_key_enc) return { error: '業主未設定 BV 憑證' };
  return { order, client };
};

// ─── 直接對 BV id 發購物金（不需本地連結）POST /api/bv/send-point-direct ───
// 用於訂單詳情 modal 等場景：已知 BV customerId，繞過本地 customer 連結
router.post('/bv/send-point-direct', async (req, res) => {
  if (!requireAgent(req, res)) return;
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  const bvCustId = parseInt(req.body?.bv_customer_id, 10);
  const point = parseInt(req.body?.point, 10);
  const title = String(req.body?.title || '客服中心發放').trim();
  const reason = String(req.body?.reason || '').trim();
  if (!clientId) return res.status(400).json({ error: '需 client_id' });
  if (!bvCustId || !point) return res.status(400).json({ error: '需 bv_customer_id + point' });
  const client = getClient(clientId);
  if (!client) return res.status(404).json({ error: '業主不存在' });
  if (!client.bv_email && !client.bv_api_key_enc) return res.status(400).json({ error: '業主未設定 BV' });
  try {
    const r = await sendCustomerPoint(client, bvCustId, point, title, reason);
    if (r.ok) {
      insertAuditLog({
        client_id: clientId, user_id: req.session?.user_id,
        action: 'bvshop.send_point_direct',
        target_type: 'bv_customer', target_id: bvCustId,
        detail: JSON.stringify({ point, title, reason }),
      });
    }
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 批次發購物金 POST /api/customers/batch-send-point ───
// body: { customer_ids: [1,2,3], point, title, reason? }
router.post('/customers/batch-send-point', async (req, res) => {
  if (!requireAgent(req, res)) return;
  const ids = Array.isArray(req.body?.customer_ids) ? req.body.customer_ids.map(Number).filter(Boolean) : [];
  const point = parseInt(req.body?.point, 10);
  const title = String(req.body?.title || '').trim() || '批次發送';
  const reason = String(req.body?.reason || '').trim();
  if (!ids.length) return res.status(400).json({ error: '需 customer_ids' });
  if (!point) return res.status(400).json({ error: '需 point' });
  if (ids.length > 200) return res.status(400).json({ error: '一次最多 200 筆' });

  const results = [];
  for (const cid of ids) {
    try {
      const ctx = getClientForCustomer(cid);
      if (ctx.error) { results.push({ customer_id: cid, ok: false, error: ctx.error }); continue; }
      if (!ctx.cust.bv_customer_id) { results.push({ customer_id: cid, ok: false, error: '未連結 BV' }); continue; }
      const r = await sendCustomerPoint(ctx.client, ctx.cust.bv_customer_id, point, title, reason);
      results.push({ customer_id: cid, bv_customer_id: ctx.cust.bv_customer_id, ok: r.ok, error: r.ok ? null : r.error });
      if (r.ok) {
        insertAuditLog({
          client_id: ctx.client.id, user_id: req.session?.user_id,
          action: 'bvshop.batch_send_point',
          target_type: 'customer', target_id: cid,
          detail: JSON.stringify({ bv_customer_id: ctx.cust.bv_customer_id, point, title, reason }),
        });
      }
    } catch (e) { results.push({ customer_id: cid, ok: false, error: e.message }); }
  }
  const okCount = results.filter(r => r.ok).length;
  res.json({ ok: true, total: ids.length, success: okCount, fail: ids.length - okCount, results });
});

// ─── 手動連結/解除 BV 會員 PUT /api/customers/:id/bv-link ───
// body: { bv_customer_id: 123 } 連結；{ bv_customer_id: 0 } 解除
// 連結成功時自動從 BV 抓顧客資料補齊本地 name/phone/email
router.put('/customers/:id/bv-link', async (req, res) => {
  if (!requireAgent(req, res)) return;
  const customerId = parseInt(req.params.id, 10);
  const raw = req.body?.bv_customer_id;
  if (raw === undefined || raw === null) return res.status(400).json({ error: '請提供 bv_customer_id' });
  const bvId = parseInt(raw, 10);
  const isUnlink = bvId === 0;
  const valToWrite = isUnlink ? null : bvId;
  if (!isUnlink && (isNaN(bvId) || bvId < 1)) return res.status(400).json({ error: 'bv_customer_id 格式錯誤' });
  const cust = db.prepare('SELECT id, client_id, name, phone, email FROM customers WHERE id = ?').get(customerId);
  if (!cust) return res.status(404).json({ error: '顧客不存在' });

  db.prepare('UPDATE customers SET bv_customer_id = ?, updated_at = ? WHERE id = ?')
    .run(valToWrite, Date.now(), customerId);

  // 連結時順便補齊本地資料（不覆蓋已有欄位）
  let synced = null;
  if (!isUnlink) {
    try {
      const client = getClient(cust.client_id);
      if (client && (client.bv_email || client.bv_api_key_enc)) {
        const r = await bvFetchCustomer(client, bvId);
        if (r.ok && r.customer) {
          const updates = {};
          if (!cust.name && r.customer.fullName) updates.name = r.customer.fullName;
          if (!cust.phone && r.customer.phone) updates.phone = r.customer.phone;
          if (!cust.email && r.customer.email) updates.email = r.customer.email;
          if (Object.keys(updates).length) {
            const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
            db.prepare(`UPDATE customers SET ${sets}, updated_at = ? WHERE id = ?`)
              .run(...Object.values(updates), Date.now(), customerId);
          }
          synced = { fullName: r.customer.fullName, email: r.customer.email, phone: r.customer.phone, level: r.customer.memberLevel?.name };
        }
      }
    } catch { /* sync 失敗不影響連結 */ }
  }

  insertAuditLog({
    client_id: cust.client_id, user_id: req.session?.user_id,
    action: isUnlink ? 'bvshop.unlink_customer' : 'bvshop.link_customer',
    target_type: 'customer', target_id: customerId,
    detail: JSON.stringify({ bv_customer_id: valToWrite }),
  });
  res.json({ ok: true, bv_customer_id: valToWrite, synced });
});

// ─── 智能搜尋 BV 顧客 GET /api/customers/:id/bv-search?q=xxx ───
// q: 純數字當電話 + 含 @ 當 email + 否則 line userid
router.get('/customers/:id/bv-search', async (req, res) => {
  if (!requireAgent(req, res)) return;
  const customerId = parseInt(req.params.id, 10);
  const q = String(req.query?.q || '').trim();
  if (!q) return res.status(400).json({ error: '請提供 q' });
  const ctx = getClientForCustomer(customerId);
  if (ctx.error) return res.status(400).json({ error: ctx.error });
  try {
    // 純數字 + 看起來像 BV id（≤ 8 位）→ 直接 fetch by ID 試
    if (/^\d{1,8}$/.test(q)) {
      const r = await bvFetchCustomer(ctx.client, parseInt(q, 10));
      if (r.ok && r.customer) {
        return res.json({ ok: true, customers: [r.customer], matchedBy: 'id' });
      }
    }
    const r = await searchBvCustomers(ctx.client, q);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 發送購物金 POST /api/customers/:id/bv-send-point ───
router.post('/customers/:id/bv-send-point', async (req, res) => {
  if (!requireAgent(req, res)) return;
  const customerId = parseInt(req.params.id, 10);
  const point = parseInt(req.body?.point, 10);
  const title = String(req.body?.title || '').trim() || '客服中心發放';
  const reason = String(req.body?.reason || '').trim();
  if (!point) return res.status(400).json({ error: '請提供 point' });

  const ctx = getClientForCustomer(customerId);
  if (ctx.error) return res.status(400).json({ error: ctx.error });
  if (!ctx.cust.bv_customer_id) {
    return res.status(400).json({
      ok: false,
      need_link: true,
      error: '此顧客尚未連結 BV 會員 — 請先在右側「BV 動作」區用 email/電話/LINE userid 搜尋連結',
    });
  }

  try {
    const r = await sendCustomerPoint(ctx.client, ctx.cust.bv_customer_id, point, title, reason);
    if (r.ok) {
      insertAuditLog({
        client_id: ctx.client.id, user_id: req.session?.user_id,
        action: 'bvshop.send_point',
        target_type: 'customer', target_id: customerId,
        detail: JSON.stringify({ bv_customer_id: ctx.cust.bv_customer_id, point, title, reason }),
      });
      return res.json(r);
    }
    // BV 回「會員不存在」→ 自動清掉 stale link 並提示
    const bvError = String(r.error || '');
    if (bvError.includes('會員不存在') || bvError.includes('customerId')) {
      const staleId = ctx.cust.bv_customer_id;
      db.prepare('UPDATE customers SET bv_customer_id = NULL, updated_at = ? WHERE id = ?')
        .run(Date.now(), customerId);
      insertAuditLog({
        client_id: ctx.client.id, user_id: req.session?.user_id,
        action: 'bvshop.auto_unlink_stale',
        target_type: 'customer', target_id: customerId,
        detail: JSON.stringify({ stale_bv_id: staleId, reason: bvError.slice(0, 200) }),
      });
      return res.json({
        ok: false,
        need_relink: true,
        stale_bv_id: staleId,
        error: `BV 會員 #${staleId} 已不存在（可能被刪除或合併），已自動解除連結。請重新搜尋連結正確的會員後再操作。`,
      });
    }
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 改顧客資料 PUT /api/customers/:id/bv-update ───
router.put('/customers/:id/bv-update', async (req, res) => {
  if (!requireAgent(req, res)) return;
  const customerId = parseInt(req.params.id, 10);
  const fields = req.body?.fields || {};
  // 允許欄位 whitelist
  const allowed = ['fullName', 'phone', 'email', 'city', 'address', 'memberLevelId', 'isBlacklist'];
  const cleaned = {};
  for (const k of allowed) if (fields[k] !== undefined) cleaned[k] = fields[k];
  if (!Object.keys(cleaned).length) return res.status(400).json({ error: '沒有要更新的欄位' });

  const ctx = getClientForCustomer(customerId);
  if (ctx.error) return res.status(400).json({ error: ctx.error });
  if (!ctx.cust.bv_customer_id) return res.status(400).json({ error: '此顧客尚未連結 BV' });

  try {
    const r = await updateBvCustomer(ctx.client, ctx.cust.bv_customer_id, cleaned);
    if (r.ok) {
      // 同步寫回我方 customer 表
      const localFields = {};
      if (cleaned.fullName) localFields.name = cleaned.fullName;
      if (cleaned.phone !== undefined) localFields.phone = cleaned.phone;
      if (cleaned.email !== undefined) localFields.email = cleaned.email;
      if (Object.keys(localFields).length) {
        const sets = Object.keys(localFields).map(k => `${k} = ?`).join(', ');
        db.prepare(`UPDATE customers SET ${sets}, updated_at = ? WHERE id = ?`)
          .run(...Object.values(localFields), Date.now(), customerId);
      }
      insertAuditLog({
        client_id: ctx.client.id, user_id: req.session?.user_id,
        action: 'bvshop.update_customer',
        target_type: 'customer', target_id: customerId,
        detail: JSON.stringify({ bv_customer_id: ctx.cust.bv_customer_id, fields: cleaned }),
      });
      return res.json(r);
    }
    // 自動清 stale link
    const errStr = String(r.error || '');
    if (errStr.includes('會員不存在') || errStr.includes('Not Found') || r.status === 404) {
      const staleId = ctx.cust.bv_customer_id;
      db.prepare('UPDATE customers SET bv_customer_id = NULL, updated_at = ? WHERE id = ?').run(Date.now(), customerId);
      return res.json({ ok: false, need_relink: true, stale_bv_id: staleId,
        error: `BV 會員 #${staleId} 已不存在，已自動解除連結，請重新搜尋連結後再試。` });
    }
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 改訂單 PUT /api/orders/:id/bv-update ───
router.put('/orders/:id/bv-update', async (req, res) => {
  if (!requireAgent(req, res)) return;
  const orderId = parseInt(req.params.id, 10);
  const fields = req.body?.fields || {};
  const allowed = ['orderStatus', 'paymentStatus', 'logisticStatus', 'note', 'trackingNumber'];
  const cleaned = {};
  for (const k of allowed) if (fields[k] !== undefined) cleaned[k] = fields[k];
  if (!Object.keys(cleaned).length) return res.status(400).json({ error: '沒有要更新的欄位' });

  const ctx = getClientForOrder(orderId);
  if (ctx.error) return res.status(400).json({ error: ctx.error });

  try {
    const r = await updateBvOrder(ctx.client, ctx.order.external_order_id, cleaned);
    if (r.ok) {
      // 標記本地需重新 sync（簡單做法：直接觸發單筆狀態映射）
      insertAuditLog({
        client_id: ctx.client.id, user_id: req.session?.user_id,
        action: 'bvshop.update_order',
        target_type: 'order', target_id: orderId,
        detail: JSON.stringify({ bv_order_id: ctx.order.external_order_id, fields: cleaned }),
      });
    }
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BV 雷達：4 個客群 GET /api/bv/segments?client_id=N ───
// 從本地 orders + customers 算（CLV stage 已預跑），加 days_since_last 等
router.get('/bv/segments', (req, res) => {
  if (!requireAgent(req, res)) return;
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const VIP_THRESHOLD = 5000;
  const SLEEPING_DAYS = 30;
  const LOST_DAYS = 90;
  const RECENT_DAYS = 7;
  const NOW = Date.now();
  const DAY = 86400000;

  const sql = (where, orderBy) => `
    SELECT c.id, c.name, c.phone, c.email, c.bv_customer_id, c.lifecycle_stage,
           c.last_active_at, c.created_at,
           (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.client_id = c.client_id AND o.source = 'bvshop') AS bv_order_count,
           (SELECT COALESCE(SUM(total_amount), 0) FROM orders o WHERE o.customer_id = c.id AND o.client_id = c.client_id AND o.source = 'bvshop') AS bv_total_spent,
           (SELECT MAX(ordered_at) FROM orders o WHERE o.customer_id = c.id AND o.client_id = c.client_id AND o.source = 'bvshop') AS bv_last_order_at,
           (SELECT id FROM conversations cv WHERE cv.customer_id = c.id AND cv.client_id = c.client_id ORDER BY last_message_at DESC LIMIT 1) AS conv_id
    FROM customers c
    WHERE c.client_id = ? AND ${where}
    ORDER BY ${orderBy}
    LIMIT ?`;

  const enrich = (rows) => rows.map(r => {
    const days = r.bv_last_order_at ? Math.floor((NOW - r.bv_last_order_at) / DAY) : null;
    return { ...r, days_since_last_order: days };
  });

  try {
    // 沈睡 VIP：BV 累積消費 ≥ 5000 且 30 天沒下單
    const sleepingVip = enrich(db.prepare(sql(
      `bv_customer_id IS NOT NULL`,
      `bv_total_spent DESC, bv_last_order_at ASC NULLS LAST`
    )).all(clientId, limit * 3))
      .filter(r => r.bv_total_spent >= VIP_THRESHOLD &&
                   r.bv_last_order_at &&
                   (NOW - r.bv_last_order_at) / DAY > SLEEPING_DAYS)
      .slice(0, limit);

    // 流失預警：30-90 天沒下單但有歷史訂單
    const atRisk = enrich(db.prepare(sql(
      `bv_customer_id IS NOT NULL`,
      `bv_last_order_at ASC NULLS LAST`
    )).all(clientId, limit * 5))
      .filter(r => r.bv_last_order_at &&
                   (NOW - r.bv_last_order_at) / DAY > SLEEPING_DAYS &&
                   (NOW - r.bv_last_order_at) / DAY <= LOST_DAYS &&
                   r.bv_order_count >= 1 &&
                   r.bv_total_spent < VIP_THRESHOLD)
      .slice(0, limit);

    // 已流失：> 90 天沒下單
    const lost = enrich(db.prepare(sql(
      `bv_customer_id IS NOT NULL`,
      `bv_last_order_at ASC NULLS LAST`
    )).all(clientId, limit * 5))
      .filter(r => r.bv_last_order_at &&
                   (NOW - r.bv_last_order_at) / DAY > LOST_DAYS &&
                   r.bv_order_count >= 1)
      .slice(0, limit);

    // 7 天內新買家
    const recentBuyers = enrich(db.prepare(sql(
      `bv_customer_id IS NOT NULL`,
      `bv_last_order_at DESC NULLS LAST`
    )).all(clientId, limit * 2))
      .filter(r => r.bv_last_order_at &&
                   (NOW - r.bv_last_order_at) / DAY <= RECENT_DAYS)
      .slice(0, limit);

    // 高價值客戶（top 累積消費）
    const highValue = enrich(db.prepare(sql(
      `bv_customer_id IS NOT NULL`,
      `bv_total_spent DESC`
    )).all(clientId, limit));

    res.json({
      ok: true,
      thresholds: { vip_threshold: VIP_THRESHOLD, sleeping_days: SLEEPING_DAYS, lost_days: LOST_DAYS, recent_days: RECENT_DAYS },
      segments: {
        sleeping_vip: { name: '沈睡 VIP', desc: `累積 ≥ ${VIP_THRESHOLD} 且 ${SLEEPING_DAYS} 天沒下單`, customers: sleepingVip },
        at_risk:     { name: '流失預警',  desc: `${SLEEPING_DAYS}-${LOST_DAYS} 天沒下單`, customers: atRisk },
        lost:        { name: '已流失',    desc: `> ${LOST_DAYS} 天沒下單`, customers: lost },
        recent_buyer:{ name: '近 7 天買家', desc: `${RECENT_DAYS} 天內有訂單`, customers: recentBuyers },
        high_value:  { name: '高價值',    desc: `累積消費 Top ${limit}`, customers: highValue },
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BV 訂單詳情（從 BV 即時抓）GET /api/orders/:id/bv-detail ───
router.get('/orders/:id/bv-detail', async (req, res) => {
  if (!requireAgent(req, res)) return;
  const orderId = parseInt(req.params.id, 10);
  const ctx = getClientForOrder(orderId);
  if (ctx.error) return res.status(400).json({ error: ctx.error });
  try {
    const r = await bvFetchOrder(ctx.client, ctx.order.external_order_id);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BV 庫存查詢 GET /api/bv/inventory/:sku?client_id=N ───
router.get('/bv/inventory/:sku', async (req, res) => {
  if (!requireAgent(req, res)) return;
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const client = getClient(clientId);
  if (!client) return res.status(404).json({ error: '業主不存在' });
  if (!client.bv_email && !client.bv_api_key_enc) return res.status(400).json({ error: '業主未設定 BV' });
  try {
    const r = await bvFetchInventory(client, req.params.sku);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BV 直接訂單查詢（by external_order_id 不必先在本地）GET /api/bv/order/:bvOrderId?client_id=N ───
router.get('/bv/order/:bvOrderId', async (req, res) => {
  if (!requireAgent(req, res)) return;
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const client = getClient(clientId);
  if (!client) return res.status(404).json({ error: '業主不存在' });
  if (!client.bv_email && !client.bv_api_key_enc) return res.status(400).json({ error: '業主未設定 BV' });
  try {
    const r = await bvFetchOrder(client, req.params.bvOrderId);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 產生綠界物流單 POST /api/orders/:id/bv-create-logistic ───
router.post('/orders/:id/bv-create-logistic', async (req, res) => {
  if (!requireAgent(req, res)) return;
  const orderId = parseInt(req.params.id, 10);
  const ctx = getClientForOrder(orderId);
  if (ctx.error) return res.status(400).json({ error: ctx.error });

  try {
    const r = await createEcpayLogistic(ctx.client, ctx.order.external_order_id);
    if (r.ok) {
      insertAuditLog({
        client_id: ctx.client.id, user_id: req.session?.user_id,
        action: 'bvshop.create_logistic',
        target_type: 'order', target_id: orderId,
        detail: JSON.stringify({ bv_order_id: ctx.order.external_order_id, response: r.data }),
      });
    }
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BV Webhook 入口（不需 outbound token，BV 推給我們）───
// 業主在 BV 後台設定 Webhook URL = https://cs.sandian.work/api/webhooks/bvshop/{client_id}
// 訂單建立/付款/出貨/送達 BV 主動 push 過來
router.post('/webhooks/bvshop/:client_id', (req, res) => {
  const clientId = parseInt(req.params.client_id, 10);
  if (!clientId) return res.status(400).json({ error: 'invalid client_id' });
  const client = getClient(clientId);
  if (!client) return res.status(404).json({ error: 'client not found' });

  const event = req.body || {};
  const eventType = event.event || event.type || event.action || 'unknown';
  log.info({ client_id: clientId, event_type: eventType, has_order: !!event.order }, 'BV webhook 收到');

  // 把訊息存進 audit_log，後台可以查
  insertAuditLog({
    client_id: clientId,
    user_id: null,
    action: 'bvshop.webhook',
    target_type: 'order',
    target_id: event.order?.id || event.order_id || null,
    detail: JSON.stringify({ event_type: eventType, payload_keys: Object.keys(event) }),
  });

  // 把 order payload upsert 進 orders 表（如果有）
  const order = event.order || event.data || event;
  if (order && (order.id || order.order_id || order.order_no)) {
    try {
      const externalId = String(order.id || order.order_id || order.order_no);
      const status = ({
        pending: 'pending', unpaid: 'pending',
        paid: 'paid', processing: 'paid',
        shipped: 'shipped', delivered: 'delivered', completed: 'delivered',
        cancelled: 'cancelled', canceled: 'cancelled',
        refunded: 'refunded', refund: 'refunded',
      }[(order.status || order.payment_status || order.order_status || '').toLowerCase()]) || 'pending';
      const totalAmount = parseFloat(order.total_amount || order.total || order.grand_total || 0) || null;
      const phone = order.customer_phone || order.phone || order.billing_phone || null;
      const email = order.customer_email || order.email || order.billing_email || null;
      const trackingNumber = order.tracking_number || order.logistics_no || order.shipment_no || null;
      const carrier = order.carrier || order.logistics_company || order.courier || null;

      let customerId = null;
      if (phone) {
        const f = db.prepare('SELECT id FROM customers WHERE client_id = ? AND phone = ? LIMIT 1').get(clientId, phone);
        if (f) customerId = f.id;
      }
      if (!customerId && email) {
        const f = db.prepare('SELECT id FROM customers WHERE client_id = ? AND email = ? LIMIT 1').get(clientId, email);
        if (f) customerId = f.id;
      }
      const now = Date.now();
      const orderedAt = order.created_at ? new Date(order.created_at).getTime() : now;

      db.prepare(`
        INSERT INTO orders
          (client_id, customer_id, external_order_id, source, status, total_amount, currency,
           items_json, tracking_number, carrier, ordered_at, created_at, updated_at)
        VALUES (?, ?, ?, 'bvshop', ?, ?, 'TWD', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(client_id, external_order_id) DO UPDATE SET
          status          = excluded.status,
          total_amount    = excluded.total_amount,
          tracking_number = excluded.tracking_number,
          carrier         = excluded.carrier,
          updated_at      = excluded.updated_at
      `).run(
        clientId, customerId, externalId, status, totalAmount,
        order.items ? JSON.stringify(order.items) : null,
        trackingNumber, carrier, orderedAt, now, now
      );
    } catch (e) {
      log.error({ err: e.message }, 'BV webhook upsert 失敗');
    }
  }

  res.json({ ok: true, received: true });
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

// ─── 廢棄購物車挽回統計 ───
router.get('/cart-abandon/stats', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const now = Date.now();
  const todayStart = now - (now % 86400000);
  const monthStart = new Date(new Date().setDate(1)).setHours(0, 0, 0, 0);

  const total = db.prepare(
    "SELECT COUNT(*) AS cnt FROM cart_events WHERE client_id = ? AND event_type = 'abandoned'"
  ).get(clientId)?.cnt ?? 0;

  const todayReminders = db.prepare(
    "SELECT COUNT(*) AS cnt FROM cart_events WHERE client_id = ? AND event_type = 'abandoned' AND reminder_sent_at >= ?"
  ).get(clientId, todayStart)?.cnt ?? 0;

  const monthReminders = db.prepare(
    "SELECT COUNT(*) AS cnt FROM cart_events WHERE client_id = ? AND event_type = 'abandoned' AND reminder_sent_at >= ?"
  ).get(clientId, monthStart)?.cnt ?? 0;

  const converted = db.prepare(
    "SELECT COUNT(*) AS cnt FROM cart_events WHERE client_id = ? AND event_type = 'abandoned' AND converted_at IS NOT NULL AND reminder_count > 0"
  ).get(clientId)?.cnt ?? 0;

  const reminded = db.prepare(
    "SELECT COUNT(*) AS cnt FROM cart_events WHERE client_id = ? AND event_type = 'abandoned' AND reminder_count > 0"
  ).get(clientId)?.cnt ?? 0;

  const conversionRate = reminded > 0 ? Math.round(converted / reminded * 100) : 0;

  res.json({
    total_abandoned: total,
    today_reminders: todayReminders,
    month_reminders: monthReminders,
    total_reminded: reminded,
    total_converted: converted,
    conversion_rate_pct: conversionRate,
  });
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

// ─── 物流通知統計 ───
router.get('/order-notify/stats', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const now = Date.now();
  const todayStart = now - (now % 86400000);
  const monthStart = new Date(new Date().setDate(1)).setHours(0, 0, 0, 0);

  const todayPush = db.prepare(`
    SELECT COUNT(*) AS cnt FROM message_billing
    WHERE client_id = ? AND api_type = 'push' AND channel = 'line'
      AND metadata LIKE '%order_status%' AND created_at >= ?
  `).get(clientId, todayStart)?.cnt ?? 0;

  const monthPush = db.prepare(`
    SELECT COUNT(*) AS cnt FROM message_billing
    WHERE client_id = ? AND api_type = 'push' AND channel = 'line'
      AND metadata LIKE '%order_status%' AND created_at >= ?
  `).get(clientId, monthStart)?.cnt ?? 0;

  // LINE Light 方案：前 200 封免費，超出每封約 NT$0.3
  const extraMessages = Math.max(0, monthPush - 200);
  const monthCostEstimate = extraMessages > 0 ? Math.round(extraMessages * 0.3) : 0;

  res.json({
    today_push: todayPush,
    month_push: monthPush,
    month_cost_estimate_twd: monthCostEstimate,
    cost_note: monthCostEstimate === 0 ? '免費額度內' : `NT$ ${monthCostEstimate}（估算）`,
  });
});

export default router;
