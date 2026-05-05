/**
 * lib/audience_sync.js — LINE Audience Group 同步核心邏輯
 *
 * syncTagToLineAudience(clientId, tagName, userIds, action, token)
 *   - action: 'add' | 'remove'
 *   - 自動 upsert audience_mappings
 *   - 寫 audience_sync_log
 *
 * bulkSyncAllTags(client) — 對某業主所有 tag 做一次完整同步
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';
import {
  createAudience,
  addUsersToAudience,
  removeUsersFromAudience,
  getAudience,
} from './line_audience.js';

const log = rootLogger.child({ module: 'audience_sync' });

// ─── Schema Migration（在 db.js 之後獨立呼叫）───
export const ensureAudienceSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audience_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      tag_name TEXT NOT NULL,
      line_audience_id TEXT,
      line_audience_status TEXT,
      member_count INTEGER DEFAULT 0,
      last_synced_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(client_id, tag_name),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audience_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      customer_id INTEGER,
      tag_name TEXT,
      action TEXT,
      line_audience_id TEXT,
      status TEXT,
      error TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audience_mappings_client ON audience_mappings(client_id);
    CREATE INDEX IF NOT EXISTS idx_audience_sync_log_client ON audience_sync_log(client_id, created_at DESC);
  `);

  // audience_sync_enabled 欄位（可能已有）
  try {
    db.exec('ALTER TABLE clients ADD COLUMN audience_sync_enabled INTEGER DEFAULT 0');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }

  log.info('audience schema ready');
};

// ─── 寫同步 log ───
const writeSyncLog = ({ client_id, customer_id = null, tag_name, action, line_audience_id = null, status, error = null }) => {
  try {
    db.prepare(`
      INSERT INTO audience_sync_log (client_id, customer_id, tag_name, action, line_audience_id, status, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(client_id, customer_id, tag_name, action, line_audience_id, status, error ? String(error).slice(0, 500) : null, Date.now());
  } catch (e) {
    log.error({ err: e.message }, 'writeSyncLog 失敗');
  }
};

/**
 * 核心同步函式
 * @param {number} clientId
 * @param {string} tagName
 * @param {string[]} userIds - LINE userId 列表
 * @param {'add'|'remove'} action
 * @param {string} token - Channel Access Token（明文）
 * @param {number|null} customerId - 單筆異動對應的 customer_id（for log）
 */
export const syncTagToLineAudience = async (clientId, tagName, userIds, action, token, customerId = null) => {
  if (!userIds.length) return;

  let mapping = db.prepare(
    'SELECT * FROM audience_mappings WHERE client_id = ? AND tag_name = ?'
  ).get(clientId, tagName);

  try {
    if (!mapping) {
      // mapping 不存在 ─ 只有 add 時才建立
      if (action !== 'add') {
        log.debug({ clientId, tagName }, 'remove 時 mapping 不存在，跳過');
        return;
      }

      // 建立新 audience group
      const createResult = await createAudience(token, `[客服中心] ${tagName}`, userIds, clientId);

      if (!createResult.ok) {
        writeSyncLog({ client_id: clientId, customer_id: customerId, tag_name: tagName, action: 'create_group', status: 'failed', error: createResult.error });
        return;
      }

      const now = Date.now();
      db.prepare(`
        INSERT INTO audience_mappings (client_id, tag_name, line_audience_id, line_audience_status, member_count, last_synced_at, created_at, updated_at)
        VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?, ?, ?)
      `).run(clientId, tagName, createResult.audienceGroupId, userIds.length, now, now, now);

      writeSyncLog({ client_id: clientId, customer_id: customerId, tag_name: tagName, action: 'create_group', line_audience_id: createResult.audienceGroupId, status: 'success' });
      log.info({ clientId, tagName, audienceGroupId: createResult.audienceGroupId }, 'audience group 建立成功');
      return;
    }

    // mapping 存在
    const audienceGroupId = mapping.line_audience_id;

    if (action === 'add') {
      const result = await addUsersToAudience(token, audienceGroupId, userIds, clientId);
      const status = result.ok ? 'success' : 'failed';
      const newCount = result.ok ? (mapping.member_count || 0) + userIds.length : mapping.member_count;

      db.prepare(`
        UPDATE audience_mappings SET member_count = ?, last_synced_at = ?, updated_at = ? WHERE id = ?
      `).run(newCount, Date.now(), Date.now(), mapping.id);

      writeSyncLog({ client_id: clientId, customer_id: customerId, tag_name: tagName, action: 'add', line_audience_id: audienceGroupId, status, error: result.error });

    } else if (action === 'remove') {
      const result = await removeUsersFromAudience(token, audienceGroupId, userIds, clientId);
      const status = result.ok ? 'success' : 'failed';
      const newCount = result.ok ? Math.max(0, (mapping.member_count || 0) - userIds.length) : mapping.member_count;

      db.prepare(`
        UPDATE audience_mappings SET member_count = ?, last_synced_at = ?, updated_at = ? WHERE id = ?
      `).run(newCount, Date.now(), Date.now(), mapping.id);

      writeSyncLog({ client_id: clientId, customer_id: customerId, tag_name: tagName, action: 'remove', line_audience_id: audienceGroupId, status, error: result.error });
    }

  } catch (e) {
    log.error({ err: e.message, clientId, tagName, action }, 'syncTagToLineAudience 未預期錯誤');
    writeSyncLog({ client_id: clientId, customer_id: customerId, tag_name: tagName, action, line_audience_id: mapping?.line_audience_id, status: 'failed', error: e.message });
  }
};

/**
 * 重新整合 LINE 回的 status（IN_PROGRESS → READY）
 * 可定期排程呼叫（或在查詢 mapping 時觸發）
 * @param {string} token
 * @param {number} clientId
 */
export const refreshAudienceStatuses = async (token, clientId) => {
  const mappings = db.prepare(
    "SELECT * FROM audience_mappings WHERE client_id = ? AND line_audience_id IS NOT NULL AND line_audience_status = 'IN_PROGRESS'"
  ).all(clientId);

  for (const m of mappings) {
    try {
      const result = await getAudience(token, m.line_audience_id, clientId);
      if (!result.ok) continue;
      const ag = result.audienceGroup;
      const status = ag?.status || ag?.audienceGroupStatus || 'IN_PROGRESS';
      const count = ag?.audienceCount ?? ag?.memberCount ?? m.member_count;

      db.prepare(`
        UPDATE audience_mappings SET line_audience_status = ?, member_count = ?, updated_at = ? WHERE id = ?
      `).run(status, count, Date.now(), m.id);
    } catch (e) {
      log.warn({ err: e.message, mapping_id: m.id }, 'refreshAudienceStatuses 單筆失敗');
    }
  }
};

/**
 * 對某 client 的所有現有 tag 做一次完整批次同步
 * 每個 tag → 撈所有有該 tag 的 customer 的 LINE user_id → createAudience 或 addUsers
 * @param {object} client - clients 資料表列（含 id, line_access_token_enc, audience_sync_enabled）
 * @param {Function} decrypt - crypto.decrypt
 * @returns {Promise<{ tag: string, result: string }[]>}
 */
export const bulkSyncAllTags = async (client, decrypt) => {
  const token = decrypt(client.line_access_token_enc);
  if (!token) {
    log.warn({ clientId: client.id }, 'bulkSyncAllTags：無 LINE token，跳過');
    return [];
  }

  // 撈出所有 customers 的 tags
  const customers = db.prepare(
    "SELECT id, tags FROM customers WHERE client_id = ? AND tags IS NOT NULL AND tags != '[]'"
  ).all(client.id);

  // 展開 tag → userId 的 map
  const tagUserMap = {}; // { tagName: Set<line_user_id> }
  const tagCustomerMap = {}; // { tagName: [customer_id] } (for log)

  for (const c of customers) {
    let tags = [];
    try { tags = JSON.parse(c.tags || '[]'); } catch { continue; }

    const cc = db.prepare(
      "SELECT channel_user_id FROM customer_channels WHERE customer_id = ? AND channel = 'line'"
    ).get(c.id);

    if (!cc?.channel_user_id) continue;

    for (const tag of tags) {
      if (!tagUserMap[tag]) tagUserMap[tag] = new Set();
      tagUserMap[tag].add(cc.channel_user_id);
      if (!tagCustomerMap[tag]) tagCustomerMap[tag] = [];
      tagCustomerMap[tag].push(c.id);
    }
  }

  const results = [];

  for (const [tagName, userIdSet] of Object.entries(tagUserMap)) {
    const userIds = [...userIdSet];
    if (!userIds.length) continue;

    let mapping = db.prepare(
      'SELECT * FROM audience_mappings WHERE client_id = ? AND tag_name = ?'
    ).get(client.id, tagName);

    try {
      if (!mapping) {
        // 建立新 audience
        const createResult = await createAudience(token, `[客服中心] ${tagName}`, userIds, client.id);
        if (createResult.ok) {
          const now = Date.now();
          db.prepare(`
            INSERT OR IGNORE INTO audience_mappings (client_id, tag_name, line_audience_id, line_audience_status, member_count, last_synced_at, created_at, updated_at)
            VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?, ?, ?)
          `).run(client.id, tagName, createResult.audienceGroupId, userIds.length, now, now, now);

          writeSyncLog({ client_id: client.id, tag_name: tagName, action: 'create_group', line_audience_id: createResult.audienceGroupId, status: 'success' });
          results.push({ tag: tagName, result: `建立成功 audienceGroupId=${createResult.audienceGroupId}，${userIds.length} 人` });
        } else {
          writeSyncLog({ client_id: client.id, tag_name: tagName, action: 'create_group', status: 'failed', error: createResult.error });
          results.push({ tag: tagName, result: `建立失敗：${createResult.error}` });
        }
      } else {
        // 已有 mapping → 補加 user
        const addResult = await addUsersToAudience(token, mapping.line_audience_id, userIds, client.id);
        const status = addResult.ok ? 'success' : 'failed';

        if (addResult.ok) {
          db.prepare('UPDATE audience_mappings SET member_count = ?, last_synced_at = ?, updated_at = ? WHERE id = ?')
            .run(userIds.length, Date.now(), Date.now(), mapping.id);
        }

        writeSyncLog({ client_id: client.id, tag_name: tagName, action: 'add', line_audience_id: mapping.line_audience_id, status, error: addResult.error });
        results.push({ tag: tagName, result: addResult.ok ? `補同步 ${userIds.length} 人成功` : `失敗：${addResult.error}` });
      }
    } catch (e) {
      log.error({ err: e.message, tagName }, 'bulkSyncAllTags 單 tag 失敗');
      writeSyncLog({ client_id: client.id, tag_name: tagName, action: 'bulk_sync', status: 'failed', error: e.message });
      results.push({ tag: tagName, result: `例外：${e.message}` });
    }
  }

  return results;
};
