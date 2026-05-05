/**
 * lib/post_reply.js — 貼文留言自動回覆 DM
 *
 * processComment(clientId, channel, comment) → 評估規則 → 發 DM → 寫 post_replies
 *
 * 支援通道：
 *   FB:  POST /webhook/fb/:client_id 接到 changes[].field === 'feed' & item === 'comment'
 *   IG:  POST /webhook/ig/:client_id 接到 changes[].field === 'comments'
 *
 * TODO: FB/IG comment webhook 目前為 stub，等 Meta App 配置好後接入
 * TODO: FB 回覆留言 API (POST /{comment-id}/replies) 待測試，需確認 page token 有 publish_pages 權限
 * TODO: IG 回覆留言 API 需確認 IG Graph API 版本
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';
import { emitToClient } from './realtime.js';
import { recordBilling } from './billing.js';

const log = rootLogger.child({ module: 'post_reply' });

// ─── Schema ───
export const ensurePostReplySchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS post_replies (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id         INTEGER NOT NULL,
      channel           TEXT NOT NULL,
      post_id           TEXT,
      comment_id        TEXT,
      commenter_id      TEXT,
      comment_text      TEXT,
      matched_rule_id   INTEGER,
      action_taken      TEXT,
      dm_message_id     INTEGER,
      created_at        INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id),
      FOREIGN KEY (matched_rule_id) REFERENCES automation_rules(id)
    );
    CREATE INDEX IF NOT EXISTS idx_post_replies_client ON post_replies(client_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_post_replies_comment ON post_replies(comment_id);
  `);
  log.info('post_replies schema ready');
};

// ─── keyword 比對（複用 rules.js 的邏輯）───
const matchKeywords = (text, trigger) => {
  if (!text || !trigger?.keywords?.length) return false;
  const haystack = text.toLowerCase();
  const keywords = trigger.keywords.map(k => k.toLowerCase());
  if (trigger.match_type === 'all') {
    return keywords.every(k => haystack.includes(k));
  }
  return keywords.some(k => haystack.includes(k));
};

// ─── 核心處理函式 ───
/**
 * @param {number} clientId
 * @param {'fb'|'ig'} channel
 * @param {{ comment_id, post_id, commenter_id, text, timestamp }} comment
 */
export const processComment = async (clientId, channel, comment) => {
  const { comment_id, post_id, commenter_id, text = '' } = comment;

  if (!comment_id || !commenter_id) {
    log.warn({ client_id: clientId, channel }, 'processComment: 缺少 comment_id 或 commenter_id');
    return;
  }

  // 防重複觸發（同一則留言可能被 webhook 送多次）
  const existing = db.prepare('SELECT id FROM post_replies WHERE comment_id = ? AND client_id = ?').get(comment_id, clientId);
  if (existing) {
    log.debug({ comment_id }, 'comment 已處理過，略過');
    return;
  }

  // 拉 comment_to_dm 規則
  const rules = db.prepare(`
    SELECT * FROM automation_rules
    WHERE client_id = ? AND enabled = 1 AND rule_type = 'comment_to_dm'
    ORDER BY priority DESC, id ASC
  `).all(clientId);

  if (!rules.length) {
    log.debug({ client_id: clientId }, 'no comment_to_dm rules');
    return;
  }

  let matchedRule = null;

  for (const rule of rules) {
    let trigger;
    try { trigger = JSON.parse(rule.trigger || '{}'); } catch { continue; }

    // 通道過濾：trigger.channels 可指定 ['fb'] / ['ig'] / 空=全部
    if (trigger.channels?.length && !trigger.channels.includes(channel)) continue;

    // 貼文 ID 過濾：trigger.post_id 有值時只對該貼文觸發
    if (trigger.post_id && trigger.post_id !== post_id) continue;

    if (matchKeywords(text, trigger)) {
      matchedRule = rule;
      break; // 只取優先度最高的一條
    }
  }

  const now = Date.now();

  if (!matchedRule) {
    // 沒命中規則：記錄 skipped
    db.prepare(`
      INSERT INTO post_replies (client_id, channel, post_id, comment_id, commenter_id, comment_text, action_taken, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'skipped', ?)
    `).run(clientId, channel, post_id || null, comment_id, commenter_id, text.slice(0, 500), now);
    return;
  }

  let action;
  try { action = JSON.parse(matchedRule.action || '{}'); } catch { return; }

  const dmContent = action?.payload?.dm_content || '您好！感謝您的留言，已收到您的訊息。';
  const alsoReplyComment = action?.payload?.also_reply_comment || false;
  const commentReplyText = action?.payload?.comment_reply_text || '';

  // 套用變數替換（簡易版，不引入 template.js 避免循環依賴）
  const vars = { customer_name: commenter_id, post_id: post_id || '' };
  const finalDmContent = dmContent.replace(/\{(\w+)\}/g, (_, k) => vars[k] || `{${k}}`);

  let dmMsgId = null;
  let actionTaken = 'skipped';

  // 發 DM
  try {
    if (channel === 'fb') {
      dmMsgId = await sendFbDm(clientId, commenter_id, finalDmContent);
      actionTaken = 'dm_sent';
    } else if (channel === 'ig') {
      dmMsgId = await sendIgDm(clientId, commenter_id, finalDmContent);
      actionTaken = 'dm_sent';
    }
  } catch (e) {
    log.error({ err: e.message, client_id: clientId, channel }, 'processComment: 發 DM 失敗');
    actionTaken = 'dm_failed';
  }

  // 選擇性回覆留言
  if (alsoReplyComment && commentReplyText) {
    try {
      if (channel === 'fb') {
        await replyFbComment(clientId, comment_id, commentReplyText);
        actionTaken = actionTaken === 'dm_sent' ? 'dm_and_comment_replied' : 'comment_replied';
      }
      // TODO: IG 回覆留言 API
    } catch (e) {
      log.warn({ err: e.message }, 'processComment: 回覆留言失敗');
    }
  }

  // 更新規則觸發統計
  db.prepare(`
    UPDATE automation_rules SET trigger_count = trigger_count + 1, last_triggered_at = ?, updated_at = ? WHERE id = ?
  `).run(now, now, matchedRule.id);

  // 寫 post_replies 表
  const prId = db.prepare(`
    INSERT INTO post_replies (client_id, channel, post_id, comment_id, commenter_id, comment_text, matched_rule_id, action_taken, dm_message_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(clientId, channel, post_id || null, comment_id, commenter_id, text.slice(0, 500), matchedRule.id, actionTaken, dmMsgId, now).lastInsertRowid;

  // 計費
  if (actionTaken.includes('dm')) {
    try {
      recordBilling({
        client_id: clientId,
        channel,
        api_type: 'push',
        metadata: { source: 'comment_to_dm', post_reply_id: prId },
      });
    } catch {}
  }

  // Emit
  emitToClient(clientId, 'comment:auto_reply', {
    post_reply_id: prId,
    channel,
    post_id,
    comment_id,
    commenter_id,
    action_taken: actionTaken,
    rule_id: matchedRule.id,
    rule_name: matchedRule.name,
  });

  log.info({ client_id: clientId, channel, post_id, comment_id, action_taken: actionTaken, rule_id: matchedRule.id }, '留言自動回覆完成');
};

// ─── FB DM 發送（lazy import 避免循環依賴）───
const sendFbDm = async (clientId, recipientId, text) => {
  const { sendText: fbSend } = await import('./fb.js');
  const { decrypt } = await import('./crypto.js');
  const client = db.prepare('SELECT fb_page_token_enc FROM clients WHERE id = ?').get(clientId);
  if (!client?.fb_page_token_enc) throw new Error('FB token 未設定');
  const token = decrypt(client.fb_page_token_enc);
  // TODO: 確認 FB Send API endpoint，recipientId 為 PSID
  await fbSend(token, recipientId, text);
  log.info({ client_id: clientId, recipient: recipientId }, 'FB DM 已發送');
  return null; // TODO: 回傳 message_id
};

// ─── FB 回覆留言（TODO: 待確認 API 權限）───
const replyFbComment = async (clientId, commentId, text) => {
  const { decrypt } = await import('./crypto.js');
  const client = db.prepare('SELECT fb_page_token_enc FROM clients WHERE id = ?').get(clientId);
  if (!client?.fb_page_token_enc) return;
  const token = decrypt(client.fb_page_token_enc);

  // TODO: 等用戶開通 publish_pages 權限後測試
  const url = `https://graph.facebook.com/v19.0/${commentId}/comments`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, access_token: token }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`FB comment reply failed: ${JSON.stringify(err)}`);
  }
};

// ─── IG DM 發送（lazy import）───
const sendIgDm = async (clientId, recipientId, text) => {
  const { sendText: igSend } = await import('./ig.js');
  const { decrypt } = await import('./crypto.js');
  const client = db.prepare('SELECT ig_access_token_enc FROM clients WHERE id = ?').get(clientId);
  if (!client?.ig_access_token_enc) throw new Error('IG token 未設定');
  const token = decrypt(client.ig_access_token_enc);
  await igSend(token, recipientId, text);
  log.info({ client_id: clientId, recipient: recipientId }, 'IG DM 已發送');
  return null;
};

export default { ensurePostReplySchema, processComment };
