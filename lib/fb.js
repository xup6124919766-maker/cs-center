import crypto from 'crypto';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'fb' });

/**
 * fb.js — FB Messenger API wrapper (skeleton)
 *
 * TODO: 等業主提供 FB Page Token 再實作完整邏輯
 * 目前：verifySignature stub + sendText stub + verifyToken challenge
 */

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

/**
 * 驗證 FB webhook 簽名（X-Hub-Signature-256）
 * @param {string} appSecret - FB App Secret
 * @param {string|Buffer} body - 原始 request body
 * @param {string} signature - X-Hub-Signature-256 header 值（sha256=xxx）
 * @returns {boolean}
 */
export const verifySignature = (appSecret, body, signature) => {
  // TODO: 等 FB App Secret 進來確認此函式在 webhook handler 中正確呼叫
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
 * 驗證 FB Webhook verify token challenge（GET 請求）
 * @param {string} storedVerifyToken - 資料庫中儲存的 verify_token
 * @param {string} hubVerifyToken - FB 傳來的 hub.verify_token
 * @param {string} challenge - FB 傳來的 hub.challenge
 * @returns {{ ok: boolean, challenge: string|null }}
 */
export const handleVerifyChallenge = (storedVerifyToken, hubVerifyToken, challenge) => {
  if (!storedVerifyToken || storedVerifyToken !== hubVerifyToken) {
    return { ok: false, challenge: null };
  }
  return { ok: true, challenge };
};

/**
 * 發送文字訊息給 FB 使用者
 * @param {string} pageToken - FB Page Access Token（解密後的明文）
 * @param {string} recipientId - FB 使用者 PSID
 * @param {string} text - 訊息內容
 * @returns {Promise<object>}
 *
 * TODO: 等 token 進來再取消 stub，改用真實 fetch 呼叫
 */
export const sendText = async (pageToken, recipientId, text) => {
  // TODO: 實際送出訊息
  // const res = await fetch(`${GRAPH_BASE}/me/messages?access_token=${pageToken}`, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     recipient: { id: recipientId },
  //     message: { text },
  //   }),
  // });
  // if (!res.ok) {
  //   const err = await res.json();
  //   throw new Error(err?.error?.message || `FB API error: ${res.status}`);
  // }
  // return res.json();
  log.warn('[FB stub] sendText 尚未實作，等 token 後啟用');
  return { stub: true, recipientId, text };
};

/**
 * 取得使用者資訊（名稱、頭像）
 * @param {string} pageToken
 * @param {string} userId
 * @returns {Promise<{ name, profile_pic }>}
 *
 * TODO: 等 token 進來再啟用
 */
export const getUserProfile = async (pageToken, userId) => {
  // TODO: 實際打 Graph API
  // const url = `${GRAPH_BASE}/${userId}?fields=name,profile_pic&access_token=${pageToken}`;
  // const res = await fetch(url);
  // if (!res.ok) throw new Error(`FB API error: ${res.status}`);
  // return res.json();
  log.warn('[FB stub] getUserProfile 尚未實作');
  return { stub: true, userId, name: null, profile_pic: null };
};
