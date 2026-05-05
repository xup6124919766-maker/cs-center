/**
 * richmenu.js — Rich Menu 圖文選單引擎
 *
 * ensureRichMenuSchema() — 建表
 * resolveMenuForCustomer(customer_id, client_id) — 依顧客 tags 找最高 priority menu
 * syncMenuToLine(rich_menu_id) — stub，等 LINE token 後實作
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'richmenu' });

export const ensureRichMenuSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rich_menus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      channel TEXT DEFAULT 'line',
      size TEXT DEFAULT 'large',
      selected INTEGER DEFAULT 0,
      chat_bar_text TEXT,
      background_image_url TEXT,
      areas_json TEXT,
      external_id TEXT,
      is_default INTEGER DEFAULT 0,
      status TEXT DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rich_menu_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      rich_menu_id INTEGER NOT NULL,
      priority INTEGER DEFAULT 0,
      condition TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (rich_menu_id) REFERENCES rich_menus(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_rich_menu_rules_priority ON rich_menu_rules(client_id, priority DESC, enabled);
  `);
  log.info('rich_menu schema ready');
};

// ─── 依顧客屬性找對應 menu ───
export const resolveMenuForCustomer = (customerId, clientId) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND client_id = ?').get(customerId, clientId);
  if (!customer) return null;

  let customerTags = [];
  let customerCF = {};
  try { customerTags = JSON.parse(customer.tags || '[]'); } catch {}
  try { customerCF = JSON.parse(customer.custom_fields || '{}'); } catch {}

  // 取所有啟用的規則（依 priority DESC）
  const rules = db.prepare(`
    SELECT r.*, m.name AS menu_name, m.status AS menu_status
    FROM rich_menu_rules r
    JOIN rich_menus m ON m.id = r.rich_menu_id
    WHERE r.client_id = ? AND r.enabled = 1 AND m.status = 'active'
    ORDER BY r.priority DESC
  `).all(clientId);

  for (const rule of rules) {
    let condition = {};
    try { condition = JSON.parse(rule.condition || '{}'); } catch { continue; }

    // 檢查 tags 條件
    if (Array.isArray(condition.tags) && condition.tags.length) {
      const matches = condition.tags.some(t => customerTags.includes(t));
      if (!matches) continue;
    }

    // 檢查 custom_fields 條件
    if (condition.custom_fields && typeof condition.custom_fields === 'object') {
      let allMatch = true;
      for (const [k, v] of Object.entries(condition.custom_fields)) {
        if (customerCF[k] !== v) { allMatch = false; break; }
      }
      if (!allMatch) continue;
    }

    // 找到符合的規則
    const menu = db.prepare('SELECT * FROM rich_menus WHERE id = ?').get(rule.rich_menu_id);
    log.info({ customer_id: customerId, menu_id: rule.rich_menu_id, rule_id: rule.id }, 'resolved rich menu');
    return menu;
  }

  // fallback: 取預設 menu
  const defaultMenu = db.prepare(
    "SELECT * FROM rich_menus WHERE client_id = ? AND is_default = 1 AND status = 'active' LIMIT 1"
  ).get(clientId);

  return defaultMenu || null;
};

// ─── 同步到 LINE（stub）───
export const syncMenuToLine = async (richMenuId) => {
  const menu = db.prepare('SELECT * FROM rich_menus WHERE id = ?').get(richMenuId);
  if (!menu) throw new Error(`rich_menu ${richMenuId} not found`);

  // TODO: 等 LINE Channel Access Token 進來後實作完整 Rich Menu API 呼叫：
  // 1. POST https://api.line.me/v2/bot/richmenu (建立 rich menu)
  //    headers: Authorization Bearer <token>
  //    body: { size, selected, name, chatBarText, areas: JSON.parse(menu.areas_json) }
  // 2. POST https://api.line.me/v2/bot/richmenu/{richMenuId}/content (上傳背景圖)
  // 3. POST https://api.line.me/v2/bot/user/all/richmenu/{richMenuId} (設為預設)
  // 4. db.prepare('UPDATE rich_menus SET external_id = ?, status = ?, updated_at = ? WHERE id = ?')
  //    .run(lineRichMenuId, 'active', Date.now(), richMenuId);

  log.warn({ rich_menu_id: richMenuId }, '[LINE stub] syncMenuToLine — 等 LINE token 後實作');
  db.prepare("UPDATE rich_menus SET status = 'active', updated_at = ? WHERE id = ?").run(Date.now(), richMenuId);
  return { ok: true, stub: true, note: 'LINE API 同步為 stub，等 token 後啟用' };
};

export default { ensureRichMenuSchema, resolveMenuForCustomer, syncMenuToLine };
