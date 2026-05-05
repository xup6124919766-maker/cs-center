/**
 * totp.js — 自寫 TOTP（RFC 6238），零外部依賴
 *
 * generateSecret()           → base32 secret
 * generateTotp(secret)       → 6 位 OTP
 * verifyTotp(secret, code)   → boolean（接受 ±1 window）
 * getOtpauthUrl(secret, username, issuer) → otpauth:// URL
 * generateBackupCodes(count) → string[]
 */

import crypto from 'crypto';

// ─── Base32 編解碼 ───
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Encode = (buf) => {
  let bits = 0;
  let val = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    val = (val << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_CHARS[(val << (5 - bits)) & 31];
  while (output.length % 8 !== 0) output += '=';
  return output;
};

const base32Decode = (str) => {
  const s = str.toUpperCase().replace(/=+$/, '');
  const bytes = [];
  let bits = 0;
  let val = 0;
  for (const ch of s) {
    const idx = BASE32_CHARS.indexOf(ch);
    if (idx === -1) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

// ─── HOTP（RFC 4226）───
const hotp = (secret, counter) => {
  const key  = base32Decode(secret);
  const msg  = Buffer.alloc(8);
  // 64-bit big-endian counter
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[19] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
             | ((hmac[offset + 1] & 0xff) << 16)
             | ((hmac[offset + 2] & 0xff) << 8)
             |  (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
};

// ─── 生成 Secret ───
export const generateSecret = (length = 20) => {
  const bytes = crypto.randomBytes(length);
  return base32Encode(bytes).replace(/=/g, '').slice(0, 32);
};

// ─── 生成 TOTP ───
export const generateTotp = (secret, timeStep = 30) => {
  const counter = Math.floor(Date.now() / 1000 / timeStep);
  return hotp(secret, counter);
};

// ─── 驗證 TOTP（±1 window，即前後 30 秒容忍）───
export const verifyTotp = (secret, code, timeStep = 30, window = 1) => {
  if (!code || !secret) return false;
  const normalizedCode = String(code).replace(/\s/g, '');
  const counter = Math.floor(Date.now() / 1000 / timeStep);
  for (let i = -window; i <= window; i++) {
    if (hotp(secret, counter + i) === normalizedCode) return true;
  }
  return false;
};

// ─── otpauth URL（給 QR code 用）───
export const getOtpauthUrl = (secret, username, issuer = '客服中心') => {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(username)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
};

// ─── 備援碼（8 組 8 碼）───
export const generateBackupCodes = (count = 8) => {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
};

export default { generateSecret, generateTotp, verifyTotp, getOtpauthUrl, generateBackupCodes };
