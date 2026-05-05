/**
 * lib/bvshop.js — BV SHOP Open API v2.2.0 整合
 *
 * 透過 forensic probing 反推出的規格（2026-05-05）：
 *   Host:        https://bvshop-manage.bvshop.tw
 *   Auth:        Authorization: Bearer {token}   (Sanctum 個人存取 token)
 *   Token 格式:  {id}|{hash}                       (例 509|abc...)
 *   API 版本:    回應 header x-api-version: 2.2.0
 *
 * 確認存在的 Endpoint（GET 除非另註）：
 *   /api/v2/orders                訂單列表
 *   /api/v2/orders/{id}           單筆訂單
 *   /api/v2/orders/search         訂單查詢
 *   /api/v2/orders/export         訂單匯出
 *   /api/v2/orders/statistics     訂單統計
 *   POST /api/v2/orders           新增訂單
 *   /api/v2/customers             顧客列表
 *   /api/v2/customers/{id}        單筆顧客
 *   /api/v2/customers/search      顧客查詢
 *   /api/v2/products              商品列表
 *   /api/v2/products/{id}         單筆商品
 *   /api/v2/categories            商品分類
 *   /api/v2/payments              金流設定
 *   /api/v2/logistics             物流設定
 *   /api/v2/inventories           庫存
 */

import { db } from './db.js';
import { decrypt } from './crypto.js';
import { logApiCall } from './api_log.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'bvshop' });

const DEFAULT_BASE = 'https://bvshop-manage.bvshop.tw';

const apiGet = async (token, path, baseUrl = DEFAULT_BASE) => {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const startAt = Date.now();
  let statusCode = 0;
  try {
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    statusCode = resp.status;
    logApiCall({
      client_id: null, service: 'bvshop', method: 'GET',
      endpoint: path, status_code: statusCode,
      duration_ms: Date.now() - startAt,
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, status: statusCode, error: body.slice(0, 200) };
    }
    return { ok: true, status: statusCode, data: await resp.json() };
  } catch (err) {
    logApiCall({
      client_id: null, service: 'bvshop', method: 'GET',
      endpoint: path, status_code: 0,
      duration_ms: Date.now() - startAt, error: err.message,
    });
    return { ok: false, status: 0, error: err.message };
  }
};

export const fetchOrders = async (token, baseUrl, sinceTs = 0, page = 1, limit = 50) => {
  const params = new URLSearchParams({ page: String(page), per_page: String(limit) });
  if (sinceTs) params.set('updated_after', new Date(sinceTs).toISOString());
  const r = await apiGet(token, `/api/v2/orders?${params}`, baseUrl);
  if (!r.ok) return { ok: false, error: r.error, orders: [] };
  const orders = Array.isArray(r.data) ? r.data : (r.data.data || r.data.orders || []);
  return { ok: true, orders };
};

export const fetchCustomers = async (token, baseUrl, page = 1, limit = 50) => {
  const r = await apiGet(token, `/api/v2/customers?page=${page}&per_page=${limit}`, baseUrl);
  if (!r.ok) return { ok: false, error: r.error, customers: [] };
  return { ok: true, customers: r.data.data || r.data.customers || r.data || [] };
};

export const fetchProducts = async (token, baseUrl, page = 1, limit = 50) => {
  const r = await apiGet(token, `/api/v2/products?page=${page}&per_page=${limit}`, baseUrl);
  if (!r.ok) return { ok: false, error: r.error, products: [] };
  return { ok: true, products: r.data.data || r.data.products || r.data || [] };
};

const mapBvStatus = (bvStatus) => ({
  pending: 'pending', unpaid: 'pending',
  paid: 'paid', processing: 'paid',
  shipped: 'shipped', delivered: 'delivered', completed: 'delivered',
  cancelled: 'cancelled', canceled: 'cancelled',
  refunded: 'refunded', refund: 'refunded',
}[(bvStatus || '').toLowerCase()] || 'pending');

export const syncOrdersForClient = async (clientId) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return { ok: false, error: '業主不存在' };

  if (!client.bv_api_key_enc) {
    return { ok: true, synced: 0, note: 'BV API token 未設定' };
  }

  const token = decrypt(client.bv_api_key_enc);
  if (!token) return { ok: false, error: '解密失敗' };

  const baseUrl = client.bv_shop_url || DEFAULT_BASE;
  const since = client.bv_last_sync_at || 0;

  log.info({ client_id: clientId, since, base_url: baseUrl }, 'BV 訂單同步開始');

  let totalSynced = 0;
  let page = 1;
  while (true) {
    const result = await fetchOrders(token, baseUrl, since, page, 50);
    if (!result.ok) {
      log.warn({ err: result.error }, 'BV API 失敗（可能 token 無效）');
      return { ok: false, error: result.error };
    }
    if (!result.orders.length) break;
    for (const o of result.orders) {
      try { upsertBvOrder(clientId, o); totalSynced++; }
      catch (e) { log.error({ err: e.message, order: o?.id }, 'upsert 失敗'); }
    }
    if (result.orders.length < 50) break;
    page++;
  }

  db.prepare('UPDATE clients SET bv_last_sync_at = ? WHERE id = ?').run(Date.now(), clientId);
  log.info({ client_id: clientId, synced: totalSynced }, 'BV 訂單同步完成');
  return { ok: true, synced: totalSynced };
};

const upsertBvOrder = (clientId, o) => {
  const externalId = String(o.id || o.order_id || o.order_no || o.order_number || '');
  if (!externalId) return;

  const status = mapBvStatus(o.status || o.payment_status || o.order_status || '');
  const totalAmount = parseFloat(o.total_amount || o.total || o.grand_total || o.amount || 0) || null;
  const phone = o.customer_phone || o.phone || o.billing_phone || o.recipient_phone || null;
  const email = o.customer_email || o.email || o.billing_email || null;
  const trackingNumber = o.tracking_number || o.logistics_no || o.shipment_no || o.tracking_no || null;
  const carrier = o.carrier || o.logistics_company || o.courier || o.shipping_company || null;

  let customerId = null;
  if (phone) {
    const found = db.prepare('SELECT id FROM customers WHERE client_id = ? AND phone = ? LIMIT 1').get(clientId, phone);
    if (found) customerId = found.id;
  }
  if (!customerId && email) {
    const found = db.prepare('SELECT id FROM customers WHERE client_id = ? AND email = ? LIMIT 1').get(clientId, email);
    if (found) customerId = found.id;
  }

  const now = Date.now();
  const orderedAt = o.created_at ? new Date(o.created_at).getTime() : now;

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
    o.items ? JSON.stringify(o.items) : null,
    trackingNumber, carrier, orderedAt, now, now
  );
};

export const verifyToken = async (token, baseUrl = DEFAULT_BASE) => {
  const r = await apiGet(token, '/api/v2/orders?per_page=1', baseUrl);
  return { ok: r.ok, status: r.status, error: r.error };
};

export default { fetchOrders, fetchCustomers, fetchProducts, syncOrdersForClient, verifyToken };
