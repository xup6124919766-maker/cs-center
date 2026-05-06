/**
 * draft.js — AI Copilot 草擬（多版本）
 *
 * generateDrafts({ conversation_id, client_id, user_id })
 * approveDraft({ draft_id, edited_content, user_id })
 * applyDnaFilter(content, brandDna) → { ok, content, violations, warnings }
 */

import { chat } from './ai.js';
import { logger as rootLogger } from './logger.js';
import { db } from './db.js';
import { maskPII, unmaskPII } from './pii.js';

const log = rootLogger.child({ module: 'draft' });

// ─── DNA Filter ───
export const applyDnaFilter = (content, brandDna = {}) => {
  let result = content || '';
  const violations = [];
  const warnings   = [];

  // 檢查 forbidden_words
  const forbidden = Array.isArray(brandDna.forbidden_words) ? brandDna.forbidden_words : [];
  for (const word of forbidden) {
    if (result.includes(word)) {
      violations.push(word);
      warnings.push(`包含禁用詞「${word}」`);
    }
  }

  // 自動加 signature（如果 auto_signature=true 且尾端沒有）
  if (brandDna.auto_signature && brandDna.signature) {
    if (!result.endsWith(brandDna.signature)) {
      result = result.trimEnd() + '\n' + brandDna.signature;
    }
  }

  // 檢查 required_phrases
  const required = Array.isArray(brandDna.required_phrases) ? brandDna.required_phrases : [];
  for (const phrase of required) {
    if (!result.includes(phrase)) {
      warnings.push(`缺少必要語句「${phrase}」`);
    }
  }

  return { ok: violations.length === 0, content: result, violations, warnings };
};

// ─── 從 learning_pairs 抓最相似的 N 組過去（顧客→客服）配對當 few-shot 範例 ───
// 簡單實作：tokenize 顧客訊息，找過去 customer_msg 共同 token 最多的 N 組（CSAT 高優先）
const findSimilarLearningPairs = (clientId, queryText, n = 3) => {
  if (!queryText || !clientId) return [];
  const words = queryText.split(/[\s，。！？,.!?]+/).filter(w => w.length >= 2);
  if (!words.length) return [];
  const conditions = words.slice(0, 8).map(() => 'customer_msg LIKE ?').join(' OR ');
  const params = words.slice(0, 8).map(w => `%${w}%`);
  try {
    const rows = db.prepare(`
      SELECT customer_msg, agent_msg, csat_score, used_ai_draft
      FROM learning_pairs
      WHERE client_id = ? AND (${conditions})
      ORDER BY
        CASE WHEN csat_score >= 4 THEN 0 ELSE 1 END,
        used_ai_draft DESC,
        created_at DESC
      LIMIT ?
    `).all(clientId, ...params, n);
    return rows;
  } catch { return []; }
};

// ─── keyword 匹配知識庫 top3 ───
const findRelevantQa = (clientId, queryText) => {
  if (!queryText || !clientId) return [];
  const words = queryText.split(/[\s，。！？,.!?]+/).filter(w => w.length >= 2);
  if (!words.length) return [];

  // 用 LIKE 匹配每個詞，取 hit_count 最高
  const conditions = words.map(() => '(question LIKE ? OR answer LIKE ?)').join(' OR ');
  const params = words.flatMap(w => [`%${w}%`, `%${w}%`]);

  try {
    const rows = db.prepare(`
      SELECT id, question, answer, category
      FROM qa_pairs
      WHERE client_id = ? AND (${conditions})
      ORDER BY hit_count DESC, updated_at DESC
      LIMIT 3
    `).all(clientId, ...params);

    // 更新 hit_count
    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      db.prepare(`UPDATE qa_pairs SET hit_count = hit_count + 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }

    return rows;
  } catch {
    return [];
  }
};

// ─── generateDrafts ───
export const generateDrafts = async ({ conversation_id, client_id, user_id = null, realtime = null }) => {
  const convId = parseInt(conversation_id, 10);
  const clientId = parseInt(client_id, 10);

  // 1. 取最近 8 則訊息
  const messages = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 8
  `).all(convId).reverse();

  // 2. 取 conversation + customer
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND client_id = ?').get(convId, clientId);
  if (!conv) {
    log.error({ conversation_id: convId, client_id: clientId }, 'conversation not found for draft');
    return { ok: false, error: '對話不存在' };
  }

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(conv.customer_id);

  // 3. 取 brand_dna
  const clientRow = db.prepare('SELECT brand_dna FROM clients WHERE id = ?').get(clientId);
  let brandDna = {};
  try { brandDna = JSON.parse(clientRow?.brand_dna || '{}'); } catch {}

  // 4. 最後一則 inbound 訊息 → 知識庫匹配 + 過去類似對話配對
  const lastInbound = [...messages].reverse().find(m => m.direction === 'inbound');
  const qaMatches = findRelevantQa(clientId, lastInbound?.content);
  const learningPairs = findSimilarLearningPairs(clientId, lastInbound?.content, 3);

  // 5. 組 system prompt
  const dnaStr = [
    brandDna.tone ? `語氣：${brandDna.tone}` : '',
    brandDna.signature ? `署名：${brandDna.signature}` : '',
    Array.isArray(brandDna.forbidden_words) && brandDna.forbidden_words.length
      ? `禁用詞：${brandDna.forbidden_words.join('、')}` : '',
    Array.isArray(brandDna.required_phrases) && brandDna.required_phrases.length
      ? `必要語句：${brandDna.required_phrases.join('、')}` : '',
    Array.isArray(brandDna.product_lines) && brandDna.product_lines.length
      ? `產品線：${brandDna.product_lines.join('、')}` : '',
  ].filter(Boolean).join('\n');

  const customerStr = [
    customer?.name ? `顧客姓名：${customer.name}` : '',
    customer?.notes ? `備註：${customer.notes}` : '',
    (() => { try { const tags = JSON.parse(customer?.tags || '[]'); return tags.length ? `標籤：${tags.join('、')}` : ''; } catch { return ''; } })(),
    (() => { try { const cf = JSON.parse(customer?.custom_fields || '{}'); const entries = Object.entries(cf).filter(([,v]) => v); return entries.length ? `自訂屬性：${entries.map(([k,v]) => `${k}=${v}`).join('、')}` : ''; } catch { return ''; } })(),
  ].filter(Boolean).join('\n');

  const qaStr = qaMatches.length
    ? qaMatches.map(q => `Q: ${q.question}\nA: ${q.answer}`).join('\n\n')
    : '（無相關知識庫）';

  // 過去你（客服）面對類似訊息實際回過的「優質範例」— AI 模仿這些口吻
  const learningStr = learningPairs.length
    ? learningPairs.map((p, i) => `範例 ${i + 1}\n顧客：${p.customer_msg}\n你的回覆：${p.agent_msg}`).join('\n\n')
    : '（暫無過去類似對話可參考）';

  const historyStr = messages.map(m => {
    const who = m.direction === 'inbound' ? '顧客' : (m.sender_type === 'note' ? '[備忘]' : '客服');
    return `${who}: ${m.content || ''}`;
  }).join('\n');

  // 優先用業主自訂的 system_prompt（梵森的「品牌大腦」），沒有則組合零碎 DNA
  const customPrompt = brandDna?.system_prompt || null;

  const system = customPrompt
    ? `${customPrompt}

== 顧客資訊 ==
${customerStr || '（未知）'}

== 知識庫參考 ==
${qaStr}

== 你過去類似情境的回覆風格（重要：模仿這些範例的口吻、用詞、結構）==
${learningStr}

== 任務 ==
基於上述品牌人格、顧客脈絡，**特別參考「你過去類似情境的回覆風格」**，幫客服起草三個版本的回覆。三個版本都必須符合品牌語調與過去範例的調性，差別在於：
- professional：完整、清楚（4-step 銷售邏輯走完）
- friendly：親近、像朋友（重情緒共鳴）
- concise：簡短、直接（核心一句帶到）

只回 JSON，格式：
{"drafts":[{"variant":"professional","content":"..."},{"variant":"friendly","content":"..."},{"variant":"concise","content":"..."}]}`
    : `你是專業客服 AI 助理。根據品牌 DNA、知識庫和對話歷史，幫客服起草三個版本的回覆。

== 品牌 DNA ==
${dnaStr || '（未設定）'}

== 顧客資訊 ==
${customerStr || '（未知）'}

== 知識庫參考 ==
${qaStr}

只回 JSON，格式：
{"drafts":[{"variant":"professional","content":"..."},{"variant":"friendly","content":"..."},{"variant":"concise","content":"..."}]}`;

  const userMsg = `對話歷史：\n${historyStr || '（無）'}\n\n請產生三個版本回覆。`;

  // 6. PII 遮蔽（業主啟用時，發送 AI 前 mask；回來再 unmask）
  const piiEnabled = clientRow?.pii_masking_enabled !== 0;
  const { masked: maskedSystem, map: sysMap } = piiEnabled ? maskPII(system) : { masked: system, map: [] };
  const { masked: maskedUserMsg, map: userMap } = piiEnabled ? maskPII(userMsg) : { masked: userMsg, map: [] };
  const piiMap = [...sysMap, ...userMap];

  // 7. 呼叫 AI
  // max_tokens 從 4096 降到 1500：每個 variant ~150 token，三個版本 ~450 token + JSON 結構綽綽有餘
  // feature='draft' 會讓 ai.js 自動選用快速模型（gemini-2.0-flash 或 AI_DRAFT_MODEL 環境變數）
  // TODO: 未來可改 streaming，讓第一個 variant 先出現，體感更快
  const aiResult = await chat({
    system: maskedSystem,
    messages: [{ role: 'user', content: maskedUserMsg }],
    max_tokens: 1500,
    json_schema: true,
    feature: 'draft',
    client_id: clientId,
    conversation_id: convId,
  });

  if (!aiResult.ok) {
    log.error({ err: aiResult.error }, 'generateDrafts AI failed');
    return { ok: false, error: aiResult.error || 'AI 生成失敗' };
  }
  if (!aiResult.json?.drafts) {
    log.error({ text_preview: (aiResult.text || '').slice(0, 200), json: aiResult.json }, 'generateDrafts AI JSON parse failed');
    return { ok: false, error: 'AI 回傳格式錯誤（無法解析 JSON）' };
  }

  const drafts = aiResult.json.drafts;
  if (!Array.isArray(drafts) || !drafts.length) {
    return { ok: false, error: 'AI 回傳格式錯誤' };
  }

  // 7. DNA filter + 寫入 DB
  const now = Date.now();
  const insertedIds = [];

  // 先標記舊 drafts 為 expired
  try {
    db.prepare(`UPDATE drafts SET status = 'expired' WHERE conversation_id = ? AND status = 'pending'`).run(convId);
  } catch {}

  for (const d of drafts) {
    const variant  = d.variant  || 'professional';
    // PII 還原：AI 若引用了 [PHONE0]/[ID]/[EMAIL] 等 token，還原成原始值
    const rawContent = piiEnabled && piiMap.length ? unmaskPII(d.content || '', piiMap) : (d.content || '');
    const filtered = applyDnaFilter(rawContent, brandDna);

    if (filtered.warnings.length) {
      log.warn({ variant, warnings: filtered.warnings }, 'draft DNA warnings');
    }

    const id = db.prepare(`
      INSERT INTO drafts (conversation_id, variant, content, status, created_by_model, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(convId, variant, filtered.content, aiResult.provider || 'ai', now).lastInsertRowid;

    insertedIds.push({ id, variant, content: filtered.content, warnings: filtered.warnings });
  }

  log.info({ conversation_id: convId, count: insertedIds.length }, 'drafts generated');

  // 8. 推播 draft:ready
  if (realtime) {
    realtime.emitToClient(clientId, 'draft:ready', {
      conversation_id: convId,
      drafts: insertedIds,
    });
  }

  return { ok: true, drafts: insertedIds };
};

// ─── approveDraft ───
export const approveDraft = async ({ draft_id, edited_content, user_id }) => {
  const draftId = parseInt(draft_id, 10);
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  if (!draft) return { ok: false, error: '草擬不存在' };

  const isEdited = edited_content && edited_content.trim() !== draft.content.trim();
  const finalContent = isEdited ? edited_content.trim() : draft.content;
  const status = isEdited ? 'edited' : 'approved';

  db.prepare(`
    UPDATE drafts SET status = ?, edited_content = ?, approved_by_user_id = ?, approved_at = ?
    WHERE id = ?
  `).run(status, isEdited ? finalContent : null, user_id, Date.now(), draftId);

  return { ok: true, draft_id: draftId, status, content: finalContent, conversation_id: draft.conversation_id };
};

export default { generateDrafts, approveDraft, applyDnaFilter };
