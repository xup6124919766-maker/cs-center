/**
 * rules.js — 規則引擎 V1
 *
 * ensureRulesSchema()
 * evaluateRules(client_id, message, context) — 評估並執行符合的規則
 * seedDefaultRules(client_id) — 建立預設規則（梵森 seed）
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';
import { emitToClient } from './realtime.js';

const log = rootLogger.child({ module: 'rules' });

// ─── Schema ───
export const ensureRulesSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      trigger TEXT NOT NULL,
      action TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      trigger_count INTEGER DEFAULT 0,
      last_triggered_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rules_client ON automation_rules(client_id, enabled, priority);
  `);
  log.info('rules schema ready');
};

// ─── 關鍵字匹配 ───
const matchKeywords = (text, trigger) => {
  if (!text || !trigger?.keywords?.length) return false;
  const haystack = trigger.case_sensitive ? text : text.toLowerCase();
  const keywords = trigger.keywords.map(k =>
    trigger.case_sensitive ? k : k.toLowerCase()
  );
  if (trigger.match_type === 'all') {
    return keywords.every(k => haystack.includes(k));
  }
  // 預設 'any'
  return keywords.some(k => haystack.includes(k));
};

// ─── lazy import template（避免循環依賴）───
let _renderTemplate = null;
const getRenderer = async () => {
  if (!_renderTemplate) {
    try {
      const mod = await import('./template.js');
      _renderTemplate = mod.renderTemplate;
    } catch { _renderTemplate = (c) => c; }
  }
  return _renderTemplate;
};

// ─── 執行 keyword_reply ───
const executeKeywordReply = async (rule, context) => {
  const { conversation_id, client_id } = context;
  const action = rule.action_parsed;
  const content = action?.payload?.content;
  if (!content) return;

  // 套用訊息範本變數
  let finalContent = content;
  try {
    const renderTemplate = await getRenderer();
    finalContent = renderTemplate(content, context.templateContext || {});
  } catch {}

  const now = Date.now();
  const msgId = db.prepare(`
    INSERT INTO messages (conversation_id, direction, sender_type, content_type, content, created_at)
    VALUES (?, 'outbound', 'system', 'text', ?, ?)
  `).run(conversation_id, finalContent, now).lastInsertRowid;

  db.prepare(`UPDATE conversations SET last_message_at = ?, last_message_preview = ?, updated_at = ? WHERE id = ?`)
    .run(now, finalContent.slice(0, 100), now, conversation_id);

  emitToClient(client_id, 'message:reply', {
    conversation_id,
    message: { id: msgId, direction: 'outbound', sender_type: 'system', content: finalContent, created_at: now },
  });

  log.info({ rule_id: rule.id, conversation_id, client_id }, 'keyword_reply executed');
};

// ─── 執行 auto_tag ───
const executeAutoTag = (rule, context) => {
  const { customer_id, client_id } = context;
  if (!customer_id) return;

  const action = rule.action_parsed;
  const newTags = action?.payload?.tags;
  if (!Array.isArray(newTags) || !newTags.length) return;

  const customer = db.prepare('SELECT tags FROM customers WHERE id = ? AND client_id = ?').get(customer_id, client_id);
  if (!customer) return;

  let existingTags = [];
  try { existingTags = JSON.parse(customer.tags || '[]'); } catch {}

  const merged = [...new Set([...existingTags, ...newTags])];
  db.prepare('UPDATE customers SET tags = ?, updated_at = ? WHERE id = ? AND client_id = ?')
    .run(JSON.stringify(merged), Date.now(), customer_id, client_id);

  log.info({ rule_id: rule.id, customer_id, tags: newTags }, 'auto_tag executed');
};

// ─── 執行 alert ───
const executeAlert = (rule, context) => {
  const { conversation_id, client_id, message } = context;
  const action = rule.action_parsed;
  const level = action?.payload?.level || 'urgent';
  const notifyUsers = action?.payload?.notify_users || [];

  const alertPayload = {
    conversation_id,
    rule_id: rule.id,
    rule_name: rule.name,
    level,
    message_preview: (message || '').slice(0, 100),
    notify_users: notifyUsers,
  };

  emitToClient(client_id, 'alert:urgent', alertPayload);

  // Webhook 出口分派（非阻塞）— 由呼叫方（server.js/realtime）另行處理，此處不重複引入

  // 寫 audit log
  try {
    db.prepare(`
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, created_at)
      VALUES (NULL, 'rule_alert', 'conversation', ?, ?, ?)
    `).run(conversation_id, JSON.stringify({ rule_id: rule.id, rule_name: rule.name, level }), Date.now());
  } catch {}

  log.warn({ rule_id: rule.id, conversation_id, client_id, level }, 'alert rule triggered');
};

// ─── 主評估函式 ───
export const evaluateRules = async (client_id, message, context = {}) => {
  if (!message || !client_id) return;

  const rules = db.prepare(`
    SELECT * FROM automation_rules
    WHERE client_id = ? AND enabled = 1
    ORDER BY priority DESC, id ASC
  `).all(client_id);

  if (!rules.length) return;

  const triggered = [];

  for (const rule of rules) {
    let trigger, action;
    try { trigger = JSON.parse(rule.trigger || '{}'); } catch { continue; }
    try { action = JSON.parse(rule.action || '{}'); } catch { continue; }

    rule.trigger_parsed = trigger;
    rule.action_parsed = action;

    if (!matchKeywords(message, trigger)) continue;

    triggered.push(rule);

    // 更新 trigger 統計
    db.prepare(`
      UPDATE automation_rules SET trigger_count = trigger_count + 1, last_triggered_at = ?, updated_at = ? WHERE id = ?
    `).run(Date.now(), Date.now(), rule.id);

    const ctx = { ...context, client_id, message };

    if (rule.rule_type === 'keyword_reply') {
      await executeKeywordReply(rule, ctx);
    } else if (rule.rule_type === 'auto_tag') {
      executeAutoTag(rule, ctx);
    } else if (rule.rule_type === 'alert') {
      executeAlert(rule, ctx);
    }
  }

  return triggered;
};

// ─── 預設規則 seed ───
export const seedDefaultRules = (clientId) => {
  const existing = db.prepare('SELECT COUNT(*) AS cnt FROM automation_rules WHERE client_id = ?').get(clientId);
  if (existing.cnt > 0) return;

  const now = Date.now();
  const rules = [
    {
      name: '客訴警示',
      rule_type: 'alert',
      trigger: JSON.stringify({ keywords: ['客訴','投訴','律師','消基會','賠償','申訴'], match_type: 'any', case_sensitive: false }),
      action: JSON.stringify({ type: 'alert', payload: { level: 'urgent', notify_users: [] } }),
      priority: 10,
    },
    {
      name: 'VIP 自動標籤',
      rule_type: 'auto_tag',
      trigger: JSON.stringify({ keywords: ['VIP','貴賓','大訂單','批發'], match_type: 'any', case_sensitive: false }),
      action: JSON.stringify({ type: 'auto_tag', payload: { tags: ['VIP'] } }),
      priority: 5,
    },
    {
      name: '營業時間自動回覆',
      rule_type: 'keyword_reply',
      trigger: JSON.stringify({ keywords: ['營業時間','幾點開'], match_type: 'any', case_sensitive: false }),
      action: JSON.stringify({ type: 'keyword_reply', payload: { content: '營業時間 09:00-18:00（週一至週五），週末及假日將於次一工作日回覆，感謝您的耐心等候！' } }),
      priority: 0,
    },
  ];

  const stmt = db.prepare(`
    INSERT INTO automation_rules (client_id, name, rule_type, trigger, action, enabled, priority, trigger_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?)
  `);

  for (const r of rules) {
    stmt.run(clientId, r.name, r.rule_type, r.trigger, r.action, r.priority, now, now);
  }

  log.info({ client_id: clientId, count: rules.length }, '已建立預設規則');
};

export default { ensureRulesSchema, evaluateRules, seedDefaultRules };
