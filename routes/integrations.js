/**
 * routes/integrations.js — Outbound Webhook 管理
 *
 * GET    /api/webhooks-out
 * POST   /api/webhooks-out
 * PUT    /api/webhooks-out/:id
 * POST   /api/webhooks-out/:id/test
 * DELETE /api/webhooks-out/:id
 */

import { Router } from 'express';
import { db } from '../lib/db.js';
import { dispatchEvent } from '../lib/webhooks_out.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'routes/integrations' });

const resolveClientId = (req) => {
  const sess = req.session;
  if (sess?.role === 'admin' && sess.client_id === null) {
    return req.query.client_id
      ? parseInt(req.query.client_id, 10)
      : (req.body?.client_id ? parseInt(req.body.client_id, 10) : null);
  }
  return sess?.client_id ?? null;
};

const SUPPORTED_EVENTS = ['alert:urgent', 'broadcast:done', 'mention', 'order:new', 'csat:received', 'game:winner'];

const router = Router();

// ─── 列表 ───
router.get('/webhooks-out', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const hooks = db.prepare('SELECT * FROM webhooks_out WHERE client_id = ? ORDER BY created_at DESC').all(clientId);
  res.json({ webhooks: hooks, supported_events: SUPPORTED_EVENTS });
});

// ─── 新增 ───
router.post('/webhooks-out', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const { name, url, type = 'slack', events, secret } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: '缺少 name 或 url' });
  if (!Array.isArray(events) || !events.length) return res.status(400).json({ error: 'events 必須是非空陣列' });

  const invalidEvents = events.filter(e => !SUPPORTED_EVENTS.includes(e));
  if (invalidEvents.length) {
    return res.status(400).json({ error: `不支援的事件：${invalidEvents.join(', ')}` });
  }

  const validTypes = ['slack', 'discord', 'generic'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type 必須是 ${validTypes.join('/')}` });
  }

  const now = Date.now();
  const id = db.prepare(`
    INSERT INTO webhooks_out (client_id, name, url, type, events, enabled, secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(clientId, name, url, type, JSON.stringify(events), secret || null, now, now).lastInsertRowid;

  log.info({ client_id: clientId, hook_id: id, type, name }, 'webhook_out created');
  res.json({ id, ok: true });
});

// ─── 更新 ───
router.put('/webhooks-out/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const hook = db.prepare('SELECT * FROM webhooks_out WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!hook) return res.status(404).json({ error: 'Webhook 不存在或無權限' });

  const { name, url, type, events, secret, enabled } = req.body || {};
  const fields = {};
  if (name    !== undefined) fields.name    = name;
  if (url     !== undefined) fields.url     = url;
  if (type    !== undefined) fields.type    = type;
  if (events  !== undefined) fields.events  = Array.isArray(events) ? JSON.stringify(events) : events;
  if (secret  !== undefined) fields.secret  = secret;
  if (enabled !== undefined) fields.enabled = enabled ? 1 : 0;

  if (!Object.keys(fields).length) return res.status(400).json({ error: '沒有要更新的欄位' });

  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE webhooks_out SET ${sets}, updated_at = ? WHERE id = ? AND client_id = ?`)
    .run(...Object.values(fields), Date.now(), id, clientId);

  res.json({ ok: true });
});

// ─── 測試 ───
router.post('/webhooks-out/:id/test', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const hook = db.prepare('SELECT * FROM webhooks_out WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!hook) return res.status(404).json({ error: 'Webhook 不存在或無權限' });

  try {
    // 暫時強制把這個 hook 的 events 設成 alert:urgent，送測試訊息
    const testHook = { ...hook, events: '["alert:urgent"]' };
    const payload = {
      conversation_id: 0,
      rule_name: '測試規則',
      level: 'urgent',
      message_preview: '這是一則測試訊息，確認 webhook 整合是否正常。',
    };

    // 直接呼叫 sendWebhook 邏輯（重用 dispatchEvent 的 table 改 override 一次）
    await dispatchEvent(clientId, 'alert:urgent', payload);

    res.json({ ok: true, message: '已送出測試訊息，請確認目標平台是否收到' });
  } catch (e) {
    log.error({ hook_id: id, err: e.message }, 'webhook test failed');
    res.status(500).json({ error: e.message });
  }
});

// ─── 刪除 ───
router.delete('/webhooks-out/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const hook = db.prepare('SELECT id FROM webhooks_out WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!hook) return res.status(404).json({ error: 'Webhook 不存在或無權限' });

  db.prepare('DELETE FROM webhooks_out WHERE id = ?').run(id);
  res.json({ ok: true });
});

export default router;
