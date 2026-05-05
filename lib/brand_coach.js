/**
 * brand_coach.js — 品牌教練 AI 模式
 *
 * scoreMessage({ client_id, user_id, content, conversation_id?, message_id?, save? })
 *   → 評分訊息的梵森魂濃度，回 JSON 分數 + 建議 + 改寫
 *
 * ensureBrandCoachSchema() — 建立 brand_coach_scores 表
 */

import { chat } from './ai.js';
import { logger as rootLogger } from './logger.js';
import { db } from './db.js';

const log = rootLogger.child({ module: 'brand_coach' });

// ─── Schema ───
export const ensureBrandCoachSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brand_coach_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      conversation_id INTEGER,
      message_id INTEGER,
      original_content TEXT,
      brand_score INTEGER,
      scores_breakdown TEXT,
      feedback TEXT,
      suggested_rewrite TEXT,
      applied INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_coach_user ON brand_coach_scores(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_coach_score ON brand_coach_scores(client_id, brand_score);
  `);

  // clients 表加門檻欄位（idempotent）
  try {
    db.exec("ALTER TABLE clients ADD COLUMN brand_coach_threshold INTEGER DEFAULT 0");
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }
};

// ─── 組 system prompt（brand_dna 摘要）───
const buildCoachSystem = (brandDna = {}) => {
  const rules = [
    brandDna.tone ? `語氣規則：${brandDna.tone}` : '語氣規則：溫柔、真誠、直接、有引導感，不油腔滑調',
    Array.isArray(brandDna.forbidden_words) && brandDna.forbidden_words.length
      ? `禁用詞（絕對不能出現）：${brandDna.forbidden_words.join('、')}` : null,
    Array.isArray(brandDna.required_phrases) && brandDna.required_phrases.length
      ? `必要語句（應該要有）：${brandDna.required_phrases.join('、')}` : null,
    '必須用「妳」而非「你」',
    '語氣比例：70% 朋友 + 30% 引導者',
    '不過度推銷，用「如果妳最近剛好有這種狀態」引導',
    '禁止命令式語氣，如「你應該」、「你一定要」',
    brandDna.signature ? `結尾署名：${brandDna.signature}` : null,
  ].filter(Boolean);

  const systemPromptBase = brandDna.system_prompt
    ? `你是梵森品牌語調分析師。梵森的品牌大腦：\n${brandDna.system_prompt}`
    : `你是梵森品牌語調分析師。梵森是一個香水品牌，核心使命是「讓女生慢慢喜歡上自己」，品牌標語是「讓妳慢慢變成自己喜歡的樣子」。`;

  return `${systemPromptBase}

品牌語調規則：
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

評分準則（各維度 0-100）：
- tone_score：語氣是否溫柔真誠有引導感？是否避免了禁忌語氣？
- dna_score：是否用「妳」？是否避免禁用詞？是否包含必要語句？
- structure_score：是否有清楚的邏輯結構（同理 → 理解 → 引導 → 行動）？
- brand_score：綜合分（三個維度的加權平均，tone×40% + dna×35% + structure×25%）

只回 JSON，不要任何額外文字：
{
  "brand_score": 整數0-100,
  "tone_score": 整數0-100,
  "dna_score": 整數0-100,
  "structure_score": 整數0-100,
  "feedback": "簡短說明優缺點（1-2 句繁體中文）",
  "suggested_rewrite": "改寫成更符合梵森風格的版本（繁體中文）"
}`;
};

// ─── scoreMessage ───
export const scoreMessage = async ({
  client_id,
  user_id,
  content,
  conversation_id = null,
  message_id = null,
  save = true,   // false = 即時預覽，不存 DB
}) => {
  if (!content || !content.trim()) {
    return { ok: false, error: '訊息內容不能為空' };
  }

  const clientId = parseInt(client_id, 10);
  const userId   = parseInt(user_id, 10);

  // 1. 取 brand_dna
  const clientRow = db.prepare('SELECT brand_dna FROM clients WHERE id = ?').get(clientId);
  if (!clientRow) return { ok: false, error: '業主不存在' };

  let brandDna = {};
  try { brandDna = JSON.parse(clientRow.brand_dna || '{}'); } catch {}

  // 2. 呼叫 AI 評分
  const system = buildCoachSystem(brandDna);
  const userMsg = `請評分以下客服訊息：\n\n${content.trim()}`;

  const aiResult = await chat({
    system,
    messages: [{ role: 'user', content: userMsg }],
    max_tokens: 800,
    json_schema: true,
    feature: 'brand_coach',
    client_id: clientId,
    user_id: userId,
    conversation_id: conversation_id ?? undefined,
  });

  if (!aiResult.ok) {
    log.error({ err: aiResult.error, client_id: clientId }, 'brand_coach AI failed');
    return { ok: false, error: aiResult.error || 'AI 評分失敗' };
  }

  const json = aiResult.json;
  if (!json || typeof json.brand_score !== 'number') {
    log.error({ text: (aiResult.text || '').slice(0, 200), json }, 'brand_coach JSON parse failed');
    return { ok: false, error: 'AI 回傳格式錯誤' };
  }

  // 3. 限制分數範圍 0-100
  const clamp = (v) => Math.min(100, Math.max(0, Math.round(v || 0)));
  const brandScore     = clamp(json.brand_score);
  const toneScore      = clamp(json.tone_score);
  const dnaScore       = clamp(json.dna_score);
  const structureScore = clamp(json.structure_score);

  const scoresBreakdown = JSON.stringify({
    tone: toneScore,
    dna: dnaScore,
    structure: structureScore,
  });

  // 4. 寫入 DB（save=false 時跳過）
  let insertId = null;
  if (save) {
    try {
      const stmt = db.prepare(`
        INSERT INTO brand_coach_scores
          (client_id, user_id, conversation_id, message_id, original_content,
           brand_score, scores_breakdown, feedback, suggested_rewrite, applied, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `);
      const r = stmt.run(
        clientId, userId,
        conversation_id ?? null, message_id ?? null,
        content.trim(),
        brandScore, scoresBreakdown,
        json.feedback || '', json.suggested_rewrite || '',
        Date.now(),
      );
      insertId = r.lastInsertRowid;
    } catch (e) {
      log.warn({ err: e.message }, 'brand_coach_scores insert failed');
    }
  }

  log.info({ client_id: clientId, user_id: userId, brand_score: brandScore, saved: save }, 'brand_coach scored');

  return {
    ok: true,
    id: insertId,
    brand_score: brandScore,
    tone_score: toneScore,
    dna_score: dnaScore,
    structure_score: structureScore,
    feedback: json.feedback || '',
    suggested_rewrite: json.suggested_rewrite || '',
  };
};

// ─── 排行榜（每位客服平均分）───
export const getLeaderboard = ({ client_id, from, to }) => {
  const clientId = parseInt(client_id, 10);
  const rows = db.prepare(`
    SELECT
      bcs.user_id,
      u.username,
      ROUND(AVG(bcs.brand_score), 1) AS avg_score,
      COUNT(bcs.id) AS msg_count,
      ROUND(SUM(bcs.applied) * 100.0 / COUNT(bcs.id), 1) AS apply_rate
    FROM brand_coach_scores bcs
    LEFT JOIN users u ON u.id = bcs.user_id
    WHERE bcs.client_id = ?
      AND bcs.created_at >= ?
      AND bcs.created_at <= ?
    GROUP BY bcs.user_id
    ORDER BY avg_score DESC
  `).all(clientId, from || 0, to || Date.now());
  return rows;
};

// ─── 個人歷史評分 ───
export const getUserScores = ({ client_id, user_id, from, to, limit = 50 }) => {
  const clientId = parseInt(client_id, 10);
  const userId   = parseInt(user_id, 10);
  return db.prepare(`
    SELECT id, conversation_id, message_id, original_content,
           brand_score, scores_breakdown, feedback, suggested_rewrite, applied, created_at
    FROM brand_coach_scores
    WHERE client_id = ? AND user_id = ?
      AND created_at >= ? AND created_at <= ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(clientId, userId, from || 0, to || Date.now(), limit);
};

// ─── 標記採用改寫 ───
export const markApplied = ({ id, client_id }) => {
  db.prepare(`
    UPDATE brand_coach_scores SET applied = 1 WHERE id = ? AND client_id = ?
  `).run(parseInt(id, 10), parseInt(client_id, 10));
};

export default { ensureBrandCoachSchema, scoreMessage, getLeaderboard, getUserScores, markApplied };
