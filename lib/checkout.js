/**
 * lib/checkout.js — 客服一鍵結帳連結產生器
 *
 * generateCheckoutLink({ client_id, conversation_id, items, user_id })
 * recordClick(short_code, req_ip)
 * getCheckoutLink(id)
 * listCheckoutLinks({ client_id, conversation_id, limit, offset })
 * getCheckoutLinkStats(id)
 * getClientProducts(client_id)
 * setProductCatalog(client_id, products)
 * setCartUrlTemplate(client_id, template)
 */

import crypto from 'crypto';
import { db } from './db.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'checkout' });

// ─── Schema Migration（safeAlter 模式）───
const safeExec = (sql) => {
  try { db.exec(sql); } catch (e) {
    if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) throw e;
  }
};

export const ensureCheckoutSchema = () => {
  // clients 新欄位
  safeExec('ALTER TABLE clients ADD COLUMN cart_url_template TEXT');
  safeExec('ALTER TABLE clients ADD COLUMN product_catalog TEXT');

  // checkout_links 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkout_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      conversation_id INTEGER,
      short_code TEXT UNIQUE NOT NULL,
      items_json TEXT NOT NULL,
      total_estimate REAL,
      full_url TEXT NOT NULL,
      short_url TEXT,
      clicked_count INTEGER NOT NULL DEFAULT 0,
      first_clicked_at INTEGER,
      converted_order_id INTEGER,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
    CREATE INDEX IF NOT EXISTS idx_checkout_client   ON checkout_links(client_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_checkout_conv     ON checkout_links(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_checkout_code     ON checkout_links(short_code);
  `);

  // 梵森預設商品 seed（如果 product_catalog 還沒設）
  seedFaisemProducts();
};

// ─── 梵森預設商品 seed ───
const seedFaisemProducts = () => {
  try {
    const vansen = db.prepare("SELECT id, product_catalog, cart_url_template FROM clients WHERE name = 'vansen'").get();
    if (!vansen) return;

    if (!vansen.product_catalog) {
      const defaultProducts = [
        { sku: 'the_twilight',       name: '晨光 The Twilight',         price: null, image_url: null, description: '清新安心型，不需要很強烈，也能讓人記住妳' },
        { sku: 'the_echo',           name: '回聲 The Echo',             price: null, image_url: null, description: '溫暖木質，是那種會讓人想多待一下的味道' },
        { sku: 'the_original_sin',   name: '原罪 The Original Sin',     price: null, image_url: null, description: '吸引力型，不是刻意，是剛好讓人注意到妳' },
        { sku: 'spray_peach_oolong', name: '口噴 白桃烏龍',             price: null, image_url: null, description: '隨身自信，靠近的時候，會更有安全感' },
        { sku: 'spray_pomelo',       name: '口噴 青柚',                 price: null, image_url: null, description: '清新明亮，讓妳隨時保持那份清新感' },
      ];
      db.prepare('UPDATE clients SET product_catalog = ? WHERE id = ?')
        .run(JSON.stringify(defaultProducts), vansen.id);
      log.info({ client_id: vansen.id }, '梵森預設商品已 seed');
    }

    if (!vansen.cart_url_template) {
      db.prepare("UPDATE clients SET cart_url_template = ? WHERE id = ?")
        .run('https://www.faisem.tw/products/{sku}', vansen.id);
      log.info({ client_id: vansen.id }, '梵森預設 cart_url_template 已 seed');
    }
  } catch (e) {
    log.warn({ err: e.message }, 'seedFaisemProducts 失敗');
  }
};

ensureCheckoutSchema();

// ─── 取得業主商品列表 ───
export const getClientProducts = (clientId) => {
  const client = db.prepare('SELECT product_catalog FROM clients WHERE id = ?').get(clientId);
  if (!client) return [];
  try {
    const catalog = JSON.parse(client.product_catalog || '[]');
    return Array.isArray(catalog) ? catalog : [];
  } catch { return []; }
};

// ─── 設定商品目錄 ───
export const setProductCatalog = (clientId, products) => {
  if (!Array.isArray(products)) throw new Error('products 必須是陣列');
  db.prepare('UPDATE clients SET product_catalog = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(products), Date.now(), clientId);
};

// ─── 設定 cart URL 模板 ───
export const setCartUrlTemplate = (clientId, template) => {
  db.prepare('UPDATE clients SET cart_url_template = ?, updated_at = ? WHERE id = ?')
    .run(template, Date.now(), clientId);
};

// ─── 產生結帳連結 ───
export const generateCheckoutLink = ({ client_id, conversation_id = null, items, user_id = null }) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items 不可為空');
  }

  const client = db.prepare('SELECT cart_url_template, product_catalog FROM clients WHERE id = ?').get(client_id);
  if (!client) throw new Error('業主不存在');

  const template = client.cart_url_template || 'https://www.faisem.tw/products/{sku}';

  // 取商品價格資訊（用於估算總額）
  let catalog = [];
  try { catalog = JSON.parse(client.product_catalog || '[]'); } catch {}

  // 計算總額（price 可能為 null）
  let totalEstimate = null;
  let hasPrices = false;
  let total = 0;
  for (const item of items) {
    const productInfo = catalog.find(p => p.sku === item.sku);
    const price = item.price ?? productInfo?.price ?? null;
    if (price !== null && price !== undefined) {
      hasPrices = true;
      total += price * (item.qty || 1);
    }
  }
  if (hasPrices) totalEstimate = total;

  // 組 items 字串：sku1:qty1,sku2:qty2
  const itemsStr = items.map(i => `${i.sku}:${i.qty || 1}`).join(',');

  // 判斷模板類型：{sku} 導去商品頁（單品），{items} 購物車（多品）
  let fullUrl;
  if (template.includes('{items}')) {
    fullUrl = template.replace('{items}', encodeURIComponent(itemsStr));
  } else if (template.includes('{sku}') && items.length === 1) {
    fullUrl = template.replace('{sku}', encodeURIComponent(items[0].sku));
  } else {
    // 多商品但模板只有 {sku}：用第一個 SKU
    fullUrl = template.replace('{sku}', encodeURIComponent(items[0].sku));
  }

  const shortCode = crypto.randomBytes(4).toString('hex');
  const shortUrl = `https://cs.sandian.work/go/${shortCode}`;
  const now = Date.now();

  db.prepare(`
    INSERT INTO checkout_links
      (client_id, conversation_id, short_code, items_json, total_estimate, full_url, short_url, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    client_id,
    conversation_id,
    shortCode,
    JSON.stringify(items),
    totalEstimate,
    fullUrl,
    shortUrl,
    user_id,
    now
  );

  log.info({ client_id, conversation_id, short_code: shortCode, items_count: items.length }, 'checkout link created');

  return {
    id: db.prepare('SELECT last_insert_rowid() AS id').get().id,
    short_code: shortCode,
    full_url: fullUrl,
    short_url: shortUrl,
    total_estimate: totalEstimate,
    items,
  };
};

// ─── 記錄點擊 + 重定向 ───
export const recordClick = (shortCode) => {
  const link = db.prepare('SELECT * FROM checkout_links WHERE short_code = ?').get(shortCode);
  if (!link) return null;

  const now = Date.now();
  if (!link.first_clicked_at) {
    db.prepare('UPDATE checkout_links SET clicked_count = clicked_count + 1, first_clicked_at = ? WHERE short_code = ?')
      .run(now, shortCode);
  } else {
    db.prepare('UPDATE checkout_links SET clicked_count = clicked_count + 1 WHERE short_code = ?')
      .run(shortCode);
  }

  log.info({ short_code: shortCode, full_url: link.full_url }, 'checkout link clicked');
  return link.full_url;
};

// ─── 取單筆連結 ───
export const getCheckoutLink = (id) => {
  return db.prepare('SELECT * FROM checkout_links WHERE id = ?').get(id);
};

// ─── 列出結帳連結 ───
export const listCheckoutLinks = ({ client_id, conversation_id = null, limit = 50, offset = 0 }) => {
  if (conversation_id) {
    return db.prepare(`
      SELECT * FROM checkout_links
      WHERE client_id = ? AND conversation_id = ?
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(client_id, conversation_id, limit, offset);
  }
  return db.prepare(`
    SELECT * FROM checkout_links
    WHERE client_id = ?
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(client_id, limit, offset);
};

// ─── 取點擊統計 ───
export const getCheckoutLinkStats = (id) => {
  const link = db.prepare('SELECT * FROM checkout_links WHERE id = ?').get(id);
  if (!link) return null;
  return {
    id: link.id,
    short_code: link.short_code,
    short_url: link.short_url,
    full_url: link.full_url,
    clicked_count: link.clicked_count,
    first_clicked_at: link.first_clicked_at,
    converted_order_id: link.converted_order_id,
    created_at: link.created_at,
    items: (() => { try { return JSON.parse(link.items_json); } catch { return []; } })(),
    total_estimate: link.total_estimate,
  };
};
