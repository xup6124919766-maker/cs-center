/**
 * webhooks_out.js — Outbound Webhook 分派（Slack/Discord/Generic）
 *
 * ensureWebhooksOutSchema()
 * dispatchEvent(client_id, event_name, payload)
 *
 * 支援事件：alert:urgent、broadcast:done、mention、order:new、csat:received、game:winner
 */

import crypto from 'crypto';
import { db } from './db.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'webhooks_out' });

// ─── Schema ───
export const ensureWebhooksOutSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks_out (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      type TEXT DEFAULT 'slack',
      events TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      secret TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_out_client ON webhooks_out(client_id, enabled);
  `);
  log.info('webhooks_out schema ready');
};

// ─── Slack payload 格式化 ───
const formatSlackPayload = (event_name, payload) => {
  const colorMap = {
    'alert:urgent': '#e53935',
    'csat:received': '#f59e0b',
    'broadcast:done': '#06C755',
    'mention': '#1877F2',
    'order:new': '#7c3aed',
    'game:winner': '#f59e0b',
  };
  const color = colorMap[event_name] || '#8a8d91';

  let text = '';
  if (event_name === 'alert:urgent') {
    text = `🚨 緊急警示：對話 #${payload.conversation_id} — ${payload.rule_name || '未知規則'}\n訊息：${payload.message_preview || ''}`;
  } else if (event_name === 'broadcast:done') {
    text = `📢 廣播完成：ID ${payload.broadcast_id}，送出 ${payload.sent_count} 筆，失敗 ${payload.fail_count} 筆`;
  } else if (event_name === 'mention') {
    text = `👋 有人提及您：對話 #${payload.conversation_id}`;
  } else if (event_name === 'order:new') {
    text = `🛒 新訂單：${payload.external_order_id || payload.order_id}，金額 ${payload.total_amount || '?'}`;
  } else if (event_name === 'csat:received') {
    text = `⭐ CSAT 評分 ${payload.score}/5：${payload.comment || '（無留言）'}`;
  } else if (event_name === 'game:winner') {
    text = `🎉 遊戲中獎：活動 #${payload.activity_id}，獎品 ${payload.prize || '?'}`;
  } else if (event_name === 'feedback:received') {
    const src = payload.broadcast_id ? `廣播 #${payload.broadcast_id}` : `活動 #${payload.activity_id}`;
    const score = payload.rating ? `評分 ${payload.rating}/5` : (payload.feedback || '');
    text = `💬 收到顧客回饋 [${src}] ${score}${payload.comment ? '：' + payload.comment : ''}`;
  } else if (event_name === 'feedback:negative') {
    const src = payload.broadcast_id ? `廣播 #${payload.broadcast_id}` : `活動 #${payload.activity_id}`;
    text = `⚠️ 負面回饋警示 [${src}] 顧客 #${payload.customer_id || '匿名'} 回應：${payload.feedback}${payload.comment ? '　' + payload.comment : ''}`;
  } else if (event_name === 'feedback:5_star_activity') {
    text = `⭐ 活動 #${payload.activity_id} 獲得 5 星好評！${payload.comment ? '評語：' + payload.comment : ''}`;
  } else {
    text = `📌 事件：${event_name}`;
  }

  return {
    attachments: [{ color, text, footer: `客服中心 • ${new Date().toLocaleString('zh-TW')}` }],
  };
};

// ─── Discord payload 格式化 ───
const formatDiscordPayload = (event_name, payload) => {
  const colorMap = {
    'alert:urgent': 0xe53935,
    'csat:received': 0xf59e0b,
    'broadcast:done': 0x06C755,
    'mention': 0x1877F2,
    'order:new': 0x7c3aed,
    'game:winner': 0xf59e0b,
  };

  let description = '';
  if (event_name === 'alert:urgent') {
    description = `緊急警示：對話 #${payload.conversation_id} — ${payload.rule_name || ''}\n訊息：${payload.message_preview || ''}`;
  } else if (event_name === 'broadcast:done') {
    description = `廣播完成：送出 ${payload.sent_count} 筆，失敗 ${payload.fail_count} 筆`;
  } else {
    description = JSON.stringify(payload).slice(0, 200);
  }

  return {
    embeds: [{
      title: event_name,
      description,
      color: colorMap[event_name] || 0x8a8d91,
      timestamp: new Date().toISOString(),
    }],
  };
};

// ─── Generic payload + HMAC 簽名 ───
const formatGenericPayload = (event_name, payload, secret) => {
  const body = JSON.stringify({ event: event_name, payload, timestamp: Date.now() });
  let signature = '';
  if (secret) {
    signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  }
  return { body, signature };
};

// ─── 發送單個 webhook ───
const sendWebhook = async (hook, event_name, payload) => {
  try {
    let fetchBody, headers = { 'Content-Type': 'application/json' };

    if (hook.type === 'slack') {
      fetchBody = JSON.stringify(formatSlackPayload(event_name, payload));
    } else if (hook.type === 'discord') {
      fetchBody = JSON.stringify(formatDiscordPayload(event_name, payload));
    } else {
      // generic
      const { body, signature } = formatGenericPayload(event_name, payload, hook.secret);
      fetchBody = body;
      if (signature) headers['X-Hub-Signature-256'] = signature;
    }

    const r = await fetch(hook.url, {
      method: 'POST',
      headers,
      body: fetchBody,
      signal: AbortSignal.timeout(10000),
    });

    if (!r.ok) {
      log.warn({ hook_id: hook.id, status: r.status, event: event_name }, 'webhook delivery failed');
    } else {
      log.info({ hook_id: hook.id, event: event_name, url: hook.url.slice(0, 40) }, 'webhook delivered');
    }
  } catch (e) {
    log.error({ hook_id: hook.id, event: event_name, err: e.message }, 'webhook error');
  }
};

// ─── 主分派函式 ───
export const dispatchEvent = async (client_id, event_name, payload) => {
  if (!client_id || !event_name) return;

  let hooks;
  try {
    hooks = db.prepare(`
      SELECT * FROM webhooks_out WHERE client_id = ? AND enabled = 1
    `).all(client_id);
  } catch { return; }

  if (!hooks.length) return;

  for (const hook of hooks) {
    let events = [];
    try { events = JSON.parse(hook.events || '[]'); } catch {}
    if (!events.includes(event_name)) continue;

    // 非同步送出，不阻塞主流程
    sendWebhook(hook, event_name, payload).catch(() => {});
  }
};

export default { ensureWebhooksOutSchema, dispatchEvent };
