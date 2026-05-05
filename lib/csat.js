/**
 * lib/csat.js — 客服個人 CSAT 輔助工具
 *
 * resolvePrimaryAgent(conversation_id)
 *   1. 先取 assigned_user_id（已指派）
 *   2. 沒有 → 找發出最多 outbound agent 訊息的 user
 *   3. 還是沒有 → 回 null
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'csat' });

/**
 * @param {number} conversationId
 * @returns {{ user_id: number|null, username: string|null, source: 'assigned'|'most_messages'|'unknown' }}
 */
export const resolvePrimaryAgent = (conversationId) => {
  // 1. 取對話資料
  const conv = db.prepare('SELECT id, assigned_user_id, client_id FROM conversations WHERE id = ?').get(conversationId);
  if (!conv) return { user_id: null, username: null, source: 'unknown' };

  // 2. 優先用 assigned_user_id
  if (conv.assigned_user_id) {
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(conv.assigned_user_id);
    if (user) {
      log.debug({ conversation_id: conversationId, user_id: user.id, source: 'assigned' }, '主責客服：指派欄位');
      return { user_id: user.id, username: user.username, source: 'assigned' };
    }
  }

  // 3. 找發最多 outbound 訊息的 agent
  const topAgent = db.prepare(`
    SELECT sender_id, COUNT(*) AS cnt
    FROM messages
    WHERE conversation_id = ?
      AND direction = 'outbound'
      AND sender_type = 'agent'
      AND sender_id IS NOT NULL
    GROUP BY sender_id
    ORDER BY cnt DESC
    LIMIT 1
  `).get(conversationId);

  if (topAgent) {
    const userId = parseInt(topAgent.sender_id, 10);
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
    if (user) {
      log.debug({ conversation_id: conversationId, user_id: user.id, cnt: topAgent.cnt, source: 'most_messages' }, '主責客服：訊息最多');
      return { user_id: user.id, username: user.username, source: 'most_messages' };
    }
  }

  log.debug({ conversation_id: conversationId }, '找不到主責客服');
  return { user_id: null, username: null, source: 'unknown' };
};
