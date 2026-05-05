/**
 * routes/brand_coach.js — 品牌教練 AI 路由
 *
 * POST   /api/brand-coach/score                    即時評分（可選擇是否存 DB）
 * GET    /api/brand-coach/leaderboard              排行榜
 * GET    /api/brand-coach/scores/:user_id          個人歷史評分
 * POST   /api/brand-coach/scores/:id/apply-rewrite 標記採用改寫
 */

import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';
import { scoreMessage, getLeaderboard, getUserScores, markApplied } from '../lib/brand_coach.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'route:brand_coach' });

const router = Router();

// ─── 所有路由都需要登入 ───
router.use(requireAuth);

// ─── POST /api/brand-coach/score ───
// body: { content, conversation_id?, message_id?, save? }
// save 預設 true；即時輸入框評分可傳 save:false 節省 DB 寫入
router.post('/score', async (req, res) => {
  const { content, conversation_id, message_id, save = true } = req.body;
  const clientId = req.session?.client_id || req.user?.client_id;
  const userId   = req.session?.user_id   || req.user?.id;

  if (!clientId || !userId) return res.status(403).json({ error: '未授權' });
  if (!content || !content.trim()) return res.status(400).json({ error: '訊息內容不能為空' });

  try {
    const result = await scoreMessage({
      client_id: clientId,
      user_id: userId,
      content: content.trim(),
      conversation_id: conversation_id || null,
      message_id: message_id || null,
      save: Boolean(save),
    });

    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.json(result);
  } catch (e) {
    log.error({ err: e.message }, 'brand-coach score error');
    return res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/brand-coach/leaderboard ───
// query: client_id?, from?, to?
router.get('/leaderboard', (req, res) => {
  const clientId = req.query.client_id || req.session?.client_id || req.user?.client_id;
  if (!clientId) return res.status(400).json({ error: '缺少 client_id' });

  const from = req.query.from ? parseInt(req.query.from) : Date.now() - 30 * 86400000;
  const to   = req.query.to   ? parseInt(req.query.to)   : Date.now();

  try {
    const rows = getLeaderboard({ client_id: clientId, from, to });
    return res.json({ ok: true, leaderboard: rows });
  } catch (e) {
    log.error({ err: e.message }, 'brand-coach leaderboard error');
    return res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/brand-coach/scores/:user_id ───
// query: from?, to?, limit?
router.get('/scores/:user_id', (req, res) => {
  const clientId = req.session?.client_id || req.user?.client_id;
  const selfId   = req.session?.user_id   || req.user?.id;
  const targetId = parseInt(req.params.user_id, 10);

  if (!clientId) return res.status(403).json({ error: '未授權' });

  // 非 admin 只能查自己
  const isAdmin = req.session?.role === 'admin' || req.user?.role === 'admin';
  if (!isAdmin && selfId !== targetId) {
    return res.status(403).json({ error: '只能查詢自己的評分記錄' });
  }

  const from  = req.query.from  ? parseInt(req.query.from)  : Date.now() - 30 * 86400000;
  const to    = req.query.to    ? parseInt(req.query.to)    : Date.now();
  const limit = req.query.limit ? parseInt(req.query.limit) : 50;

  try {
    const scores = getUserScores({ client_id: clientId, user_id: targetId, from, to, limit });
    // 反序列化 scores_breakdown
    const parsed = scores.map(s => ({
      ...s,
      scores_breakdown: (() => { try { return JSON.parse(s.scores_breakdown || '{}'); } catch { return {}; } })(),
    }));
    return res.json({ ok: true, scores: parsed });
  } catch (e) {
    log.error({ err: e.message }, 'brand-coach scores error');
    return res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/brand-coach/scores/:id/apply-rewrite ───
router.post('/scores/:id/apply-rewrite', (req, res) => {
  const clientId = req.session?.client_id || req.user?.client_id;
  if (!clientId) return res.status(403).json({ error: '未授權' });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '無效 id' });

  try {
    markApplied({ id, client_id: clientId });
    return res.json({ ok: true });
  } catch (e) {
    log.error({ err: e.message }, 'brand-coach apply-rewrite error');
    return res.status(500).json({ error: e.message });
  }
});

export default router;
