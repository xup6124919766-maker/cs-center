/**
 * ai.js — 統一 AI 客戶端（零依賴，直接 fetch API）
 *
 * 支援 Anthropic Claude + Gemini fallback
 * AI_PROVIDER=auto 時優先用 Anthropic，失敗則 Gemini
 *
 * P3 新增：
 *   - 用量追蹤 → ai_usage 表
 *   - 預算上限檢查（clients.ai_budget_usd > 0 時啟用）
 */

import { logger as rootLogger } from './logger.js';
import { db } from './db.js';

const log = rootLogger.child({ module: 'ai' });

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta';

const AI_PROVIDER = () => process.env.AI_PROVIDER || 'auto';
const AI_MODEL    = () => process.env.AI_MODEL    || 'claude-haiku-4-5-20251001';
const ANTHROPIC_KEY = () => process.env.ANTHROPIC_API_KEY || '';
const GEMINI_KEY    = () => process.env.GEMINI_API_KEY    || '';

// ─── feature 別模型對照 ───
// AI_DRAFT_MODEL / AI_VOC_MODEL 可透過環境變數覆寫；
// 預設 draft 用 gemini-2.0-flash（最快）；voc 用 gemini-2.0-flash（輕量省錢）
const FEATURE_MODEL = {
  draft: () => process.env.AI_DRAFT_MODEL || 'gemini-2.0-flash',
  voc:   () => process.env.AI_VOC_MODEL   || 'gemini-2.0-flash',
};

// ─── 成本表（$/M tokens）───
const COST_TABLE = {
  'claude-haiku-4-5':            { input: 1.00 / 1e6, output: 5.00  / 1e6 },
  'claude-haiku-4-5-20251001':   { input: 1.00 / 1e6, output: 5.00  / 1e6 },
  'claude-sonnet-4-6':           { input: 3.00 / 1e6, output: 15.00 / 1e6 },
  'claude-sonnet-4-6-20251001':  { input: 3.00 / 1e6, output: 15.00 / 1e6 },
  'gemini-2.5-flash':            { input: 0,           output: 0           },
  'gemini-2.0-flash':            { input: 0,           output: 0           },
  'gemini-2.5-flash-lite':       { input: 0,           output: 0           },
  'gemini-1.5-pro':              { input: 1.25 / 1e6, output: 5.00  / 1e6 },
};

const estimateCost = (model, inputTokens, outputTokens) => {
  const m = model?.toLowerCase() || '';
  // 找最長匹配前綴
  const key = Object.keys(COST_TABLE).find(k => m.startsWith(k)) || '';
  const rates = COST_TABLE[key] || { input: 0, output: 0 };
  return rates.input * (inputTokens || 0) + rates.output * (outputTokens || 0);
};

// ─── 寫入用量記錄 ───
const recordUsage = ({ client_id, user_id, feature, provider, model, input_tokens, output_tokens, conversation_id }) => {
  if (!client_id) return;
  const cost = estimateCost(model, input_tokens, output_tokens);
  try {
    db.prepare(`
      INSERT INTO ai_usage (client_id, user_id, feature, provider, model, input_tokens, output_tokens, cost_usd, conversation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(client_id ?? null, user_id ?? null, feature || 'unknown', provider, model || null,
      input_tokens || 0, output_tokens || 0, cost, conversation_id ?? null, Date.now());
  } catch (e) {
    log.warn({ err: e.message }, 'ai_usage record failed');
  }
};

// ─── 預算檢查 ───
const checkBudget = (client_id) => {
  if (!client_id) return { ok: true };
  try {
    const client = db.prepare('SELECT ai_budget_usd, ai_budget_period FROM clients WHERE id = ?').get(client_id);
    if (!client || !client.ai_budget_usd || client.ai_budget_usd <= 0) return { ok: true };

    const budget = client.ai_budget_usd;
    const period = client.ai_budget_period || 'monthly';

    const now = Date.now();
    let periodStart;
    if (period === 'monthly') {
      const d = new Date(now);
      periodStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    } else if (period === 'daily') {
      const d = new Date(now);
      periodStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    } else {
      periodStart = 0;
    }

    const row = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_usage
      WHERE client_id = ? AND created_at >= ?
    `).get(client_id, periodStart);

    if (row.total >= budget) {
      log.warn({ client_id, budget, used: row.total, period }, 'AI budget exceeded');
      return { ok: false, error: 'AI budget exceeded', used: row.total, budget };
    }
    return { ok: true, used: row.total, budget };
  } catch { return { ok: true }; }
};

// ─── Anthropic ───
const callAnthropic = async ({ messages, system, model, max_tokens = 1024, json_schema = null }) => {
  const key = ANTHROPIC_KEY();
  if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY 未設定' };

  const body = {
    model: model || AI_MODEL(),
    max_tokens,
    messages,
  };

  if (system) {
    // 支援 prompt caching
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }

  try {
    const r = await fetch(`${ANTHROPIC_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!r.ok) {
      const err = await r.text();
      log.error({ status: r.status, body: err }, 'anthropic API error');
      return { ok: false, error: `Anthropic ${r.status}: ${err.slice(0, 200)}` };
    }

    const data = await r.json();
    const content = data.content?.[0]?.text || '';
    const inputTok  = data.usage?.input_tokens  || 0;
    const outputTok = data.usage?.output_tokens || 0;
    log.info({ model: data.model, input_tokens: inputTok, output_tokens: outputTok }, 'anthropic OK');

    if (json_schema) {
      try {
        const parsed = JSON.parse(content);
        return { ok: true, text: content, json: parsed, provider: 'anthropic', input_tokens: inputTok, output_tokens: outputTok, model: data.model };
      } catch {
        // 嘗試提取 JSON
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            return { ok: true, text: content, json: JSON.parse(match[0]), provider: 'anthropic', input_tokens: inputTok, output_tokens: outputTok, model: data.model };
          } catch {}
        }
        log.warn({ content }, 'anthropic JSON parse failed, returning raw text');
        return { ok: true, text: content, json: null, provider: 'anthropic', input_tokens: inputTok, output_tokens: outputTok, model: data.model };
      }
    }

    return { ok: true, text: content, provider: 'anthropic', input_tokens: inputTok, output_tokens: outputTok, model: data.model };
  } catch (e) {
    log.error({ err: e.message }, 'anthropic fetch error');
    return { ok: false, error: e.message };
  }
};

// ─── Gemini ───
const callGemini = async ({ messages, system, model, max_tokens = 1024, json_schema = null }) => {
  const key = GEMINI_KEY();
  if (!key) return { ok: false, error: 'GEMINI_API_KEY 未設定' };

  // 組成 Gemini 格式
  const geminiMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  // 優先用傳入的 model，否則預設 gemini-2.5-flash
  const geminiModel = model || 'gemini-2.5-flash';

  const body = {
    contents: geminiMessages,
    generationConfig: {
      maxOutputTokens: max_tokens,
      // json_schema 模式：要求 JSON 輸出，避免 markdown code block 截斷
      ...(json_schema ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  try {
    const r = await fetch(
      `${GEMINI_BASE}/models/${geminiModel}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      }
    );

    if (!r.ok) {
      const err = await r.text();
      log.error({ status: r.status, body: err }, 'gemini API error');
      return { ok: false, error: `Gemini ${r.status}: ${err.slice(0, 200)}` };
    }

    const data = await r.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    log.info({ provider: 'gemini' }, 'gemini OK');

    // 剝掉 markdown code block（Gemini 常回 ```json ... ```）
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    // 嘗試解析 JSON
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!json) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { json = JSON.parse(match[0]); } catch {}
      }
    }

    if (!json) {
      log.warn({ text_len: text.length, text_end: text.slice(-100), finish_reason: data.candidates?.[0]?.finishReason }, 'gemini JSON parse failed');
    }

    const usageMeta = data.usageMetadata || {};
    return {
      ok: true, text, json, provider: 'gemini',
      model: geminiModel,
      input_tokens: usageMeta.promptTokenCount || 0,
      output_tokens: usageMeta.candidatesTokenCount || 0,
    };
  } catch (e) {
    log.error({ err: e.message }, 'gemini fetch error');
    return { ok: false, error: e.message };
  }
};

// ─── 主要 chat 函式（自動 fallback）───
// opts 支援額外欄位：client_id, user_id, feature, conversation_id（用於用量追蹤）
export const chat = async (opts) => {
  const { client_id, user_id, feature, conversation_id, ...callOpts } = opts;

  // 預算檢查
  if (client_id) {
    const budget = checkBudget(client_id);
    if (!budget.ok) return { ok: false, error: budget.error, used: budget.used, budget: budget.budget };
  }

  // feature 別模型注入：若呼叫端沒有指定 model，根據 feature 自動選快速模型
  // 支援 AI_DRAFT_MODEL / AI_VOC_MODEL 環境變數覆寫
  if (feature && FEATURE_MODEL[feature] && !callOpts.model) {
    callOpts.model = FEATURE_MODEL[feature]();
    log.debug({ feature, model: callOpts.model }, 'feature model selected');
  }

  const provider = AI_PROVIDER();
  let result;

  // 若選到 gemini-* 模型，不論 AI_PROVIDER 設定一律走 Gemini 路徑（避免 Anthropic 不認識此模型）
  const isGeminiModel = (callOpts.model || '').startsWith('gemini-');

  if (provider === 'gemini' || isGeminiModel) {
    if (!GEMINI_KEY()) return { ok: false, error: 'GEMINI_API_KEY 未設定' };
    result = await callGemini(callOpts);
  } else if (provider === 'anthropic') {
    result = await callAnthropic(callOpts);
  } else {
    // auto: 優先 Anthropic
    if (ANTHROPIC_KEY()) {
      result = await callAnthropic(callOpts);
      if (!result.ok) {
        log.warn({ err: result.error }, 'anthropic failed, trying gemini');
        if (GEMINI_KEY()) result = await callGemini(callOpts);
      }
    } else if (GEMINI_KEY()) {
      result = await callGemini(callOpts);
    } else {
      return { ok: false, error: 'AI_API_KEY 未設定（需要 ANTHROPIC_API_KEY 或 GEMINI_API_KEY）' };
    }
  }

  // 用量追蹤（僅在成功時記錄）
  if (result?.ok && client_id) {
    recordUsage({
      client_id,
      user_id: user_id ?? null,
      feature: feature || 'unknown',
      provider: result.provider || provider,
      model: result.model || callOpts.model || AI_MODEL(),
      input_tokens: result.input_tokens || 0,
      output_tokens: result.output_tokens || 0,
      conversation_id: conversation_id ?? null,
    });
  }

  return result;
};

export default { chat };
