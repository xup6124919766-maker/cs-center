import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getUserByUsername, insertSession, getSession, deleteSession } from './db.js';

const SESSION_DAYS = 14;
const COOKIE_NAME = 'cs_sid';

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
export const verifyPassword = (pw, hash) => {
  if (!hash) return false;
  try { return bcrypt.compareSync(pw, hash); } catch { return false; }
};

export const checkLogin = (username, password) => {
  const user = getUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
};

export const createSession = (user) => {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_DAYS * 86400000;
  insertSession(id, user.id, user.username, user.role, user.client_id ?? null, expiresAt);
  return { id, expiresAt };
};

export const destroySession = (id) => deleteSession(id);

const parseCookies = (str) => {
  if (!str) return {};
  return Object.fromEntries(str.split(';').map(s => {
    const [k, ...v] = s.trim().split('=');
    return [k, v.join('=')];
  }));
};

export const getCookie = (req, name = COOKIE_NAME) => parseCookies(req.headers.cookie)[name];

export const requireAuth = (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[COOKIE_NAME];
  if (!sid) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '未登入' });
    return res.redirect('/login.html');
  }
  const sess = getSession(sid);
  if (!sess) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '已過期' });
    return res.redirect('/login.html');
  }
  req.session = sess;
  next();
};

export const requireAdmin = (req, res, next) => {
  if (req.session?.role !== 'admin') {
    return res.status(403).json({ error: '權限不足，需要 admin 角色' });
  }
  next();
};

// 確認 agent 只能存取自己業主的資料
// super admin (client_id = null) 可以存取所有業主
export const requireClientAccess = (clientId) => (req, res, next) => {
  const sess = req.session;
  if (sess.role === 'admin' && sess.client_id === null) return next(); // super admin
  if (sess.client_id !== null && sess.client_id === parseInt(clientId, 10)) return next();
  return res.status(403).json({ error: '無此業主的存取權限' });
};

export const setSessionCookie = (res, sessionId, expiresAt) => {
  const expires = new Date(expiresAt).toUTCString();
  const isProd = process.env.NODE_ENV === 'production';
  // B4: SameSite=Strict（防 CSRF 強化），HttpOnly（防 XSS 讀取 session）
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Expires=${expires}`];
  if (isProd) flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sessionId}; ${flags.join('; ')}`);
};

export const clearSessionCookie = (res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
};
