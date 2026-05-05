/**
 * template.js — 訊息範本變數替換
 *
 * renderTemplate(content, context) — 替換 {variable} 佔位符
 * buildTemplateContext(conversation_id, client_id) — 從 DB 組裝 context
 *
 * 支援變數：
 *   {customer.name} {customer.phone} {customer.tags}
 *   {conversation.intent} {conversation.id}
 *   {order.tracking_number} {order.status}
 *   {date.today} {date.now} {client.display_name}
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'template' });

// ─── 簡易 mustache-like 替換 ───
export const renderTemplate = (content, context = {}) => {
  if (!content) return content;

  return content.replace(/\{([^}]+)\}/g, (match, key) => {
    const parts = key.trim().split('.');
    let val = context;
    for (const part of parts) {
      if (val == null) return match;
      val = val[part];
    }
    if (val == null || val === undefined) return match;
    return String(val);
  });
};

// ─── 組裝 context 物件 ───
export const buildTemplateContext = (conversationId, clientId) => {
  const ctx = {
    customer: {},
    conversation: {},
    order: {},
    date: {
      today: new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }),
      now: new Date().toLocaleString('zh-TW', { hour: '2-digit', minute: '2-digit' }),
    },
    client: {},
  };

  try {
    // conversation
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (conv) {
      ctx.conversation.id = conv.id;
      ctx.conversation.intent = conv.intent || '';
      ctx.conversation.status = conv.status || '';

      // customer
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(conv.customer_id);
      if (customer) {
        ctx.customer.name = customer.name || '';
        ctx.customer.phone = customer.phone || '';
        ctx.customer.email = customer.email || '';
        let tags = [];
        try { tags = JSON.parse(customer.tags || '[]'); } catch {}
        ctx.customer.tags = tags.join('、');
      }
    }

    // client
    if (clientId) {
      const client = db.prepare('SELECT display_name FROM clients WHERE id = ?').get(clientId);
      if (client) ctx.client.display_name = client.display_name || '';
    }

    // order（最近一筆）
    try {
      const order = db.prepare(`
        SELECT * FROM orders WHERE client_id = ? ORDER BY ordered_at DESC LIMIT 1
      `).get(clientId);
      if (order) {
        ctx.order.tracking_number = order.tracking_number || '';
        ctx.order.status = order.status || '';
        ctx.order.id = order.id || '';
      }
    } catch {}
  } catch (e) {
    log.warn({ err: e.message }, 'buildTemplateContext error');
  }

  return ctx;
};

// ─── 可用變數說明（給前端 UI 用）───
export const AVAILABLE_VARIABLES = [
  { key: '{customer.name}',        label: '顧客姓名' },
  { key: '{customer.phone}',       label: '顧客電話' },
  { key: '{customer.email}',       label: '顧客 Email' },
  { key: '{customer.tags}',        label: '顧客標籤' },
  { key: '{conversation.id}',      label: '對話 ID' },
  { key: '{conversation.intent}',  label: '對話意圖' },
  { key: '{order.tracking_number}', label: '物流追蹤號' },
  { key: '{order.status}',         label: '訂單狀態' },
  { key: '{date.today}',           label: '今天日期' },
  { key: '{date.now}',             label: '現在時間' },
  { key: '{client.display_name}',  label: '品牌名稱' },
];

export default { renderTemplate, buildTemplateContext, AVAILABLE_VARIABLES };
