/**
 * routes/logs.js — 統一 LOG 查詢 endpoints
 *
 * GET /api/logs/api-calls        — API 呼叫 LOG
 * GET /api/logs/api-calls/:id    — 單筆詳情
 * GET /api/logs/slow             — 慢查詢 / 慢 endpoint
 * GET /api/logs/schedulers       — 排程執行記錄
 * GET /api/logs/schedulers/health — 每個 scheduler 最近一次
 * GET /api/logs/sockets/stats    — WebSocket 統計
 * GET /api/logs/sockets/online   — 當前在線
 * GET /api/security-events       — 安全事件
 * POST /api/security-events/:id/resolve
 */

import { Router } from 'express';
import { db } from '../lib/db.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'routes/logs' });
const router = Router();

// admin 驗證 helper
const requireAdmin = (req, res, next) => {
  if (req.session?.role !== 'admin') return res.status(403).json({ error: '需要管理員權限' });
  next();
};

// ─── API 呼叫 LOG ───
router.get('/api-calls', requireAdmin, (req, res) => {
  const { client_id, channel, from, to, error_only, limit: rawLimit, offset: rawOffset } = req.query;
  const limit  = Math.min(parseInt(rawLimit  || '50', 10), 200);
  const offset = parseInt(rawOffset || '0', 10);

  const where = [];
  const args  = [];

  if (client_id)  { where.push('client_id = ?');  args.push(parseInt(client_id, 10)); }
  if (channel)    { where.push('channel = ?');     args.push(channel); }
  if (from)       { where.push('created_at >= ?'); args.push(parseInt(from, 10)); }
  if (to)         { where.push('created_at < ?');  args.push(parseInt(to, 10)); }
  if (error_only === 'true') { where.push('(error IS NOT NULL OR response_status >= 400)'); }

  try {
    const rows = db.prepare(`
      SELECT id, client_id, direction, channel, endpoint, method,
             response_status, duration_ms, error, created_at
      FROM api_call_logs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...args, limit, offset);

    const total = db.prepare(`
      SELECT COUNT(*) AS cnt FROM api_call_logs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `).get(...args)?.cnt || 0;

    res.json({ total, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api-calls/:id', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM api_call_logs WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!row) return res.status(404).json({ error: '記錄不存在' });
    res.json({ log: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 慢日誌 ───
router.get('/slow', requireAdmin, (req, res) => {
  const { type, from, to, limit: rawLimit } = req.query;
  const limit = Math.min(parseInt(rawLimit || '50', 10), 200);
  const where = [];
  const args  = [];

  if (type) { where.push('type = ?');         args.push(type); }
  if (from) { where.push('created_at >= ?');  args.push(parseInt(from, 10)); }
  if (to)   { where.push('created_at < ?');   args.push(parseInt(to, 10)); }

  try {
    const rows = db.prepare(`
      SELECT * FROM slow_logs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY duration_ms DESC, created_at DESC LIMIT ?
    `).all(...args, limit);

    // top 10 by path
    const topEndpoints = db.prepare(`
      SELECT path, COUNT(*) AS hit_count, AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms
      FROM slow_logs WHERE type = 'endpoint'
      GROUP BY path ORDER BY avg_ms DESC LIMIT 10
    `).all();

    const topSql = db.prepare(`
      SELECT path, COUNT(*) AS hit_count, AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms
      FROM slow_logs WHERE type = 'sql'
      GROUP BY path ORDER BY avg_ms DESC LIMIT 10
    `).all();

    res.json({ rows, top_endpoints: topEndpoints, top_sql: topSql });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 排程 LOG ───
router.get('/schedulers', requireAdmin, (req, res) => {
  const { name, status, from, to, limit: rawLimit } = req.query;
  const limit = Math.min(parseInt(rawLimit || '50', 10), 200);
  const where = [];
  const args  = [];

  if (name)   { where.push('scheduler_name = ?'); args.push(name); }
  if (status) { where.push('status = ?');          args.push(status); }
  if (from)   { where.push('started_at >= ?');     args.push(parseInt(from, 10)); }
  if (to)     { where.push('started_at < ?');      args.push(parseInt(to, 10)); }

  try {
    const rows = db.prepare(`
      SELECT * FROM scheduler_runs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY started_at DESC LIMIT ?
    `).all(...args, limit);

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/schedulers/health', requireAdmin, (req, res) => {
  try {
    const names = [
      'broadcasts', 'journeys', 'scheduled_messages', 'reminders',
      'daily_reports', 'backup', 'backup_remote', 'quota_check', 'cleanup',
    ];

    const health = names.map(name => {
      const last = db.prepare(`
        SELECT * FROM scheduler_runs WHERE scheduler_name = ? ORDER BY started_at DESC LIMIT 1
      `).get(name);
      return {
        name,
        last_run_at:   last?.started_at   ?? null,
        last_status:   last?.status       ?? 'never',
        last_duration: last?.finished_at && last?.started_at
          ? last.finished_at - last.started_at : null,
        error: last?.error ?? null,
      };
    });

    res.json({ health });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WebSocket 統計 ───
router.get('/sockets/stats', requireAdmin, (req, res) => {
  const period = req.query.period || 'day';
  const now = Date.now();
  const from = period === 'hour' ? now - 3600_000
             : period === 'week' ? now - 7 * 86400_000
             : now - 86400_000;

  try {
    const stats = db.prepare(`
      SELECT
        COUNT(CASE WHEN event_type='connect' THEN 1 END) AS connect_count,
        COUNT(CASE WHEN event_type='disconnect' THEN 1 END) AS disconnect_count,
        COUNT(CASE WHEN event_type='auth_failed' THEN 1 END) AS auth_failed_count,
        AVG(CASE WHEN event_type='disconnect' THEN duration_ms END) AS avg_duration_ms,
        MAX(CASE WHEN event_type='disconnect' THEN duration_ms END) AS max_duration_ms
      FROM socket_events WHERE created_at >= ?
    `).get(from);

    res.json({ period, from, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/sockets/online', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, username, role, client_id, online_status, last_seen_at, status_message
      FROM users WHERE online_status IN ('online', 'away')
      ORDER BY online_status ASC, last_seen_at DESC
    `).all();
    res.json({ users: rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 安全事件 ───
router.get('/security-events', requireAdmin, (req, res) => {
  const { severity, resolved, limit: rawLimit, event_type } = req.query;
  const limit = Math.min(parseInt(rawLimit || '50', 10), 200);
  const where = [];
  const args  = [];

  if (severity)   { where.push('severity = ?');   args.push(severity); }
  if (event_type) { where.push('event_type = ?'); args.push(event_type); }
  if (resolved !== undefined) { where.push('resolved = ?'); args.push(parseInt(resolved, 10)); }

  try {
    const rows = db.prepare(`
      SELECT * FROM security_events
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT ?
    `).all(...args, limit);

    res.json({ events: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/security-events/:id/resolve', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ev = db.prepare('SELECT id FROM security_events WHERE id = ?').get(id);
    if (!ev) return res.status(404).json({ error: '事件不存在' });
    db.prepare('UPDATE security_events SET resolved = 1 WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 訊息送達狀態 ───
router.get('/messages/:id/delivery', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const msg = db.prepare(`
      SELECT id, direction, delivery_status, delivered_at, read_at, delivery_error, created_at
      FROM messages WHERE id = ?
    `).get(id);
    if (!msg) return res.status(404).json({ error: '訊息不存在' });
    res.json({ message: msg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
