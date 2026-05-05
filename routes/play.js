/**
 * routes/play.js — 玩家公開 endpoints（不需登入）
 *
 * POST /api/play/check-in/:client_id?channel_user_id=&customer_id=
 * POST /api/play/:participation_id/share      body: { channel, customer_id, channel_user_id }
 * GET  /api/play/referral/:client_id?customer_id=
 * POST /api/play/referral/claim               body: { invite_code, channel_user_id, customer_id }
 * GET  /api/play/points/:client_id?customer_id=
 * GET  /api/leaderboard/global?client_id=
 * GET  /api/games/:id/leaderboard?client_id=  (無須登入版，供玩家頁用)
 */

import { Router } from 'express';
import { db } from '../lib/db.js';
import { addPoints, getPointsBalance, getActivityLeaderboard, getGlobalLeaderboard } from '../lib/game.js';
import { logger as rootLogger } from '../lib/logger.js';
import crypto from 'crypto';

const log = rootLogger.child({ module: 'routes/play' });
const router = Router();

// ─── 每日簽到積點規則 ───
const CHECKIN_POINTS = (streak) => {
  if (streak >= 30) return 100;
  if (streak >= 7)  return 20;
  return 5;
};

// ─── 簽到（POST /api/play/check-in/:client_id）───
router.post('/check-in/:client_id', (req, res) => {
  const clientId = parseInt(req.params.client_id, 10);
  const customerId = req.query.customer_id ? parseInt(req.query.customer_id, 10) : null;
  const channelUserId = req.query.channel_user_id || req.body?.channel_user_id || null;

  if (!customerId && !channelUserId) {
    return res.status(400).json({ error: '需提供 customer_id 或 channel_user_id' });
  }

  const now = Date.now();
  const DAY_MS = 86400000;
  const TWO_DAYS_MS = DAY_MS * 2;

  try {
    // 使用 customer_id 為主，channel_user_id 為輔
    if (customerId) {
      // 取現有紀錄
      let rec = db.prepare('SELECT * FROM check_ins WHERE client_id = ? AND customer_id = ?').get(clientId, customerId);

      if (rec) {
        // 24h 內已簽 → 拒絕
        if (now - rec.last_checkin_at < DAY_MS) {
          const nextAt = rec.last_checkin_at + DAY_MS;
          return res.json({
            ok: false,
            already_checked_today: true,
            next_checkin_at: nextAt,
            streak_days: rec.streak_days,
            total_days: rec.total_days,
            points_balance: getPointsBalance(clientId, customerId).balance,
          });
        }

        // 連續天數計算
        const streak = (now - rec.last_checkin_at < TWO_DAYS_MS) ? rec.streak_days + 1 : 1;
        const points = CHECKIN_POINTS(streak);

        db.prepare(`
          UPDATE check_ins SET streak_days = ?, total_days = total_days + 1, last_checkin_at = ?, points = points + ?, updated_at = ?
          WHERE client_id = ? AND customer_id = ?
        `).run(streak, now, points, now, clientId, customerId);

        addPoints(clientId, customerId, points, 'check_in');

        // 任務進度
        try {
          _progressTask(clientId, customerId, 'check_in_streak');
        } catch {}

        rec = db.prepare('SELECT * FROM check_ins WHERE client_id = ? AND customer_id = ?').get(clientId, customerId);
        return res.json({
          ok: true,
          streak_days: rec.streak_days,
          total_days: rec.total_days,
          points_earned: points,
          points_balance: getPointsBalance(clientId, customerId).balance,
        });

      } else {
        // 第一次簽到
        const points = CHECKIN_POINTS(1);
        db.prepare(`
          INSERT INTO check_ins (client_id, customer_id, streak_days, total_days, last_checkin_at, points, created_at)
          VALUES (?, ?, 1, 1, ?, ?, ?)
        `).run(clientId, customerId, now, points, now);
        addPoints(clientId, customerId, points, 'check_in');

        return res.json({
          ok: true,
          streak_days: 1,
          total_days: 1,
          points_earned: points,
          points_balance: getPointsBalance(clientId, customerId).balance,
        });
      }

    } else {
      // channel_user_id 版本
      let rec = db.prepare('SELECT * FROM check_ins_channel WHERE client_id = ? AND channel_user_id = ?').get(clientId, channelUserId);

      if (rec) {
        if (now - rec.last_checkin_at < DAY_MS) {
          return res.json({
            ok: false,
            already_checked_today: true,
            next_checkin_at: rec.last_checkin_at + DAY_MS,
            streak_days: rec.streak_days,
            total_days: rec.total_days,
            points_balance: rec.points,
          });
        }
        const streak = (now - rec.last_checkin_at < TWO_DAYS_MS) ? rec.streak_days + 1 : 1;
        const points = CHECKIN_POINTS(streak);
        db.prepare(`
          UPDATE check_ins_channel SET streak_days = ?, total_days = total_days + 1, last_checkin_at = ?, points = points + ?
          WHERE client_id = ? AND channel_user_id = ?
        `).run(streak, now, points, clientId, channelUserId);

        rec = db.prepare('SELECT * FROM check_ins_channel WHERE client_id = ? AND channel_user_id = ?').get(clientId, channelUserId);
        return res.json({ ok: true, streak_days: rec.streak_days, total_days: rec.total_days, points_earned: points, points_balance: rec.points });

      } else {
        const points = CHECKIN_POINTS(1);
        db.prepare(`
          INSERT INTO check_ins_channel (client_id, channel_user_id, streak_days, total_days, last_checkin_at, points, created_at)
          VALUES (?, ?, 1, 1, ?, ?, ?)
        `).run(clientId, channelUserId, now, points, now);
        return res.json({ ok: true, streak_days: 1, total_days: 1, points_earned: points, points_balance: points });
      }
    }
  } catch (e) {
    log.error({ err: e.message, client_id: clientId }, 'check-in failed');
    return res.status(500).json({ error: '簽到失敗，請稍後再試' });
  }
});

// ─── 取簽到資訊（GET /api/play/check-in/:client_id/status）───
router.get('/check-in/:client_id/status', (req, res) => {
  const clientId = parseInt(req.params.client_id, 10);
  const customerId = req.query.customer_id ? parseInt(req.query.customer_id, 10) : null;
  const channelUserId = req.query.channel_user_id || null;

  try {
    let rec = null;
    if (customerId) {
      rec = db.prepare('SELECT * FROM check_ins WHERE client_id = ? AND customer_id = ?').get(clientId, customerId);
    } else if (channelUserId) {
      rec = db.prepare('SELECT * FROM check_ins_channel WHERE client_id = ? AND channel_user_id = ?').get(clientId, channelUserId);
    }

    const now = Date.now();
    const checked_today = rec ? (now - rec.last_checkin_at < 86400000) : false;
    const balance = customerId ? getPointsBalance(clientId, customerId).balance : (rec?.points ?? 0);

    res.json({
      streak_days: rec?.streak_days ?? 0,
      total_days: rec?.total_days ?? 0,
      last_checkin_at: rec?.last_checkin_at ?? null,
      checked_today,
      points_balance: balance,
    });
  } catch (e) {
    log.error({ err: e.message }, 'check-in status failed');
    res.status(500).json({ error: '查詢失敗' });
  }
});

// ─── 中獎分享回饋（POST /api/play/:participation_id/share）───
router.post('/:participation_id/share', (req, res) => {
  const participationId = parseInt(req.params.participation_id, 10);
  const { channel, customer_id, channel_user_id } = req.body || {};

  if (!channel || !['line', 'fb', 'ig'].includes(channel)) {
    return res.status(400).json({ error: 'channel 必須是 line/fb/ig' });
  }
  if (!customer_id && !channel_user_id) {
    return res.status(400).json({ error: '需提供 customer_id 或 channel_user_id' });
  }

  const customerId = customer_id ? parseInt(customer_id, 10) : null;
  const now = Date.now();
  const SHARE_BONUS_POINTS = 20;
  const DAY_MS = 86400000;

  try {
    // 取 participation + activity
    const participation = db.prepare('SELECT * FROM participations WHERE id = ?').get(participationId);
    if (!participation) return res.status(404).json({ error: '參與紀錄不存在' });

    const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(participation.activity_id);
    if (!activity) return res.status(404).json({ error: '活動不存在' });
    if (!activity.share_bonus_enabled) return res.status(400).json({ error: '此活動未開啟分享回饋' });

    // 24h 同 channel 只能領一次
    const existing = db.prepare(`
      SELECT id FROM share_records
      WHERE participation_id = ? AND share_channel = ?
        AND (customer_id = ? OR channel_user_id = ?)
        AND created_at > ?
    `).get(participationId, channel, customerId ?? -1, channel_user_id ?? '', now - DAY_MS);

    if (existing) {
      return res.json({ ok: false, already_shared: true, message: '此頻道今日已領取分享獎勵' });
    }

    // 寫 share_records
    db.prepare(`
      INSERT INTO share_records (client_id, participation_id, customer_id, channel_user_id, share_channel, bonus_points, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(activity.client_id, participationId, customerId ?? null, channel_user_id ?? null, channel, SHARE_BONUS_POINTS, now);

    // 給點
    let balanceAfter = 0;
    if (customerId) {
      balanceAfter = addPoints(activity.client_id, customerId, SHARE_BONUS_POINTS, 'share_bonus', 'participation', participationId);
    }

    log.info({ participation_id: participationId, channel, customer_id: customerId, bonus: SHARE_BONUS_POINTS }, 'share bonus given');
    res.json({ ok: true, bonus_points: SHARE_BONUS_POINTS, balance_after: balanceAfter });

  } catch (e) {
    log.error({ err: e.message, participation_id: participationId }, 'share bonus failed');
    res.status(500).json({ error: '分享回饋失敗' });
  }
});

// ─── MGM：產生邀請連結（GET /api/play/referral/:client_id?customer_id=）───
router.get('/referral/:client_id', (req, res) => {
  const clientId = parseInt(req.params.client_id, 10);
  const customerId = req.query.customer_id ? parseInt(req.query.customer_id, 10) : null;
  if (!customerId) return res.status(400).json({ error: '需提供 customer_id' });

  try {
    // 查是否已有 pending 邀請碼
    let ref = db.prepare('SELECT * FROM referrals WHERE client_id = ? AND inviter_customer_id = ? AND status = ?')
      .get(clientId, customerId, 'pending');

    if (!ref) {
      const inviteCode = crypto.randomBytes(6).toString('hex').toUpperCase();
      db.prepare(`
        INSERT INTO referrals (client_id, inviter_customer_id, invite_code, status, reward_given, created_at)
        VALUES (?, ?, ?, 'pending', 0, ?)
      `).run(clientId, customerId, inviteCode, Date.now());
      ref = db.prepare('SELECT * FROM referrals WHERE invite_code = ?').get(inviteCode);
    }

    const inviteUrl = `${req.protocol}://${req.get('host')}/play/check-in.html?ref=${ref.invite_code}&client_id=${clientId}`;
    const inviteCount = db.prepare('SELECT COUNT(*) AS cnt FROM referrals WHERE client_id = ? AND inviter_customer_id = ? AND status = ?')
      .get(clientId, customerId, 'completed').cnt;

    res.json({
      invite_code: ref.invite_code,
      invite_url: inviteUrl,
      completed_invites: inviteCount,
      points_per_invite: 100,
    });
  } catch (e) {
    log.error({ err: e.message }, 'referral get failed');
    res.status(500).json({ error: '產生邀請連結失敗' });
  }
});

// ─── MGM：兌換邀請（POST /api/play/referral/claim）───
router.post('/referral/claim', (req, res) => {
  const { invite_code, channel_user_id, customer_id } = req.body || {};
  if (!invite_code) return res.status(400).json({ error: '需提供 invite_code' });
  if (!customer_id && !channel_user_id) return res.status(400).json({ error: '需提供 customer_id 或 channel_user_id' });

  const inviteeCustomerId = customer_id ? parseInt(customer_id, 10) : null;

  try {
    const ref = db.prepare('SELECT * FROM referrals WHERE invite_code = ?').get(invite_code);
    if (!ref) return res.status(404).json({ error: '邀請碼不存在' });
    if (ref.status === 'completed') return res.json({ ok: false, message: '邀請碼已被使用' });
    if (inviteeCustomerId && ref.inviter_customer_id === inviteeCustomerId) {
      return res.json({ ok: false, message: '不能邀請自己' });
    }

    const now = Date.now();

    // 更新邀請紀錄
    db.prepare(`
      UPDATE referrals SET status = 'completed', invitee_customer_id = ?, reward_given = 1, completed_at = ?
      WHERE invite_code = ?
    `).run(inviteeCustomerId ?? null, now, invite_code);

    // 雙方各得 100 點（invitee 需有 customer_id）
    const REWARD_POINTS = 100;
    addPoints(ref.client_id, ref.inviter_customer_id, REWARD_POINTS, 'mgm_invite', 'referral', ref.id);
    if (inviteeCustomerId) {
      addPoints(ref.client_id, inviteeCustomerId, REWARD_POINTS, 'mgm_invited', 'referral', ref.id);
    }

    // 邀請任務進度（邀請人）
    try {
      _progressTask(ref.client_id, ref.inviter_customer_id, 'invite_friend');
    } catch {}

    log.info({ invite_code, inviter: ref.inviter_customer_id, invitee: inviteeCustomerId }, 'referral completed');
    res.json({ ok: true, inviter_bonus: REWARD_POINTS, invitee_bonus: inviteeCustomerId ? REWARD_POINTS : 0 });

  } catch (e) {
    log.error({ err: e.message, invite_code }, 'referral claim failed');
    res.status(500).json({ error: '邀請兌換失敗' });
  }
});

// ─── 點數查詢（GET /api/play/points/:client_id?customer_id=）───
router.get('/points/:client_id', (req, res) => {
  const clientId = parseInt(req.params.client_id, 10);
  const customerId = req.query.customer_id ? parseInt(req.query.customer_id, 10) : null;
  if (!customerId) return res.status(400).json({ error: '需提供 customer_id' });

  const acct = getPointsBalance(clientId, customerId);
  const txns = db.prepare(`
    SELECT * FROM points_transactions
    WHERE client_id = ? AND customer_id = ?
    ORDER BY created_at DESC LIMIT 20
  `).all(clientId, customerId);

  res.json({ ...acct, transactions: txns });
});

// ─── 公開排行榜（GET /api/leaderboard/global?client_id=）───
router.get('/leaderboard/global', (req, res) => {
  const clientId = req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  if (!clientId) return res.status(400).json({ error: '需提供 client_id' });
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const leaderboard = getGlobalLeaderboard(clientId, limit);
  res.json({ client_id: clientId, leaderboard });
});

// ─── 公開：活動排行榜（GET /api/play/leaderboard/:activity_id）───
router.get('/leaderboard/:activity_id', (req, res) => {
  const activityId = parseInt(req.params.activity_id, 10);
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
  const leaderboard = getActivityLeaderboard(activityId, limit);
  res.json({ activity_id: activityId, leaderboard });
});

export default router;
