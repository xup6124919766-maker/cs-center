/**
 * lib/line_audience.js — LINE Audience Group API wrapper
 *
 * 注意：這是廣播分眾用的 Audience Group，與 LINE OA Manager 聊天標籤完全不同系統。
 * OA 聊天標籤 LINE 不開 API，此處功能僅供廣播時選擇受眾用。
 *
 * 速率限制：60 req/min（LINE 官方限制）
 * Audience 建立最少 1 個 user，否則直接 skip。
 */

import { logApiCall } from './api_log.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'line_audience' });
const BASE = 'https://api.line.me/v2/bot/audienceGroup';

// ─── helper：統一 fetch + log ───
const lineRequest = async ({ token, method, url, body = null, clientId = null, action = '' }) => {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const start = Date.now();
  let resStatus = null;
  let resBody = null;

  try {
    const fetchOpts = { method, headers };
    if (body) fetchOpts.body = JSON.stringify(body);

    const res = await fetch(url, fetchOpts);
    resStatus = res.status;

    // 204 No Content
    if (res.status === 204) {
      resBody = {};
    } else {
      resBody = await res.json().catch(() => ({}));
    }

    logApiCall({
      direction: 'outbound',
      channel: 'line_audience',
      endpoint: url,
      method,
      req_headers: headers,
      req_body: body,
      res_status: resStatus,
      res_body: resBody,
      duration_ms: Date.now() - start,
      client_id: clientId,
    });

    if (!res.ok) {
      const errMsg = `LINE Audience API [${action}] 錯誤：${resStatus} ${JSON.stringify(resBody)}`;
      log.warn({ status: resStatus, body: resBody, action }, errMsg);
      return { ok: false, status: resStatus, error: resBody?.message || JSON.stringify(resBody), raw: resBody };
    }

    return { ok: true, status: resStatus, data: resBody };
  } catch (e) {
    logApiCall({
      direction: 'outbound',
      channel: 'line_audience',
      endpoint: url,
      method,
      req_headers: headers,
      req_body: body,
      res_status: null,
      res_body: null,
      duration_ms: Date.now() - start,
      error: e.message,
      client_id: clientId,
    });
    log.error({ err: e.message, action }, 'LINE Audience API 呼叫失敗');
    return { ok: false, error: e.message };
  }
};

/**
 * 建立新的 Audience Group（upload 型，以 LINE userId 列表上傳）
 * @param {string} token - Channel Access Token（明文）
 * @param {string} description - audience group 名稱（顯示在 LINE OA Manager）
 * @param {string[]} userIds - LINE userId 列表，至少 1 個
 * @param {number|null} clientId
 * @returns {Promise<{ ok: boolean, audienceGroupId?: string, error?: string }>}
 */
export const createAudience = async (token, description, userIds = [], clientId = null) => {
  if (!userIds.length) {
    log.warn({ description }, 'createAudience 跳過：userIds 為空（LINE 要求至少 1 個）');
    return { ok: false, error: 'userIds 為空，LINE 要求至少 1 個 userId 才能建立 audience' };
  }

  const body = {
    description,
    isIfaAudience: false,
    audiences: userIds.map(id => ({ id })),
  };

  const result = await lineRequest({
    token, method: 'POST', url: `${BASE}/upload`, body, clientId, action: 'createAudience',
  });

  if (!result.ok) return result;

  const audienceGroupId = result.data?.audienceGroup?.audienceGroupId ?? result.data?.audienceGroupId;
  log.info({ audienceGroupId, description, user_count: userIds.length }, 'LINE audience group 建立成功');
  return { ok: true, audienceGroupId: String(audienceGroupId) };
};

/**
 * 將 userId 加入既有 Audience Group
 * @param {string} token
 * @param {string|number} audienceGroupId
 * @param {string[]} userIds
 * @param {number|null} clientId
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export const addUsersToAudience = async (token, audienceGroupId, userIds = [], clientId = null) => {
  if (!userIds.length) return { ok: true };

  const body = {
    audienceGroupId: Number(audienceGroupId),
    audiences: userIds.map(id => ({ id })),
  };

  const result = await lineRequest({
    token, method: 'PUT', url: `${BASE}/upload`, body, clientId, action: 'addUsers',
  });

  if (result.ok) {
    log.info({ audienceGroupId, user_count: userIds.length }, 'LINE audience 加成員成功');
  }
  return result;
};

/**
 * 從 Audience Group 移除 userId
 * LINE API: DELETE /v2/bot/audienceGroup/{audienceGroupId}/users
 * body: { userIds: [...] }
 * @param {string} token
 * @param {string|number} audienceGroupId
 * @param {string[]} userIds
 * @param {number|null} clientId
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export const removeUsersFromAudience = async (token, audienceGroupId, userIds = [], clientId = null) => {
  if (!userIds.length) return { ok: true };

  // LINE 移除 API 用 DELETE + body
  const body = { userIds };

  const result = await lineRequest({
    token,
    method: 'DELETE',
    url: `${BASE}/${audienceGroupId}/users`,
    body,
    clientId,
    action: 'removeUsers',
  });

  if (result.ok) {
    log.info({ audienceGroupId, user_count: userIds.length }, 'LINE audience 移除成員成功');
  }
  return result;
};

/**
 * 列出所有 Audience Groups
 * @param {string} token
 * @param {number|null} clientId
 * @returns {Promise<{ ok: boolean, audienceGroups?: object[], error?: string }>}
 */
export const listAudiences = async (token, clientId = null) => {
  const result = await lineRequest({
    token, method: 'GET', url: `${BASE}/list?page=1&size=40`, clientId, action: 'listAudiences',
  });

  if (!result.ok) return result;
  return { ok: true, audienceGroups: result.data?.audienceGroups || [] };
};

/**
 * 取得單一 Audience Group 詳情（含 memberCount + status）
 * @param {string} token
 * @param {string|number} audienceGroupId
 * @param {number|null} clientId
 * @returns {Promise<{ ok: boolean, audienceGroup?: object, error?: string }>}
 */
export const getAudience = async (token, audienceGroupId, clientId = null) => {
  const result = await lineRequest({
    token, method: 'GET', url: `${BASE}/${audienceGroupId}`, clientId, action: 'getAudience',
  });

  if (!result.ok) return result;
  return { ok: true, audienceGroup: result.data?.audienceGroup || result.data };
};

/**
 * 刪除 Audience Group（僅刪 LINE 那邊；mapping 要由呼叫方另行刪除）
 * @param {string} token
 * @param {string|number} audienceGroupId
 * @param {number|null} clientId
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export const deleteAudience = async (token, audienceGroupId, clientId = null) => {
  const result = await lineRequest({
    token, method: 'DELETE', url: `${BASE}/${audienceGroupId}`, clientId, action: 'deleteAudience',
  });

  if (result.ok) {
    log.info({ audienceGroupId }, 'LINE audience group 已刪除');
  }
  return result;
};
