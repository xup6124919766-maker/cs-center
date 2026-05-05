/**
 * game.js — 互動遊戲抽獎引擎 v2
 *
 * drawPrizes(activity_id, opts, times) — 連抽 + 保底機制
 * drawPrize(activity_id, opts)          — 向下相容包裝（times=1）
 * getActivity / listActivities / getActivityPrizes / getActivityStats
 * ensureGameSchema()                    — 建表 + migration
 * addPoints / getPointsBalance          — 點數帳戶操作
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'game' });

// ─── safeAlter helper ───
const safeAlter = (sql) => {
  try { db.exec(sql); } catch (e) {
    if (!e.message?.includes('duplicate column')) throw e;
  }
};

// ─── Schema Migration ───
export const ensureGameSchema = () => {
  // 基礎表（保持原本）
  db.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      start_at INTEGER,
      end_at INTEGER,
      config TEXT,
      participation_limit_per_user INTEGER DEFAULT 1,
      total_quota INTEGER,
      total_participations INTEGER DEFAULT 0,
      auto_tag_winner TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS prizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      probability REAL NOT NULL,
      quota INTEGER,
      remaining INTEGER,
      coupon_code TEXT,
      display_order INTEGER DEFAULT 0,
      FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS participations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL,
      customer_id INTEGER,
      channel_user_id TEXT,
      prize_id INTEGER,
      is_winner INTEGER DEFAULT 0,
      ip TEXT,
      user_agent TEXT,
      redeemed_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE INDEX IF NOT EXISTS idx_participations_activity ON participations(activity_id, customer_id);
  `);

  // ─── 進階欄位 migration（activities 表）───
  safeAlter('ALTER TABLE activities ADD COLUMN draws_per_participation INTEGER DEFAULT 1');
  safeAlter('ALTER TABLE activities ADD COLUMN guaranteed_after INTEGER');
  safeAlter('ALTER TABLE activities ADD COLUMN vip_multiplier REAL DEFAULT 1.0');
  safeAlter('ALTER TABLE activities ADD COLUMN share_bonus_enabled INTEGER DEFAULT 0');
  safeAlter('ALTER TABLE activities ADD COLUMN time_window_seconds INTEGER');
  safeAlter('ALTER TABLE activities ADD COLUMN max_winners INTEGER');
  safeAlter('ALTER TABLE activities ADD COLUMN cover_image_url TEXT');
  safeAlter('ALTER TABLE activities ADD COLUMN sound_effect TEXT');

  // ─── 新表：每日簽到 ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS check_ins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      customer_id INTEGER,
      channel_user_id TEXT,
      streak_days INTEGER DEFAULT 1,
      total_days INTEGER DEFAULT 1,
      last_checkin_at INTEGER,
      points INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      UNIQUE(client_id, customer_id)
    );

    CREATE TABLE IF NOT EXISTS check_ins_channel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      channel_user_id TEXT NOT NULL,
      streak_days INTEGER DEFAULT 1,
      total_days INTEGER DEFAULT 1,
      last_checkin_at INTEGER,
      points INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(client_id, channel_user_id)
    );
  `);

  // ─── 新表：點數帳戶 ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS points_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      balance INTEGER DEFAULT 0,
      total_earned INTEGER DEFAULT 0,
      total_spent INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      UNIQUE(client_id, customer_id)
    );

    CREATE TABLE IF NOT EXISTS points_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      balance_after INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pts_txn_customer ON points_transactions(customer_id, client_id, created_at DESC);
  `);

  // ─── 新表：分享回饋 ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      participation_id INTEGER,
      customer_id INTEGER,
      channel_user_id TEXT,
      share_channel TEXT,
      bonus_points INTEGER DEFAULT 0,
      bonus_extra_draw INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);

  // ─── 新表：MGM 邀請 ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      inviter_customer_id INTEGER NOT NULL,
      invitee_customer_id INTEGER,
      invite_code TEXT UNIQUE,
      status TEXT DEFAULT 'pending',
      reward_given INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `);

  // ─── 新表：集點任務 ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      task_type TEXT,
      target INTEGER,
      reward_points INTEGER,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      progress INTEGER DEFAULT 0,
      completed_at INTEGER,
      reward_given INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(task_id, customer_id)
    );
  `);

  // ─── Seed 梵森預設任務 ───
  _seedDefaultTasks();

  log.info('game schema v2 ready');
};

// ─── 梵森預設任務 seed ───
const _seedDefaultTasks = () => {
  try {
    const vansen = db.prepare("SELECT id FROM clients WHERE name = 'vansen'").get();
    if (!vansen) return;
    const existing = db.prepare('SELECT COUNT(*) AS cnt FROM tasks WHERE client_id = ?').get(vansen.id);
    if (existing.cnt > 0) return;
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO tasks (client_id, name, description, task_type, target, reward_points, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `);
    stmt.run(vansen.id, '連續簽到 7 天', '連續簽到滿 7 天獲得獎勵', 'check_in_streak', 7, 100, now);
    stmt.run(vansen.id, '邀請朋友', '邀請朋友加好友獲得獎勵', 'invite_friend', 1, 200, now);
    stmt.run(vansen.id, '玩抽獎一次', '參與任一抽獎活動', 'play_game', 1, 10, now);
    stmt.run(vansen.id, '完成購買', '完成一筆訂單', 'place_order', 1, 500, now);
    log.info({ client_id: vansen.id }, '已 seed 梵森預設任務');
  } catch (e) {
    log.warn({ err: e.message }, '_seedDefaultTasks failed');
  }
};

// ─── Helpers ───
export const getActivity = (activityId, clientId = null) => {
  if (clientId) {
    return db.prepare('SELECT * FROM activities WHERE id = ? AND client_id = ?').get(activityId, clientId);
  }
  return db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
};

export const listActivities = (clientId) =>
  db.prepare('SELECT * FROM activities WHERE client_id = ? ORDER BY created_at DESC').all(clientId);

export const getActivityPrizes = (activityId) =>
  db.prepare('SELECT * FROM prizes WHERE activity_id = ? ORDER BY display_order ASC').all(activityId);

// ─── 點數操作 ───
export const addPoints = (clientId, customerId, amount, reason, refType = null, refId = null) => {
  if (!customerId || amount === 0) return null;
  const now = Date.now();
  // upsert points_accounts
  db.prepare(`
    INSERT INTO points_accounts (client_id, customer_id, balance, total_earned, total_spent, updated_at)
    VALUES (?, ?, 0, 0, 0, ?)
    ON CONFLICT(client_id, customer_id) DO NOTHING
  `).run(clientId, customerId, now);

  if (amount > 0) {
    db.prepare(`
      UPDATE points_accounts
      SET balance = balance + ?, total_earned = total_earned + ?, updated_at = ?
      WHERE client_id = ? AND customer_id = ?
    `).run(amount, amount, now, clientId, customerId);
  } else {
    db.prepare(`
      UPDATE points_accounts
      SET balance = MAX(0, balance + ?), total_spent = total_spent + ?, updated_at = ?
      WHERE client_id = ? AND customer_id = ?
    `).run(amount, Math.abs(amount), now, clientId, customerId);
  }

  const acct = db.prepare('SELECT balance FROM points_accounts WHERE client_id = ? AND customer_id = ?').get(clientId, customerId);
  const balanceAfter = acct?.balance ?? 0;

  db.prepare(`
    INSERT INTO points_transactions (customer_id, client_id, amount, reason, ref_type, ref_id, balance_after, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(customerId, clientId, amount, reason, refType, refId, balanceAfter, now);

  return balanceAfter;
};

export const getPointsBalance = (clientId, customerId) => {
  const acct = db.prepare('SELECT * FROM points_accounts WHERE client_id = ? AND customer_id = ?').get(clientId, customerId);
  return acct ?? { balance: 0, total_earned: 0, total_spent: 0 };
};

// ─── 核心抽獎引擎（多抽 + 保底）───
export const drawPrizes = (activityId, {
  customer_id = null,
  channel_user_id = null,
  ip = null,
  user_agent = null,
  times = 1,
} = {}) => {
  const now = Date.now();

  // 1. 取活動
  const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
  if (!activity) return { ok: false, error: '活動不存在' };
  if (activity.status !== 'active') return { ok: false, error: '活動不在進行中' };
  if (activity.start_at && now < activity.start_at) return { ok: false, error: '活動尚未開始' };
  if (activity.end_at && now > activity.end_at) return { ok: false, error: '活動已結束' };

  // 限時視窗檢查（time_window_seconds）
  if (activity.time_window_seconds && activity.start_at) {
    const windowEnd = activity.start_at + activity.time_window_seconds * 1000;
    if (now > windowEnd) {
      // 自動結束
      db.prepare("UPDATE activities SET status = 'ended', updated_at = ? WHERE id = ?").run(now, activityId);
      return { ok: false, error: '限時活動已結束' };
    }
  }

  // 2. 總名額檢查
  if (activity.total_quota !== null && activity.total_participations >= activity.total_quota) {
    return { ok: false, error: '活動名額已滿' };
  }

  // 限量名額（max_winners）
  if (activity.max_winners !== null && activity.max_winners !== undefined) {
    const winnerCount = db.prepare('SELECT COUNT(*) AS cnt FROM participations WHERE activity_id = ? AND is_winner = 1').get(activityId).cnt;
    if (winnerCount >= activity.max_winners) {
      db.prepare("UPDATE activities SET status = 'ended', updated_at = ? WHERE id = ?").run(now, activityId);
      return { ok: false, error: '中獎名額已滿' };
    }
  }

  // 3. VIP 加成：取顧客 lifecycle_stage
  let vipMultiplier = 1.0;
  if (customer_id && activity.vip_multiplier && activity.vip_multiplier !== 1.0) {
    try {
      const cust = db.prepare('SELECT lifecycle_stage FROM customers WHERE id = ?').get(customer_id);
      if (cust?.lifecycle_stage === 'vip') {
        vipMultiplier = activity.vip_multiplier;
      }
    } catch {}
  }

  // 4. 確定本次幾抽
  const drawTimes = Math.max(1, Math.min(times || activity.draws_per_participation || 1, 50));

  let results = [];
  let lastParticipationId = null;

  try {
    db.exec('BEGIN IMMEDIATE');

    // 4a. 檢查參與次數上限
    if (activity.participation_limit_per_user > 0) {
      let existingCount = 0;
      if (customer_id) {
        existingCount = db.prepare(
          'SELECT COUNT(*) AS cnt FROM participations WHERE activity_id = ? AND customer_id = ?'
        ).get(activityId, customer_id).cnt;
      } else if (channel_user_id) {
        existingCount = db.prepare(
          'SELECT COUNT(*) AS cnt FROM participations WHERE activity_id = ? AND channel_user_id = ?'
        ).get(activityId, channel_user_id).cnt;
      }
      // 每抽一次算一次參與，不同次 drawPrizes 呼叫要累加
      if (existingCount >= activity.participation_limit_per_user) {
        db.exec('ROLLBACK');
        return { ok: false, error: `每人限抽 ${activity.participation_limit_per_user} 次` };
      }
    }

    // 4b. 撈可用獎項
    const prizes = db.prepare(
      'SELECT * FROM prizes WHERE activity_id = ? AND (remaining > 0 OR quota IS NULL) ORDER BY display_order ASC'
    ).all(activityId);

    if (!prizes.length) {
      db.exec('ROLLBACK');
      return { ok: false, error: '活動無可用獎項' };
    }

    // 4c. 找最高機率獎項（保底排除用）
    const maxProbPrize = prizes.reduce((a, b) => b.probability > a.probability ? b : a, prizes[0]);

    for (let i = 0; i < drawTimes; i++) {
      const drawIndex = i + 1; // 第幾抽（1-based）
      const isGuaranteed = activity.guaranteed_after && drawIndex === activity.guaranteed_after;

      let wonPrize = null;

      if (isGuaranteed) {
        // 保底：強制從非最高機率獎中隨機選一個
        const candidates = prizes.filter(p => p.id !== maxProbPrize.id && (p.remaining > 0 || p.quota === null));
        if (candidates.length) {
          wonPrize = candidates[Math.floor(Math.random() * candidates.length)];
        } else {
          wonPrize = maxProbPrize; // fallback
        }
      } else {
        // 正常抽：累計機率 + VIP 加成
        let rand = Math.random();
        let cumulative = 0;
        for (const prize of prizes) {
          let prob = prize.probability;
          // VIP 加成：非銘謝惠顧的獎項才乘倍率
          if (vipMultiplier !== 1.0 && prob < 0.9) {
            prob = Math.min(prob * vipMultiplier, 0.95);
          }
          cumulative += prob;
          if (rand <= cumulative) {
            wonPrize = prize;
            break;
          }
        }
      }

      // 扣 remaining
      if (wonPrize && wonPrize.quota !== null) {
        const fresh = db.prepare('SELECT remaining FROM prizes WHERE id = ?').get(wonPrize.id);
        if (!fresh || fresh.remaining <= 0) {
          wonPrize = null;
        } else {
          db.prepare('UPDATE prizes SET remaining = remaining - 1 WHERE id = ? AND remaining > 0').run(wonPrize.id);
        }
      }

      // 記錄參與
      const participationId = db.prepare(`
        INSERT INTO participations (activity_id, customer_id, channel_user_id, prize_id, is_winner, ip, user_agent, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        activityId,
        customer_id ?? null,
        channel_user_id ?? null,
        wonPrize?.id ?? null,
        wonPrize ? 1 : 0,
        ip ?? null,
        user_agent ?? null,
        now + i // 避免同 ms 完全相同
      ).lastInsertRowid;

      lastParticipationId = participationId;

      // 累計 total_participations
      db.prepare('UPDATE activities SET total_participations = total_participations + 1, updated_at = ? WHERE id = ?').run(now, activityId);

      // 中獎自動貼標
      if (wonPrize && activity.auto_tag_winner && customer_id) {
        try {
          const cust = db.prepare('SELECT tags FROM customers WHERE id = ?').get(customer_id);
          if (cust) {
            let tags = [];
            try { tags = JSON.parse(cust.tags || '[]'); } catch {}
            if (!tags.includes(activity.auto_tag_winner)) {
              tags.push(activity.auto_tag_winner);
              db.prepare('UPDATE customers SET tags = ?, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(tags), now, customer_id);
            }
          }
        } catch {}
      }

      results.push({
        won: !!wonPrize,
        prize: wonPrize ? {
          id: wonPrize.id,
          name: wonPrize.name,
          description: wonPrize.description,
          image_url: wonPrize.image_url,
          coupon_code: wonPrize.coupon_code,
        } : null,
        participation_id: Number(participationId),
        draw_index: drawIndex,
        is_guaranteed: isGuaranteed,
      });
    }

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    log.error({ err: e.message, activity_id: activityId }, 'drawPrizes transaction failed');
    return { ok: false, error: '抽獎發生錯誤，請稍後再試' };
  }

  // 中獎後給玩遊戲任務點數（非同步，不影響主流程）
  if (customer_id) {
    try {
      const clientId = activity.client_id;
      _progressTask(clientId, customer_id, 'play_game');
    } catch {}
  }

  const anyWon = results.some(r => r.won);
  log.info({ activity_id: activityId, times: drawTimes, any_won: anyWon }, 'drawPrizes result');

  return {
    ok: true,
    draws: results,
    // 向下相容欄位（單抽）
    won: results[0]?.won ?? false,
    prize: results[0]?.prize ?? null,
    participation_id: results[0]?.participation_id ?? null,
  };
};

// ─── 向下相容：單抽包裝 ───
export const drawPrize = (activityId, opts = {}) => {
  return drawPrizes(activityId, { ...opts, times: 1 });
};

// ─── 任務進度更新（內部用）───
const _progressTask = (clientId, customerId, taskType, delta = 1) => {
  const tasks = db.prepare(
    "SELECT * FROM tasks WHERE client_id = ? AND task_type = ? AND enabled = 1"
  ).all(clientId, taskType);

  for (const task of tasks) {
    // upsert task_completion
    db.prepare(`
      INSERT INTO task_completions (task_id, customer_id, client_id, progress, created_at)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(task_id, customer_id) DO NOTHING
    `).run(task.id, customerId, clientId, Date.now());

    const comp = db.prepare('SELECT * FROM task_completions WHERE task_id = ? AND customer_id = ?')
      .get(task.id, customerId);
    if (!comp || comp.reward_given) continue;

    const newProgress = (comp.progress || 0) + delta;
    if (newProgress >= task.target) {
      // 完成
      db.prepare(`
        UPDATE task_completions SET progress = ?, completed_at = ?, reward_given = 1
        WHERE task_id = ? AND customer_id = ?
      `).run(newProgress, Date.now(), task.id, customerId);
      // 給點
      addPoints(clientId, customerId, task.reward_points, 'task_complete', 'task', task.id);
      log.info({ task_id: task.id, customer_id: customerId, points: task.reward_points }, '任務完成');
    } else {
      db.prepare('UPDATE task_completions SET progress = ? WHERE task_id = ? AND customer_id = ?')
        .run(newProgress, task.id, customerId);
    }
  }
};

export { _progressTask };

// ─── 統計 ───
export const getActivityStats = (activityId) => {
  const total = db.prepare('SELECT COUNT(*) AS cnt FROM participations WHERE activity_id = ?').get(activityId).cnt;
  const winners = db.prepare('SELECT COUNT(*) AS cnt FROM participations WHERE activity_id = ? AND is_winner = 1').get(activityId).cnt;
  const byPrize = db.prepare(`
    SELECT p.name, COUNT(pa.id) AS count
    FROM prizes p
    LEFT JOIN participations pa ON pa.prize_id = p.id
    WHERE p.activity_id = ?
    GROUP BY p.id, p.name
  `).all(activityId);

  return { total_participations: total, total_winners: winners, prize_distribution: byPrize };
};

// ─── 排行榜 ───
export const getActivityLeaderboard = (activityId, limit = 10) => {
  return db.prepare(`
    SELECT
      pa.customer_id,
      pa.channel_user_id,
      cu.name AS customer_name,
      cc.channel_avatar_url AS avatar_url,
      pr.name AS prize_name,
      pr.image_url AS prize_image,
      pa.created_at
    FROM participations pa
    LEFT JOIN prizes pr ON pr.id = pa.prize_id
    LEFT JOIN customers cu ON cu.id = pa.customer_id
    LEFT JOIN customer_channels cc ON cc.customer_id = pa.customer_id
    WHERE pa.activity_id = ? AND pa.is_winner = 1
    ORDER BY pa.created_at DESC
    LIMIT ?
  `).all(activityId, limit);
};

export const getGlobalLeaderboard = (clientId, limit = 20) => {
  return db.prepare(`
    SELECT
      pa.customer_id,
      cu.name AS customer_name,
      cc.channel_avatar_url AS avatar_url,
      COUNT(pa.id) AS total_wins,
      COUNT(DISTINCT pa.activity_id) AS activities_count,
      MAX(pa.created_at) AS last_win_at
    FROM participations pa
    LEFT JOIN activities a ON a.id = pa.activity_id
    LEFT JOIN customers cu ON cu.id = pa.customer_id
    LEFT JOIN customer_channels cc ON cc.customer_id = pa.customer_id
    WHERE a.client_id = ? AND pa.is_winner = 1 AND pa.customer_id IS NOT NULL
    GROUP BY pa.customer_id
    ORDER BY total_wins DESC, last_win_at DESC
    LIMIT ?
  `).all(clientId, limit);
};

// ─── 剩餘名額計算 ───
export const getActivityRemaining = (activityId) => {
  const activity = db.prepare('SELECT max_winners, total_participations, total_quota, time_window_seconds, start_at, status FROM activities WHERE id = ?').get(activityId);
  if (!activity) return null;
  let remaining_winners = null;
  if (activity.max_winners !== null && activity.max_winners !== undefined) {
    const winnerCount = db.prepare('SELECT COUNT(*) AS cnt FROM participations WHERE activity_id = ? AND is_winner = 1').get(activityId).cnt;
    remaining_winners = Math.max(0, activity.max_winners - winnerCount);
  }
  let time_remaining_seconds = null;
  if (activity.time_window_seconds && activity.start_at) {
    const windowEnd = activity.start_at + activity.time_window_seconds * 1000;
    time_remaining_seconds = Math.max(0, Math.floor((windowEnd - Date.now()) / 1000));
  }
  return { remaining_winners, time_remaining_seconds };
};

export default { drawPrize, drawPrizes, getActivity, listActivities, getActivityPrizes, getActivityStats, getActivityLeaderboard, getGlobalLeaderboard, getActivityRemaining, addPoints, getPointsBalance, ensureGameSchema };
