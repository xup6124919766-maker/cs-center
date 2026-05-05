/**
 * intent.js — 情緒偵測 + 意圖分類 + 對話摘要
 *
 * classifyMessage(message, context, brandDna) → { intent, emotion, urgency }
 * summarizeConversation(messages) → string
 */

import { chat } from './ai.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'intent' });

const INTENT_LABELS   = ['詢價', '下單', '客訴', '物流', '售後', '成分諮詢', '其他'];
const EMOTION_LABELS  = ['neutral', 'positive', 'negative', 'angry'];
const URGENCY_LABELS  = ['low', 'normal', 'high'];

// ─── 情緒偵測 + 意圖分類 ───
export const classifyMessage = async (message, contextMessages = [], brandDna = {}) => {
  // 防禦：contextMessages 必須是陣列
  const safeCtx = Array.isArray(contextMessages) ? contextMessages : [];
  const contextStr = safeCtx
    .slice(-3)
    .map(m => `[${m.direction === 'inbound' ? '顧客' : '客服'}] ${m.content || ''}`)
    .join('\n');

  const system = `你是客服智能分析助手。分析顧客訊息的意圖、情緒和緊急程度，用 JSON 回答。
品牌：${brandDna.tone || '一般'}
意圖選項：${INTENT_LABELS.join('|')}
情緒選項：${EMOTION_LABELS.join('|')}
緊急程度選項：${URGENCY_LABELS.join('|')}
只回 JSON，不要說明。`;

  // message 是字串（content 文字），不是 object
  const userContent = `對話上下文：\n${contextStr || '（無）'}\n\n最新顧客訊息：\n${typeof message === 'string' ? message : (message?.content || '')}`;

  const result = await chat({
    system,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: 128,
    json_schema: true,
  });

  if (!result.ok || !result.json) {
    log.warn({ err: result.error }, 'classifyMessage AI failed, using defaults');
    return { intent: '其他', emotion: 'neutral', urgency: 'normal' };
  }

  const j = result.json;
  const intent   = INTENT_LABELS.includes(j.intent)   ? j.intent   : '其他';
  const emotion  = EMOTION_LABELS.includes(j.emotion)  ? j.emotion  : 'neutral';
  const urgency  = URGENCY_LABELS.includes(j.urgency)  ? j.urgency  : 'normal';

  log.info({ intent, emotion, urgency }, 'classified message');
  return { intent, emotion, urgency };
};

// ─── 對話摘要（P8 升級：回傳結構化 JSON）───
export const summarizeConversation = async (messages = []) => {
  if (!messages.length) return null;

  const history = messages
    .slice(-20)
    .map(m => {
      const who = m.direction === 'inbound' ? '顧客' : (m.sender_type === 'note' ? '[備忘]' : '客服');
      return `${who}: ${m.content || ''}`;
    })
    .join('\n');

  const system = `你是客服摘要助手，請根據對話記錄，產出以下 JSON 格式（不要說明，只回 JSON）：
{
  "summary": "3 句話摘要：①顧客問什麼 ②目前處理到哪 ③待辦事項",
  "key_intent": "詢價|下單|客訴|物流|售後|成分諮詢|其他",
  "key_entities": { "products": [], "order_ids": [] },
  "action_required": "需要客服做什麼，例如：等顧客回覆 / 寄出商品 / 處理退貨"
}
使用繁體中文，summary 控制在 100 字內。`;

  const result = await chat({
    system,
    messages: [{ role: 'user', content: `對話記錄：\n${history}` }],
    max_tokens: 512,
    json_schema: true,
  });

  if (!result.ok) {
    log.warn({ err: result.error }, 'summarizeConversation AI failed');
    return null;
  }

  // 優先用 result.json，fallback 嘗試解析 result.text
  let parsed = result.json;
  if (!parsed && result.text) {
    try {
      const match = result.text.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    } catch {}
  }

  if (!parsed?.summary) {
    // 嘗試從 raw text 提取 JSON（去除 markdown code fence、雙層嵌套）
    let text = (result.text || '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    try {
      const obj = JSON.parse(text);
      if (obj?.summary) {
        let s = String(obj.summary).trim();
        if (s.startsWith('{')) {
          try { const inner = JSON.parse(s); if (inner?.summary) s = String(inner.summary).trim(); } catch {}
        }
        return {
          summary: s, key_intent: obj.key_intent || null,
          key_entities: obj.key_entities || { products: [], order_ids: [] },
          action_required: obj.action_required || null,
        };
      }
    } catch {}
    // 強力 regex：直接挖 "summary": "..." 的內容（管它是 truncated JSON 還是巢狀）
    const m = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*?)"\s*[,}]/);
    if (m && m[1]) {
      const summary = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
      const intentM = text.match(/"key_intent"\s*:\s*"([^"]*)"/);
      const actionM = text.match(/"action_required"\s*:\s*"((?:[^"\\]|\\.)*?)"/);
      return {
        summary, key_intent: intentM?.[1] || null,
        key_entities: { products: [], order_ids: [] },
        action_required: actionM ? actionM[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : null,
      };
    }
    return { summary: text, key_intent: null, key_entities: { products: [], order_ids: [] }, action_required: null };
  }

  // parsed.summary 存在，也防雙層 JSON
  let cleanSum = String(parsed.summary || '').trim();
  if (cleanSum.startsWith('{') && cleanSum.includes('"summary"')) {
    const m = cleanSum.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*?)"/);
    if (m && m[1]) cleanSum = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
  }
  parsed.summary = cleanSum;

  const INTENT_LABELS = ['詢價', '下單', '客訴', '物流', '售後', '成分諮詢', '其他'];

  // 防 AI 回覆套娃 JSON：如果 summary 本身又是 JSON 字串，再解一次
  let cleanSummary = String(parsed.summary || '').trim();
  if (cleanSummary.startsWith('{') && cleanSummary.includes('"summary"')) {
    try {
      const inner = JSON.parse(cleanSummary);
      if (inner?.summary) cleanSummary = String(inner.summary).trim();
    } catch {}
  }
  // 移除可能殘留的 markdown code fence
  cleanSummary = cleanSummary.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  return {
    summary: cleanSummary,
    key_intent: INTENT_LABELS.includes(parsed.key_intent) ? parsed.key_intent : null,
    key_entities: {
      products: Array.isArray(parsed.key_entities?.products) ? parsed.key_entities.products : [],
      order_ids: Array.isArray(parsed.key_entities?.order_ids) ? parsed.key_entities.order_ids : [],
    },
    action_required: parsed.action_required ? String(parsed.action_required).trim() : null,
  };
};

export default { classifyMessage, summarizeConversation };
