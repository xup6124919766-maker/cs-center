/**
 * routes/billing.js — LINE/FB 計費查詢
 *
 * GET  /api/billing/usage?client_id=&from=&to=&group_by=channel|api_type|day
 * GET  /api/billing/cost-estimate?client_id=&period=current_month
 */

import { Router } from 'express';
import { db } from '../lib/db.js';
import { getMonthlyUsage, getQuotaForPlan } from '../lib/billing.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'routes/billing' });
const router = Router();

const resolveClientId = (req) => {
  const sess = req.session;
  if (sess?.role === 'admin' && sess.client_id === null) {
    return req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  }
  return sess?.client_id ?? null;
};

// ─── 用量查詢 ───
router.get('/usage', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const from = req.query.from ? parseInt(req.query.from, 10) : Date.now() - 30 * 24 * 60 * 60 * 1000;
  const to   = req.query.to   ? parseInt(req.query.to, 10)   : Date.now();
  const groupBy = req.query.group_by || 'day'; // channel | api_type | day

  try {
    let rows;
    if (groupBy === 'channel') {
      rows = db.prepare(`
        SELECT channel,
               SUM(cost_units) AS cost_units,
               COUNT(*) AS records,
               SUM(CASE WHEN is_billable=1 THEN 1 ELSE 0 END) AS billable_records
        FROM message_billing
        WHERE client_id = ? AND created_at >= ? AND created_at < ?
        GROUP BY channel
      `).all(clientId, from, to);
    } else if (groupBy === 'api_type') {
      rows = db.prepare(`
        SELECT channel, api_type,
               SUM(cost_units) AS cost_units,
               COUNT(*) AS records,
               SUM(is_billable) AS billable_records
        FROM message_billing
        WHERE client_id = ? AND created_at >= ? AND created_at < ?
        GROUP BY channel, api_type
        ORDER BY cost_units DESC
      `).all(clientId, from, to);
    } else {
      // group by day
      rows = db.prepare(`
        SELECT
          strftime('%Y-%m-%d', datetime(created_at / 1000, 'unixepoch')) AS day,
          channel,
          SUM(cost_units) AS cost_units,
          COUNT(*) AS records,
          SUM(is_billable) AS billable_records
        FROM message_billing
        WHERE client_id = ? AND created_at >= ? AND created_at < ?
        GROUP BY day, channel
        ORDER BY day ASC
      `).all(clientId, from, to);
    }

    const total = db.prepare(`
      SELECT COALESCE(SUM(cost_units), 0) AS total_units, COUNT(*) AS total_records
      FROM message_billing
      WHERE client_id = ? AND created_at >= ? AND created_at < ? AND is_billable = 1
    `).get(clientId, from, to);

    res.json({ client_id: clientId, from, to, group_by: groupBy, rows, total });
  } catch (e) {
    log.error({ err: e.message }, 'billing usage error');
    res.status(500).json({ error: e.message });
  }
});

// ─── 當月費用估算 ───
router.get('/cost-estimate', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  try {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    if (!client) return res.status(404).json({ error: '業主不存在' });

    const plan = client.line_plan || 'light';
    const quota = getQuotaForPlan(plan);
    const usage = getMonthlyUsage(clientId);
    const used = usage.line_units;
    const limit = quota.free;
    const pct = limit > 0 ? Math.round(used / limit * 100) : 0;
    const extra = Math.max(0, used - limit);
    const extra_cost_usd = extra * quota.price_per_extra;

    // 方案建議
    const suggestions = [];
    if (plan === 'light' && used > 150) {
      suggestions.push({ plan: 'medium', free: 4000, reason: '用量接近 Light 方案上限，建議升級到 Medium（4,000則）' });
    }
    if (plan === 'medium' && used > 3000) {
      suggestions.push({ plan: 'heavy', free: 25000, reason: '用量接近 Medium 方案上限，建議升級到 Heavy（25,000則）' });
    }

    res.json({
      client_id: clientId,
      client_name: client.display_name,
      period: 'current_month',
      line_plan: plan,
      quota_free: limit,
      used_units: used,
      usage_pct: pct,
      extra_units: extra,
      estimated_extra_cost_usd: extra_cost_usd,
      plan_suggestions: suggestions,
      from: usage.from,
      to: usage.to,
    });
  } catch (e) {
    log.error({ err: e.message }, 'cost-estimate error');
    res.status(500).json({ error: e.message });
  }
});

// ─── 設定業主 LINE 方案 ───
router.put('/plan', (req, res) => {
  if (req.session?.role !== 'admin') return res.status(403).json({ error: '需要管理員權限' });
  const { client_id, line_plan, line_quota_warning_threshold } = req.body || {};
  if (!client_id) return res.status(400).json({ error: '需指定 client_id' });

  const validPlans = ['light', 'medium', 'heavy'];
  if (line_plan && !validPlans.includes(line_plan)) {
    return res.status(400).json({ error: `line_plan 必須是 ${validPlans.join('/')}` });
  }

  try {
    const fields = {};
    if (line_plan) fields.line_plan = line_plan;
    if (line_quota_warning_threshold) fields.line_quota_warning_threshold = parseInt(line_quota_warning_threshold, 10);
    if (!Object.keys(fields).length) return res.json({ ok: true });

    const entries = Object.entries(fields);
    db.prepare(
      `UPDATE clients SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
    ).run(...entries.map(([, v]) => v), Date.now(), client_id);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
