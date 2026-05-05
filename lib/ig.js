import crypto from 'crypto';
import { logger as rootLogger } from './logger.js';
import { logApiCall } from './api_log.js';

const log = rootLogger.child({ module: 'ig' });

/**
 * ig.js — Instagram DM API wrapper（仿照 fb.js 1:1）
 *
 * IG DM 透過 Meta Graph API，與 FB Messenger 同層架構：
 * - Send DM endpoint: POST /v18.0/{ig-user-id}/messages
 * - Webhook 簽章：X-Hub-Signature-256（HMAC-SHA256，與 FB 完全相同）
 * - 必要權限：instagram_basic、instagram_manage_messages、pages_messaging
 * - IG Business Account 必須連結到 FB Page 才能收發 DM
 *
 * TODO: 等業主提供 IG Access Token 再取消 stub，啟用真實 API 呼叫
 */

const GRAPH_BASE = 'https://graph.facebook.com/v18.0';

/**
 * 驗證 IG webhook 簽章（X-Hub-Signature-256）
 * 與 FB 使用相同的 HMAC-SHA256 演算法
 *
 * @param {string} appSecret   - Meta App Secret（可共用 fb_app_secret）
 * @param {string|Buffer} body - 原始 request body
 * @param {string} signature   - X-Hub-Signature-256 header 值（sha256=xxx）
 * @returns {boolean}
 */
export const verifySignature = (appSecret, body, signature) => {
  // TODO: 等 IG App Secret 進來確認此函式在 webhook handler 中正確呼叫
  if (!appSecret || !signature) return false;
  const bodyStr = Buffer.isBuffer(body) ? body.toString('utf8') : body;
  const hmac = crypto.createHmac('sha256', appSecret);
  hmac.update(bodyStr);
  const expected = `sha256=${hmac.digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
};

/**
 * 驗證 IG Webhook verify token challenge（GET 請求）
 *
 * @param {string} storedVerifyToken - 資料庫中儲存的 ig_verify_token
 * @param {string} hubVerifyToken    - Meta 傳來的 hub.verify_token
 * @param {string} challenge         - Meta 傳來的 hub.challenge
 * @returns {{ ok: boolean, challenge: string|null }}
 */
export const handleVerifyChallenge = (storedVerifyToken, hubVerifyToken, challenge) => {
  if (!storedVerifyToken || storedVerifyToken !== hubVerifyToken) {
    return { ok: false, challenge: null };
  }
  return { ok: true, challenge };
};

/**
 * 發送文字訊息給 IG 使用者
 *
 * @param {string} accessToken   - IG Access Token（解密後的明文）
 * @param {string} igUserId      - IG Business Account User ID（ig_business_account_id）
 * @param {string} recipientPsid - IG-scoped PSID（sender.id from webhook）
 * @param {string} text          - 訊息內容
 * @returns {Promise<object>}
 *
 * TODO: 等 IG token 進來再取消 stub，改用真實 fetch 呼叫
 */
export const sendText = async (accessToken, igUserId, recipientPsid, text) => {
  // TODO: 等 IG token 進來實作
  // const endpoint = `${GRAPH_BASE}/${igUserId}/messages`;
  // const startAt = Date.now();
  // try {
  //   const res = await fetch(endpoint, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({
  //       recipient: { id: recipientPsid },
  //       message: { text },
  //     }),
  //   });
  //   const data = await res.json();
  //   logApiCall({
  //     direction: 'outbound', channel: 'ig', endpoint,
  //     method: 'POST',
  //     req_body: { recipient: { id: recipientPsid }, message: { text } },
  //     res_status: res.status,
  //     res_body: data,
  //     duration_ms: Date.now() - startAt,
  //   });
  //   if (!res.ok) throw new Error(data?.error?.message || `IG API error: ${res.status}`);
  //   return data;
  // } catch (e) {
  //   logApiCall({ direction: 'outbound', channel: 'ig', endpoint, error: e.message, duration_ms: Date.now() - startAt });
  //   throw e;
  // }

  log.warn({ recipientPsid }, '[IG stub] sendText 尚未實作，等 IG token 進來啟用');
  return { stub: true, igUserId, recipientPsid, text };
};

/**
 * 取得 IG 使用者資訊（名稱、頭像）
 *
 * @param {string} accessToken - IG Access Token（解密後的明文）
 * @param {string} psid        - IG-scoped PSID
 * @returns {Promise<{ name, profile_pic }>}
 *
 * TODO: 等 IG token 進來再啟用
 */
export const getUserProfile = async (accessToken, psid) => {
  // TODO: 等 IG token 進來實作
  // const startAt = Date.now();
  // const endpoint = `${GRAPH_BASE}/${psid}?fields=name,profile_pic&access_token=${accessToken}`;
  // try {
  //   const res = await fetch(endpoint);
  //   const data = await res.json();
  //   logApiCall({
  //     direction: 'outbound', channel: 'ig', endpoint,
  //     method: 'GET', res_status: res.status, res_body: data,
  //     duration_ms: Date.now() - startAt,
  //   });
  //   if (!res.ok) throw new Error(`IG API error: ${res.status}`);
  //   return data;
  // } catch (e) {
  //   logApiCall({ direction: 'outbound', channel: 'ig', endpoint, error: e.message, duration_ms: Date.now() - startAt });
  //   throw e;
  // }

  log.warn({ psid }, '[IG stub] getUserProfile 尚未實作，等 IG token 進來啟用');
  return { stub: true, psid, name: null, profile_pic: null };
};
