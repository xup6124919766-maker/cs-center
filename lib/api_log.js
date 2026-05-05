/**
 * lib/api_log.js — LINE/FB API request/response 完整 LOG
 *
 * logApiCall({ direction, channel, endpoint, method, req_body, res_status, res_body, duration_ms, client_id, error })
 * cleanOldApiLogs() — 刪除 30 天前的 logs
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'api_log' });

// ─── Schema ───
export const ensureApiLogSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      direction TEXT NOT NULL,
      channel TEXT NOT NULL,
      endpoint TEXT,
      method TEXT,
      request_headers TEXT,
      request_body TEXT,
      response_status INTEGER,
      response_body TEXT,
      duration_ms INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apicalls_client ON api_call_logs(client_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_apicalls_error ON api_call_logs(channel, response_status, created_at);
  `);

  // 確認表真的存在（啟動時驗證）
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_call_logs'").get();
  if (tableExists) {
    const rowCount = db.prepare('SELECT COUNT(*) AS cnt FROM api_call_logs').get()?.cnt ?? 0;
    console.error(`[api_log] api_call_logs 表已就緒，現有 ${rowCount} 筆`);
    log.info({ row_count: rowCount }, 'api_log schema ready');
  } else {
    console.error('[api_log] ERROR：api_call_logs 表建立失敗！');
    log.error('api_call_logs 表建立失敗');
  }
};

// ─── 敏感 token Mask ───
const maskHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') return headers;
  const masked = { ...headers };
  const sensitiveKeys = ['authorization', 'x-line-channel-access-token', 'x-channel-secret'];
  for (const key of sensitiveKeys) {
    if (masked[key]) {
      const val = String(masked[key]);
      masked[key] = val.length > 12 ? val.slice(0, 6) + '...' + val.slice(-4) : '***';
    }
  }
  return masked;
};

// ─── 寫入 API 呼叫 LOG ───
export const logApiCall = ({
  direction = 'outbound',
  channel,
  endpoint,
  method = 'POST',
  req_body = null,
  req_headers = null,
  res_status = null,
  res_body = null,
  duration_ms = null,
  client_id = null,
  error = null,
}) => {
  // 確認有被呼叫（除錯用，正式上線後仍保留方便追蹤）
  console.error('[logApiCall] called', { channel, endpoint, res_status, client_id, direction });

  let stmt;
  try {
    stmt = db.prepare(`
      INSERT INTO api_call_logs
        (client_id, direction, channel, endpoint, method, request_headers, request_body, response_status, response_body, duration_ms, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  } catch (e) {
    console.error('[api_log] prepare 失敗（表可能未建）：', e.message, e.stack);
    log.error({ err: e.message, stack: e.stack }, 'logApiCall prepare 失敗');
    return;
  }

  try {
    const reqBodyStr = req_body
      ? (typeof req_body === 'string' ? req_body : JSON.stringify(req_body)).slice(0, 4000)
      : null;
    const resBodyStr = res_body
      ? (typeof res_body === 'string' ? res_body : JSON.stringify(res_body)).slice(0, 4000)
      : null;
    const headersStr = req_headers
      ? JSON.stringify(maskHeaders(req_headers)).slice(0, 2000)
      : null;

    stmt.run(
      client_id, direction, channel, endpoint, method,
      headersStr, reqBodyStr, res_status, resBodyStr,
      duration_ms, error ? String(error).slice(0, 500) : null,
      Date.now()
    );
  } catch (e) {
    // 明確印到 console，避免 silent 吃錯誤
    console.error('[api_log] logApiCall run 失敗：', e.message, e.stack);
    log.error({ err: e.message, stack: e.stack }, 'logApiCall run 失敗');
  }
};

// ─── 清除舊 logs（30 天）───
export const cleanOldApiLogs = () => {
  try {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const result = db.prepare('DELETE FROM api_call_logs WHERE created_at < ?').run(cutoff);
    if (result.changes > 0) {
      log.info({ deleted: result.changes }, 'old api_call_logs cleaned');
    }
  } catch (e) {
    log.error({ err: e.message }, 'cleanOldApiLogs failed');
  }
};

export default { ensureApiLogSchema, logApiCall, cleanOldApiLogs };
