/**
 * routes/feedback.js — 廣播評價 + 活動評價（公開端點，不需登入）
 *
 * 廣播評價：
 *   GET  /api/feedback/broadcast/:id/info
 *   POST /api/feedback/broadcast/:id
 *
 * 活動評價：
 *   GET  /api/feedback/activity/:id/info
 *   POST /api/feedback/activity/:id
 *
 * 後台統計（需 requireAuth，在 server.js 掛到 requireAuth 之後）：
 *   GET  /api/broadcasts/:id/feedback
 *   GET  /api/broadcasts/:id/feedback-stats
 *   GET  /api/games/:id/feedback
 *   GET  /api/games/:id/feedback-stats
 */

import { Router } from 'express';
import { db } from '../lib/db.js';
import { emitToClient } from '../lib/realtime.js';
import { dispatchEvent } from '../lib/webhooks_out.js';
import { createRateLimiter } from '../lib/security.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'routes/feedback' });

// ─── Schema Migration ───
export const ensureFeedbackSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS broadcast_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcast_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      customer_id INTEGER,
      channel_user_id TEXT,
      feedback TEXT NOT NULL,
      comment TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );
    CREATE INDEX IF NOT EXISTS idx_bcast_fb ON broadcast_feedback(broadcast_id, feedback);

    CREATE TABLE IF NOT EXISTS activity_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      customer_id INTEGER,
      channel_user_id TEXT,
      participation_id INTEGER,
      rating INTEGER NOT NULL,
      comment TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id),
      FOREIGN KEY (participation_id) REFERENCES participations(id)
    );
    CREATE INDEX IF NOT EXISTS idx_act_fb ON activity_feedback(activity_id, rating);

    CREATE INDEX IF NOT EXISTS idx_bcast_fb_cust ON broadcast_feedback(broadcast_id, customer_id);
  `);

  // safeAlter：broadcasts 加 attach_feedback_url 欄位
  try {
    db.exec(`ALTER TABLE broadcasts ADD COLUMN attach_feedback_url INTEGER DEFAULT 1`);
  } catch {}

  log.info('feedback schema ready');
};

// ─── 公開端點限流（30 req/min/IP）───
const feedbackRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  keyFn: (req) => req.ip || 'unknown',
  message: '評價請求太頻繁，請稍後再試',
});

// ─── helpers ───
const VALID_FEEDBACK = ['useful', 'not_useful', 'unsubscribe'];

// 把「不再接收廣播」標籤加到顧客身上
const tagUnsubscribe = (customerId) => {
  if (!customerId) return;
  try {
    const cust = db.prepare('SELECT tags FROM customers WHERE id = ?').get(customerId);
    if (!cust) return;
    let tags = [];
    try { tags = JSON.parse(cust.tags || '[]'); } catch {}
    const TAG = '不再接收廣播';
    if (!tags.includes(TAG)) {
      tags.push(TAG);
      db.prepare('UPDATE customers SET tags = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(tags), Date.now(), customerId);
      log.info({ customer_id: customerId }, 'unsubscribe tag applied');
    }
  } catch (e) {
    log.warn({ err: e.message, customer_id: customerId }, 'tagUnsubscribe failed');
  }
};

const router = Router();

// ═══════════════════════════════════════════════════════════
// 廣播評價（公開）
// ═══════════════════════════════════════════════════════════

// GET /api/feedback/broadcast/:id/info
router.get('/broadcast/:id/info', feedbackRateLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '無效的廣播 ID' });

  const broadcast = db.prepare(
    'SELECT id, name, channel, content, content_type, client_id FROM broadcasts WHERE id = ?'
  ).get(id);
  if (!broadcast) return res.status(404).json({ error: '廣播不存在' });

  // 拿業主名稱
  const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(broadcast.client_id);

  // 若傳了 customer_id，查是否已評過
  const customerId = req.query.customer_id ? parseInt(req.query.customer_id, 10) : null;
  let alreadyRated = false;
  if (customerId) {
    const exists = db.prepare(
      'SELECT id FROM broadcast_feedback WHERE broadcast_id = ? AND customer_id = ?'
    ).get(id, customerId);
    alreadyRated = !!exists;
  }

  res.json({
    broadcast_id: broadcast.id,
    name: broadcast.name,
    channel: broadcast.channel,
    business: client?.name || '',
    content_preview: (broadcast.content || '').slice(0, 120),
    already_rated: alreadyRated,
  });
});

// POST /api/feedback/broadcast/:id
router.post('/broadcast/:id', feedbackRateLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '無效的廣播 ID' });

  const broadcast = db.prepare('SELECT id, client_id FROM broadcasts WHERE id = ?').get(id);
  if (!broadcast) return res.status(404).json({ error: '廣播不存在' });

  const { customer_id, channel_user_id, feedback, comment } = req.body || {};

  if (!feedback || !VALID_FEEDBACK.includes(feedback)) {
    return res.status(400).json({ error: `feedback 必須是 ${VALID_FEEDBACK.join('/')}` });
  }

  const custId = customer_id ? parseInt(customer_id, 10) : null;

  // 防重複：同 customer_id + broadcast_id 只能評一次
  if (custId) {
    const exists = db.prepare(
      'SELECT id FROM broadcast_feedback WHERE broadcast_id = ? AND customer_id = ?'
    ).get(id, custId);
    if (exists) {
      return res.status(409).json({ error: '您已送過這則廣播的評價' });
    }
  }

  const now = Date.now();
  db.prepare(`
    INSERT INTO broadcast_feedback
      (broadcast_id, client_id, customer_id, channel_user_id, feedback, comment, ip, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, broadcast.client_id,
    custId ?? null,
    channel_user_id || null,
    feedback,
    comment || null,
    req.ip || null,
    (req.headers['user-agent'] || '').slice(0, 200),
    now
  );

  // unsubscribe → 加標籤
  if (feedback === 'unsubscribe' && custId) {
    tagUnsubscribe(custId);
  }

  // emit + dispatchEvent
  const fbPayload = {
    broadcast_id: id,
    client_id: broadcast.client_id,
    customer_id: custId,
    feedback,
    comment: comment || null,
  };

  emitToClient(broadcast.client_id, 'feedback:received', fbPayload);

  if (feedback === 'not_useful' || feedback === 'unsubscribe') {
    emitToClient(broadcast.client_id, 'feedback:negative', fbPayload);
    dispatchEvent(broadcast.client_id, 'feedback:negative', fbPayload).catch(() => {});
  }

  dispatchEvent(broadcast.client_id, 'feedback:received', fbPayload).catch(() => {});

  log.info({ broadcast_id: id, feedback, customer_id: custId }, 'broadcast feedback saved');
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// 活動評價（公開）
// ═══════════════════════════════════════════════════════════

// GET /api/feedback/activity/:id/info
router.get('/activity/:id/info', feedbackRateLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '無效的活動 ID' });

  const activity = db.prepare(
    'SELECT id, name, type, client_id FROM activities WHERE id = ?'
  ).get(id);
  if (!activity) return res.status(404).json({ error: '活動不存在' });

  // 拿業主名稱
  const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(activity.client_id);

  // participation_id → 回傳中獎資訊
  let participation = null;
  const participationId = req.query.participation_id ? parseInt(req.query.participation_id, 10) : null;
  if (participationId) {
    const pa = db.prepare(
      'SELECT pa.is_winner, pr.name AS prize_name, pr.description AS prize_desc FROM participations pa LEFT JOIN prizes pr ON pr.id = pa.prize_id WHERE pa.id = ? AND pa.activity_id = ?'
    ).get(participationId, id);
    if (pa) {
      participation = {
        is_winner: pa.is_winner === 1,
        prize_name: pa.prize_name || null,
        prize_desc: pa.prize_desc || null,
      };
    }
  }

  res.json({
    activity_id: activity.id,
    name: activity.name,
    type: activity.type,
    business: client?.name || '',
    participation,
  });
});

// POST /api/feedback/activity/:id
router.post('/activity/:id', feedbackRateLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '無效的活動 ID' });

  const activity = db.prepare('SELECT id, client_id FROM activities WHERE id = ?').get(id);
  if (!activity) return res.status(404).json({ error: '活動不存在' });

  const { customer_id, channel_user_id, participation_id, rating, comment } = req.body || {};

  const ratingNum = parseInt(rating, 10);
  if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'rating 必須是 1-5 的整數' });
  }

  const custId = customer_id ? parseInt(customer_id, 10) : null;
  const partId = participation_id ? parseInt(participation_id, 10) : null;

  const now = Date.now();
  db.prepare(`
    INSERT INTO activity_feedback
      (activity_id, client_id, customer_id, channel_user_id, participation_id, rating, comment, ip, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, activity.client_id,
    custId ?? null,
    channel_user_id || null,
    partId ?? null,
    ratingNum,
    comment || null,
    req.ip || null,
    (req.headers['user-agent'] || '').slice(0, 200),
    now
  );

  const fbPayload = {
    activity_id: id,
    client_id: activity.client_id,
    customer_id: custId,
    participation_id: partId,
    rating: ratingNum,
    comment: comment || null,
  };

  emitToClient(activity.client_id, 'feedback:received', fbPayload);
  dispatchEvent(activity.client_id, 'feedback:received', fbPayload).catch(() => {});

  if (ratingNum === 5) {
    emitToClient(activity.client_id, 'feedback:5_star_activity', fbPayload);
    dispatchEvent(activity.client_id, 'feedback:5_star_activity', fbPayload).catch(() => {});
  }

  log.info({ activity_id: id, rating: ratingNum, customer_id: custId }, 'activity feedback saved');
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// 後台統計（掛到 requireAuth 之後，在 server.js 以 broadcastRouter / gamesRouter 掛入）
// 這裡只 export helper 函式給各自 route 用
// ═══════════════════════════════════════════════════════════

const resolveClientId = (req) => {
  const sess = req.session;
  if (sess?.role === 'admin' && sess.client_id === null) {
    return req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  }
  return sess?.client_id ?? null;
};

/**
 * broadcastFeedbackRouter — 掛在 /api/broadcasts，路由包含 /:id/feedback 前綴
 * 這樣就能正確捕 /api/broadcasts/:id/feedback 和 /api/broadcasts/:id/feedback-stats
 */
export const broadcastFeedbackRouter = Router();

// GET /api/broadcasts/:id/feedback
broadcastFeedbackRouter.get('/:id/feedback', (req, res) => {
  const broadcastId = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const broadcast = db.prepare('SELECT id FROM broadcasts WHERE id = ? AND client_id = ?').get(broadcastId, clientId);
  if (!broadcast) return res.status(404).json({ error: '廣播不存在或無權限' });

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const rows = db.prepare(`
    SELECT bf.*, c.name AS customer_name
    FROM broadcast_feedback bf
    LEFT JOIN customers c ON c.id = bf.customer_id
    WHERE bf.broadcast_id = ?
    ORDER BY bf.created_at DESC
    LIMIT ? OFFSET ?
  `).all(broadcastId, limit, offset);

  const total = db.prepare('SELECT COUNT(*) AS cnt FROM broadcast_feedback WHERE broadcast_id = ?').get(broadcastId).cnt;
  res.json({ feedback: rows, total });
});

// GET /api/broadcasts/:id/feedback-stats
broadcastFeedbackRouter.get('/:id/feedback-stats', (req, res) => {
  const broadcastId = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const broadcast = db.prepare('SELECT id, name FROM broadcasts WHERE id = ? AND client_id = ?').get(broadcastId, clientId);
  if (!broadcast) return res.status(404).json({ error: '廣播不存在或無權限' });

  const breakdown = db.prepare(`
    SELECT feedback, COUNT(*) AS count
    FROM broadcast_feedback
    WHERE broadcast_id = ?
    GROUP BY feedback
  `).all(broadcastId);

  const counts = { useful: 0, not_useful: 0, unsubscribe: 0 };
  for (const row of breakdown) {
    if (counts[row.feedback] !== undefined) counts[row.feedback] = row.count;
  }

  const total = counts.useful + counts.not_useful + counts.unsubscribe;
  const ratedTotal = counts.useful + counts.not_useful;
  const useful_rate = ratedTotal > 0 ? Math.round(counts.useful / ratedTotal * 100) : null;

  const recent_comments = db.prepare(`
    SELECT bf.feedback, bf.comment, bf.created_at, c.name AS customer_name
    FROM broadcast_feedback bf
    LEFT JOIN customers c ON c.id = bf.customer_id
    WHERE bf.broadcast_id = ? AND bf.comment IS NOT NULL AND bf.comment != ''
    ORDER BY bf.created_at DESC
    LIMIT 10
  `).all(broadcastId);

  res.json({
    broadcast_id: broadcastId,
    name: broadcast.name,
    total,
    counts,
    useful_rate,
    recent_comments,
  });
});

/**
 * activityFeedbackRouter — 掛在 /api/games，路由包含 /:id/feedback 前綴
 */
export const activityFeedbackRouter = Router();

// GET /api/games/:id/feedback
activityFeedbackRouter.get('/:id/feedback', (req, res) => {
  const activityId = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const activity = db.prepare('SELECT id FROM activities WHERE id = ? AND client_id = ?').get(activityId, clientId);
  if (!activity) return res.status(404).json({ error: '活動不存在或無權限' });

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const rows = db.prepare(`
    SELECT af.*, c.name AS customer_name
    FROM activity_feedback af
    LEFT JOIN customers c ON c.id = af.customer_id
    WHERE af.activity_id = ?
    ORDER BY af.created_at DESC
    LIMIT ? OFFSET ?
  `).all(activityId, limit, offset);

  const total = db.prepare('SELECT COUNT(*) AS cnt FROM activity_feedback WHERE activity_id = ?').get(activityId).cnt;
  res.json({ feedback: rows, total });
});

// GET /api/games/:id/feedback-stats
activityFeedbackRouter.get('/:id/feedback-stats', (req, res) => {
  const activityId = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const activity = db.prepare('SELECT id, name FROM activities WHERE id = ? AND client_id = ?').get(activityId, clientId);
  if (!activity) return res.status(404).json({ error: '活動不存在或無權限' });

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      ROUND(AVG(rating) * 10) / 10.0 AS avg_rating
    FROM activity_feedback
    WHERE activity_id = ?
  `).get(activityId);

  const distribution = db.prepare(`
    SELECT rating, COUNT(*) AS count
    FROM activity_feedback
    WHERE activity_id = ?
    GROUP BY rating
    ORDER BY rating DESC
  `).all(activityId);

  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of distribution) {
    dist[row.rating] = row.count;
  }

  const recent_comments = db.prepare(`
    SELECT af.rating, af.comment, af.created_at, c.name AS customer_name
    FROM activity_feedback af
    LEFT JOIN customers c ON c.id = af.customer_id
    WHERE af.activity_id = ? AND af.comment IS NOT NULL AND af.comment != ''
    ORDER BY af.created_at DESC
    LIMIT 10
  `).all(activityId);

  res.json({
    activity_id: activityId,
    name: activity.name,
    total: stats.total,
    avg_rating: stats.avg_rating,
    distribution: dist,
    recent_comments,
  });
});

export default router;
