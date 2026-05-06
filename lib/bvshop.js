/**
 * lib/bvshop.js — BV SHOP Open API v2 整合（已驗證打通）
 *
 * 確認規格（從 apidog 文件 + 實打驗證 2026-05-05）：
 *   測試 base URL: https://bvshop-manage.bv-shop.tw/api/v2
 *   ⚠ 注意是 bv-shop.tw（連字號），不是 bvshop.tw
 *
 *   認證流程：
 *     1. POST /api/v2/get-token?email=&password=&type=store  (Content-Length: 0)
 *        → { accessToken, tokenType: "bearer", user: {...} }
 *     2. 之後每個 request 帶 Authorization: Bearer {accessToken}
 *     3. 每次 get-token 會作廢上一個 token（重要！process 內快取避免 thrashing）
 *
 *   已驗證 endpoint：
 *     GET /orders            (orderStatus, paymentStatus, logisticStatus, page, limit, withDetail)
 *     GET /orders/{id}
 *     POST /orders / PUT /orders/{id}
 *     GET /customers, /customers/{id}, /customer-levels
 *     POST /customers / PUT/DELETE /customers/{id}
 *     GET /categories, /products, /products/{id}
 *     GET /payments, /logistics
 *     GET /inventories, /inventories/{sku} (PUT, batch)
 *     GET /dealers, /dealers/{id}, /performances
 *
 *   訂單狀態 enum:
 *     orderStatus     1=已成立  2=待確認  4=已完成  -1=異常單  -3=已取消
 *     paymentStatus   1=未付款  2=已付款  -1=已退款  -4=...
 *     logisticStatus  1=未出貨  2=處理中  3=已出貨  4=已配達  5=已取貨  -1=已退貨
 */

import { db } from './db.js';
import { decrypt } from './crypto.js';
import { logApiCall } from './api_log.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'bvshop' });

const DEFAULT_BASE = 'https://bvshop-manage.bv-shop.tw';

// process 內 token 快取：每次 get-token 會作廢前一個，所以盡量重用
// key = clientId, value = { token, fetchedAt }
const tokenCache = new Map();
const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 分鐘重新拿一次

const buildBase = (baseUrl) => (baseUrl || DEFAULT_BASE).replace(/\/$/, '');

// ─── 用 email/password 換 access token ───
export const fetchAccessToken = async (email, password, type = 'store', baseUrl = DEFAULT_BASE) => {
  const startAt = Date.now();
  const url = `${buildBase(baseUrl)}/api/v2/get-token?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&type=${encodeURIComponent(type || 'store')}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Length': '0' },
      signal: AbortSignal.timeout(15000),
    });
    logApiCall({
      client_id: null, service: 'bvshop', method: 'POST',
      endpoint: '/api/v2/get-token', status_code: resp.status,
      duration_ms: Date.now() - startAt,
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, status: resp.status, error: body.slice(0, 300) };
    }
    const data = await resp.json();
    return { ok: true, token: data.accessToken, user: data.user, tokenType: data.tokenType };
  } catch (err) {
    logApiCall({
      client_id: null, service: 'bvshop', method: 'POST',
      endpoint: '/api/v2/get-token', status_code: 0,
      duration_ms: Date.now() - startAt, error: err.message,
    });
    return { ok: false, status: 0, error: err.message };
  }
};

// ─── 取/重取業主 token（自動快取）───
const getCachedTokenForClient = async (client) => {
  const clientId = client.id;
  const cached = tokenCache.get(clientId);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached.token;

  const email = client.bv_email;
  const password = client.bv_password_enc ? decrypt(client.bv_password_enc) : null;
  if (!email || !password) {
    // 後備：如果只設了舊 bv_api_key_enc（直接 token），就拿來用
    if (client.bv_api_key_enc) {
      const t = decrypt(client.bv_api_key_enc);
      if (t) return t;
    }
    throw new Error('BV email/password 未設定');
  }
  const type = client.bv_type || 'store';
  const baseUrl = client.bv_shop_url || DEFAULT_BASE;

  const r = await fetchAccessToken(email, password, type, baseUrl);
  if (!r.ok) throw new Error(`get-token 失敗: ${r.status} ${r.error}`);
  tokenCache.set(clientId, { token: r.token, fetchedAt: Date.now() });
  return r.token;
};

// ─── 通用 GET wrapper（401 自動重拿 token 重試一次）───
const apiGet = async (client, path) => {
  const baseUrl = buildBase(client.bv_shop_url);
  let token = await getCachedTokenForClient(client);
  const doFetch = async (tk) => {
    const startAt = Date.now();
    const resp = await fetch(`${baseUrl}${path}`, {
      headers: { 'Authorization': `Bearer ${tk}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    logApiCall({
      client_id: client.id, service: 'bvshop', method: 'GET',
      endpoint: path.split('?')[0], status_code: resp.status,
      duration_ms: Date.now() - startAt,
    });
    return resp;
  };
  let resp = await doFetch(token);
  if (resp.status === 401) {
    // token 失效了 — 強制重拿
    tokenCache.delete(client.id);
    token = await getCachedTokenForClient(client);
    resp = await doFetch(token);
  }
  if (!resp.ok) {
    const body = await resp.text();
    return { ok: false, status: resp.status, error: body.slice(0, 300) };
  }
  return { ok: true, status: resp.status, data: await resp.json() };
};

// ─── BV 訂單狀態 → 系統內部狀態 ───
const mapBvOrder = (o) => {
  // logistic 優先
  if (o.logisticStatus === 4 || o.logisticStatus === 5) return 'delivered';
  if (o.logisticStatus === 3) return 'shipped';
  if (o.orderStatus === -3) return 'cancelled';
  if (o.paymentStatus === -1) return 'refunded';
  if (o.paymentStatus === 2) return 'paid';
  return 'pending';
};

// ─── 拉訂單（支援 since=updatedAfter；BV 用 startAt/endAt）───
export const fetchOrders = async (client, sinceTs = 0, page = 1, limit = 50) => {
  const params = new URLSearchParams({ page: String(page), limit: String(Math.min(limit, 100)), withDetail: 'true' });
  if (sinceTs) {
    params.set('dateType', 'updated');
    params.set('startAt', new Date(sinceTs).toISOString().split('T')[0]);
  }
  const r = await apiGet(client, `/api/v2/orders?${params}`);
  if (!r.ok) return { ok: false, error: r.error, orders: [] };
  return { ok: true, orders: r.data.data || [] };
};

export const fetchCustomers = async (client, page = 1, limit = 50) => {
  const r = await apiGet(client, `/api/v2/customers?page=${page}&limit=${Math.min(limit, 100)}`);
  if (!r.ok) return { ok: false, error: r.error, customers: [] };
  return { ok: true, customers: r.data.data || [] };
};

export const fetchProducts = async (client, page = 1, limit = 50) => {
  const r = await apiGet(client, `/api/v2/products?page=${page}&limit=${Math.min(limit, 100)}`);
  if (!r.ok) return { ok: false, error: r.error, products: [] };
  return { ok: true, products: r.data.data || [] };
};

// ─── 取單筆 BV 訂單詳情 ───
export const fetchOrder = async (client, bvOrderId) => {
  const r = await apiGet(client, `/api/v2/orders/${bvOrderId}`);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, order: r.data?.data || r.data };
};

// ─── 取單筆 BV 商品 ───
export const fetchProduct = async (client, bvProductId) => {
  const r = await apiGet(client, `/api/v2/products/${bvProductId}`);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, product: r.data?.data || r.data };
};

// ─── 取庫存（by SKU）───
export const fetchInventory = async (client, sku) => {
  const r = await apiGet(client, `/api/v2/inventories/${encodeURIComponent(sku)}`);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, inventory: r.data?.data || r.data };
};

// ─── Upsert 單筆 BV 訂單到 orders 表 ───
const upsertBvOrder = (clientId, o) => {
  const externalId = String(o.id || o.uid || '');
  if (!externalId) return;

  const status = mapBvOrder(o);
  const totalAmount = parseFloat(o.totalAmount || o.total || o.subtotal || 0) || null;
  const phone = o.recipient?.phone || o.customer?.phone || o.phone || null;
  const email = o.customer?.email || o.email || null;
  const trackingNumber = o.logistic?.trackingNumber || o.trackingNumber || null;
  const carrier = o.logistic?.name || o.logisticName || null;

  let customerId = null;
  const bvCustomerId = o.customer?.id || o.customerId || null;
  if (bvCustomerId) {
    const f = db.prepare('SELECT id FROM customers WHERE client_id = ? AND bv_customer_id = ? LIMIT 1').get(clientId, bvCustomerId);
    if (f) customerId = f.id;
  }
  if (!customerId && phone) {
    const f = db.prepare('SELECT id FROM customers WHERE client_id = ? AND phone = ? LIMIT 1').get(clientId, phone);
    if (f) customerId = f.id;
  }
  if (!customerId && email) {
    const f = db.prepare('SELECT id FROM customers WHERE client_id = ? AND email = ? LIMIT 1').get(clientId, email);
    if (f) customerId = f.id;
  }
  // 把 BV customer id 反向綁回我方 customer record（如果還沒）
  if (customerId && bvCustomerId) {
    db.prepare('UPDATE customers SET bv_customer_id = ? WHERE id = ? AND (bv_customer_id IS NULL OR bv_customer_id != ?)')
      .run(bvCustomerId, customerId, bvCustomerId);
  }

  const now = Date.now();
  const orderedAt = o.createdAt ? new Date(o.createdAt).getTime() : now;

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

// ─── 同步單一業主的訂單 ───
export const syncOrdersForClient = async (clientId) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return { ok: false, error: '業主不存在' };
  if (!client.bv_email && !client.bv_api_key_enc) {
    return { ok: true, synced: 0, note: 'BV 帳密未設定' };
  }

  const since = client.bv_last_sync_at || 0;
  log.info({ client_id: clientId, since }, 'BV 同步開始');

  let totalSynced = 0;
  let page = 1;
  while (true) {
    const result = await fetchOrders(client, since, page, 100);
    if (!result.ok) {
      log.warn({ err: result.error }, 'BV API 失敗');
      return { ok: false, error: result.error };
    }
    if (!result.orders.length) break;
    for (const o of result.orders) {
      try { upsertBvOrder(clientId, o); totalSynced++; }
      catch (e) { log.error({ err: e.message, order: o?.id }, 'upsert 失敗'); }
    }
    if (result.orders.length < 100) break;
    page++;
  }

  db.prepare('UPDATE clients SET bv_last_sync_at = ? WHERE id = ?').run(Date.now(), clientId);
  log.info({ client_id: clientId, synced: totalSynced }, 'BV 同步完成');
  return { ok: true, synced: totalSynced };
};

// ─── 直接驗證 email/password 是否能拿到 token（admin UI 用）───
export const verifyCredentials = async (email, password, type = 'store', baseUrl = DEFAULT_BASE) => {
  const r = await fetchAccessToken(email, password, type, baseUrl);
  return { ok: r.ok, status: r.status, error: r.error, user: r.user };
};

// ─── 通用寫入 wrapper（POST/PUT/DELETE，401 自動重試）───
const apiWrite = async (client, method, path, body) => {
  const baseUrl = buildBase(client.bv_shop_url);
  const isWriteWithBody = body && Object.keys(body).length > 0;
  const url = `${baseUrl}${path}${isWriteWithBody ? '' : (path.includes('?') ? '' : '')}`;
  let token = await getCachedTokenForClient(client);
  const doFetch = async (tk) => {
    const startAt = Date.now();
    const opts = {
      method,
      headers: { 'Authorization': `Bearer ${tk}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20000),
    };
    if (isWriteWithBody) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (method !== 'GET') {
      opts.headers['Content-Length'] = '0';
    }
    const resp = await fetch(url, opts);
    logApiCall({
      client_id: client.id, service: 'bvshop', method,
      endpoint: path.split('?')[0], status_code: resp.status,
      duration_ms: Date.now() - startAt,
    });
    return resp;
  };
  let resp = await doFetch(token);
  if (resp.status === 401) {
    tokenCache.delete(client.id);
    token = await getCachedTokenForClient(client);
    resp = await doFetch(token);
  }
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!resp.ok) return { ok: false, status: resp.status, error: text.slice(0, 500), data };
  return { ok: true, status: resp.status, data };
};

// ─── 發送購物金給會員 ───
// POST /api/v2/customers/point — body: { customerId, point, title, reason? }
export const sendCustomerPoint = async (client, bvCustomerId, point, title, reason = '') => {
  if (!bvCustomerId) return { ok: false, error: '缺 BV customer id' };
  if (!point || point === 0) return { ok: false, error: '購物金金額不可為 0' };
  if (!title) return { ok: false, error: '缺購物金標題' };
  return await apiWrite(client, 'POST', '/api/v2/customers/point', {
    customerId: parseInt(bvCustomerId, 10),
    point: parseInt(point, 10),
    title: String(title),
    reason: reason || '客服中心發放',
  });
};

// ─── 更新顧客資料 ───
// PUT /api/v2/customers/{id}
export const updateBvCustomer = async (client, bvCustomerId, fields) => {
  if (!bvCustomerId) return { ok: false, error: '缺 BV customer id' };
  return await apiWrite(client, 'PUT', `/api/v2/customers/${bvCustomerId}`, fields);
};

// ─── 更新訂單（狀態/付款/出貨）───
// PUT /api/v2/orders/{id}
export const updateBvOrder = async (client, bvOrderId, fields) => {
  if (!bvOrderId) return { ok: false, error: '缺 BV order id' };
  return await apiWrite(client, 'PUT', `/api/v2/orders/${bvOrderId}`, fields);
};

// ─── 產生綠界物流單 ───
// POST /api/v2/order-logistic/ecpay — body: { orderId }
export const createEcpayLogistic = async (client, bvOrderId) => {
  if (!bvOrderId) return { ok: false, error: '缺 BV order id' };
  return await apiWrite(client, 'POST', '/api/v2/order-logistic/ecpay', {
    orderId: parseInt(bvOrderId, 10),
  });
};

// ─── 向下相容：舊的 verifyToken（直接 token 模式）───
export const verifyToken = async (token, baseUrl = DEFAULT_BASE) => {
  const startAt = Date.now();
  try {
    const resp = await fetch(`${buildBase(baseUrl)}/api/v2/orders?limit=1`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    logApiCall({
      client_id: null, service: 'bvshop', method: 'GET',
      endpoint: '/api/v2/orders', status_code: resp.status,
      duration_ms: Date.now() - startAt,
    });
    return { ok: resp.ok, status: resp.status, error: resp.ok ? null : await resp.text() };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
};

export default {
  fetchOrders, fetchCustomers, fetchProducts, fetchOrder, fetchProduct, fetchInventory,
  syncOrdersForClient, verifyCredentials, verifyToken, fetchAccessToken,
  sendCustomerPoint, updateBvCustomer, updateBvOrder, createEcpayLogistic,
};
