/**
 * routes/scheduled.js — 訊息排程
 *
 * POST   /api/conversations/:id/schedule-message
 * GET    /api/scheduled-messages
 * DELETE /api/scheduled-messages/:id
 *
 * 排程器函式：runScheduledMessages()（由 server.js 每 30 秒呼叫）
 */

import { Router } from 'express';
import { db } from '../lib/db.js';
import { logger as rootLogger } from '../lib/logger.js';
import { emitToClient } from '../lib/realtime.js';
import { renderTemplate, buildTemplateContext } from '../lib/template.js';

const log = rootLogger.child({ module: 'routes/scheduled' });

// ─── Schema ───
export const ensureScheduledSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_type TEXT DEFAULT 'text',
      scheduled_at INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      sent_at INTEGER,
      error TEXT,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sched_msg_pending ON scheduled_messages(status, scheduled_at);
  `);
  log.info('scheduled_messages schema ready');
};

const resolveClientId = (req) => {
  const sess = req.session;
  if (sess?.role === 'admin' && sess.client_id === null) {
    return req.query.client_id
      ? parseInt(req.query.client_id, 10)
      : (req.body?.client_id ? parseInt(req.body.client_id, 10) : null);
  }
  return sess?.client_id ?? null;
};

const router = Router();

// ─── 排程發送 ───
router.post('/conversations/:id/schedule-message', (req, res) => {
  const convId = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? (req.body?.client_id ? parseInt(req.body.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND client_id = ?').get(convId, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });

  const { content, content_type = 'text', scheduled_at } = req.body || {};
  if (!content?.trim()) return res.status(400).json({ error: '訊息內容不可為空' });
  if (!scheduled_at || isNaN(parseInt(scheduled_at, 10))) return res.status(400).json({ error: '需指定有效的 scheduled_at（timestamp ms）' });

  const schedAt = parseInt(scheduled_at, 10);
  if (schedAt <= Date.now()) return res.status(400).json({ error: 'scheduled_at 必須是未來時間' });

  const now = Date.now();
  const id = db.prepare(`
    INSERT INTO scheduled_messages (client_id, conversation_id, content, content_type, scheduled_at, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(clientId, convId, content.trim(), content_type, schedAt, req.session.user_id ?? null, now).lastInsertRowid;

  log.info({ id, client_id: clientId, conversation_id: convId, scheduled_at: schedAt }, 'scheduled message created');
  res.json({ id, ok: true });
});

// ─── 查詢排程訊息 ───
router.get('/scheduled-messages', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const status = req.query.status || null;
  const where = ['client_id = ?'];
  const args  = [clientId];
  if (status) { where.push('status = ?'); args.push(status); }

  const messages = db.prepare(`
    SELECT * FROM scheduled_messages WHERE ${where.join(' AND ')} ORDER BY scheduled_at ASC
  `).all(...args);

  res.json({ scheduled_messages: messages });
});

// ─── 取消排程訊息 ───
router.delete('/scheduled-messages/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const msg = db.prepare('SELECT * FROM scheduled_messages WHERE id = ? AND client_id = ?').get(id, clientId);
  if (!msg) return res.status(404).json({ error: '排程訊息不存在或無權限' });
  if (msg.status !== 'pending') return res.status(400).json({ error: '只能取消 pending 狀態的排程訊息' });

  db.prepare("UPDATE scheduled_messages SET status = 'cancelled', updated_at = ? WHERE id = ?")
    .run(Date.now(), id);

  res.json({ ok: true });
});

// ─── 排程執行器（每 30 秒 setInterval）───
export const runScheduledMessages = async () => {
  const now = Date.now();
  const due = db.prepare(`
    SELECT * FROM scheduled_messages WHERE status = 'pending' AND scheduled_at <= ?
  `).all(now);

  if (!due.length) return;

  for (const msg of due) {
    try {
      const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(msg.conversation_id);
      if (!conv) {
        db.prepare("UPDATE scheduled_messages SET status = 'failed', error = ?, sent_at = ? WHERE id = ?")
          .run('對話不存在', now, msg.id);
        continue;
      }

      // 套用範本變數
      let content = msg.content;
      try {
        const ctx = buildTemplateContext(msg.conversation_id, msg.client_id);
        content = renderTemplate(content, ctx);
      } catch {}

      const msgId = db.prepare(`
        INSERT INTO messages (conversation_id, direction, sender_type, content_type, content, created_at)
        VALUES (?, 'outbound', 'system', ?, ?, ?)
      `).run(msg.conversation_id, msg.content_type, content, now).lastInsertRowid;

      db.prepare(`
        UPDATE conversations SET last_message_at = ?, last_message_preview = ?, updated_at = ? WHERE id = ?
      `).run(now, content.slice(0, 100), now, msg.conversation_id);

      db.prepare("UPDATE scheduled_messages SET status = 'sent', sent_at = ? WHERE id = ?")
        .run(now, msg.id);

      emitToClient(msg.client_id, 'message:reply', {
        conversation_id: msg.conversation_id,
        message: { id: msgId, direction: 'outbound', sender_type: 'system', content, created_at: now },
      });

      log.info({ scheduled_msg_id: msg.id, conversation_id: msg.conversation_id }, 'scheduled message sent');
    } catch (e) {
      log.error({ scheduled_msg_id: msg.id, err: e.message }, 'scheduled message failed');
      db.prepare("UPDATE scheduled_messages SET status = 'failed', error = ?, sent_at = ? WHERE id = ?")
        .run(e.message.slice(0, 200), now, msg.id);
    }
  }
};

export default router;
