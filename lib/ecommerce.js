/**
 * ecommerce.js — 電商 Schema Migration + 購物車棄單自動提醒排程
 */

import { db, getClient } from './db.js';
import { logger as rootLogger } from './logger.js';
import { decrypt } from './crypto.js';
import { recordBilling } from './billing.js';

const log = rootLogger.child({ module: 'ecommerce' });

export const ensureEcommerceSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      customer_id INTEGER,
      external_order_id TEXT NOT NULL,
      source TEXT,
      status TEXT,
      total_amount REAL,
      currency TEXT DEFAULT 'TWD',
      items_json TEXT,
      tracking_number TEXT,
      carrier TEXT,
      shipping_address TEXT,
      notes TEXT,
      ordered_at INTEGER,
      paid_at INTEGER,
      shipped_at INTEGER,
      delivered_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      UNIQUE(client_id, external_order_id)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, ordered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id, status, ordered_at DESC);

    CREATE TABLE IF NOT EXISTS cart_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      customer_id INTEGER,
      external_cart_id TEXT,
      event_type TEXT,
      items_json TEXT,
      total_amount REAL,
      abandoned_at INTEGER,
      recovered_at INTEGER,
      reminder_sent_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE INDEX IF NOT EXISTS idx_cart_events_client ON cart_events(client_id, event_type, created_at DESC);
  `);

  // 新增棄單挽回欄位（已存在則跳過）
  const safeAlter = (sql) => {
    try { db.exec(sql); } catch (e) {
      if (!e.message?.includes('duplicate column')) throw e;
    }
  };
  safeAlter('ALTER TABLE cart_events ADD COLUMN reminder_count INTEGER DEFAULT 0');
  safeAlter('ALTER TABLE cart_events ADD COLUMN converted_at INTEGER');

  log.info('ecommerce schema ready');
};

// ─── 棄單提醒排程（每 10 分鐘呼叫一次）───
export const runCartAbandonReminders = async () => {
  const cutoff = Date.now() - 30 * 60 * 1000; // 30 分鐘前

  const carts = db.prepare(`
    SELECT * FROM cart_events
    WHERE event_type = 'abandoned'
      AND abandoned_at < ?
      AND reminder_count = 0
      AND converted_at IS NULL
      AND customer_id IS NOT NULL
  `).all(cutoff);

  if (!carts.length) return;
  log.info({ count: carts.length }, '棄單提醒：找到待發提醒的購物車');

  for (const cart of carts) {
    await sendCartAbandonReminder(cart);
  }
};

const sendCartAbandonReminder = async (cart) => {
  const cc = db.prepare(
    "SELECT channel_user_id FROM customer_channels WHERE customer_id = ? AND channel = 'line' LIMIT 1"
  ).get(cart.customer_id);

  if (!cc?.channel_user_id) {
    log.warn({ cart_id: cart.id, customer_id: cart.customer_id }, '棄單提醒：找不到 LINE user_id，略過');
    return;
  }

  const client = getClient(cart.client_id);
  if (!client?.line_access_token_enc) {
    log.warn({ cart_id: cart.id, client_id: cart.client_id }, '棄單提醒：LINE token 未設定，略過');
    return;
  }

  let items = '';
  try {
    const itemsArr = JSON.parse(cart.items_json || '[]');
    items = itemsArr.map(i => i.name || i.title || '').filter(Boolean).join('、');
  } catch {}

  const msg = `Hi 🌸 看到妳剛剛在挑${items ? `${items}` : '香味'}～\n\n如果是猶豫，沒關係慢慢來。\n如果是被別的事打斷了，這裡是妳的小提醒：\n\n限時 2 小時用代碼 BACK10 → 免運回來繼續挑 💝`;

  try {
    const { sendText: lineSend } = await import('./line.js');
    const accessToken = decrypt(client.line_access_token_enc);
    await lineSend(accessToken, cc.channel_user_id, msg, cart.client_id);

    // 計費追蹤
    recordBilling({
      client_id: cart.client_id,
      channel: 'line',
      api_type: 'push',
      recipient_count: 1,
      metadata: JSON.stringify({ source: 'cart_abandon', cart_id: cart.id }),
    });

    db.prepare('UPDATE cart_events SET reminder_count = reminder_count + 1, reminder_sent_at = ? WHERE id = ?')
      .run(Date.now(), cart.id);

    log.info({ cart_id: cart.id, customer_id: cart.customer_id }, '棄單提醒已發送');
  } catch (e) {
    log.error({ err: e.message, cart_id: cart.id }, '棄單提醒發送失敗');
  }
};

export default { ensureEcommerceSchema, runCartAbandonReminders };
