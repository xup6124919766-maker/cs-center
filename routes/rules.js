/**
 * routes/rules.js — 規則引擎 CRUD
 *
 * GET    /api/rules
 * POST   /api/rules
 * PUT    /api/rules/:id
 * DELETE /api/rules/:id
 * POST   /api/rules/:id/test
 */

import { Router } from 'express';
import { db } from '../lib/db.js';
import { evaluateRules } from '../lib/rules.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'routes/rules' });

const resolveClientId = (req) => {
  const sess = req.session;
  if (sess?.role === 'admin' && sess.client_id === null) {
    return req.query.client_id
      ? parseInt(req.query.client_id, 10)
      : (req.body?.client_id ? parseInt(req.body.client_id, 10) : null);
  }
  return sess?.client_id ?? null;
};

const router = Router();

// ─── 列表 ───
router.get('/', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const type    = req.query.type    || null;
  const enabled = req.query.enabled !== undefined ? parseInt(req.query.enabled, 10) : null;

  const where = ['client_id = ?'];
  const args  = [clientId];
  if (type)            { where.push('rule_type = ?'); args.push(type); }
  if (enabled !== null){ where.push('enabled = ?');   args.push(enabled); }

  const rules = db.prepare(`
    SELECT * FROM automation_rules WHERE ${where.join(' AND ')} ORDER BY priority DESC, id ASC
  `).all(...args);

  res.json({ rules });
});

// ─── 新增 ───
router.post('/', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const { name, rule_type, trigger, action, priority = 0, enabled = 1 } = req.body || {};
  if (!name || !rule_type || !trigger || !action) {
    return res.status(400).json({ error: '缺少 name / rule_type / trigger / action' });
  }

  const validTypes = ['keyword_reply', 'auto_tag', 'alert'];
  if (!validTypes.includes(rule_type)) {
    return res.status(400).json({ error: `rule_type 必須是 ${validTypes.join('/')}` });
  }

  // 驗證 JSON
  try { JSON.parse(typeof trigger === 'string' ? trigger : JSON.stringify(trigger)); } catch {
    return res.status(400).json({ error: 'trigger 必須是合法 JSON' });
  }
  try { JSON.parse(typeof action === 'string' ? action : JSON.stringify(action)); } catch {
    return res.status(400).json({ error: 'action 必須是合法 JSON' });
  }

  const triggerStr = typeof trigger === 'string' ? trigger : JSON.stringify(trigger);
  const actionStr  = typeof action  === 'string' ? action  : JSON.stringify(action);

  const now = Date.now();
  const id = db.prepare(`
    INSERT INTO automation_rules (client_id, name, rule_type, trigger, action, enabled, priority, trigger_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(clientId, name, rule_type, triggerStr, actionStr, enabled ? 1 : 0, parseInt(priority, 10), now, now).lastInsertRowid;

  log.info({ client_id: clientId, rule_id: id, rule_type, name }, 'rule created');
  res.json({ id, ok: true });
});

// ─── 更新（含 toggle enabled）───
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const rule = db.prepare('SELECT * FROM automation_rules WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!rule) return res.status(404).json({ error: '規則不存在或無權限' });

  const { name, rule_type, trigger, action, priority, enabled } = req.body || {};
  const fields = {};

  if (name      !== undefined) fields.name      = name;
  if (rule_type !== undefined) fields.rule_type  = rule_type;
  if (trigger   !== undefined) fields.trigger    = typeof trigger === 'string' ? trigger : JSON.stringify(trigger);
  if (action    !== undefined) fields.action     = typeof action  === 'string' ? action  : JSON.stringify(action);
  if (priority  !== undefined) fields.priority   = parseInt(priority, 10);
  if (enabled   !== undefined) fields.enabled    = enabled ? 1 : 0;

  if (!Object.keys(fields).length) return res.status(400).json({ error: '沒有要更新的欄位' });

  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE automation_rules SET ${sets}, updated_at = ? WHERE id = ? AND client_id = ?`)
    .run(...Object.values(fields), Date.now(), id, clientId);

  res.json({ ok: true });
});

// ─── 刪除 ───
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const rule = db.prepare('SELECT id FROM automation_rules WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!rule) return res.status(404).json({ error: '規則不存在或無權限' });

  db.prepare('DELETE FROM automation_rules WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ─── 測試規則 ───
router.post('/:id/test', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const rule = db.prepare('SELECT * FROM automation_rules WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!rule) return res.status(404).json({ error: '規則不存在或無權限' });

  const { sample_message } = req.body || {};
  if (!sample_message) return res.status(400).json({ error: '缺少 sample_message' });

  // 只測試這一條規則，不執行 action（dry run）
  let trigger;
  try { trigger = JSON.parse(rule.trigger || '{}'); } catch {
    return res.status(400).json({ error: '規則 trigger JSON 格式錯誤' });
  }

  const text = trigger.case_sensitive ? sample_message : sample_message.toLowerCase();
  const keywords = (trigger.keywords || []).map(k =>
    trigger.case_sensitive ? k : k.toLowerCase()
  );

  let matched = false;
  if (trigger.match_type === 'all') {
    matched = keywords.every(k => text.includes(k));
  } else {
    matched = keywords.some(k => text.includes(k));
  }

  const matchedKeywords = keywords.filter(k => text.includes(k));

  res.json({
    triggered: matched,
    rule_id: id,
    rule_name: rule.name,
    rule_type: rule.rule_type,
    matched_keywords: matchedKeywords,
    sample_message,
  });
});

export default router;
