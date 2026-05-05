/**
 * routes/games.js — 互動遊戲 v2
 *
 * 後台：GET/POST /api/games  PUT/DELETE /api/games/:id
 *       POST /api/games/:id/start|end
 *       GET /api/games/:id/stats  GET /api/games/:id/participations
 *       GET /api/games/:id/leaderboard
 *       GET /api/leaderboard/global?client_id=
 * 玩家（公開）：
 *       POST /api/play/check-in/:client_id
 *       POST /api/play/:participation_id/share
 *       GET  /api/play/referral/:client_id?customer_id=
 *       POST /api/play/referral/claim
 */

import { Router } from 'express';
import { db } from '../lib/db.js';
import { insertAuditLog } from '../lib/db.js';
import { emitToClient } from '../lib/realtime.js';
import {
  drawPrize,
  drawPrizes,
  getActivity,
  listActivities,
  getActivityPrizes,
  getActivityStats,
  getActivityLeaderboard,
  getGlobalLeaderboard,
  getActivityRemaining,
  addPoints,
  getPointsBalance,
  _progressTask,
} from '../lib/game.js';
import { logger as rootLogger } from '../lib/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const log = rootLogger.child({ module: 'routes/games' });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// resolveClientId 從 session 決定 client_id
const resolveClientId = (req) => {
  const sess = req.session;
  if (sess?.role === 'admin' && sess.client_id === null) {
    return req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  }
  return sess?.client_id ?? null;
};

const router = Router();

// ─── 後台：列活動 ───
router.get('/', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const activities = listActivities(clientId).map(a => ({
    ...a,
    config: (() => { try { return JSON.parse(a.config || '{}'); } catch { return {}; } })(),
    prizes: getActivityPrizes(a.id),
  }));
  res.json({ activities });
});

// ─── 後台：建立活動（含 prizes 巢狀陣列）───
router.post('/', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const {
    name, type, start_at, end_at, config,
    participation_limit_per_user = 1,
    total_quota = null,
    auto_tag_winner = null,
    prizes = [],
    // 進階欄位
    draws_per_participation = 1,
    guaranteed_after = null,
    vip_multiplier = 1.0,
    share_bonus_enabled = 0,
    time_window_seconds = null,
    max_winners = null,
    cover_image_url = null,
    sound_effect = null,
  } = req.body || {};

  if (!name || !type) return res.status(400).json({ error: '缺少 name 或 type' });
  if (!['wheel', 'scratch', 'gacha'].includes(type)) {
    return res.status(400).json({ error: 'type 必須是 wheel/scratch/gacha' });
  }
  if (!Array.isArray(prizes) || prizes.length === 0) {
    return res.status(400).json({ error: 'prizes 必須是非空陣列' });
  }

  const now = Date.now();
  let actId;
  try {
    db.exec('BEGIN');
    actId = db.prepare(`
      INSERT INTO activities
        (client_id, name, type, status, start_at, end_at, config,
         participation_limit_per_user, total_quota, auto_tag_winner, total_participations,
         draws_per_participation, guaranteed_after, vip_multiplier, share_bonus_enabled,
         time_window_seconds, max_winners, cover_image_url, sound_effect,
         created_at, updated_at)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      clientId, name, type,
      start_at ?? null, end_at ?? null,
      typeof config === 'object' ? JSON.stringify(config) : (config ?? null),
      participation_limit_per_user, total_quota ?? null,
      auto_tag_winner ?? null,
      draws_per_participation,
      guaranteed_after ?? null,
      vip_multiplier ?? 1.0,
      share_bonus_enabled ? 1 : 0,
      time_window_seconds ?? null,
      max_winners ?? null,
      cover_image_url ?? null,
      sound_effect ?? null,
      now, now
    ).lastInsertRowid;

    for (let i = 0; i < prizes.length; i++) {
      const p = prizes[i];
      if (!p.name || p.probability === undefined) continue;
      const remaining = p.quota !== null && p.quota !== undefined ? p.quota : null;
      db.prepare(`
        INSERT INTO prizes (activity_id, name, description, image_url, probability, quota, remaining, coupon_code, display_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        actId, p.name,
        p.description ?? null, p.image_url ?? null,
        parseFloat(p.probability),
        p.quota ?? null, remaining,
        p.coupon_code ?? null, i
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    log.error({ err: e.message }, 'create activity failed');
    return res.status(500).json({ error: '建立活動失敗' });
  }

  insertAuditLog({
    user_id: req.session?.user_id,
    action: 'create_activity',
    entity_type: 'activity',
    entity_id: actId,
    ip: req.ip,
  });

  log.info({ activity_id: actId, client_id: clientId, name, type }, 'activity created');
  res.json({ id: actId, ok: true });
});

// ─── 後台：編輯活動 ───
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const activity = getActivity(id, clientId);
  if (!activity) return res.status(404).json({ error: '活動不存在或無權限' });

  const allowed = [
    'name', 'start_at', 'end_at', 'participation_limit_per_user', 'total_quota', 'auto_tag_winner',
    // 進階欄位
    'draws_per_participation', 'guaranteed_after', 'vip_multiplier', 'share_bonus_enabled',
    'time_window_seconds', 'max_winners', 'cover_image_url', 'sound_effect',
  ];
  const fields = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) fields[k] = req.body[k];
  }
  if (req.body.config !== undefined) {
    fields.config = typeof req.body.config === 'object' ? JSON.stringify(req.body.config) : req.body.config;
  }

  if (Object.keys(fields).length === 0) return res.json({ ok: true });

  const entries = Object.entries(fields);
  db.prepare(
    `UPDATE activities SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND client_id = ?`
  ).run(...entries.map(([, v]) => v), Date.now(), id, clientId);

  res.json({ ok: true });
});

// ─── 後台：啟動活動 ───
router.post('/:id/start', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const activity = getActivity(id, clientId);
  if (!activity) return res.status(404).json({ error: '活動不存在或無權限' });

  const now = Date.now();
  // 設 start_at（如果沒設的話，記錄現在啟動時間供限時計算用）
  db.prepare("UPDATE activities SET status = 'active', start_at = COALESCE(start_at, ?), updated_at = ? WHERE id = ?")
    .run(now, now, id);
  insertAuditLog({ user_id: req.session?.user_id, action: 'start_activity', entity_type: 'activity', entity_id: id, ip: req.ip });
  emitToClient(clientId, 'activity:started', { activity_id: id });
  log.info({ activity_id: id, client_id: clientId }, 'activity started');
  res.json({ ok: true });
});

// ─── 後台：結束活動 ───
router.post('/:id/end', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const activity = getActivity(id, clientId);
  if (!activity) return res.status(404).json({ error: '活動不存在或無權限' });

  db.prepare("UPDATE activities SET status = 'ended', updated_at = ? WHERE id = ?").run(Date.now(), id);
  insertAuditLog({ user_id: req.session?.user_id, action: 'end_activity', entity_type: 'activity', entity_id: id, ip: req.ip });
  emitToClient(clientId, 'activity:ended', { activity_id: id });
  res.json({ ok: true });
});

// ─── 後台：刪除活動 ───
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const activity = getActivity(id, clientId);
  if (!activity) return res.status(404).json({ error: '活動不存在或無權限' });
  db.prepare('DELETE FROM activities WHERE id = ?').run(id);
  insertAuditLog({ user_id: req.session?.user_id, action: 'delete_activity', entity_type: 'activity', entity_id: id, ip: req.ip });
  res.json({ ok: true });
});

// ─── 後台：統計 ───
router.get('/:id/stats', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const activity = getActivity(id, clientId);
  if (!activity) return res.status(404).json({ error: '活動不存在或無權限' });
  const stats = getActivityStats(id);
  res.json({ activity_id: id, ...stats });
});

// ─── 後台：活動排行榜 ───
router.get('/:id/leaderboard', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const activity = getActivity(id, clientId);
  if (!activity) return res.status(404).json({ error: '活動不存在或無權限' });
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 100);
  const leaderboard = getActivityLeaderboard(id, limit);
  res.json({ activity_id: id, leaderboard });
});

// ─── 全店排行榜（後台 + 玩家公開）───
router.get('/leaderboard/global', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const leaderboard = getGlobalLeaderboard(clientId, limit);
  res.json({ client_id: clientId, leaderboard });
});

// ─── 後台：參與名單（分頁）───
router.get('/:id/participations', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const activity = getActivity(id, clientId);
  if (!activity) return res.status(404).json({ error: '活動不存在或無權限' });

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);

  const rows = db.prepare(`
    SELECT pa.*, pr.name AS prize_name, cu.name AS customer_name
    FROM participations pa
    LEFT JOIN prizes pr ON pr.id = pa.prize_id
    LEFT JOIN customers cu ON cu.id = pa.customer_id
    WHERE pa.activity_id = ?
    ORDER BY pa.created_at DESC
    LIMIT ? OFFSET ?
  `).all(id, limit, offset);

  const total = db.prepare('SELECT COUNT(*) AS cnt FROM participations WHERE activity_id = ?').get(id).cnt;
  res.json({ participations: rows, total });
});

// ─── 玩家：活動資訊（公開）───
router.get('/play-info/:activity_id', (req, res) => {
  const id = parseInt(req.params.activity_id, 10);
  const activity = getActivity(id);
  if (!activity || activity.status !== 'active') {
    return res.status(404).json({ error: '活動不存在或尚未開始' });
  }
  const prizes = getActivityPrizes(id).map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    image_url: p.image_url,
    display_order: p.display_order,
  }));
  let config = {};
  try { config = JSON.parse(activity.config || '{}'); } catch {}
  const rem = getActivityRemaining(id);
  res.json({
    id: activity.id,
    name: activity.name,
    type: activity.type,
    start_at: activity.start_at,
    end_at: activity.end_at,
    participation_limit_per_user: activity.participation_limit_per_user,
    draws_per_participation: activity.draws_per_participation || 1,
    sound_effect: activity.sound_effect || 'silent',
    share_bonus_enabled: activity.share_bonus_enabled || 0,
    config: { background_image: config.background_image, description: config.description },
    prizes,
    remaining_winners: rem?.remaining_winners ?? null,
    time_remaining_seconds: rem?.time_remaining_seconds ?? null,
  });
});

// ─── 玩家：抽獎（公開）───
router.post('/play-draw/:activity_id', (req, res) => {
  const id = parseInt(req.params.activity_id, 10);
  const { channel_user_id, customer_id, times } = req.body || {};

  const result = drawPrizes(id, {
    customer_id: customer_id ? parseInt(customer_id, 10) : null,
    channel_user_id: channel_user_id || null,
    ip: req.ip,
    user_agent: req.headers['user-agent'] || null,
    times: times ? parseInt(times, 10) : undefined,
  });

  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  try {
    const activity = getActivity(id);
    if (activity) emitToClient(activity.client_id, 'game:draw', { activity_id: id, won: result.won, prize: result.prize?.name });
  } catch {}

  res.json(result);
});

// ─── 玩家公開：分享回饋（POST /api/play/:participation_id/share）───
// 注意：這個 endpoint 在 server.js 掛在 requireAuth 之前，用獨立路由
// 這裡先定義，server.js 會在 requireAuth 前掛 gamesPublicRouter

// ─── 後台：集點任務列表 ───
router.get('/tasks', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const tasks = db.prepare('SELECT * FROM tasks WHERE client_id = ? ORDER BY created_at ASC').all(clientId);
  res.json({ tasks });
});

// ─── 後台：新增任務 ───
router.post('/tasks', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const { name, description, task_type, target, reward_points, enabled = 1 } = req.body || {};
  if (!name || !task_type) return res.status(400).json({ error: '缺少 name 或 task_type' });
  const id = db.prepare(`
    INSERT INTO tasks (client_id, name, description, task_type, target, reward_points, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(clientId, name, description ?? null, task_type, target ?? 1, reward_points ?? 0, enabled ? 1 : 0, Date.now()).lastInsertRowid;
  res.json({ id, ok: true });
});

// ─── 後台：更新任務 ───
router.put('/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  const allowed = ['name', 'description', 'target', 'reward_points', 'enabled'];
  const fields = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) fields[k] = req.body[k];
  }
  if (!Object.keys(fields).length) return res.json({ ok: true });
  const entries = Object.entries(fields);
  db.prepare(`UPDATE tasks SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ? AND client_id = ?`)
    .run(...entries.map(([, v]) => v), id, clientId);
  res.json({ ok: true });
});

export default router;
