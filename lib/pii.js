/**
 * pii.js — PII 遮蔽工具
 *
 * maskPII(text) → { masked, map }
 *   masked: 遮蔽後的文字
 *   map: [ { token, original }, ... ]
 *
 * unmaskPII(masked, map) → 還原後的文字
 *
 * 偵測類型：
 *   身分證/居留證：A-Z 開頭 + 9 碼數字
 *   信用卡：16 位數字（含空格/破折號分隔）
 *   手機號：09xxxxxxxx（台灣）
 *   Email
 */

import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'pii' });

// ─── 規則定義 ───
const PII_RULES = [
  {
    type: 'ID_CARD',
    // 身分證：大寫字母 + 9 位數字
    pattern: /\b([A-Z][12]\d{8})\b/g,
    token: '[ID]',
  },
  {
    type: 'CREDIT_CARD',
    // 信用卡：16 位數字（含空格或破折號）
    pattern: /\b(\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4})\b/g,
    token: '[CARD]',
  },
  {
    type: 'PHONE_TW',
    // 台灣手機：09xx-xxx-xxx 或 09xxxxxxxx
    pattern: /\b(09\d{2}[\s\-]?\d{3}[\s\-]?\d{3})\b/g,
    token: '[PHONE]',
  },
  {
    type: 'EMAIL',
    // Email
    pattern: /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g,
    token: '[EMAIL]',
  },
];

// ─── maskPII ───
export const maskPII = (text) => {
  if (!text || typeof text !== 'string') return { masked: text, map: [] };

  let masked = text;
  const map = [];
  let tokenIdx = 0;

  for (const rule of PII_RULES) {
    rule.pattern.lastIndex = 0;
    masked = masked.replace(rule.pattern, (match) => {
      const uniqueToken = `${rule.token}${tokenIdx}`;
      map.push({ token: uniqueToken, original: match, type: rule.type });
      tokenIdx++;
      return uniqueToken;
    });
  }

  if (map.length > 0) {
    log.info({ count: map.length, types: map.map(m => m.type) }, 'PII masked');
  }

  return { masked, map };
};

// ─── unmaskPII ───
export const unmaskPII = (masked, map = []) => {
  if (!masked || !map.length) return masked;

  let result = masked;
  // 倒序替換避免 token idx 衝突
  for (const entry of [...map].reverse()) {
    result = result.replace(entry.token, entry.original);
  }
  return result;
};

export default { maskPII, unmaskPII };
