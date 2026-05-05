/**
 * routes/ab_test.js — A/B Test API
 *
 * GET    /api/ab-tests                       列出 A/B Tests
 * POST   /api/ab-tests                       建立 draft
 * GET    /api/ab-tests/:id                   詳情含現有 winner
 * PUT    /api/ab-tests/:id                   編輯 draft
 * DELETE /api/ab-tests/:id                   取消（running 不准）
 * GET    /api/ab-tests/:id/results           即時統計（不寫 DB）
 * POST   /api/ab-tests/:id/launch            啟動
 * POST   /api/ab-tests/:id/decide-winner     決定勝者
 * POST   /api/ab-tests/:id/send-winner-to-rest  送勝者給剩下的人
 */

import { Router } from 'express';
import { db, insertAuditLog } from '../lib/db.js';
import {
  createAbTest,
  launchAbTest,
  computeAbResults,
  decideWinner,
  sendWinnerToRest,
} from '../lib/ab_test.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'routes/ab_test' });

const resolveClientId = (req) => {
  const sess = req.session;
  if (sess?.role === 'admin' && sess.client_id === null) {
    return req.query.client_id
      ? parseInt(req.query.client_id, 10)
      : req.body?.client_id ? parseInt(req.body.client_id, 10) : null;
  }
  return sess?.client_id ?? null;
};

const router = Router();

// ─── 列出 A/B Tests ───
router.get('/', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const status = req.query.status || null;
  const where = ['client_id = ?'];
  const args = [clientId];
  if (status) { where.push('status = ?'); args.push(status); }

  const rows = db.prepare(
    `SELECT * FROM ab_tests WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 100`
  ).all(...args);

  res.json({ ab_tests: rows });
});

// ─── 建立 draft ───
router.post('/', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  try {
    const result = createAbTest({
      ...req.body,
      client_id: clientId,
      created_by: req.session?.user_id ?? null,
    });
    insertAuditLog({
      user_id: req.session?.user_id,
      action: 'create_ab_test',
      entity_type: 'ab_test',
      entity_id: result.id,
      ip: req.ip,
    });
    res.json({ ...result, ok: true });
  } catch (e) {
    log.warn({ err: e.message }, 'create ab_test failed');
    res.status(400).json({ error: e.message });
  }
});

// ─── 取單筆 ───
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const test = db.prepare('SELECT * FROM ab_tests WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!test) return res.status(404).json({ error: 'A/B Test 不存在或無權限' });

  // 附帶兩個 broadcast 的基本資訊
  const bcastA = test.broadcast_a_id
    ? db.prepare('SELECT id, name, status, total_targets, sent_count FROM broadcasts WHERE id = ?').get(test.broadcast_a_id)
    : null;
  const bcastB = test.broadcast_b_id
    ? db.prepare('SELECT id, name, status, total_targets, sent_count FROM broadcasts WHERE id = ?').get(test.broadcast_b_id)
    : null;

  res.json({ ab_test: test, broadcast_a: bcastA, broadcast_b: bcastB });
});

// ─── 編輯 draft ───
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const test = db.prepare('SELECT * FROM ab_tests WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!test) return res.status(404).json({ error: 'A/B Test 不存在或無權限' });
  if (test.status !== 'draft') return res.status(400).json({ error: '只能編輯 draft 狀態的 A/B Test' });

  const allowed = [
    'name', 'hypothesis', 'channel',
    'variant_a_content', 'variant_b_content',
    'variant_a_label', 'variant_b_label',
    'split_strategy', 'test_size_percent',
    'primary_metric', 'min_sample_per_variant',
  ];
  const fields = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) fields[k] = req.body[k];
  }
  if (req.body.segment_filter !== undefined) {
    fields.segment_filter = typeof req.body.segment_filter === 'object'
      ? JSON.stringify(req.body.segment_filter)
      : req.body.segment_filter;
  }

  if (Object.keys(fields).length === 0) return res.json({ ok: true });

  const now = Date.now();
  const entries = Object.entries(fields);
  db.prepare(
    `UPDATE ab_tests SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
  ).run(...entries.map(([, v]) => v), now, id);

  // 同步更新兩個 broadcast 的 content（若有更新 variant content）
  if (fields.variant_a_content && test.broadcast_a_id) {
    const labelA = fields.variant_a_label || test.variant_a_label;
    const nameA = `${fields.name || test.name} — ${labelA}`;
    db.prepare('UPDATE broadcasts SET content = ?, name = ?, updated_at = ? WHERE id = ?')
      .run(fields.variant_a_content, nameA, now, test.broadcast_a_id);
  }
  if (fields.variant_b_content && test.broadcast_b_id) {
    const labelB = fields.variant_b_label || test.variant_b_label;
    const nameB = `${fields.name || test.name} — ${labelB}`;
    db.prepare('UPDATE broadcasts SET content = ?, name = ?, updated_at = ? WHERE id = ?')
      .run(fields.variant_b_content, nameB, now, test.broadcast_b_id);
  }

  res.json({ ok: true });
});

// ─── 取消 / 刪除 ───
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const test = db.prepare('SELECT * FROM ab_tests WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!test) return res.status(404).json({ error: 'A/B Test 不存在或無權限' });
  if (test.status === 'running') return res.status(400).json({ error: '進行中的 A/B Test 無法刪除，請先等待完成或選手動取消' });

  // 連帶刪除兩個 draft broadcasts（只刪 draft/failed 狀態）
  if (test.broadcast_a_id) {
    const ba = db.prepare('SELECT status FROM broadcasts WHERE id = ?').get(test.broadcast_a_id);
    if (ba && ['draft', 'failed'].includes(ba.status)) {
      db.prepare('DELETE FROM broadcasts WHERE id = ?').run(test.broadcast_a_id);
    }
  }
  if (test.broadcast_b_id) {
    const bb = db.prepare('SELECT status FROM broadcasts WHERE id = ?').get(test.broadcast_b_id);
    if (bb && ['draft', 'failed'].includes(bb.status)) {
      db.prepare('DELETE FROM broadcasts WHERE id = ?').run(test.broadcast_b_id);
    }
  }

  db.prepare('DELETE FROM ab_tests WHERE id = ?').run(id);
  insertAuditLog({
    user_id: req.session?.user_id,
    action: 'delete_ab_test',
    entity_type: 'ab_test',
    entity_id: id,
    ip: req.ip,
  });
  res.json({ ok: true });
});

// ─── 即時統計（不寫 DB）───
router.get('/:id/results', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const test = db.prepare('SELECT * FROM ab_tests WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!test) return res.status(404).json({ error: 'A/B Test 不存在或無權限' });

  try {
    const results = computeAbResults(id);
    res.json(results);
  } catch (e) {
    log.error({ err: e.message, test_id: id }, 'compute ab results error');
    res.status(500).json({ error: e.message });
  }
});

// ─── 啟動 ───
router.post('/:id/launch', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const test = db.prepare('SELECT * FROM ab_tests WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!test) return res.status(404).json({ error: 'A/B Test 不存在或無權限' });

  try {
    const result = await launchAbTest(id);
    insertAuditLog({
      user_id: req.session?.user_id,
      action: 'launch_ab_test',
      entity_type: 'ab_test',
      entity_id: id,
      ip: req.ip,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    log.error({ err: e.message, test_id: id }, 'launch ab_test failed');
    res.status(400).json({ error: e.message });
  }
});

// ─── 決定勝者 ───
router.post('/:id/decide-winner', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const test = db.prepare('SELECT * FROM ab_tests WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!test) return res.status(404).json({ error: 'A/B Test 不存在或無權限' });

  const manualWinner = req.body?.manual_winner || null;

  try {
    const result = decideWinner(id, manualWinner);
    insertAuditLog({
      user_id: req.session?.user_id,
      action: 'ab_test_decide_winner',
      entity_type: 'ab_test',
      entity_id: id,
      details: JSON.stringify({ winner: result.winner, manual: !!manualWinner }),
      ip: req.ip,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    log.error({ err: e.message, test_id: id }, 'decide winner failed');
    res.status(400).json({ error: e.message });
  }
});

// ─── 送勝者給剩下的人 ───
router.post('/:id/send-winner-to-rest', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const test = db.prepare('SELECT * FROM ab_tests WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!test) return res.status(404).json({ error: 'A/B Test 不存在或無權限' });

  try {
    const result = await sendWinnerToRest(id);
    insertAuditLog({
      user_id: req.session?.user_id,
      action: 'ab_test_send_winner_rest',
      entity_type: 'ab_test',
      entity_id: id,
      details: JSON.stringify({ rest_count: result.rest_count, broadcast_id: result.rest_broadcast_id }),
      ip: req.ip,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    log.error({ err: e.message, test_id: id }, 'send winner to rest failed');
    res.status(400).json({ error: e.message });
  }
});

export default router;
