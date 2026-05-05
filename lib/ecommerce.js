/**
 * ecommerce.js — 電商 Schema Migration
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';

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
  log.info('ecommerce schema ready');
};

export default { ensureEcommerceSchema };
