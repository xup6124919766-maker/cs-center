/**
 * broadcast.js — 廣播 + 分眾推播引擎
 *
 * resolveSegment(client_id, filter) — filter JSON → 顧客陣列
 * prepareBroadcast(broadcast_id)   — 預寫 broadcast_recipients
 * executeBroadcast(broadcast_id)   — 逐筆送出（含 stub LINE/FB）
 * runScheduledBroadcasts()         — 每分鐘 setInterval 觸發
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';
import { emitToClient } from './realtime.js';

const log = rootLogger.child({ module: 'broadcast' });

// ─── Schema Migration ───
export const ensureBroadcastSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      channel TEXT NOT NULL,
      content_type TEXT DEFAULT 'text',
      content TEXT NOT NULL,
      segment_filter TEXT,
      status TEXT DEFAULT 'draft',
      scheduled_at INTEGER,
      sent_at INTEGER,
      total_targets INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      delivered_count INTEGER DEFAULT 0,
      read_count INTEGER DEFAULT 0,
      click_count INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS broadcast_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcast_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      channel TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      external_message_id TEXT,
      error TEXT,
      sent_at INTEGER,
      read_at INTEGER,
      clicked_at INTEGER,
      FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_bcast_status ON broadcasts(client_id, status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_bcast_recip ON broadcast_recipients(broadcast_id, status);
  `);
};

// ─── 分眾解析 ───
export const resolveSegment = (clientId, filter = {}) => {
  const where = ['c.client_id = ?', 'c.is_blocked = 0'];
  const args = [clientId];

  // tags: ['VIP', 'Premium'] → 任一 tag 符合
  if (Array.isArray(filter.tags) && filter.tags.length) {
    const tagConditions = filter.tags.map(() => "c.tags LIKE ?").join(' OR ');
    where.push(`(${tagConditions})`);
    for (const tag of filter.tags) args.push(`%"${tag}"%`);
  }

  // emotion_in: ['negative', 'angry'] → 任一 emotion 符合
  if (Array.isArray(filter.emotion_in) && filter.emotion_in.length) {
    // 透過最近一則對話的 emotion
    const emotionPlaceholders = filter.emotion_in.map(() => '?').join(', ');
    where.push(`c.id IN (
      SELECT DISTINCT customer_id FROM conversations
      WHERE client_id = ? AND emotion IN (${emotionPlaceholders})
      ORDER BY last_message_at DESC LIMIT 1
    )`);
    args.push(clientId, ...filter.emotion_in);
  }

  // is_blocked filter（預設已過濾，若明確傳 true 表示只查黑名單）
  if (filter.is_blocked === true) {
    where.splice(where.indexOf('c.is_blocked = 0'), 1);
    where.push('c.is_blocked = 1');
  }

  // joined_after: timestamp
  if (filter.joined_after) {
    where.push('c.created_at >= ?');
    args.push(filter.joined_after);
  }

  // custom_fields: { field: value }
  if (filter.custom_fields && typeof filter.custom_fields === 'object') {
    for (const [field, value] of Object.entries(filter.custom_fields)) {
      if (value !== null && value !== undefined) {
        where.push(`c.custom_fields LIKE ?`);
        args.push(`%"${field}":"${value}"%`);
      }
    }
  }

  return db.prepare(`
    SELECT c.id, c.name, c.phone, c.email, c.tags, c.custom_fields
    FROM customers c
    WHERE ${where.join(' AND ')}
    ORDER BY c.updated_at DESC
  `).all(...args);
};

// ─── 預備廣播（寫 recipients）───
export const prepareBroadcast = (broadcastId) => {
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(broadcastId);
  if (!broadcast) throw new Error(`broadcast ${broadcastId} not found`);

  let filter = {};
  try { filter = JSON.parse(broadcast.segment_filter || '{}'); } catch {}

  const customers = resolveSegment(broadcast.client_id, filter);

  // 清除舊 recipients（重新 prepare 時）
  db.prepare('DELETE FROM broadcast_recipients WHERE broadcast_id = ? AND status = ?').run(broadcastId, 'pending');

  const now = Date.now();
  const insertRecipient = db.prepare(`
    INSERT OR IGNORE INTO broadcast_recipients (broadcast_id, customer_id, channel, status)
    VALUES (?, ?, ?, 'pending')
  `);

  try {
    db.exec('BEGIN');
    for (const cust of customers) {
      insertRecipient.run(broadcastId, cust.id, broadcast.channel);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  // 更新 total_targets
  db.prepare('UPDATE broadcasts SET total_targets = ?, updated_at = ? WHERE id = ?')
    .run(customers.length, now, broadcastId);

  log.info({ broadcast_id: broadcastId, targets: customers.length }, 'broadcast prepared');
  return customers.length;
};

// ─── sleep helper ───
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── 評價連結 URL 基底（可由環境變數覆寫）───
const BASE_URL = process.env.BASE_URL || 'https://cs.sandian.work';

// ─── 執行廣播 ───
export const executeBroadcast = async (broadcastId) => {
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(broadcastId);
  if (!broadcast) throw new Error(`broadcast ${broadcastId} not found`);

  db.prepare("UPDATE broadcasts SET status = 'sending', updated_at = ? WHERE id = ?").run(Date.now(), broadcastId);
  log.info({ broadcast_id: broadcastId, name: broadcast.name }, 'broadcast executing');

  const recipients = db.prepare(
    "SELECT * FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'pending'"
  ).all(broadcastId);

  let sentCount = 0;
  let failCount = 0;

  for (let i = 0; i < recipients.length; i++) {
    const recip = recipients[i];
    try {
      // TODO: 等業主提供 LINE/FB/IG token 後，根據 channel 呼叫實際 API
      // if (broadcast.channel === 'line' || broadcast.channel === 'all') {
      //   const client = getClient(broadcast.client_id);
      //   const token = decrypt(client.line_access_token_enc);
      //   const channelId = getChannelUserId(recip.customer_id, 'line');
      //   if (channelId && token) await lineSend(token, channelId, broadcast.content);
      // }
      // if (broadcast.channel === 'fb' || broadcast.channel === 'all') {
      //   const client = getClient(broadcast.client_id);
      //   const token = decrypt(client.fb_page_token_enc);
      //   const psid = getChannelUserId(recip.customer_id, 'fb');
      //   if (psid && token) await fbSend(token, psid, broadcast.content);
      // }
      // if (broadcast.channel === 'ig' || broadcast.channel === 'all') {
      //   // TODO: 等 IG token 進來實作
      //   const client = getClient(broadcast.client_id);
      //   if (client.ig_access_token_enc && client.ig_business_account_id) {
      //     const token = decrypt(client.ig_access_token_enc);
      //     const igPsid = getChannelUserId(recip.customer_id, 'ig');
      //     if (igPsid) await igSend(token, client.ig_business_account_id, igPsid, broadcast.content);
      //   }
      // }

      // 組合訊息內容（如有開啟評價連結則附加）
      let finalContent = broadcast.content;
      const attachFeedback = broadcast.attach_feedback_url !== 0; // 預設 1（開）
      if (attachFeedback) {
        const feedbackUrl = `${BASE_URL}/feedback/broadcast.html?broadcast_id=${broadcastId}&customer_id=${recip.customer_id}`;
        finalContent = `${broadcast.content}\n\n👉 覺得有用嗎？${feedbackUrl}`;
      }

      // 寫入 messages 表（outbound/system）
      // 取最近的 open conversation 或建新的
      let conv = db.prepare(
        "SELECT id FROM conversations WHERE client_id = ? AND customer_id = ? AND status = 'open' ORDER BY last_message_at DESC LIMIT 1"
      ).get(broadcast.client_id, recip.customer_id);

      if (conv) {
        db.prepare(`
          INSERT INTO messages (conversation_id, direction, sender_type, content_type, content, created_at)
          VALUES (?, 'outbound', 'system', ?, ?, ?)
        `).run(conv.id, broadcast.content_type, finalContent, Date.now());
      }

      db.prepare(
        "UPDATE broadcast_recipients SET status = 'sent', sent_at = ? WHERE id = ?"
      ).run(Date.now(), recip.id);
      sentCount++;
    } catch (e) {
      log.error({ err: e.message, recipient_id: recip.id, customer_id: recip.customer_id }, 'broadcast send failed');
      db.prepare(
        "UPDATE broadcast_recipients SET status = 'failed', error = ? WHERE id = ?"
      ).run(e.message.slice(0, 200), recip.id);
      failCount++;
    }

    // 速率限制：每 10 則等 1 秒
    if ((i + 1) % 10 === 0) await sleep(1000);
  }

  const now = Date.now();
  db.prepare(`
    UPDATE broadcasts SET status = 'sent', sent_at = ?, sent_count = ?, updated_at = ? WHERE id = ?
  `).run(now, sentCount, now, broadcastId);

  log.info({ broadcast_id: broadcastId, sent: sentCount, failed: failCount }, 'broadcast done');
  emitToClient(broadcast.client_id, 'broadcast:done', { broadcast_id: broadcastId, sent_count: sentCount, fail_count: failCount });
  return { sent: sentCount, failed: failCount };
};

// ─── 排程廣播執行器（每分鐘跑）───
export const runScheduledBroadcasts = async () => {
  const now = Date.now();
  const due = db.prepare(
    "SELECT id FROM broadcasts WHERE status = 'scheduled' AND scheduled_at <= ?"
  ).all(now);

  for (const b of due) {
    log.info({ broadcast_id: b.id }, 'running scheduled broadcast');
    try {
      await prepareBroadcast(b.id);
      await executeBroadcast(b.id);
    } catch (e) {
      log.error({ err: e.message, broadcast_id: b.id }, 'scheduled broadcast failed');
      db.prepare("UPDATE broadcasts SET status = 'failed', updated_at = ? WHERE id = ?").run(now, b.id);
    }
  }
};

export default { resolveSegment, prepareBroadcast, executeBroadcast, runScheduledBroadcasts, ensureBroadcastSchema };
