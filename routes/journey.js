/**
 * routes/journey.js — 顧客旅程
 *
 * GET  /api/journeys
 * POST /api/journeys
 * PUT  /api/journeys/:id
 * POST /api/journeys/:id/activate | pause
 * GET  /api/journeys/:id/runs
 * GET  /api/journeys/:id/stats
 */

import { Router } from 'express';
import { db, insertAuditLog } from '../lib/db.js';
import { enrollCustomer } from '../lib/journey.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'routes/journey' });

const resolveClientId = (req) => {
  const sess = req.session;
  if (sess?.role === 'admin' && sess.client_id === null) {
    return req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  }
  return sess?.client_id ?? null;
};

// ─── 預設範本 ───
const JOURNEY_TEMPLATES = {
  welcome: {
    name: '新客歡迎序列',
    description: '新顧客建立後立即觸發歡迎流程',
    trigger_type: 'customer_created',
    trigger_config: {},
    steps_json: [
      { type: 'send_message', config: { content: '歡迎您！感謝您的加入，有任何問題都可以找我們 :-D' } },
      { type: 'wait', config: { duration_ms: 86400000 } }, // 24 小時
      { type: 'send_message', config: { content: '感謝您加入！這裡有一份新客專屬優惠碼給您：NEW20，結帳時輸入享 9 折！' } },
    ],
  },
  reactivate: {
    name: '沉默顧客喚醒',
    description: '超過 30 天無對話的顧客',
    trigger_type: 'custom_event',
    trigger_config: { event: 'inactive_30d' },
    steps_json: [
      { type: 'send_message', config: { content: '好久不見！我們最近推出了新品，歡迎回來看看 :-) 有任何問題隨時可以找我們。' } },
      { type: 'wait', config: { duration_ms: 604800000 } }, // 7 天
      { type: 'condition', config: { field: 'tag', value: 'replied', else_step_index: 4 } },
      { type: 'send_message', config: { content: '再次提醒，我們隨時歡迎您！' } },
      { type: 'add_tag', config: { tag: '沉默顧客' } },
    ],
  },
  birthday: {
    name: '生日祝福',
    description: '生日當天自動送祝福',
    trigger_type: 'birthday',
    trigger_config: {},
    steps_json: [
      { type: 'send_message', config: { content: '生日快樂！祝您生日平安喜樂！我們準備了一份生日優惠碼 BDAY15，享 85 折，今天使用有效！' } },
    ],
  },
};

const router = Router();

// ─── 列旅程 ───
router.get('/', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const journeys = db.prepare('SELECT * FROM journeys WHERE client_id = ? ORDER BY created_at DESC').all(clientId).map(j => ({
    ...j,
    steps: (() => { try { return JSON.parse(j.steps_json || '[]'); } catch { return []; } })(),
    trigger_config: (() => { try { return JSON.parse(j.trigger_config || '{}'); } catch { return {}; } })(),
  }));
  res.json({ journeys });
});

// ─── 建旅程（含 template 捷徑）───
router.post('/', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  let { name, description, trigger_type, trigger_config, steps, template } = req.body || {};

  // 使用範本
  if (template && JOURNEY_TEMPLATES[template]) {
    const tpl = JOURNEY_TEMPLATES[template];
    name = name || tpl.name;
    description = description || tpl.description;
    trigger_type = trigger_type || tpl.trigger_type;
    trigger_config = trigger_config || tpl.trigger_config;
    steps = steps || tpl.steps_json;
  }

  if (!name || !trigger_type) return res.status(400).json({ error: '缺少 name 或 trigger_type' });
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'steps 必須是非空陣列' });
  }

  const now = Date.now();
  const id = db.prepare(`
    INSERT INTO journeys (client_id, name, description, trigger_type, trigger_config, status, steps_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)
  `).run(
    clientId, name, description ?? null, trigger_type,
    trigger_config ? JSON.stringify(trigger_config) : '{}',
    JSON.stringify(steps), now, now
  ).lastInsertRowid;

  insertAuditLog({ user_id: req.session?.user_id, action: 'create_journey', entity_type: 'journey', entity_id: id, ip: req.ip });
  log.info({ id, client_id: clientId, name }, 'journey created');
  res.json({ id, ok: true });
});

// ─── 編輯旅程 ───
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const journey = db.prepare('SELECT * FROM journeys WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!journey) return res.status(404).json({ error: '旅程不存在或無權限' });

  const { name, description, trigger_type, trigger_config, steps } = req.body || {};
  const fields = {};
  if (name !== undefined) fields.name = name;
  if (description !== undefined) fields.description = description;
  if (trigger_type !== undefined) fields.trigger_type = trigger_type;
  if (trigger_config !== undefined) fields.trigger_config = JSON.stringify(trigger_config);
  if (steps !== undefined) fields.steps_json = JSON.stringify(steps);

  if (Object.keys(fields).length === 0) return res.json({ ok: true });
  const entries = Object.entries(fields);
  db.prepare(
    `UPDATE journeys SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND client_id = ?`
  ).run(...entries.map(([, v]) => v), Date.now(), id, clientId);

  res.json({ ok: true });
});

// ─── 啟動 ───
router.post('/:id/activate', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const journey = db.prepare('SELECT * FROM journeys WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!journey) return res.status(404).json({ error: '旅程不存在或無權限' });

  db.prepare("UPDATE journeys SET status = 'active', updated_at = ? WHERE id = ?").run(Date.now(), id);
  insertAuditLog({ user_id: req.session?.user_id, action: 'activate_journey', entity_type: 'journey', entity_id: id, ip: req.ip });
  log.info({ journey_id: id, client_id: clientId }, 'journey activated');
  res.json({ ok: true });
});

// ─── 暫停 ───
router.post('/:id/pause', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const journey = db.prepare('SELECT * FROM journeys WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!journey) return res.status(404).json({ error: '旅程不存在或無權限' });

  db.prepare("UPDATE journeys SET status = 'paused', updated_at = ? WHERE id = ?").run(Date.now(), id);
  res.json({ ok: true });
});

// ─── 進行中 runs ───
router.get('/:id/runs', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const journey = db.prepare('SELECT * FROM journeys WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!journey) return res.status(404).json({ error: '旅程不存在或無權限' });

  const status = req.query.status || null;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);

  const where = ['jr.journey_id = ?'];
  const args = [id];
  if (status) { where.push('jr.status = ?'); args.push(status); }
  args.push(limit, offset);

  const runs = db.prepare(`
    SELECT jr.*, c.name AS customer_name
    FROM journey_runs jr
    LEFT JOIN customers c ON c.id = jr.customer_id
    WHERE ${where.join(' AND ')}
    ORDER BY jr.started_at DESC LIMIT ? OFFSET ?
  `).all(...args);

  res.json({ runs });
});

// ─── 統計 ───
router.get('/:id/stats', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const journey = db.prepare('SELECT * FROM journeys WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!journey) return res.status(404).json({ error: '旅程不存在或無權限' });

  const statusBreakdown = db.prepare(`
    SELECT status, COUNT(*) AS count FROM journey_runs WHERE journey_id = ? GROUP BY status
  `).all(id);

  const avgDuration = db.prepare(`
    SELECT AVG(completed_at - started_at) AS avg_ms
    FROM journey_runs WHERE journey_id = ? AND status = 'completed' AND completed_at IS NOT NULL
  `).get(id);

  const completionRate = journey.total_enrolled > 0
    ? Math.round(journey.total_completed / journey.total_enrolled * 100)
    : 0;

  res.json({
    journey_id: id,
    name: journey.name,
    status: journey.status,
    total_enrolled: journey.total_enrolled,
    total_completed: journey.total_completed,
    completion_rate_pct: completionRate,
    avg_duration_ms: avgDuration?.avg_ms || null,
    status_breakdown: statusBreakdown,
  });
});

// ─── 範本列表 ───
router.get('/templates/list', (_req, res) => {
  res.json({ templates: Object.entries(JOURNEY_TEMPLATES).map(([key, tpl]) => ({ key, ...tpl })) });
});

export default router;
