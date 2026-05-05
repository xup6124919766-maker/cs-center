/**
 * routes/quiz.js — Quiz API endpoints
 *
 * 公開（不需登入）：
 *   POST /api/quiz/start
 *   POST /api/quiz/:token/answer
 *   GET  /api/quiz/:token
 *   POST /api/quiz/:token/recommend
 *
 * 需登入（admin/agent）：
 *   GET  /api/quiz/sessions
 *   GET  /api/quiz/stats
 */

import { Router } from 'express';
import {
  startQuiz, submitAnswer, getQuizSession, getRecommendation,
  listQuizSessions, getQuizStats, QUIZ_QUESTIONS,
} from '../lib/quiz.js';
import { requireAuth } from '../lib/auth.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'routes/quiz' });
const router = Router();

// ─── POST /api/quiz/start ───
// body 或 query: { client_id, channel_user_id?, source?, utm_source? }
router.post('/start', (req, res) => {
  const { client_id, channel_user_id, source, utm_source } = { ...req.query, ...req.body };
  const clientId = parseInt(client_id, 10);
  if (!clientId) return res.status(400).json({ error: '缺少 client_id' });

  try {
    const result = startQuiz({
      client_id: clientId,
      channel_user_id: channel_user_id || null,
      source: source || 'web',
      utm_source: utm_source || null,
    });
    res.json(result);
  } catch (e) {
    log.error({ err: e.message }, 'quiz start failed');
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/quiz/:token/answer ───
// body: { question_id, value }
router.post('/:token/answer', (req, res) => {
  const { token } = req.params;
  const { question_id, value } = req.body || {};
  if (!question_id || !value) return res.status(400).json({ error: '缺少 question_id 或 value' });

  try {
    const result = submitAnswer(token, question_id, value);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    log.error({ err: e.message, token }, 'quiz answer failed');
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/quiz/:token ───
router.get('/:token', (req, res) => {
  const { token } = req.params;
  // 避免衝到 /sessions 或 /stats
  if (token === 'sessions' || token === 'stats') return res.status(404).json({ error: 'not found' });

  const session = getQuizSession(token);
  if (!session) return res.status(404).json({ error: 'session 不存在' });
  res.json(session);
});

// ─── POST /api/quiz/:token/recommend ───
router.post('/:token/recommend', async (req, res) => {
  const { token } = req.params;
  try {
    const result = await getRecommendation(token);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    log.error({ err: e.message, token }, 'quiz recommend failed');
    res.status(500).json({ error: e.message });
  }
});

// ─── 以下需要登入 ───

// GET /api/quiz/sessions?client_id=&status=&limit=&offset=
router.get('/sessions', requireAuth, (req, res) => {
  const clientId = req.session.role === 'admin'
    ? parseInt(req.query.client_id, 10) || null
    : req.session.client_id;

  if (!clientId) return res.status(400).json({ error: '缺少 client_id' });

  const sessions = listQuizSessions({
    client_id: clientId,
    status: req.query.status || null,
    limit: parseInt(req.query.limit, 10) || 50,
    offset: parseInt(req.query.offset, 10) || 0,
  });
  res.json({ sessions });
});

// GET /api/quiz/stats?client_id=&from=&to=
router.get('/stats', requireAuth, (req, res) => {
  const clientId = req.session.role === 'admin'
    ? parseInt(req.query.client_id, 10) || null
    : req.session.client_id;

  if (!clientId) return res.status(400).json({ error: '缺少 client_id' });

  const stats = getQuizStats({
    client_id: clientId,
    from: parseInt(req.query.from, 10) || 0,
    to: req.query.to ? parseInt(req.query.to, 10) : null,
  });
  res.json(stats);
});

export default router;
