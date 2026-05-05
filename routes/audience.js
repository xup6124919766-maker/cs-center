/**
 * routes/audience.js — LINE Audience Group 同步管理 API
 *
 * GET  /api/audience/mappings        列出 mapping + 狀態
 * POST /api/audience/sync-now        對特定 tag 同步全部現有客戶
 * POST /api/audience/bulk-sync       對所有 tag 做完整批次同步
 * DELETE /api/audience/mappings/:id  刪除 mapping（不刪 LINE 端 audience）
 * PUT  /api/clients/:id/audience-sync 開關同步功能
 *
 * ⚠️  這是廣播分眾 Audience Group，與 LINE OA Manager 聊天標籤是兩個完全不同的系統。
 *     Audience Group 用於 LINE 廣播時選擇受眾，不會出現在 OA 聊天標籤欄位。
 */

import express from 'express';
import { db } from '../lib/db.js';
import { decrypt } from '../lib/crypto.js';
import { logger as rootLogger } from '../lib/logger.js';
import { syncTagToLineAudience, bulkSyncAllTags, refreshAudienceStatuses } from '../lib/audience_sync.js';

const router = express.Router();
const log = rootLogger.child({ module: 'routes/audience' });

// ─── 共用 helper：解析 clientId ───
const resolveClientId = (req) => {
  if (req.session?.client_id) return req.session.client_id;
  const q = req.query.client_id ?? req.body?.client_id;
  if (q) return parseInt(q, 10);
  return null;
};

// ─── GET /api/audience/mappings ───
router.get('/mappings', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const mappings = db.prepare(`
    SELECT * FROM audience_mappings WHERE client_id = ? ORDER BY tag_name ASC
  `).all(clientId);

  res.json({ mappings });
});

// ─── GET /api/audience/sync-log ───
router.get('/sync-log', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const logs = db.prepare(`
    SELECT * FROM audience_sync_log WHERE client_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(clientId);

  res.json({ logs });
});

// ─── POST /api/audience/sync-now ───
// body: { tag_name } 或 query: tag_name
// 把所有有這個 tag 的 customers 的 LINE user_id 一次推上去
router.post('/sync-now', async (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const tagName = req.body?.tag_name || req.query.tag_name;
  if (!tagName) return res.status(400).json({ error: '需指定 tag_name' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: '業主不存在' });
  if (!client.line_access_token_enc) return res.status(400).json({ error: '尚未設定 LINE token' });

  // 撈所有有該 tag 的 LINE user_id
  const customers = db.prepare(`
    SELECT c.id, c.tags FROM customers c WHERE c.client_id = ? AND c.tags IS NOT NULL
  `).all(clientId);

  const userIds = [];
  const customerIds = [];
  for (const c of customers) {
    let tags = [];
    try { tags = JSON.parse(c.tags || '[]'); } catch { continue; }
    if (!tags.includes(tagName)) continue;

    const cc = db.prepare(
      "SELECT channel_user_id FROM customer_channels WHERE customer_id = ? AND channel = 'line'"
    ).get(c.id);
    if (cc?.channel_user_id) {
      userIds.push(cc.channel_user_id);
      customerIds.push(c.id);
    }
  }

  if (!userIds.length) {
    return res.json({ ok: true, message: `tag "${tagName}" 沒有符合的 LINE 顧客`, synced: 0 });
  }

  try {
    const token = decrypt(client.line_access_token_enc);
    await syncTagToLineAudience(clientId, tagName, userIds, 'add', token, null);
    res.json({ ok: true, tag: tagName, synced: userIds.length });
  } catch (e) {
    log.error({ err: e.message, clientId, tagName }, 'sync-now 失敗');
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/audience/bulk-sync ───
// 對所有現有 tag 做一次完整同步
router.post('/bulk-sync', async (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: '業主不存在' });
  if (!client.line_access_token_enc) return res.status(400).json({ error: '尚未設定 LINE token' });

  try {
    const results = await bulkSyncAllTags(client, decrypt);
    res.json({ ok: true, results });
  } catch (e) {
    log.error({ err: e.message, clientId }, 'bulk-sync 失敗');
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/audience/mappings/:id ───
// 只刪本地 mapping，不碰 LINE 那邊的 audience
router.delete('/mappings/:id', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const mappingId = parseInt(req.params.id, 10);
  const mapping = db.prepare('SELECT * FROM audience_mappings WHERE id = ? AND client_id = ?').get(mappingId, clientId);
  if (!mapping) return res.status(404).json({ error: 'mapping 不存在或無權限' });

  db.prepare('DELETE FROM audience_mappings WHERE id = ?').run(mappingId);
  log.info({ mappingId, clientId, tag_name: mapping.tag_name }, 'audience mapping 已刪除（LINE 端未異動）');
  res.json({ ok: true, note: 'LINE 端的 audience group 未被刪除，可至 LINE OA Manager 手動管理' });
});

// ─── POST /api/audience/refresh-status ───
// 重新從 LINE 拉 status（IN_PROGRESS → READY）
router.post('/refresh-status', async (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client || !client.line_access_token_enc) return res.status(400).json({ error: '尚未設定 LINE token' });

  try {
    const token = decrypt(client.line_access_token_enc);
    await refreshAudienceStatuses(token, clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /api/audience/enable/:id ───
// body: { enabled: 0 | 1 }  — 開關特定 client 的 audience 同步
router.put('/enable/:id', (req, res) => {
  const clientId = parseInt(req.params.id, 10);
  const { enabled } = req.body || {};
  if (enabled === undefined) return res.status(400).json({ error: '需提供 enabled' });

  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: '業主不存在' });

  db.prepare('UPDATE clients SET audience_sync_enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, Date.now(), clientId);

  log.info({ clientId, enabled: !!enabled }, 'audience_sync_enabled 已更新');
  res.json({ ok: true, audience_sync_enabled: enabled ? 1 : 0 });
});

export default router;
