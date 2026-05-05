/**
 * realtime.js — Socket.IO 即時推播
 *
 * init(httpServer) → 啟動 socket.io
 * emitToClient(client_id, event, payload) → 推到該 client 的所有 socket
 *
 * 認證：從 cookie 讀 cs_sid，驗 session，加入 client:{client_id} 房間
 */

import { Server as SocketIO } from 'socket.io';
import { logger as rootLogger } from './logger.js';
import { getSession, db } from './db.js';
import { dispatchEvent } from './webhooks_out.js';

const log = rootLogger.child({ module: 'realtime' });

let io = null;

// ─── 解析 cookie ───
const parseCookies = (str) => {
  if (!str) return {};
  return Object.fromEntries(str.split(';').map(s => {
    const [k, ...v] = s.trim().split('=');
    return [k, v.join('=')];
  }));
};

// ─── 初始化 ───
export const init = (httpServer) => {
  io = new SocketIO(httpServer, {
    cors: { origin: '*', credentials: true },
    path: '/socket.io/',
    // ── 心跳設定（對抗 Cloudflare 100s 閒置 timeout）──
    pingInterval: 20_000,   // 每 20 秒 server→client ping（預設 25s）
    pingTimeout:  25_000,   // 25 秒沒 pong 才斷（預設 20s）
    // ── transport 順序：優先 WebSocket，失敗 fallback polling ──
    transports: ['websocket', 'polling'],
    cookie: false,
  });

  // ─── 認證 middleware ───
  io.use((socket, next) => {
    const cookieStr = socket.handshake.headers?.cookie || '';
    const cookies   = parseCookies(cookieStr);
    const sid       = cookies['cs_sid'];

    if (!sid) {
      log.warn({ remote: socket.handshake.address }, 'socket rejected: no session cookie');
      // P6: 記錄 auth_failed
      try {
        db.prepare(`
          INSERT INTO socket_events (event_type, ip, user_agent, reason, created_at)
          VALUES ('auth_failed', ?, ?, 'no_session_cookie', ?)
        `).run(socket.handshake.address, socket.handshake.headers?.['user-agent'] || null, Date.now());
      } catch {}
      return next(new Error('未登入'));
    }

    const sess = getSession(sid);
    if (!sess) {
      log.warn({ remote: socket.handshake.address }, 'socket rejected: session expired');
      try {
        db.prepare(`
          INSERT INTO socket_events (event_type, ip, user_agent, reason, created_at)
          VALUES ('auth_failed', ?, ?, 'session_expired', ?)
        `).run(socket.handshake.address, socket.handshake.headers?.['user-agent'] || null, Date.now());
      } catch {}
      return next(new Error('Session 已過期'));
    }

    socket.session = sess;
    next();
  });

  // ─── 連線處理 ───
  io.on('connection', (socket) => {
    const sess = socket.session;
    const clientRoom = `client:${sess.client_id ?? 'admin'}`;
    const userRoom   = `user:${sess.user_id}`;
    const connectedAt = Date.now();

    socket.join(clientRoom);
    socket.join(userRoom);   // 個人房間，@提及 + status 用

    // 更新上線狀態
    try {
      db.prepare("UPDATE users SET online_status = 'online', last_seen_at = ? WHERE id = ?")
        .run(connectedAt, sess.user_id);
      io.to(clientRoom).emit('user:status', { user_id: sess.user_id, online_status: 'online', last_seen_at: connectedAt });
    } catch {}

    // P6: 記錄 connect 事件
    try {
      db.prepare(`
        INSERT INTO socket_events (event_type, user_id, username, client_id, socket_id, ip, user_agent, created_at)
        VALUES ('connect', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sess.user_id, sess.username, sess.client_id ?? null,
        socket.id,
        socket.handshake.address || null,
        socket.handshake.headers?.['user-agent'] || null,
        connectedAt
      );
    } catch {}

    log.info({ user_id: sess.user_id, username: sess.username, clientRoom, userRoom }, 'socket connected');

    socket.on('disconnect', (reason) => {
      const disconnectedAt = Date.now();
      const duration = disconnectedAt - connectedAt;
      log.info({ user_id: sess.user_id, reason, duration_ms: duration }, 'socket disconnected');

      // P6: 記錄 disconnect 事件
      try {
        db.prepare(`
          INSERT INTO socket_events (event_type, user_id, username, client_id, socket_id, ip, duration_ms, reason, created_at)
          VALUES ('disconnect', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sess.user_id, sess.username, sess.client_id ?? null,
          socket.id,
          socket.handshake.address || null,
          duration, reason, disconnectedAt
        );
      } catch {}

      // 下線時更新狀態（有其他 socket 在同房間就保持 online）
      try {
        const socketsInRoom = io.sockets.adapter.rooms.get(userRoom);
        // socketsInRoom 包含自己（已移除），若 size === 0 表示完全下線
        const remainingCount = (socketsInRoom ? socketsInRoom.size : 0);
        if (remainingCount === 0) {
          db.prepare("UPDATE users SET online_status = 'offline', last_seen_at = ? WHERE id = ?")
            .run(disconnectedAt, sess.user_id);
          io.to(clientRoom).emit('user:status', { user_id: sess.user_id, online_status: 'offline', last_seen_at: disconnectedAt });
        }
      } catch {}
    });

    // ping/pong 健康確認
    socket.on('ping', (cb) => {
      if (typeof cb === 'function') cb({ pong: true, user_id: sess.user_id });
    });

    // heartbeat：前端每 30 秒送，更新 last_seen_at
    socket.on('heartbeat', () => {
      try {
        db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), sess.user_id);
      } catch {}
    });

    // keepalive：前端每 30 秒主動送，維持 Cloudflare WebSocket 連線不被 100s 閒置斷線
    socket.on('keepalive', () => { /* noop — 收到即可，socket.io 層自動維持 */ });
  });

  // 每 5 分鐘掃無心跳的 user，降為 away
  setInterval(() => {
    try {
      const threshold = Date.now() - 5 * 60 * 1000;
      db.prepare(`
        UPDATE users SET online_status = 'away'
        WHERE online_status = 'online' AND last_seen_at < ?
      `).run(threshold);
    } catch {}
  }, 60_000);

  log.info('socket.io initialized');
  return io;
};

// ─── 推播給指定業主所有 socket（同時觸發 outbound webhook）───
export const emitToClient = (client_id, event, payload) => {
  if (!io) return;
  const room = `client:${client_id ?? 'admin'}`;
  io.to(room).emit(event, payload);
  log.debug({ room, event }, 'emit');
  // outbound webhook 分派（async，不阻塞）
  if (client_id) {
    Promise.resolve().then(() => dispatchEvent(client_id, event, payload)).catch(() => {});
  }
};

// ─── 推播給特定 user ───
export const emitToUser = (user_id, event, payload) => {
  if (!io) return;
  const room = `user:${user_id}`;
  io.to(room).emit(event, payload);
  log.debug({ room, event }, 'emit to user');
};

// ─── 推播給所有 admin socket ───
export const emitToAdmin = (event, payload) => {
  if (!io) return;
  io.to('client:admin').emit(event, payload);
};

export default { init, emitToClient, emitToAdmin, emitToUser };
