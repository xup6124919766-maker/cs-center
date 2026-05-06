/**
 * routes/analytics.js — 客服績效報表
 *
 * GET  /api/analytics/agents
 * GET  /api/analytics/agents/:user_id/ratings
 * GET  /api/analytics/agents/:user_id/badges
 * GET  /api/analytics/conversations
 * GET  /api/analytics/drafts
 * GET  /api/analytics/funnel
 */

import { Router } from 'express';
import { db } from '../lib/db.js';
import { chat } from '../lib/ai.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'routes/analytics' });

const resolveClientId = (req) => {
  const sess = req.session;
  if (sess?.role === 'admin' && sess.client_id === null) {
    return req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  }
  return sess?.client_id ?? null;
};

const router = Router();

// ─── 時間範圍解析 ───
const parseRange = (req) => {
  const now = Date.now();
  const from = req.query.from ? parseInt(req.query.from, 10) : now - 7 * 24 * 3600 * 1000;
  const to   = req.query.to   ? parseInt(req.query.to,   10) : now;
  return { from, to };
};

// ─── 客服績效 ───
router.get('/agents', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const { from, to } = parseRange(req);

  // 每位客服的訊息數
  const agentMsgs = db.prepare(`
    SELECT m.sender_id AS user_id, COUNT(*) AS message_count
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.client_id = ? AND m.direction = 'outbound' AND m.sender_type = 'agent'
      AND m.created_at BETWEEN ? AND ?
    GROUP BY m.sender_id
  `).all(clientId, from, to);

  // FRT（首次回覆時間）：每個對話第一則 inbound 到第一則 outbound(agent) 的時間差
  const frtRows = db.prepare(`
    SELECT
      m_out.sender_id AS user_id,
      AVG(m_out.created_at - m_in.created_at) AS avg_frt_ms
    FROM (
      SELECT conversation_id, MIN(created_at) AS created_at
      FROM messages
      WHERE direction = 'inbound'
      GROUP BY conversation_id
    ) AS m_in
    JOIN (
      SELECT conversation_id, sender_id, MIN(created_at) AS created_at
      FROM messages
      WHERE direction = 'outbound' AND sender_type = 'agent'
      GROUP BY conversation_id
    ) AS m_out ON m_out.conversation_id = m_in.conversation_id
    JOIN conversations c ON c.id = m_in.conversation_id
    WHERE c.client_id = ? AND m_out.created_at BETWEEN ? AND ?
    GROUP BY m_out.sender_id
  `).all(clientId, from, to);

  // 解決時間（對話從 open → closed 的平均時間）
  const resolveRows = db.prepare(`
    SELECT
      assigned_user_id AS user_id,
      AVG(updated_at - created_at) AS avg_resolve_ms,
      COUNT(*) AS resolved_count
    FROM conversations
    WHERE client_id = ? AND status = 'closed' AND updated_at BETWEEN ? AND ?
      AND assigned_user_id IS NOT NULL
    GROUP BY assigned_user_id
  `).all(clientId, from, to);

  // B: 改用 csat_agent_id 算 CSAT（含分布）
  const csatRows = db.prepare(`
    SELECT
      csat_agent_id AS user_id,
      AVG(csat_score) AS csat_avg,
      COUNT(csat_score) AS csat_count,
      SUM(CASE WHEN csat_score = 5 THEN 1 ELSE 0 END) AS csat_5_count,
      SUM(CASE WHEN csat_score = 4 THEN 1 ELSE 0 END) AS csat_4_count,
      SUM(CASE WHEN csat_score = 3 THEN 1 ELSE 0 END) AS csat_3_count,
      SUM(CASE WHEN csat_score = 2 THEN 1 ELSE 0 END) AS csat_2_count,
      SUM(CASE WHEN csat_score = 1 THEN 1 ELSE 0 END) AS csat_1_count
    FROM conversations
    WHERE client_id = ? AND csat_score IS NOT NULL AND csat_agent_id IS NOT NULL
      AND updated_at BETWEEN ? AND ?
    GROUP BY csat_agent_id
  `).all(clientId, from, to);

  // B: 每位客服最近 5 則評語
  const recentCommentRows = db.prepare(`
    SELECT csat_agent_id AS user_id, csat_comment, csat_score, updated_at
    FROM conversations
    WHERE client_id = ? AND csat_score IS NOT NULL AND csat_agent_id IS NOT NULL
      AND csat_comment IS NOT NULL
      AND updated_at BETWEEN ? AND ?
    ORDER BY updated_at DESC
  `).all(clientId, from, to);

  // 整理最近評語：每位 user 最多 5 則
  const recentByAgent = {};
  for (const r of recentCommentRows) {
    if (!recentByAgent[r.user_id]) recentByAgent[r.user_id] = [];
    if (recentByAgent[r.user_id].length < 5) {
      recentByAgent[r.user_id].push({ score: r.csat_score, comment: r.csat_comment, at: r.updated_at });
    }
  }

  // 合併成 user 維度
  const usersMap = new Map();

  const getOrCreate = (userId) => {
    if (!usersMap.has(userId)) {
      usersMap.set(userId, {
        user_id: userId,
        username: null,
        message_count: 0,
        avg_frt_ms: null,
        avg_resolve_ms: null,
        resolved_count: 0,
        // B: 新欄位
        csat_avg: null,
        csat_count: 0,
        csat_5_count: 0,
        csat_4_count: 0,
        csat_3_count: 0,
        csat_2_count: 0,
        csat_1_count: 0,
        csat_recent_comments: [],
      });
    }
    return usersMap.get(userId);
  };

  for (const r of agentMsgs) {
    const u = getOrCreate(r.user_id);
    u.message_count = r.message_count;
  }
  for (const r of frtRows) {
    const u = getOrCreate(r.user_id);
    u.avg_frt_ms = r.avg_frt_ms ? Math.round(r.avg_frt_ms) : null;
  }
  for (const r of resolveRows) {
    const u = getOrCreate(r.user_id);
    u.avg_resolve_ms = r.avg_resolve_ms ? Math.round(r.avg_resolve_ms) : null;
    u.resolved_count = r.resolved_count;
  }
  for (const r of csatRows) {
    const u = getOrCreate(r.user_id);
    u.csat_avg    = r.csat_avg ? Math.round(r.csat_avg * 10) / 10 : null;
    u.csat_count  = r.csat_count;
    u.csat_5_count = r.csat_5_count;
    u.csat_4_count = r.csat_4_count;
    u.csat_3_count = r.csat_3_count;
    u.csat_2_count = r.csat_2_count;
    u.csat_1_count = r.csat_1_count;
    u.csat_recent_comments = recentByAgent[r.user_id] || [];
  }

  // 補上 username
  for (const [userId, data] of usersMap) {
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    data.username = user?.username ?? `user_${userId}`;
  }

  res.json({ agents: Array.from(usersMap.values()), from, to });
});

// ─── B: 單一客服詳細 CSAT 紀錄 ───
router.get('/agents/:user_id/ratings', (req, res) => {
  const userId = parseInt(req.params.user_id, 10);
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const { from, to } = parseRange(req);
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);

  const ratings = db.prepare(`
    SELECT
      c.id AS conversation_id,
      c.csat_score AS score,
      c.csat_comment AS comment,
      c.updated_at AS created_at,
      cu.name AS customer_name
    FROM conversations c
    LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE c.client_id = ?
      AND c.csat_agent_id = ?
      AND c.csat_score IS NOT NULL
      AND c.updated_at BETWEEN ? AND ?
    ORDER BY c.updated_at DESC
    LIMIT ?
  `).all(clientId, userId, from, to, limit);

  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: '客服不存在' });

  const summary = db.prepare(`
    SELECT
      AVG(csat_score) AS csat_avg,
      COUNT(csat_score) AS csat_count,
      SUM(CASE WHEN csat_score = 5 THEN 1 ELSE 0 END) AS csat_5_count,
      SUM(CASE WHEN csat_score = 4 THEN 1 ELSE 0 END) AS csat_4_count,
      SUM(CASE WHEN csat_score = 3 THEN 1 ELSE 0 END) AS csat_3_count,
      SUM(CASE WHEN csat_score = 2 THEN 1 ELSE 0 END) AS csat_2_count,
      SUM(CASE WHEN csat_score = 1 THEN 1 ELSE 0 END) AS csat_1_count
    FROM conversations
    WHERE client_id = ? AND csat_agent_id = ? AND csat_score IS NOT NULL
      AND updated_at BETWEEN ? AND ?
  `).get(clientId, userId, from, to);

  res.json({
    user_id: user.id,
    username: user.username,
    summary: {
      csat_avg: summary?.csat_avg ? Math.round(summary.csat_avg * 10) / 10 : null,
      csat_count: summary?.csat_count || 0,
      csat_5_count: summary?.csat_5_count || 0,
      csat_4_count: summary?.csat_4_count || 0,
      csat_3_count: summary?.csat_3_count || 0,
      csat_2_count: summary?.csat_2_count || 0,
      csat_1_count: summary?.csat_1_count || 0,
    },
    ratings,
    from,
    to,
  });
});

// ─── B: 單一客服成就 badges ───
router.get('/agents/:user_id/badges', (req, res) => {
  const userId = parseInt(req.params.user_id, 10);
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: '客服不存在' });

  // 全時間統計
  const allTime = db.prepare(`
    SELECT
      AVG(csat_score) AS csat_avg,
      COUNT(csat_score) AS csat_count,
      SUM(CASE WHEN csat_score = 5 THEN 1 ELSE 0 END) AS csat_5_count
    FROM conversations
    WHERE client_id = ? AND csat_agent_id = ? AND csat_score IS NOT NULL
  `).get(clientId, userId);

  // 本週冠軍（本週評分 ≥ 3 的平均是否最高）
  const now = Date.now();
  const weekStart = now - 7 * 24 * 3600 * 1000;
  const thisWeekAvg = db.prepare(`
    SELECT AVG(csat_score) AS avg, COUNT(*) AS cnt
    FROM conversations
    WHERE client_id = ? AND csat_agent_id = ? AND csat_score IS NOT NULL
      AND updated_at >= ?
  `).get(clientId, userId, weekStart);

  // 全客服本週 best avg（至少 3 筆才算）
  const weekBest = db.prepare(`
    SELECT csat_agent_id, AVG(csat_score) AS avg, COUNT(*) AS cnt
    FROM conversations
    WHERE client_id = ? AND csat_score IS NOT NULL AND updated_at >= ?
    GROUP BY csat_agent_id
    HAVING COUNT(*) >= 3
    ORDER BY avg DESC
    LIMIT 1
  `).get(clientId, weekStart);

  // 進步獎：近 7 天平均 > 前 7 天平均
  const prev7Start = now - 14 * 24 * 3600 * 1000;
  const prev7End = weekStart;
  const prevAvg = db.prepare(`
    SELECT AVG(csat_score) AS avg FROM conversations
    WHERE client_id = ? AND csat_agent_id = ? AND csat_score IS NOT NULL
      AND updated_at BETWEEN ? AND ?
  `).get(clientId, userId, prev7Start, prev7End);

  const badges = [];

  // 5 星王：累計 5 星數 ≥ 10
  if ((allTime?.csat_5_count || 0) >= 10) {
    badges.push({ id: 'star5_king', label: '5 星王', desc: `累計 ${allTime.csat_5_count} 則 5 星好評` });
  }

  // 完美客服：歷史平均 ≥ 4.5（至少 5 筆）
  if ((allTime?.csat_count || 0) >= 5 && (allTime?.csat_avg || 0) >= 4.5) {
    badges.push({ id: 'perfect_service', label: '完美客服', desc: `歷史平均 ${Math.round(allTime.csat_avg * 10) / 10} 星` });
  }

  // 週冠軍：本週平均最高且評分數 ≥ 3
  if (weekBest && weekBest.csat_agent_id === userId && (thisWeekAvg?.cnt || 0) >= 3) {
    badges.push({ id: 'weekly_champ', label: '週冠軍', desc: `本週平均 ${Math.round(weekBest.avg * 10) / 10} 星` });
  }

  // 進步獎：近 7 天平均比前 7 天進步 ≥ 0.5
  if (
    prevAvg?.avg != null && thisWeekAvg?.avg != null &&
    (thisWeekAvg.avg - prevAvg.avg) >= 0.5 &&
    (thisWeekAvg?.cnt || 0) >= 3
  ) {
    badges.push({ id: 'improving', label: '進步獎', desc: `本週平均較上週進步 ${Math.round((thisWeekAvg.avg - prevAvg.avg) * 10) / 10} 星` });
  }

  res.json({
    user_id: user.id,
    username: user.username,
    badges,
    stats: {
      csat_avg_alltime: allTime?.csat_avg ? Math.round(allTime.csat_avg * 10) / 10 : null,
      csat_count_alltime: allTime?.csat_count || 0,
      csat_5_count_alltime: allTime?.csat_5_count || 0,
      week_avg: thisWeekAvg?.avg ? Math.round(thisWeekAvg.avg * 10) / 10 : null,
      week_count: thisWeekAvg?.cnt || 0,
    },
  });
});

// ─── 對話統計 ───
router.get('/conversations', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const { from, to } = parseRange(req);
  const groupBy = req.query.group_by || 'day';

  let rows = [];
  if (groupBy === 'intent') {
    rows = db.prepare(`
      SELECT COALESCE(intent, '未分類') AS label, COUNT(*) AS count
      FROM conversations
      WHERE client_id = ? AND created_at BETWEEN ? AND ?
      GROUP BY intent
    `).all(clientId, from, to);
  } else if (groupBy === 'emotion') {
    rows = db.prepare(`
      SELECT COALESCE(emotion, 'neutral') AS label, COUNT(*) AS count
      FROM conversations
      WHERE client_id = ? AND created_at BETWEEN ? AND ?
      GROUP BY emotion
    `).all(clientId, from, to);
  } else if (groupBy === 'hour') {
    rows = db.prepare(`
      SELECT
        CAST((created_at - ?) / 3600000 AS INTEGER) AS hour_offset,
        COUNT(*) AS count
      FROM conversations
      WHERE client_id = ? AND created_at BETWEEN ? AND ?
      GROUP BY hour_offset
      ORDER BY hour_offset
    `).all(from, clientId, from, to);
  } else {
    // day
    rows = db.prepare(`
      SELECT
        CAST((created_at - ?) / 86400000 AS INTEGER) AS day_offset,
        COUNT(*) AS count
      FROM conversations
      WHERE client_id = ? AND created_at BETWEEN ? AND ?
      GROUP BY day_offset
      ORDER BY day_offset
    `).all(from, clientId, from, to);
  }

  const total = db.prepare('SELECT COUNT(*) AS cnt FROM conversations WHERE client_id = ? AND created_at BETWEEN ? AND ?')
    .get(clientId, from, to).cnt;

  res.json({ group_by: groupBy, total, data: rows, from, to });
});

// ─── AI 草擬統計 ───
router.get('/drafts', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const { from, to } = parseRange(req);

  const total = db.prepare(`
    SELECT COUNT(*) AS cnt FROM drafts d
    JOIN conversations c ON c.id = d.conversation_id
    WHERE c.client_id = ? AND d.created_at BETWEEN ? AND ?
  `).get(clientId, from, to).cnt;

  const approved = db.prepare(`
    SELECT COUNT(*) AS cnt FROM drafts d
    JOIN conversations c ON c.id = d.conversation_id
    WHERE c.client_id = ? AND d.status IN ('approved', 'edited') AND d.created_at BETWEEN ? AND ?
  `).get(clientId, from, to).cnt;

  const byVariant = db.prepare(`
    SELECT d.variant, COUNT(*) AS count, SUM(CASE WHEN d.status IN ('approved','edited') THEN 1 ELSE 0 END) AS approved
    FROM drafts d
    JOIN conversations c ON c.id = d.conversation_id
    WHERE c.client_id = ? AND d.created_at BETWEEN ? AND ?
    GROUP BY d.variant
  `).all(clientId, from, to);

  const acceptanceRate = total > 0 ? Math.round(approved / total * 100) : 0;

  res.json({
    total_drafts: total,
    approved_count: approved,
    acceptance_rate_pct: acceptanceRate,
    by_variant: byVariant,
    from,
    to,
  });
});

// ─── 對話漏斗 ───
router.get('/funnel', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const { from, to } = parseRange(req);

  const newConvs = db.prepare(
    'SELECT COUNT(*) AS cnt FROM conversations WHERE client_id = ? AND created_at BETWEEN ? AND ?'
  ).get(clientId, from, to).cnt;

  // engaged: 至少一則 inbound 且一則 outbound 的對話
  const engaged = db.prepare(`
    SELECT COUNT(DISTINCT c.id) AS cnt
    FROM conversations c
    WHERE c.client_id = ? AND c.created_at BETWEEN ? AND ?
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound')
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'outbound')
  `).get(clientId, from, to).cnt;

  const resolved = db.prepare(
    "SELECT COUNT(*) AS cnt FROM conversations WHERE client_id = ? AND status = 'closed' AND updated_at BETWEEN ? AND ?"
  ).get(clientId, from, to).cnt;

  const csatSubmitted = db.prepare(
    'SELECT COUNT(*) AS cnt FROM conversations WHERE client_id = ? AND csat_score IS NOT NULL AND updated_at BETWEEN ? AND ?'
  ).get(clientId, from, to).cnt;

  res.json({
    funnel: [
      { stage: 'new_conversation', count: newConvs },
      { stage: 'engaged', count: engaged },
      { stage: 'resolved', count: resolved },
      { stage: 'csat_submitted', count: csatSubmitted },
    ],
    from,
    to,
  });
});

// ─── 業績歸因（對話 → 之後 7 天 BV 訂單）─────────────────
// GET /api/analytics/revenue-attribution?client_id=N&conv_id=X
//     回單一對話導向金額（chat header 用）
// GET /api/analytics/revenue-attribution?client_id=N&user_id=X&days=30
//     回某客服整月導向金額（agent ranking 用）
router.get('/revenue-attribution', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const ATTRIB_WINDOW = 7 * 86400000; // 對話最後活動後 7 天內 BV 訂單算這對話的功勞

  // 模式 1：單一對話
  if (req.query.conv_id) {
    const cid = parseInt(req.query.conv_id, 10);
    const conv = db.prepare('SELECT id, customer_id, last_message_at, created_at FROM conversations WHERE id = ? AND client_id = ?').get(cid, clientId);
    if (!conv || !conv.customer_id) return res.json({ ok: true, conversation_id: cid, revenue: 0, orders: 0 });
    const start = conv.created_at || 0;
    const end = (conv.last_message_at || Date.now()) + ATTRIB_WINDOW;
    const r = db.prepare(`
      SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS total
      FROM orders WHERE client_id = ? AND customer_id = ?
        AND ordered_at BETWEEN ? AND ?
        AND status IN ('paid','shipped','delivered')
    `).get(clientId, conv.customer_id, start, end);
    return res.json({ ok: true, conversation_id: cid, revenue: r.total || 0, orders: r.cnt || 0, window_days: 7 });
  }

  // 模式 2：客服月度 ranking
  const days = Math.min(parseInt(req.query.days || '30', 10), 90);
  const since = Date.now() - days * 86400000;
  // 該期間每個客服回過的對話 → 對話 customer 在期間 + 7 天內訂單金額
  const rows = db.prepare(`
    SELECT u.id AS user_id, u.username, u.display_name,
           COUNT(DISTINCT c.id) AS conv_count,
           COALESCE(SUM(o.total_amount), 0) AS revenue,
           COUNT(DISTINCT o.id) AS order_count
    FROM users u
    LEFT JOIN messages m ON m.sender_id = CAST(u.id AS TEXT) AND m.direction = 'outbound' AND m.created_at >= ?
    LEFT JOIN conversations c ON c.id = m.conversation_id AND c.client_id = ?
    LEFT JOIN orders o ON o.customer_id = c.customer_id AND o.client_id = ?
      AND o.ordered_at BETWEEN m.created_at AND m.created_at + ?
      AND o.status IN ('paid','shipped','delivered')
    WHERE u.client_id = ? OR u.client_id IS NULL
    GROUP BY u.id
    HAVING conv_count > 0 OR revenue > 0
    ORDER BY revenue DESC
    LIMIT 50
  `).all(since, clientId, clientId, ATTRIB_WINDOW, clientId);
  res.json({ ok: true, days, agents: rows });
});

// ─── 熱門問題 AI 聚類（過去 N 天 inbound）GET /hot-topics?days=7 ───
router.get('/hot-topics', async (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const days = Math.min(Math.max(parseInt(req.query.days || '7', 10), 1), 30);
  const since = Date.now() - days * 86400000;

  // 拉過去 N 天的 inbound 文字訊息（去重複過短）
  const msgs = db.prepare(`
    SELECT DISTINCT m.content
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.client_id = ?
      AND m.direction = 'inbound'
      AND m.content_type = 'text'
      AND m.content IS NOT NULL
      AND length(m.content) BETWEEN 5 AND 300
      AND m.created_at >= ?
    ORDER BY m.created_at DESC
    LIMIT 500
  `).all(clientId, since).map(r => r.content);

  if (!msgs.length) return res.json({ ok: true, days, total_messages: 0, clusters: [] });

  // 分批送 AI 聚類（每批 100 則，避免 token 爆）
  const sample = msgs.slice(0, 200);
  const system = `你是客服資料分析師。下面是過去 ${days} 天客戶的 inbound 訊息，請聚類成最多 8 個主題群組（FAQ 候選）。每組標題不超過 12 字、合併同義問題、按出現頻率排序。

只回 JSON：
{"clusters":[{"title":"...","frequency":N,"sample_questions":["...","..."],"suggested_answer":"客服可以這樣回..."}]}`;

  const userText = sample.map((m, i) => `${i + 1}. ${m}`).join('\n');
  try {
    const r = await chat({
      client_id: clientId,
      feature: 'voc',
      system,
      messages: [{ role: 'user', content: userText.slice(0, 12000) }],
      max_tokens: 1500,
      json_schema: true,
    });
    if (!r.ok) return res.status(502).json({ error: r.error || 'AI 失敗' });
    const data = r.json || {};
    res.json({ ok: true, days, total_messages: msgs.length, sample_size: sample.length, clusters: data.clusters || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
