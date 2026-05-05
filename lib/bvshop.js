/**
 * lib/bvshop.js — BV SHOP 訂單同步
 *
 * TODO: 等用戶提供 BV SHOP Open API 文件後，對齊以下欄位：
 *   - 端點路徑（目前預設為通用 REST 結構）
 *   - 認證方式（目前同時嘗試 Bearer + X-API-Key header）
 *   - 訂單狀態欄位對應
 *   - 顧客識別欄位（phone / email）
 *
 * 預期 BV Open API 端點（待用戶確認）：
 *   GET /api/orders?since=&page=&limit=   → 訂單列表
 *   GET /api/orders/{id}                  → 單筆訂單詳情
 *   GET /api/products?since=              → 商品列表（可選）
 *   認證：Authorization: Bearer {api_key}  或  X-API-Key: {api_key}
 */

import { db } from './db.js';
import { decrypt } from './crypto.js';
import { logApiCall } from './api_log.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'bvshop' });

// ─── BV API fetch wrapper ───
export const fetchOrders = async (apiKey, baseUrl, since = 0, page = 1, limit = 50) => {
  // TODO: 等用戶提供文件後確認端點格式與 query 參數名稱
  const url = `${baseUrl.replace(/\/$/, '')}/api/orders?since=${since}&page=${page}&limit=${limit}`;
  const startAt = Date.now();
  let ok = false;
  let statusCode = 0;

  try {
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-API-Key': apiKey,           // TODO: 確認 BV 實際使用哪種認證方式
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    statusCode = resp.status;
    ok = resp.ok;

    logApiCall({
      client_id: null,
      service: 'bvshop',
      method: 'GET',
      endpoint: '/api/orders',
      status_code: statusCode,
      duration_ms: Date.now() - startAt,
    });

    if (!resp.ok) {
      log.warn({ url, status: resp.status }, 'BV API 回應非 2xx');
      return { ok: false, error: `HTTP ${resp.status}`, orders: [] };
    }

    const data = await resp.json();
    // TODO: 確認 BV API 回傳結構（data.orders / data.data / 直接陣列？）
    const orders = Array.isArray(data) ? data : (data.orders || data.data || []);
    return { ok: true, orders };

  } catch (err) {
    log.error({ err: err.message, url }, 'BV API 請求失敗');
    logApiCall({
      client_id: null,
      service: 'bvshop',
      method: 'GET',
      endpoint: '/api/orders',
      status_code: 0,
      duration_ms: Date.now() - startAt,
      error: err.message,
    });
    return { ok: false, error: err.message, orders: [] };
  }
};

// ─── 將 BV 訂單狀態對應到系統內部狀態 ───
// TODO: 等用戶提供文件後確認 BV 原始狀態字串
const mapBvStatus = (bvStatus) => {
  const statusMap = {
    'pending': 'pending',
    'paid': 'paid',
    'processing': 'paid',
    'shipped': 'shipped',
    'delivered': 'delivered',
    'completed': 'delivered',
    'cancelled': 'cancelled',
    'canceled': 'cancelled',
    'refunded': 'refunded',
    'refund': 'refunded',
  };
  return statusMap[(bvStatus || '').toLowerCase()] || 'pending';
};

// ─── 同步單一業主的訂單 ───
export const syncOrdersForClient = async (clientId) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) {
    log.warn({ client_id: clientId }, 'syncOrdersForClient: 業主不存在');
    return { ok: false, error: '業主不存在' };
  }

  // 架構已鋪好，等用戶提供 API key 才實際拉
  if (!client.bv_api_key_enc || !client.bv_shop_url) {
    log.info({ client_id: clientId }, 'BV SHOP 尚未設定 API key 或 URL，跳過同步（TODO: 等用戶提供 API key）');
    return { ok: true, synced: 0, note: 'BV API key 未設定，stub mode' };
  }

  const apiKey = decrypt(client.bv_api_key_enc);
  if (!apiKey) {
    log.warn({ client_id: clientId }, 'BV API key 解密失敗');
    return { ok: false, error: '解密失敗' };
  }

  const since = client.bv_last_sync_at || 0;
  const baseUrl = client.bv_shop_url;

  log.info({ client_id: clientId, since, base_url: baseUrl }, 'BV 訂單同步開始');

  let totalSynced = 0;
  let page = 1;

  while (true) {
    const result = await fetchOrders(apiKey, baseUrl, since, page, 50);
    if (!result.ok || !result.orders.length) break;

    for (const o of result.orders) {
      try {
        upsertBvOrder(clientId, o);
        totalSynced++;
      } catch (e) {
        log.error({ err: e.message, order: o?.id }, 'upsert order 失敗');
      }
    }

    if (result.orders.length < 50) break; // 最後一頁
    page++;
  }

  // 更新最後同步時間
  db.prepare('UPDATE clients SET bv_last_sync_at = ? WHERE id = ?').run(Date.now(), clientId);

  log.info({ client_id: clientId, synced: totalSynced }, 'BV 訂單同步完成');
  return { ok: true, synced: totalSynced };
};

// ─── Upsert 單筆 BV 訂單到 orders 表 ───
const upsertBvOrder = (clientId, o) => {
  // TODO: 確認 BV 訂單物件的實際欄位名稱
  const externalId = String(o.id || o.order_id || o.order_no || '');
  if (!externalId) return;

  const status = mapBvStatus(o.status || o.payment_status || '');
  const totalAmount = parseFloat(o.total_amount || o.total || o.grand_total || 0) || null;
  const phone = o.customer_phone || o.phone || o.billing_phone || null;
  const email = o.customer_email || o.email || o.billing_email || null;
  const trackingNumber = o.tracking_number || o.logistics_no || o.shipment_no || null;
  const carrier = o.carrier || o.logistics_company || o.courier || null;

  // 嘗試比對既有顧客（先 phone → email）
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
    clientId,
    customerId,
    externalId,
    status,
    totalAmount,
    o.items ? JSON.stringify(o.items) : null,
    trackingNumber,
    carrier,
    orderedAt,
    now,
    now
  );
};

export default { fetchOrders, syncOrdersForClient };
