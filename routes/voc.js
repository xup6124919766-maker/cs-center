/**
 * routes/voc.js — Voice of Customer API
 *
 * GET  /api/voc/topics           → 主題排行（count 降冪）
 * GET  /api/voc/topics/:id/excerpts → 主題所有原文
 * GET  /api/voc/insights         → 詳細分析列表
 * POST /api/voc/analyze-now      → 手動觸發批次分析（admin）
 * GET  /api/voc/dashboard        → 整合儀表板數據
 * PATCH /api/voc/insights/:id/handled → 標記投訴已處理
 */

import { Router } from 'express';
import { db } from '../lib/db.js';
import { runVocBatch, recomputeVocTopics } from '../lib/voc.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'routes/voc' });
const router = Router();

// ─── 工具：解析 client_id（沿用 analytics.js 模式）───
const resolveClientId = (req) => {
  const sess = req.session;
  if (sess?.role === 'admin' && sess.client_id === null) {
    return req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  }
  return sess?.client_id ?? null;
};

// ─── 工具：period 轉 ms ───
const periodToMs = (period = '30d') => {
  const map = { '7d': 7, '30d': 30, '90d': 90 };
  const days = map[period] || 30;
  return Date.now() - days * 24 * 3600_000;
};

// ─── GET /api/voc/topics ───
router.get('/topics', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const category = req.query.category || null;
  const limit    = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const from     = req.query.from ? parseInt(req.query.from, 10) : periodToMs('30d');
  const to       = req.query.to   ? parseInt(req.query.to, 10)   : Date.now();

  const where = ['client_id = ?'];
  const args  = [clientId];
  if (category) { where.push('category = ?'); args.push(category); }

  // 加入情緒分布
  const topics = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM voc_insights v
       WHERE v.client_id = t.client_id AND v.topic = t.topic
         AND v.created_at BETWEEN ? AND ? AND v.sentiment = 'positive') AS pos_count,
      (SELECT COUNT(*) FROM voc_insights v
       WHERE v.client_id = t.client_id AND v.topic = t.topic
         AND v.created_at BETWEEN ? AND ? AND v.sentiment = 'neutral') AS neu_count,
      (SELECT COUNT(*) FROM voc_insights v
       WHERE v.client_id = t.client_id AND v.topic = t.topic
         AND v.created_at BETWEEN ? AND ? AND v.sentiment = 'negative') AS neg_count
    FROM voc_topics t
    WHERE ${where.join(' AND ')}
    ORDER BY t.count DESC
    LIMIT ?
  `).all(from, to, from, to, from, to, ...args, limit);

  res.json({ topics, from, to });
});

// ─── GET /api/voc/topics/:id/excerpts ───
router.get('/topics/:id/excerpts', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const topicRow = db.prepare('SELECT * FROM voc_topics WHERE id = ? AND client_id = ?')
    .get(parseInt(req.params.id, 10), clientId);
  if (!topicRow) return res.status(404).json({ error: '主題不存在' });

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const from  = req.query.from ? parseInt(req.query.from, 10) : 0;
  const to    = req.query.to   ? parseInt(req.query.to, 10)   : Date.now();

  const insights = db.prepare(`
    SELECT vi.*, cu.name AS customer_name, c.id AS conv_id
    FROM voc_insights vi
    JOIN conversations c ON c.id = vi.conversation_id
    LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE vi.client_id = ? AND vi.topic = ?
      AND vi.created_at BETWEEN ? AND ?
    ORDER BY vi.created_at DESC
    LIMIT ?
  `).all(clientId, topicRow.topic, from, to, limit);

  res.json({ topic: topicRow, insights });
});

// ─── GET /api/voc/insights ───
router.get('/insights', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const category = req.query.category || null;
  const sentiment = req.query.sentiment || null;
  const urgency   = req.query.urgency || null;
  const handled   = req.query.handled !== undefined ? parseInt(req.query.handled, 10) : null;
  const from  = req.query.from ? parseInt(req.query.from, 10) : periodToMs('30d');
  const to    = req.query.to   ? parseInt(req.query.to, 10)   : Date.now();
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);

  const where = ['vi.client_id = ?', 'vi.created_at BETWEEN ? AND ?'];
  const args  = [clientId, from, to];

  if (category) { where.push('vi.category = ?'); args.push(category); }
  if (sentiment) { where.push('vi.sentiment = ?'); args.push(sentiment); }
  if (urgency)  { where.push('vi.urgency = ?'); args.push(urgency); }
  if (handled !== null) { where.push('vi.handled = ?'); args.push(handled); }

  const total = db.prepare(`
    SELECT COUNT(*) AS cnt FROM voc_insights vi
    WHERE ${where.join(' AND ')}
  `).get(...args).cnt;

  const insights = db.prepare(`
    SELECT vi.*, cu.name AS customer_name, c.id AS conv_id
    FROM voc_insights vi
    JOIN conversations c ON c.id = vi.conversation_id
    LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE ${where.join(' AND ')}
    ORDER BY vi.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...args, limit, offset);

  res.json({ total, insights, from, to, limit, offset });
});

// ─── POST /api/voc/analyze-now ───
router.post('/analyze-now', async (req, res) => {
  const sess = req.session;
  // admin 或業主都可觸發
  if (!sess) return res.status(401).json({ error: '需登入' });

  const clientId = sess.role === 'admin' && sess.client_id === null
    ? (req.query.client_id || req.body?.client_id ? parseInt(req.query.client_id || req.body?.client_id, 10) : null)
    : sess.client_id;

  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const since   = req.query.since || req.body?.since || null;
  const sinceMs = since ? parseInt(since, 10) : null;
  const batchSize = Math.min(parseInt(req.query.batch_size || req.body?.batch_size || '50', 10), 200);

  // 非同步執行，立即回應
  res.json({ ok: true, message: '批次分析已觸發，請稍後查看 /api/voc/topics' });

  // 背景跑
  setImmediate(async () => {
    try {
      const result = await runVocBatch(clientId, sinceMs, { batchSize });
      await recomputeVocTopics(clientId);
      log.info({ clientId, ...result }, 'analyze-now batch done');
    } catch (e) {
      log.error({ err: e.message, clientId }, 'analyze-now background error');
    }
  });
});

// ─── GET /api/voc/dashboard ───
router.get('/dashboard', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const period = req.query.period || '30d';
  const from   = periodToMs(period);
  const to     = Date.now();

  // 1. 基本數字
  const totalAnalyzed = db.prepare(`
    SELECT COUNT(*) AS cnt FROM voc_insights WHERE client_id = ? AND created_at BETWEEN ? AND ?
  `).get(clientId, from, to).cnt;

  const catCounts = db.prepare(`
    SELECT category, COUNT(*) AS cnt FROM voc_insights
    WHERE client_id = ? AND created_at BETWEEN ? AND ?
    GROUP BY category
  `).all(clientId, from, to);

  const catMap = {};
  for (const r of catCounts) catMap[r.category] = r.cnt;

  const sentimentCounts = db.prepare(`
    SELECT sentiment, COUNT(*) AS cnt FROM voc_insights
    WHERE client_id = ? AND created_at BETWEEN ? AND ?
    GROUP BY sentiment
  `).all(clientId, from, to);

  const sentMap = {};
  for (const r of sentimentCounts) sentMap[r.sentiment] = r.cnt;

  const highUrgency = db.prepare(`
    SELECT COUNT(*) AS cnt FROM voc_insights
    WHERE client_id = ? AND urgency = 'high' AND created_at BETWEEN ? AND ?
  `).get(clientId, from, to).cnt;

  // 2. TOP 10 主題
  const topTopics = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM voc_insights v WHERE v.client_id = t.client_id AND v.topic = t.topic AND v.sentiment = 'positive' AND v.created_at BETWEEN ? AND ?) AS pos_count,
      (SELECT COUNT(*) FROM voc_insights v WHERE v.client_id = t.client_id AND v.topic = t.topic AND v.sentiment = 'neutral'  AND v.created_at BETWEEN ? AND ?) AS neu_count,
      (SELECT COUNT(*) FROM voc_insights v WHERE v.client_id = t.client_id AND v.topic = t.topic AND v.sentiment = 'negative' AND v.created_at BETWEEN ? AND ?) AS neg_count
    FROM voc_topics t
    WHERE t.client_id = ?
    ORDER BY t.count DESC
    LIMIT 10
  `).all(from, to, from, to, from, to, clientId);

  // 3. 產品提及排行
  const productMentions = db.prepare(`
    SELECT product_mention,
      COUNT(*) AS total,
      SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) AS pos,
      SUM(CASE WHEN sentiment = 'negative' THEN 1 ELSE 0 END) AS neg
    FROM voc_insights
    WHERE client_id = ? AND product_mention IS NOT NULL AND created_at BETWEEN ? AND ?
    GROUP BY product_mention
    ORDER BY total DESC
  `).all(clientId, from, to);

  // 4. 最近抱怨列表（未處理優先）
  const complaints = db.prepare(`
    SELECT vi.*, cu.name AS customer_name
    FROM voc_insights vi
    JOIN conversations c ON c.id = vi.conversation_id
    LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE vi.client_id = ? AND vi.category = 'complaint'
      AND vi.created_at BETWEEN ? AND ?
    ORDER BY vi.handled ASC, vi.urgency DESC, vi.created_at DESC
    LIMIT 20
  `).all(clientId, from, to);

  // 5. 產品改進 signal（request 類）
  const productRequests = db.prepare(`
    SELECT topic, COUNT(*) AS cnt
    FROM voc_insights
    WHERE client_id = ? AND category = 'request' AND topic IS NOT NULL
      AND created_at BETWEEN ? AND ?
    GROUP BY topic
    ORDER BY cnt DESC
    LIMIT 10
  `).all(clientId, from, to);

  // 6. 每產品最常問的問題 + 最常讚美的
  const productDetails = {};
  for (const p of productMentions) {
    const topQuestion = db.prepare(`
      SELECT topic, COUNT(*) AS cnt FROM voc_insights
      WHERE client_id = ? AND product_mention = ? AND category = 'question' AND topic IS NOT NULL
        AND created_at BETWEEN ? AND ?
      GROUP BY topic ORDER BY cnt DESC LIMIT 1
    `).get(clientId, p.product_mention, from, to);

    const topPraise = db.prepare(`
      SELECT topic, COUNT(*) AS cnt FROM voc_insights
      WHERE client_id = ? AND product_mention = ? AND category = 'praise' AND topic IS NOT NULL
        AND created_at BETWEEN ? AND ?
      GROUP BY topic ORDER BY cnt DESC LIMIT 1
    `).get(clientId, p.product_mention, from, to);

    productDetails[p.product_mention] = {
      top_question: topQuestion?.topic || null,
      top_praise: topPraise?.topic || null,
    };
  }

  res.json({
    period,
    from,
    to,
    summary: {
      total_analyzed: totalAnalyzed,
      complaint_count: catMap['complaint'] || 0,
      praise_count:    catMap['praise'] || 0,
      request_count:   catMap['request'] || 0,
      question_count:  catMap['question'] || 0,
      product_feedback_count: catMap['product_feedback'] || 0,
      negative_count:  sentMap['negative'] || 0,
      positive_count:  sentMap['positive'] || 0,
      neutral_count:   sentMap['neutral'] || 0,
      high_urgency_count: highUrgency,
      complaint_ratio: totalAnalyzed > 0 ? Math.round((catMap['complaint'] || 0) / totalAnalyzed * 100) : 0,
      praise_ratio:    totalAnalyzed > 0 ? Math.round((catMap['praise'] || 0) / totalAnalyzed * 100) : 0,
      negative_ratio:  totalAnalyzed > 0 ? Math.round((sentMap['negative'] || 0) / totalAnalyzed * 100) : 0,
    },
    top_topics: topTopics,
    product_mentions: productMentions.map(p => ({
      ...p,
      details: productDetails[p.product_mention] || {},
    })),
    complaints,
    product_requests: productRequests,
  });
});

// ─── PATCH /api/voc/insights/:id/handled ───
router.patch('/insights/:id/handled', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const id      = parseInt(req.params.id, 10);
  const handled = req.body?.handled !== undefined ? (req.body.handled ? 1 : 0) : 1;

  const row = db.prepare('SELECT id FROM voc_insights WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!row) return res.status(404).json({ error: '找不到此筆洞察' });

  db.prepare('UPDATE voc_insights SET handled = ? WHERE id = ?').run(handled, id);
  res.json({ ok: true, id, handled });
});

export default router;
