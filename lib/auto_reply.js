/**
 * auto_reply.js — AI 離線自動回覆
 *
 * ensureAutoReplySchema()      — 建立 schema
 * shouldAutoReply(clientId)    — 判斷是否在離線時段
 * processAutoReply(convId, msg, replyFn) — 主流程
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';
import { chat } from './ai.js';

const log = rootLogger.child({ module: 'auto_reply' });

// ─── Schema ───
export const ensureAutoReplySchema = () => {
  // clients 欄位（safeAlter 容錯）
  const safeAlter = (sql) => {
    try { db.exec(sql); } catch (e) {
      if (!e.message?.includes('duplicate column')) throw e;
    }
  };

  safeAlter('ALTER TABLE clients ADD COLUMN auto_reply_enabled INTEGER DEFAULT 0');
  safeAlter('ALTER TABLE clients ADD COLUMN auto_reply_schedule TEXT');
  safeAlter('ALTER TABLE clients ADD COLUMN auto_reply_confidence_threshold REAL DEFAULT 0.7');
  safeAlter('ALTER TABLE clients ADD COLUMN auto_reply_disclaimer TEXT');

  // conversations.force_human
  safeAlter('ALTER TABLE conversations ADD COLUMN force_human INTEGER DEFAULT 0');

  // auto_reply_logs
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_reply_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      inbound_message_id INTEGER,
      outbound_message_id INTEGER,
      matched_qa_id INTEGER,
      confidence REAL,
      trigger_reason TEXT,
      ai_response TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );
    CREATE INDEX IF NOT EXISTS idx_auto_reply_logs_client ON auto_reply_logs(client_id, created_at DESC);
  `);

  log.info('auto_reply schema ready');
};

// ─── 離線時段判斷 ───
// schedule = { always_on: bool, off_hours: [{ day: 0-6, start: 'HH:MM', end: 'HH:MM' }] }
// day: 0=週日 ... 6=週六
const isInOffHours = (schedule) => {
  if (!schedule) return false;
  if (schedule.always_on) return true;

  const offHours = Array.isArray(schedule.off_hours) ? schedule.off_hours : [];
  if (!offHours.length) return false;

  const now = new Date();
  const nowDay = now.getDay();           // 0=週日
  const nowMin = now.getHours() * 60 + now.getMinutes();

  for (const slot of offHours) {
    const slotDay = slot.day;
    if (slotDay !== undefined && slotDay !== nowDay) continue;

    const [sh, sm] = (slot.start || '00:00').split(':').map(Number);
    const [eh, em] = (slot.end   || '23:59').split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin   = eh * 60 + em;

    if (startMin <= endMin) {
      // 同天區間 18:00 - 22:00
      if (nowMin >= startMin && nowMin <= endMin) return true;
    } else {
      // 跨午夜 22:00 - 09:00
      if (nowMin >= startMin || nowMin <= endMin) return true;
    }
  }
  return false;
};

// ─── 簡單關鍵字相似度（無向量，用詞交集）───
const simpleScore = (query, qaQuestion) => {
  const words = (s) => s.split(/[\s，。！？,.!?\r\n]+/).filter(w => w.length >= 2);
  const qw = new Set(words(query));
  const aw = words(qaQuestion);
  if (!qw.size || !aw.length) return 0;
  const hits = aw.filter(w => qw.has(w)).length;
  return hits / Math.max(qw.size, aw.length);
};

// ─── 找最佳 QA ───
const findBestQa = (clientId, text, threshold) => {
  const rows = db.prepare(`
    SELECT id, question, answer FROM qa_pairs WHERE client_id = ? ORDER BY hit_count DESC LIMIT 50
  `).all(clientId);

  let best = null;
  let bestScore = 0;

  for (const row of rows) {
    const score = simpleScore(text, row.question);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  if (best && bestScore >= threshold) {
    return { qa: best, confidence: bestScore };
  }
  return null;
};

// ─── AI 輔助生成（若 QA 命中率不夠，用 AI 加強）───
const generateAiResponse = async (clientId, customerText, brandDna = {}) => {
  // 取 FAQ context
  const rows = db.prepare(`
    SELECT question, answer FROM qa_pairs WHERE client_id = ? ORDER BY hit_count DESC LIMIT 10
  `).all(clientId);

  const faqContext = rows.map(r => `Q: ${r.question}\nA: ${r.answer}`).join('\n\n');

  const system = `你是品牌客服機器人。根據知識庫 FAQ 回答顧客問題，回答要簡短（100字內）、口語、繁體中文。
品牌語氣：${brandDna.tone || '親切專業'}
FAQ 知識庫：
${faqContext || '（尚無 FAQ）'}
若問題不在 FAQ 範圍內，請回覆「感謝您的訊息，客服人員上班後將盡快為您解答！」`;

  const result = await chat({
    system,
    messages: [{ role: 'user', content: customerText }],
    max_tokens: 256,
  });

  if (!result.ok) return null;
  return result.text || null;
};

// ─── 主判斷邏輯 ───
export const shouldAutoReply = (clientId, conversationId) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client || !client.auto_reply_enabled) return { should: false };

  // force_human 對話不自動回
  const conv = db.prepare('SELECT force_human FROM conversations WHERE id = ?').get(conversationId);
  if (conv?.force_human) return { should: false, reason: 'force_human' };

  let schedule = null;
  try { schedule = JSON.parse(client.auto_reply_schedule || 'null'); } catch {}

  const inOffHours = isInOffHours(schedule);
  if (!inOffHours) return { should: false, reason: 'in_working_hours' };

  return {
    should: true,
    reason: schedule?.always_on ? 'always_on' : 'off_hours',
    threshold: client.auto_reply_confidence_threshold ?? 0.7,
    disclaimer: client.auto_reply_disclaimer || '',
    client,
  };
};

// ─── 真人關鍵字偵測 ───
const HUMAN_KEYWORDS = ['真人客服', '找客服', '我要找人', '真人', '人工', '客服人員', '真人服務'];
export const detectHumanRequest = (text) => {
  return HUMAN_KEYWORDS.some(kw => text.includes(kw));
};

// ─── 主處理流程 ───
// replyFn: async (convId, content) => void  — 負責實際送出訊息
export const processAutoReply = async (conversationId, customerText, clientId, inboundMsgId, replyFn) => {
  try {
    // 偵測「真人客服」請求
    if (detectHumanRequest(customerText)) {
      db.prepare('UPDATE conversations SET force_human = 1, updated_at = ? WHERE id = ?')
        .run(Date.now(), conversationId);
      log.info({ conv_id: conversationId }, '顧客請求真人客服，已標記 force_human=1');
      return;
    }

    const check = shouldAutoReply(clientId, conversationId);
    if (!check.should) return;

    const { threshold, disclaimer, client } = check;
    let brandDna = {};
    try { brandDna = JSON.parse(client.brand_dna || '{}'); } catch {}

    // 找最佳 QA
    const qaResult = findBestQa(clientId, customerText, threshold);
    let responseText = null;
    let matchedQaId = null;
    let confidence = 0;

    if (qaResult) {
      responseText = qaResult.qa.answer;
      matchedQaId = qaResult.qa.id;
      confidence = qaResult.confidence;

      // 更新 hit_count
      db.prepare('UPDATE qa_pairs SET hit_count = hit_count + 1 WHERE id = ?').run(matchedQaId);
    } else {
      // QA 沒命中，用 AI 生成
      responseText = await generateAiResponse(clientId, customerText, brandDna);
      confidence = responseText ? 0.5 : 0;
    }

    if (!responseText) {
      log.info({ conv_id: conversationId }, '自動回覆：無法生成答案，略過');
      return;
    }

    // 加 disclaimer
    const finalText = disclaimer
      ? `${responseText}\n\n${disclaimer}`
      : responseText;

    // 寫 message（sender_type='ai'）
    const outboundMsgId = db.prepare(`
      INSERT INTO messages (conversation_id, direction, sender_type, content_type, content, created_at)
      VALUES (?, 'outbound', 'ai', 'text', ?, ?)
    `).run(conversationId, finalText, Date.now()).lastInsertRowid;

    // 更新 conversation
    db.prepare(`
      UPDATE conversations SET last_message_at = ?, last_message_preview = ?, updated_at = ? WHERE id = ?
    `).run(Date.now(), finalText.slice(0, 100), Date.now(), conversationId);

    // 實際送出（若有 replyFn）
    if (typeof replyFn === 'function') {
      try {
        await replyFn(conversationId, finalText, outboundMsgId);
      } catch (e) {
        log.warn({ err: e.message, conv_id: conversationId }, '自動回覆送出失敗');
      }
    }

    // 寫 auto_reply_logs
    db.prepare(`
      INSERT INTO auto_reply_logs (client_id, conversation_id, inbound_message_id, outbound_message_id, matched_qa_id, confidence, trigger_reason, ai_response, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(clientId, conversationId, inboundMsgId || null, outboundMsgId, matchedQaId, confidence, check.reason, finalText, Date.now());

    log.info({ conv_id: conversationId, confidence, matched_qa_id: matchedQaId, reason: check.reason }, '自動回覆已送出');
  } catch (e) {
    log.error({ err: e.message, conv_id: conversationId }, 'processAutoReply 失敗');
  }
};

export default { ensureAutoReplySchema, shouldAutoReply, processAutoReply, detectHumanRequest };
