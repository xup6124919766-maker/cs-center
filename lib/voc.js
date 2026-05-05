/**
 * lib/voc.js — Voice of Customer 智慧分析
 *
 * ensureVocSchema()                         → 建 voc_insights / voc_topics 表
 * analyzeMessage(messageId)                 → 分析單則訊息，寫入 voc_insights
 * runVocBatch(clientId, sinceMs, opts)      → 批次分析（限速）
 * recomputeVocTopics(clientId)              → 重算 voc_topics 聚合 + 趨勢
 */

import { db } from './db.js';
import { chat } from './ai.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'voc' });

// ─── Schema ───
export const ensureVocSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voc_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      topic TEXT,
      product_mention TEXT,
      sentiment TEXT,
      urgency TEXT,
      raw_excerpt TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_voc_client_cat ON voc_insights(client_id, category, created_at);
    CREATE INDEX IF NOT EXISTS idx_voc_topic ON voc_insights(client_id, topic);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_voc_message ON voc_insights(message_id);

    CREATE TABLE IF NOT EXISTS voc_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      topic TEXT NOT NULL,
      category TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      first_seen_at INTEGER,
      last_seen_at INTEGER,
      example_excerpts TEXT,
      trend TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(client_id, topic)
    );
    CREATE INDEX IF NOT EXISTS idx_voc_topics_client ON voc_topics(client_id, count DESC);
  `);

  // voc_complaint_handled 欄位（手動標記已處理）
  try {
    db.exec('ALTER TABLE voc_insights ADD COLUMN handled INTEGER DEFAULT 0');
  } catch (e) {
    if (!e.message.includes('duplicate column')) { /* 忽略已存在 */ }
  }

  log.info('voc schema ready');
};

// ─── 分類 prompt（省 token，用 haiku）───
const buildVocPrompt = (content, context) => {
  const ctxStr = context.slice(-3).map(m => {
    const who = m.direction === 'inbound' ? '顧客' : '客服';
    return `${who}: ${(m.content || '').slice(0, 100)}`;
  }).join('\n');

  return `你是品牌顧客聲音分析師。請分析以下顧客訊息，用 JSON 格式回答。

上下文：
${ctxStr || '（無）'}

顧客訊息：
${(content || '').slice(0, 500)}

請回傳：
{
  "category": "complaint"|"praise"|"request"|"question"|"product_feedback"|"none",
  "topic": "10字以內的主題，例如：物流太慢、想要男生款、成分疑慮（none時填null）",
  "product_mention": "the_echo"|"晨光"|"原罪"|"口噴白桃"|"口噴青柚"|null,
  "sentiment": "positive"|"neutral"|"negative",
  "urgency": "low"|"normal"|"high",
  "key_excerpt": "最具代表性的原文片段（≤100字）"
}

規則：
- category=none 表示非顧客洞察（純聊天、系統訊息等）
- urgency=high：客訴、強烈不滿、要求退款/賠償
- 只回 JSON，不要說明`;
};

const VALID_CATEGORIES = ['complaint', 'praise', 'request', 'question', 'product_feedback', 'none'];
const VALID_SENTIMENTS = ['positive', 'neutral', 'negative'];
const VALID_URGENCIES  = ['low', 'normal', 'high'];

// ─── 分析單則訊息 ───
export const analyzeMessage = async (messageId) => {
  // 1. 撈訊息
  const msg = db.prepare(`
    SELECT m.*, c.client_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ?
  `).get(messageId);

  if (!msg) {
    log.warn({ messageId }, 'analyzeMessage: message not found');
    return null;
  }

  // 只分析 inbound + text
  if (msg.direction !== 'inbound' || msg.content_type !== 'text' || !msg.content?.trim()) {
    return null;
  }

  // 已分析過就跳過
  const existing = db.prepare('SELECT id FROM voc_insights WHERE message_id = ?').get(messageId);
  if (existing) return { skipped: true, id: existing.id };

  // 2. 撈上下文（前3則）
  const context = db.prepare(`
    SELECT direction, content FROM messages
    WHERE conversation_id = ? AND id < ? AND content_type = 'text'
    ORDER BY created_at DESC LIMIT 3
  `).all(msg.conversation_id, messageId).reverse();

  // 3. 呼叫 AI
  const prompt = buildVocPrompt(msg.content, context);

  let result;
  try {
    result = await chat({
      system: '你是品牌顧客聲音分析師，只回 JSON。',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 256,
      json_schema: true,
      model: 'claude-haiku-4-5-20251001',
      client_id: msg.client_id,
      feature: 'voc_analyze',
    });
  } catch (e) {
    log.error({ err: e.message, messageId }, 'analyzeMessage: AI call failed');
    return null;
  }

  if (!result?.ok || !result?.json) {
    log.warn({ err: result?.error, messageId }, 'analyzeMessage: AI failed or no JSON');
    return null;
  }

  const j = result.json;

  // 4. 驗證並清理
  const category = VALID_CATEGORIES.includes(j.category) ? j.category : 'none';
  if (category === 'none') {
    // none 不寫入 DB，節省空間
    return { skipped: true, reason: 'category=none' };
  }

  const topic        = typeof j.topic === 'string' ? j.topic.slice(0, 30) : null;
  const productMention = typeof j.product_mention === 'string' ? j.product_mention.slice(0, 50) : null;
  const sentiment    = VALID_SENTIMENTS.includes(j.sentiment) ? j.sentiment : 'neutral';
  const urgency      = VALID_URGENCIES.includes(j.urgency) ? j.urgency : 'normal';
  const rawExcerpt   = typeof j.key_excerpt === 'string' ? j.key_excerpt.slice(0, 200) : (msg.content || '').slice(0, 200);

  // 5. 寫入 voc_insights
  const now = Date.now();
  let insightId;
  try {
    insightId = db.prepare(`
      INSERT OR IGNORE INTO voc_insights
        (client_id, message_id, conversation_id, category, topic, product_mention,
         sentiment, urgency, raw_excerpt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.client_id, messageId, msg.conversation_id,
      category, topic, productMention,
      sentiment, urgency, rawExcerpt, now
    ).lastInsertRowid;
  } catch (e) {
    log.warn({ err: e.message, messageId }, 'voc_insights insert failed');
    return null;
  }

  // 6. 累計 voc_topics
  if (topic) {
    upsertVocTopic(msg.client_id, topic, category, rawExcerpt, now);
  }

  log.info({ messageId, category, topic, sentiment, urgency }, 'voc insight saved');
  return { id: insightId, category, topic, sentiment, urgency };
};

// ─── upsert voc_topics（每次分析後即時累計）───
const upsertVocTopic = (clientId, topic, category, excerpt, now) => {
  try {
    const existing = db.prepare(
      'SELECT id, count, example_excerpts FROM voc_topics WHERE client_id = ? AND topic = ?'
    ).get(clientId, topic);

    if (existing) {
      // 更新 count + last_seen + excerpts（最多 5 個）
      let excerpts = [];
      try { excerpts = JSON.parse(existing.example_excerpts || '[]'); } catch {}
      if (excerpt && !excerpts.includes(excerpt)) {
        excerpts.unshift(excerpt);
        excerpts = excerpts.slice(0, 5);
      }
      db.prepare(`
        UPDATE voc_topics
        SET count = count + 1, last_seen_at = ?, example_excerpts = ?, updated_at = ?
        WHERE id = ?
      `).run(now, JSON.stringify(excerpts), now, existing.id);
    } else {
      const excerpts = excerpt ? JSON.stringify([excerpt]) : '[]';
      db.prepare(`
        INSERT INTO voc_topics (client_id, topic, category, count, first_seen_at, last_seen_at, example_excerpts, trend, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, 'stable', ?, ?)
      `).run(clientId, topic, category, now, now, excerpts, now, now);
    }
  } catch (e) {
    log.warn({ err: e.message, topic }, 'upsertVocTopic failed');
  }
};

// ─── 批次分析（限速：每批次最多 N 則，間隔 delay ms）───
export const runVocBatch = async (clientId, sinceMs = null, { batchSize = 20, delayMs = 500 } = {}) => {
  const since = sinceMs ?? (Date.now() - 30 * 24 * 3600_000); // 預設 30 天

  // 撈未分析的 inbound text 訊息
  const msgs = db.prepare(`
    SELECT m.id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.client_id = ?
      AND m.direction = 'inbound'
      AND m.content_type = 'text'
      AND m.content IS NOT NULL
      AND m.created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM voc_insights v WHERE v.message_id = m.id)
    ORDER BY m.created_at ASC
    LIMIT ?
  `).all(clientId, since, batchSize);

  if (!msgs.length) {
    log.info({ clientId }, 'voc batch: no new messages to analyze');
    return { processed: 0, success: 0, error: 0 };
  }

  let success = 0;
  let errorCount = 0;

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    try {
      const r = await analyzeMessage(msg.id);
      if (r && !r.skipped) success++;
    } catch (e) {
      log.error({ err: e.message, messageId: msg.id }, 'voc batch: analyzeMessage error');
      errorCount++;
    }

    // 限速：每 5 則暫停一下
    if (i > 0 && i % 5 === 0 && delayMs > 0) {
      await new Promise(res => setTimeout(res, delayMs));
    }
  }

  log.info({ clientId, processed: msgs.length, success, errorCount }, 'voc batch done');
  return { processed: msgs.length, success, error: errorCount };
};

// ─── 重算 voc_topics 趨勢（rising/stable/falling）───
export const recomputeVocTopics = (clientId) => {
  const now = Date.now();
  const recent30 = now - 30 * 24 * 3600_000;
  const recent7  = now - 7  * 24 * 3600_000;
  const prev7Start = recent30;      // 用 30天 vs 7天做對比
  const prev7End   = recent7;

  try {
    const topics = db.prepare('SELECT id, topic FROM voc_topics WHERE client_id = ?').all(clientId);

    for (const t of topics) {
      // 最近 7 天出現次數
      const recentCount = db.prepare(`
        SELECT COUNT(*) AS cnt FROM voc_insights
        WHERE client_id = ? AND topic = ? AND created_at >= ?
      `).get(clientId, t.topic, recent7)?.cnt || 0;

      // 前 23 天出現次數（30天 - 最近7天），除以 23/7 標準化
      const prevCount = db.prepare(`
        SELECT COUNT(*) AS cnt FROM voc_insights
        WHERE client_id = ? AND topic = ? AND created_at >= ? AND created_at < ?
      `).get(clientId, t.topic, prev7Start, prev7End)?.cnt || 0;

      // 每天平均次數對比
      const recentRate = recentCount / 7;
      const prevRate   = prevCount / 23;

      let trend = 'stable';
      if (prevRate === 0) {
        trend = recentCount > 0 ? 'rising' : 'stable';
      } else {
        const ratio = recentRate / prevRate;
        if (ratio >= 1.5) trend = 'rising';
        else if (ratio <= 0.5) trend = 'falling';
        else trend = 'stable';
      }

      db.prepare('UPDATE voc_topics SET trend = ?, updated_at = ? WHERE id = ?')
        .run(trend, now, t.id);
    }

    log.info({ clientId, topicsUpdated: topics.length }, 'voc topics trend recomputed');
    return topics.length;
  } catch (e) {
    log.error({ err: e.message, clientId }, 'recomputeVocTopics failed');
    return 0;
  }
};

export default { ensureVocSchema, analyzeMessage, runVocBatch, recomputeVocTopics };
