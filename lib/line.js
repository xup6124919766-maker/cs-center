import crypto from 'crypto';
import { logger as rootLogger } from './logger.js';
import { logApiCall } from './api_log.js';

const log = rootLogger.child({ module: 'line' });

const LINE_API_BASE = 'https://api.line.me/v2/bot';

/**
 * 驗證 LINE webhook 簽名（HMAC-SHA256）
 * @param {string} channelSecret - LINE Channel Secret（解密後的明文）
 * @param {string|Buffer} body - 原始 request body
 * @param {string} signature - X-Line-Signature header 值
 * @returns {boolean}
 */
export const verifySignature = (channelSecret, body, signature) => {
  if (!channelSecret || !signature) return false;
  const bodyStr = Buffer.isBuffer(body) ? body.toString('utf8') : body;
  const hmac = crypto.createHmac('sha256', channelSecret);
  hmac.update(bodyStr);
  const expected = hmac.digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
};

/**
 * 發送 push 訊息給 LINE 使用者（計費）
 * @param {string} accessToken - LINE Channel Access Token（解密後明文）
 * @param {string} to - LINE userId
 * @param {string} text - 訊息內容
 * @param {number|null} [clientId=null] - 業主 client_id（用於 api_call_logs）
 * @returns {Promise<object>}
 */
export const sendText = async (accessToken, to, text, clientId = null) => {
  const endpoint = `${LINE_API_BASE}/message/push`;
  const reqBody = { to, messages: [{ type: 'text', text }] };
  const reqHeaders = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  const start = Date.now();
  let resStatus = null;
  let resBody = null;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(reqBody),
    });
    resStatus = res.status;
    resBody = await res.json().catch(() => ({}));

    logApiCall({
      direction: 'outbound',
      channel: 'line',
      endpoint,
      method: 'POST',
      req_headers: reqHeaders,
      req_body: reqBody,
      res_status: resStatus,
      res_body: resBody,
      duration_ms: Date.now() - start,
      client_id: clientId,
    });

    if (!res.ok) {
      const msg = `LINE push API 錯誤：${resStatus} ${JSON.stringify(resBody)}`;
      log.error({ status: resStatus, body: resBody, to }, msg);
      throw new Error(msg);
    }

    log.info({ to, text_len: text.length }, 'LINE push 訊息已送出');
    return resBody;
  } catch (e) {
    if (resStatus === null) {
      // fetch 本身失敗（網路問題）
      logApiCall({
        direction: 'outbound',
        channel: 'line',
        endpoint,
        method: 'POST',
        req_headers: reqHeaders,
        req_body: reqBody,
        res_status: null,
        res_body: null,
        duration_ms: Date.now() - start,
        error: e.message,
        client_id: clientId,
      });
    }
    throw e;
  }
};

/**
 * 使用 reply token 回覆訊息（24h 內免費，每個 token 只能用一次）
 * @param {string} accessToken - LINE Channel Access Token（解密後明文）
 * @param {string} replyToken - 從 webhook event 取得的 replyToken
 * @param {string} text - 訊息內容
 * @param {number|null} [clientId=null] - 業主 client_id（用於 api_call_logs）
 * @returns {Promise<object>}
 */
export const replyText = async (accessToken, replyToken, text, clientId = null) => {
  const endpoint = `${LINE_API_BASE}/message/reply`;
  const reqBody = { replyToken, messages: [{ type: 'text', text }] };
  const reqHeaders = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  const start = Date.now();
  let resStatus = null;
  let resBody = null;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(reqBody),
    });
    resStatus = res.status;
    resBody = await res.json().catch(() => ({}));

    logApiCall({
      direction: 'outbound',
      channel: 'line',
      endpoint,
      method: 'POST',
      req_headers: reqHeaders,
      req_body: { ...reqBody, replyToken: reqBody.replyToken?.slice(0, 8) + '...' },
      res_status: resStatus,
      res_body: resBody,
      duration_ms: Date.now() - start,
      client_id: clientId,
    });

    if (!res.ok) {
      const msg = `LINE reply API 錯誤：${resStatus} ${JSON.stringify(resBody)}`;
      log.error({ status: resStatus, body: resBody }, msg);
      throw new Error(msg);
    }

    log.info({ text_len: text.length }, 'LINE reply 訊息已送出');
    return resBody;
  } catch (e) {
    if (resStatus === null) {
      logApiCall({
        direction: 'outbound',
        channel: 'line',
        endpoint,
        method: 'POST',
        req_headers: reqHeaders,
        req_body: reqBody,
        res_status: null,
        res_body: null,
        duration_ms: Date.now() - start,
        error: e.message,
        client_id: clientId,
      });
    }
    throw e;
  }
};

/**
 * 取得 LINE 媒體訊息內容（音訊、圖片等）
 * @param {string} accessToken - LINE Channel Access Token（解密後明文）
 * @param {string} messageId - LINE message ID
 * @param {number|null} [clientId=null] - 業主 client_id（用於 api_call_logs）
 * @returns {Promise<{ ok: boolean, buffer?: Buffer, contentType?: string, error?: string }>}
 */
export const getMessageContent = async (accessToken, messageId, clientId = null) => {
  const endpoint = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const reqHeaders = { 'Authorization': `Bearer ${accessToken}` };
  const start = Date.now();

  try {
    const res = await fetch(endpoint, {
      headers: reqHeaders,
    });

    const duration = Date.now() - start;

    logApiCall({
      direction: 'outbound',
      channel: 'line',
      endpoint,
      method: 'GET',
      req_headers: reqHeaders,
      req_body: null,
      res_status: res.status,
      res_body: null,
      duration_ms: duration,
      client_id: clientId,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const msg = `LINE content API 錯誤：${res.status} ${errText}`;
      log.error({ status: res.status, messageId }, msg);
      throw new Error(msg);
    }

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const contentType = res.headers.get('content-type') || 'audio/m4a';

    log.info({ messageId, size_bytes: buffer.length, content_type: contentType }, 'LINE 媒體內容取得成功');
    return { ok: true, buffer, contentType };
  } catch (e) {
    logApiCall({
      direction: 'outbound',
      channel: 'line',
      endpoint,
      method: 'GET',
      req_headers: reqHeaders,
      req_body: null,
      res_status: null,
      res_body: null,
      duration_ms: Date.now() - start,
      error: e.message,
      client_id: clientId,
    });
    log.error({ err: e.message, messageId }, 'LINE 媒體內容取得失敗');
    return { ok: false, error: e.message };
  }
};

/**
 * 取得 LINE 使用者 profile
 * @param {string} accessToken
 * @param {string} userId
 * @param {number|null} [clientId=null] - 業主 client_id（用於 api_call_logs）
 * @returns {Promise<{ displayName, userId, pictureUrl, statusMessage }>}
 */
export const getUserProfile = async (accessToken, userId, clientId = null) => {
  const endpoint = `${LINE_API_BASE}/profile/${userId}`;
  const reqHeaders = { 'Authorization': `Bearer ${accessToken}` };
  const start = Date.now();
  let resStatus = null;
  let resBody = null;

  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: reqHeaders,
    });
    resStatus = res.status;
    resBody = await res.json().catch(() => ({}));

    logApiCall({
      direction: 'outbound',
      channel: 'line',
      endpoint,
      method: 'GET',
      req_headers: reqHeaders,
      req_body: null,
      res_status: resStatus,
      res_body: resBody,
      duration_ms: Date.now() - start,
      client_id: clientId,
    });

    if (!res.ok) {
      const msg = `LINE profile API 錯誤：${resStatus} ${JSON.stringify(resBody)}`;
      log.warn({ status: resStatus, userId }, msg);
      throw new Error(msg);
    }

    log.debug({ userId, displayName: resBody.displayName }, 'LINE profile 取得成功');
    return {
      displayName: resBody.displayName || null,
      userId: resBody.userId || userId,
      pictureUrl: resBody.pictureUrl || null,
      statusMessage: resBody.statusMessage || null,
    };
  } catch (e) {
    if (resStatus === null) {
      logApiCall({
        direction: 'outbound',
        channel: 'line',
        endpoint,
        method: 'GET',
        req_headers: reqHeaders,
        req_body: null,
        res_status: null,
        res_body: null,
        duration_ms: Date.now() - start,
        error: e.message,
        client_id: clientId,
      });
    }
    throw e;
  }
};
