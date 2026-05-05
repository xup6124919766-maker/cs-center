/**
 * lib/security.js — 零依賴安全強化
 *
 * exports:
 *   securityHeaders()   — HTTP security headers middleware
 *   createRateLimiter() — in-memory rate limiter factory
 *   csrfMiddleware()    — CSRF double-submit cookie protection
 *   generateCsrfToken() — 生成並寫入 CSRF cookie
 */

import crypto from 'crypto';

// ─── B1. HTTP Security Headers ───
export const securityHeaders = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // CSP — 允許 socket.io、QR API；允許 inline script（舊頁面大量使用 onclick）
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.socket.io",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://api.qrserver.com https://sprofile.line-scdn.net https://profile.line-scdn.net https://*.fbcdn.net https://*.cdninstagram.com https:",
    "connect-src 'self' wss: ws:",
    "frame-ancestors 'none'",
  ].join('; '));

  // HSTS（生產環境才送）
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
};

// ─── B2. In-Memory Rate Limiter ───
export const createRateLimiter = ({ windowMs, max, keyFn, message }) => {
  const store = new Map();

  // 每分鐘清理過期 entries
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of store) {
      if (entry.resetAt < cutoff) store.delete(key);
    }
  }, 60_000).unref();

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : (req.ip || 'unknown');
    if (!key) return next();

    const now = Date.now();
    const entry = store.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count++;
    store.set(key, entry);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count));

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: message || 'Too many requests',
        retry_after: retryAfter,
      });
    }
    next();
  };
};

// ─── 預設限流器（方便直接 import 使用）───
export const globalRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 60,
  keyFn: (req) => req.ip || 'unknown',
  message: '請求太頻繁，請稍後再試',
});

export const loginRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 10,
  keyFn: (req) => req.ip || 'unknown',
  message: '登入嘗試次數過多，請稍後再試',
});

export const aiRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  keyFn: (req) => {
    // 以 client_id 為 key（session 可能尚未載入，用 header fallback）
    const clientId = req.session?.client_id ?? req.query?.client_id ?? req.body?.client_id ?? req.ip;
    return String(clientId || req.ip || 'unknown');
  },
  message: 'AI 請求頻率過高，請稍後再試',
});

// ─── B3. CSRF Protection（雙提交 cookie 模式）───

const CSRF_COOKIE = 'cs_csrf';
const CSRF_HEADER = 'x-csrf-token';

// 跳過 CSRF 驗證的路徑前綴
const CSRF_SKIP_PREFIXES = [
  '/webhook/',    // LINE/FB webhook 用簽章驗證
  '/api/play/',   // 玩家公開 API
  '/api/csat/',   // CSAT 公開填寫
  '/api/webhooks/ecommerce/', // 電商 webhook
];

const shouldSkipCsrf = (path) => {
  return CSRF_SKIP_PREFIXES.some(prefix => path.startsWith(prefix));
};

// 從 Cookie 字串解析
const parseCookieStr = (str) => {
  if (!str) return {};
  return Object.fromEntries(str.split(';').map(s => {
    const [k, ...v] = s.trim().split('=');
    return [k.trim(), v.join('=')];
  }));
};

// 生成並寫入 CSRF token 到 cookie（登入後呼叫）
export const generateCsrfToken = (res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const isProd = process.env.NODE_ENV === 'production';
  const flags = ['SameSite=Strict', 'Path=/'];
  if (isProd) flags.push('Secure');
  // 注意：不加 HttpOnly，前端 JS 需要讀取
  res.setHeader('Set-Cookie',
    (res.getHeader('Set-Cookie') instanceof Array
      ? res.getHeader('Set-Cookie')
      : res.getHeader('Set-Cookie') ? [res.getHeader('Set-Cookie')] : [])
      .concat(`${CSRF_COOKIE}=${token}; ${flags.join('; ')}`)
  );
  return token;
};

// CSRF 驗證 middleware（掛在 requireAuth 之後的 mutating 路由）
export const csrfMiddleware = (req, res, next) => {
  // 只驗 mutating 請求
  const method = req.method?.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();

  // 跳過豁免路徑
  if (shouldSkipCsrf(req.path)) return next();

  const cookies = parseCookieStr(req.headers.cookie);
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];

  if (!cookieToken || !headerToken) {
    return res.status(403).json({ error: '缺少 CSRF token，請重新整理頁面後再試' });
  }

  // 比對（timing-safe）
  if (cookieToken.length !== headerToken.length) {
    return res.status(403).json({ error: 'CSRF token 驗證失敗' });
  }
  try {
    const a = Buffer.from(cookieToken, 'utf8');
    const b = Buffer.from(headerToken, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: 'CSRF token 驗證失敗' });
    }
  } catch {
    return res.status(403).json({ error: 'CSRF token 驗證失敗' });
  }

  next();
};
