/**
 * routes/broadcast.js — 廣播 + 分眾推播
 *
 * GET  /api/broadcasts
 * POST /api/broadcasts
 * GET  /api/broadcasts/:id
 * PUT  /api/broadcasts/:id
 * POST /api/broadcasts/:id/preview
 * POST /api/broadcasts/:id/schedule
 * POST /api/broadcasts/:id/send-now
 * DELETE /api/broadcasts/:id
 * GET  /api/broadcasts/:id/recipients
 * GET  /api/broadcasts/:id/stats
 */

import { Router } from 'express';
import { db, insertAuditLog } from '../lib/db.js';
import { resolveSegment, prepareBroadcast, executeBroadcast } from '../lib/broadcast.js';
import { previewCost, recordBilling } from '../lib/billing.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'routes/broadcast' });

const resolveClientId = (req) => {
  const sess = req.session;
  if (sess?.role === 'admin' && sess.client_id === null) {
    return req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  }
  return sess?.client_id ?? null;
};

const router = Router();

// ─── 列廣播 ───
router.get('/', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const status = req.query.status || null;
  const where = ['client_id = ?'];
  const args = [clientId];
  if (status) { where.push('status = ?'); args.push(status); }
  const rows = db.prepare(
    `SELECT * FROM broadcasts WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 100`
  ).all(...args);
  res.json({ broadcasts: rows });
});

// ─── 建草稿 ───
router.post('/', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const { name, channel, content_type = 'text', content, segment_filter } = req.body || {};
  if (!name || !channel || !content) return res.status(400).json({ error: '缺少 name / channel / content' });

  const now = Date.now();
  const id = db.prepare(`
    INSERT INTO broadcasts (client_id, name, channel, content_type, content, segment_filter, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
  `).run(
    clientId, name, channel, content_type, content,
    segment_filter ? JSON.stringify(segment_filter) : null,
    req.session?.user_id ?? null, now, now
  ).lastInsertRowid;

  insertAuditLog({ user_id: req.session?.user_id, action: 'create_broadcast', entity_type: 'broadcast', entity_id: id, ip: req.ip });
  log.info({ id, client_id: clientId, name }, 'broadcast draft created');
  res.json({ id, ok: true });
});

// ─── 取單筆 ───
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!broadcast) return res.status(404).json({ error: '廣播不存在或無權限' });
  res.json({ broadcast });
});

// ─── 編輯草稿 ───
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!broadcast) return res.status(404).json({ error: '廣播不存在或無權限' });
  if (broadcast.status !== 'draft') return res.status(400).json({ error: '只能編輯草稿' });

  const allowed = ['name', 'channel', 'content_type', 'content'];
  const fields = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) fields[k] = req.body[k];
  }
  if (req.body.segment_filter !== undefined) {
    fields.segment_filter = typeof req.body.segment_filter === 'object'
      ? JSON.stringify(req.body.segment_filter) : req.body.segment_filter;
  }

  if (Object.keys(fields).length === 0) return res.json({ ok: true });
  const entries = Object.entries(fields);
  db.prepare(
    `UPDATE broadcasts SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND client_id = ?`
  ).run(...entries.map(([, v]) => v), Date.now(), id, clientId);

  res.json({ ok: true });
});

// ─── 預覽符合條件人數 ───
router.post('/:id/preview', (req, res) => {
  const id = parseInt(req.params.id, 10);
  // 先找 broadcast 取 client_id（admin 無 session.client_id 時）
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
  if (!broadcast) return res.status(404).json({ error: '廣播不存在' });
  const clientId = resolveClientId(req) ?? broadcast.client_id;
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const filter = req.body?.filter || {};
  try {
    const customers = resolveSegment(clientId, filter);
    res.json({ count: customers.length, sample: customers.slice(0, 3).map(c => ({ id: c.id, name: c.name })) });
  } catch (e) {
    log.error({ err: e.message }, 'broadcast preview error');
    res.status(500).json({ error: '預覽失敗' });
  }
});

// ─── 預約排程 ───
router.post('/:id/schedule', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!broadcast) return res.status(404).json({ error: '廣播不存在或無權限' });

  const { scheduled_at } = req.body || {};
  if (!scheduled_at) return res.status(400).json({ error: '缺少 scheduled_at' });

  db.prepare("UPDATE broadcasts SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?")
    .run(parseInt(scheduled_at, 10), Date.now(), id);

  insertAuditLog({ user_id: req.session?.user_id, action: 'schedule_broadcast', entity_type: 'broadcast', entity_id: id, ip: req.ip });
  res.json({ ok: true });
});

// ─── 廣播費用預覽（送出前確認）───
router.post('/:id/cost-preview', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
  if (!broadcast) return res.status(404).json({ error: '廣播不存在' });

  try {
    // 先 prepare 拿到 total_targets（不執行）
    const targets = resolveSegment(broadcast.client_id, (() => {
      try { return JSON.parse(broadcast.segment_filter || '{}'); } catch { return {}; }
    })());
    const broadcastWithTargets = { ...broadcast, total_targets: targets.length };
    const cost = previewCost(broadcastWithTargets);
    res.json({ cost, total_targets: targets.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 立即送出 ───
router.post('/:id/send-now', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
  if (!broadcast) return res.status(404).json({ error: '廣播不存在' });
  const clientId = resolveClientId(req) ?? broadcast.client_id;
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  if (!['draft', 'scheduled'].includes(broadcast.status)) return res.status(400).json({ error: '廣播狀態不可送出' });

  try {
    const targets = await prepareBroadcast(id);

    // P6: 廣播前記錄計費（multicast）
    recordBilling({
      client_id: clientId,
      channel: broadcast.channel === 'all' ? 'line' : broadcast.channel,
      api_type: 'multicast',
      recipient_count: targets,
      conversation_id: null,
      metadata: { broadcast_id: id, name: broadcast.name },
    });

    // 非同步執行，不等完成
    executeBroadcast(id).catch(e => log.error({ err: e.message, broadcast_id: id }, 'executeBroadcast async error'));
    insertAuditLog({ user_id: req.session?.user_id, action: 'send_broadcast', entity_type: 'broadcast', entity_id: id, ip: req.ip });
    res.json({ ok: true, total_targets: targets, note: '廣播已開始送出（背景執行）' });
  } catch (e) {
    log.error({ err: e.message, broadcast_id: id }, 'send-now failed');
    res.status(500).json({ error: '廣播送出失敗' });
  }
});

// ─── 刪除 ───
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!broadcast) return res.status(404).json({ error: '廣播不存在或無權限' });
  if (broadcast.status === 'sending') return res.status(400).json({ error: '送出中不可刪除' });
  db.prepare('DELETE FROM broadcasts WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ─── 收件人列表 ───
router.get('/:id/recipients', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!broadcast) return res.status(404).json({ error: '廣播不存在或無權限' });

  const status = req.query.status || null;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);

  const where = ['br.broadcast_id = ?'];
  const args = [id];
  if (status) { where.push('br.status = ?'); args.push(status); }
  args.push(limit, offset);

  const rows = db.prepare(`
    SELECT br.*, c.name AS customer_name
    FROM broadcast_recipients br
    LEFT JOIN customers c ON c.id = br.customer_id
    WHERE ${where.join(' AND ')}
    ORDER BY br.id ASC LIMIT ? OFFSET ?
  `).all(...args);

  res.json({ recipients: rows });
});

// ─── 成效統計 ───
router.get('/:id/stats', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
  if (!broadcast) return res.status(404).json({ error: '廣播不存在或無權限' });
  const clientId = resolveClientId(req) ?? broadcast.client_id ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const statusBreakdown = db.prepare(`
    SELECT status, COUNT(*) AS count FROM broadcast_recipients WHERE broadcast_id = ? GROUP BY status
  `).all(id);

  const total = broadcast.total_targets || 0;
  const sent = broadcast.sent_count || 0;
  const delivered = broadcast.delivered_count || 0;
  const read = broadcast.read_count || 0;
  const click = broadcast.click_count || 0;

  res.json({
    broadcast_id: id,
    name: broadcast.name,
    status: broadcast.status,
    total_targets: total,
    sent_count: sent,
    delivered_count: delivered,
    read_count: read,
    click_count: click,
    delivery_rate: total > 0 ? Math.round(delivered / total * 100) : 0,
    open_rate: sent > 0 ? Math.round(read / sent * 100) : 0,
    click_rate: sent > 0 ? Math.round(click / sent * 100) : 0,
    status_breakdown: statusBreakdown,
  });
});

export default router;
