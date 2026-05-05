/**
 * routes/richmenu.js — Rich Menu 圖文選單
 *
 * GET  /api/rich-menus
 * POST /api/rich-menus
 * PUT  /api/rich-menus/:id
 * POST /api/rich-menus/:id/sync
 * POST /api/rich-menus/:id/set-default
 * DELETE /api/rich-menus/:id
 * GET  /api/rich-menus/:id/rules
 * POST /api/rich-menus/:id/rules
 * DELETE /api/rich-menus/rules/:rule_id
 */

import { Router } from 'express';
import { db, insertAuditLog } from '../lib/db.js';
import { syncMenuToLine, resolveMenuForCustomer } from '../lib/richmenu.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'routes/richmenu' });

const resolveClientId = (req) => {
  const sess = req.session;
  if (sess?.role === 'admin' && sess.client_id === null) {
    return req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  }
  return sess?.client_id ?? null;
};

const router = Router();

// ─── 列 menu ───
router.get('/', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const menus = db.prepare('SELECT * FROM rich_menus WHERE client_id = ? ORDER BY created_at DESC').all(clientId).map(m => ({
    ...m,
    areas: (() => { try { return JSON.parse(m.areas_json || '[]'); } catch { return []; } })(),
  }));
  res.json({ rich_menus: menus });
});

// ─── 建立 menu ───
router.post('/', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const {
    name, channel = 'line', size = 'large', selected = 0,
    chat_bar_text, background_image_url, areas, is_default = 0,
  } = req.body || {};

  if (!name) return res.status(400).json({ error: '缺少 name' });

  const now = Date.now();
  const id = db.prepare(`
    INSERT INTO rich_menus
      (client_id, name, channel, size, selected, chat_bar_text, background_image_url, areas_json, is_default, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(
    clientId, name, channel, size, selected ? 1 : 0,
    chat_bar_text ?? null, background_image_url ?? null,
    areas ? JSON.stringify(areas) : '[]',
    is_default ? 1 : 0, now, now
  ).lastInsertRowid;

  insertAuditLog({ user_id: req.session?.user_id, action: 'create_rich_menu', entity_type: 'rich_menu', entity_id: id, ip: req.ip });
  log.info({ id, client_id: clientId, name }, 'rich menu created');
  res.json({ id, ok: true });
});

// ─── 編輯 menu ───
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const menu = db.prepare('SELECT * FROM rich_menus WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!menu) return res.status(404).json({ error: 'menu 不存在或無權限' });

  const allowed = ['name', 'channel', 'size', 'selected', 'chat_bar_text', 'background_image_url', 'is_default'];
  const fields = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) fields[k] = req.body[k];
  }
  if (req.body.areas !== undefined) {
    fields.areas_json = typeof req.body.areas === 'string' ? req.body.areas : JSON.stringify(req.body.areas);
  }
  if (Object.keys(fields).length === 0) return res.json({ ok: true });

  const entries = Object.entries(fields);
  db.prepare(
    `UPDATE rich_menus SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND client_id = ?`
  ).run(...entries.map(([, v]) => v), Date.now(), id, clientId);

  res.json({ ok: true });
});

// ─── 同步到 LINE（stub）───
router.post('/:id/sync', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const menu = db.prepare('SELECT * FROM rich_menus WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!menu) return res.status(404).json({ error: 'menu 不存在或無權限' });

  try {
    const result = await syncMenuToLine(id);
    insertAuditLog({ user_id: req.session?.user_id, action: 'sync_rich_menu', entity_type: 'rich_menu', entity_id: id, ip: req.ip });
    res.json(result);
  } catch (e) {
    log.error({ err: e.message, rich_menu_id: id }, 'sync failed');
    res.status(500).json({ error: e.message });
  }
});

// ─── 設為預設 ───
router.post('/:id/set-default', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const menu = db.prepare('SELECT * FROM rich_menus WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!menu) return res.status(404).json({ error: 'menu 不存在或無權限' });

  // 先把同 client 的其他 menu 取消預設
  db.prepare('UPDATE rich_menus SET is_default = 0, updated_at = ? WHERE client_id = ?').run(Date.now(), clientId);
  db.prepare('UPDATE rich_menus SET is_default = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  res.json({ ok: true });
});

// ─── 刪除 menu ───
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const menu = db.prepare('SELECT * FROM rich_menus WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!menu) return res.status(404).json({ error: 'menu 不存在或無權限' });
  db.prepare('DELETE FROM rich_menus WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ─── 列規則 ───
router.get('/:id/rules', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const menu = db.prepare('SELECT * FROM rich_menus WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!menu) return res.status(404).json({ error: 'menu 不存在或無權限' });

  const rules = db.prepare('SELECT * FROM rich_menu_rules WHERE rich_menu_id = ? ORDER BY priority DESC').all(id);
  res.json({ rules });
});

// ─── 新增規則 ───
router.post('/:id/rules', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const menu = db.prepare('SELECT * FROM rich_menus WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!menu) return res.status(404).json({ error: 'menu 不存在或無權限' });

  const { priority = 0, condition } = req.body || {};
  if (!condition) return res.status(400).json({ error: '缺少 condition' });

  const condStr = typeof condition === 'object' ? JSON.stringify(condition) : condition;
  const ruleId = db.prepare(`
    INSERT INTO rich_menu_rules (client_id, rich_menu_id, priority, condition, enabled, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(clientId, id, parseInt(priority, 10), condStr, Date.now()).lastInsertRowid;

  res.json({ id: ruleId, ok: true });
});

// ─── 刪除規則 ───
router.delete('/rules/:rule_id', (req, res) => {
  const ruleId = parseInt(req.params.rule_id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const rule = db.prepare('SELECT * FROM rich_menu_rules WHERE id = ? AND client_id = ?').get(ruleId, clientId);
  if (!rule) return res.status(404).json({ error: '規則不存在或無權限' });
  db.prepare('DELETE FROM rich_menu_rules WHERE id = ?').run(ruleId);
  res.json({ ok: true });
});

// ─── 解析顧客對應 menu（測試用）───
router.get('/resolve/:customer_id', (req, res) => {
  const customerId = parseInt(req.params.customer_id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const menu = resolveMenuForCustomer(customerId, clientId);
  res.json({ menu: menu || null });
});

export default router;
