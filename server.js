import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger as rootLogger } from './lib/logger.js';
import {
  listClients, getClient, insertClient, updateClient, deleteClient,
  listConversations, getConversation, updateConversation,
  insertConversation, findOpenConversation,
  listMessages, insertMessage,
  listTemplates, getTemplate, insertTemplate, updateTemplate, deleteTemplate,
  listCustomers, getCustomer, insertCustomer, updateCustomer, getCustomerChannels,
  insertChannelIdentity, getChannelIdentity,
  purgeExpiredSessions, insertAuditLog, listAuditLogs,
  countActiveSessions, getStats, db,
  // P2/P3 新函式
  listUsers, getUser, insertUser, updateUser, deleteUser,
  insertTransfer, listTransfers,
  searchMessages,
  listQaPairs, getQaPair, insertQaPair, updateQaPair, deleteQaPair, similarQaPairs,
  // P3 新函式
  updateClientFull, updateUserFull, updateConversationFull, updateQaPairFull,
} from './lib/db.js';
import { encrypt, decrypt } from './lib/crypto.js';
import {
  checkLogin, createSession, destroySession,
  requireAuth, requireAdmin,
  setSessionCookie, clearSessionCookie, getCookie,
  hashPassword,
} from './lib/auth.js';
import { normalizeLine, normalizeFb, normalizeIg } from './lib/normalize.js';
import { verifySignature as lineVerify, sendText as lineSendText, replyText as lineReplyText, getUserProfile as lineGetUserProfile, getMessageContent as lineGetMessageContent } from './lib/line.js';
import { verifySignature as fbVerify, handleVerifyChallenge, sendText as fbSend } from './lib/fb.js';
import {
  verifySignature as igVerify,
  handleVerifyChallenge as igHandleVerifyChallenge,
  sendText as igSend,
  getUserProfile as igGetUserProfile,
} from './lib/ig.js';
import { init as realtimeInit, emitToClient, emitToUser, emitToAdmin } from './lib/realtime.js';
import { generateDrafts, approveDraft } from './lib/draft.js';
import { classifyMessage, summarizeConversation } from './lib/intent.js';

// ─── P4 新模組 Schema + Scheduler ───
import { ensureGameSchema, getActivity, getActivityPrizes, drawPrize } from './lib/game.js';
import { ensureBroadcastSchema, runScheduledBroadcasts } from './lib/broadcast.js';
import { ensureAbTestSchema } from './lib/ab_test.js';
import { ensureEcommerceSchema } from './lib/ecommerce.js';
import { ensureRichMenuSchema } from './lib/richmenu.js';
import { ensureJourneySchema, runScheduledJourneys, checkAndEnrollJourneyTrigger } from './lib/journey.js';

// ─── P3（第三輪）新模組 ───
import { ensureRulesSchema, evaluateRules, seedDefaultRules } from './lib/rules.js';
import { ensureWebhooksOutSchema, dispatchEvent } from './lib/webhooks_out.js';
import { renderTemplate, buildTemplateContext, AVAILABLE_VARIABLES } from './lib/template.js';
import { maskPII, unmaskPII } from './lib/pii.js';
import { generateSecret, verifyTotp, getOtpauthUrl, generateBackupCodes } from './lib/totp.js';

// ─── P5（第四輪）新模組 ───
import {
  securityHeaders, globalRateLimiter, loginRateLimiter, aiRateLimiter,
  csrfMiddleware, generateCsrfToken,
} from './lib/security.js';
import { runBackup, scheduleBackup } from './lib/backup.js';
import { runBackupAndUpload, scheduleRemoteBackup } from './lib/backup_remote.js';

// ─── P6（第六輪）新模組 ───
import { ensureBillingSchema, scanAllClientsQuota, previewCost, recordBilling } from './lib/billing.js';
import { ensureApiLogSchema, logApiCall, cleanOldApiLogs } from './lib/api_log.js';
import { ensureSecuritySchema, recordLoginAttempt, cleanOldSecurityEvents } from './lib/security_monitor.js';
import { ensureSchedulerSchema, wrapScheduler, cleanOldSchedulerRuns } from './lib/scheduler_logger.js';

// ─── P3 Route Modules ───
import rulesRouter from './routes/rules.js';
import scheduledRouter, { ensureScheduledSchema, runScheduledMessages } from './routes/scheduled.js';
import integrationsRouter from './routes/integrations.js';

// ─── P4 Route Modules ───
import gamesRouter from './routes/games.js';
import broadcastRouter from './routes/broadcast.js';
import abTestRouter from './routes/ab_test.js';
import ecommerceRouter from './routes/ecommerce.js';
import richmenuRouter from './routes/richmenu.js';
import journeyRouter from './routes/journey.js';
import analyticsRouter from './routes/analytics.js';

// ─── P8 新模組 ───
import { syncOrdersForClient } from './lib/bvshop.js';
import { ensurePostReplySchema, processComment } from './lib/post_reply.js';

// ─── 遊戲化公開路由 ───
import playRouter from './routes/play.js';
import { getActivityRemaining } from './lib/game.js';

// ─── VoC 顧客洞察 ───
import { ensureVocSchema, analyzeMessage as vocAnalyzeMessage, runVocBatch, recomputeVocTopics } from './lib/voc.js';
import vocRouter from './routes/voc.js';

// ─── Quiz + Checkout 新功能 ───
import quizRouter from './routes/quiz.js';
import checkoutRouter from './routes/checkout.js';
import { recordClick as recordCheckoutClick } from './lib/checkout.js';

// ─── 語音轉文字 + SLA ───
import { transcribeAudio } from './lib/transcribe.js';
import {
  ensureSlaSchema, startSlaScheduler,
  getSlaConfigForApi, getSlaDashboard, computeSlaStatus,
} from './lib/sla.js';

// ─── 新功能：AI 自動回覆 + CLV ───
import { ensureAutoReplySchema, processAutoReply, detectHumanRequest } from './lib/auto_reply.js';
import { ensureClvSchema, computeLifecycle, scheduleClvJob, getClvOverview, getClvCustomers } from './lib/clv.js';

// ─── P6 Route Modules ───
import billingRouter from './routes/billing.js';
import logsRouter from './routes/logs.js';

// ─── Feedback Route Modules ───
import feedbackRouter, { ensureFeedbackSchema, broadcastFeedbackRouter, activityFeedbackRouter } from './routes/feedback.js';

// ─── 品牌教練 ───
import { ensureBrandCoachSchema } from './lib/brand_coach.js';
import brandCoachRouter from './routes/brand_coach.js';

// ─── B5. 啟動環境變數驗證 ───
const requireEnv = (key, ifProductionOnly = false) => {
  if (ifProductionOnly && process.env.NODE_ENV !== 'production') return;
  if (!process.env[key]) {
    console.error(`[FATAL] 缺少必要環境變數：${key}`);
    process.exit(1);
  }
};
requireEnv('ENCRYPTION_KEY');
requireEnv('SESSION_SECRET');
requireEnv('ADMIN_PASS_HASH', true);   // 生產必要

if (process.env.ENCRYPTION_KEY && !/^[0-9a-f]{64}$/i.test(process.env.ENCRYPTION_KEY)) {
  console.error('[FATAL] ENCRYPTION_KEY 必須是 64 字元 hex（32 bytes）');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
  console.warn('[WARN] 沒設 ANTHROPIC_API_KEY 或 GEMINI_API_KEY，AI 草擬等功能不可用');
}

// ─── 初始化 P4 Schema ───
ensureGameSchema();
ensureBroadcastSchema();
ensureAbTestSchema();
ensureEcommerceSchema();
ensureRichMenuSchema();
ensureJourneySchema();

// ─── 初始化 P3 Schema ───
ensureRulesSchema();
ensureScheduledSchema();
ensureWebhooksOutSchema();

// ─── 初始化 P6 Schema ───
ensureBillingSchema();
ensureApiLogSchema();
ensureSecuritySchema();
ensureSchedulerSchema();

// ─── 初始化評價 Schema ───
ensureFeedbackSchema();

// ─── 初始化 P8 Schema ───
ensurePostReplySchema();

// ─── 初始化新功能 Schema ───
ensureAutoReplySchema();
ensureClvSchema();

// ─── 初始化 SLA Schema ───
ensureSlaSchema();
startSlaScheduler();

// ─── 初始化 VoC Schema ───
ensureVocSchema();

// ─── 初始化品牌教練 Schema ───
ensureBrandCoachSchema();

// ─── 梵森預設規則 seed ───
try {
  const vansen = db.prepare("SELECT id FROM clients WHERE name = 'vansen'").get();
  if (vansen) seedDefaultRules(vansen.id);
} catch {}

const log = rootLogger.child({ module: 'server' });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8080', 10);
const pkg = JSON.parse(
  (await import('fs')).default.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
);

const app = express();

// ─── C1. trust proxy（Railway 走 reverse proxy）───
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', parseInt(process.env.TRUST_PROXY, 10) || 1);
}

// ─── HTTP server（讓 socket.io 掛上去）───
const httpServer = http.createServer(app);

// ─── 初始化 Socket.IO ───
realtimeInit(httpServer);

// ─── B1. Security Headers（最早掛）───
app.use(securityHeaders);

// ─── B2. Global Rate Limiter（60 req/min/IP）───
app.use(globalRateLimiter);

// ─── Request ID + 計時 middleware ───
app.use((req, res, next) => {
  req.id = crypto.randomUUID().slice(0, 8);
  req.startAt = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - req.startAt;
    const status = res.statusCode;
    const ctx = {
      request_id: req.id,
      method: req.method,
      path: req.path,
      status,
      duration_ms: duration,
      ip: req.ip,
      user_id: req.session?.user_id ?? null,
    };
    if (status >= 500) log.error(ctx, 'req end');
    else if (status >= 400) log.warn(ctx, 'req end');
    else log.info(ctx, 'req end');

    // ─── P6: 慢 endpoint 偵測（>500ms）───
    if (duration > 500) {
      console.log('[slow_logs] inserting', duration, `${req.method} ${req.path}`);
      log.warn({ path: req.path, duration_ms: duration, method: req.method }, '慢端點偵測');
      try {
        db.prepare(`
          INSERT INTO slow_logs (type, path, duration_ms, user_id, client_id, details, created_at)
          VALUES ('endpoint', ?, ?, ?, ?, ?, ?)
        `).run(
          `${req.method} ${req.path}`,
          duration,
          req.session?.user_id ?? null,
          req.session?.client_id ?? null,
          JSON.stringify({ status, request_id: req.id }),
          Date.now()
        );
      } catch (e) {
        console.error('[slow_logs] INSERT 失敗：', e.message, e.stack);
      }
    }
  });

  log.info({
    request_id: req.id,
    method: req.method,
    path: req.path,
    ip: req.ip,
  }, 'req start');

  next();
});

// ─── raw body 給 webhook 驗簽用，其他 JSON parse ───
app.use((req, res, next) => {
  if (req.path.startsWith('/webhook/')) {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      try { req.body = JSON.parse(req.rawBody.toString('utf8')); } catch { req.body = {}; }
      next();
    });
  } else {
    express.json({ limit: '2mb' })(req, res, next);
  }
});

// ─── 公開路由（不需登入）───
app.use('/login.html', express.static(path.join(__dirname, 'public', 'login.html')));
app.use('/styles.css', express.static(path.join(__dirname, 'public', 'styles.css')));

// ─── PWA 必要檔（manifest / SW / icons 必須在 requireAuth 之前）───
app.get('/manifest.webmanifest', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// icons 目錄公開（SVG 設正確 Content-Type）
app.get('/icons/:file', (req, res) => {
  const file = req.params.file;
  // 限制只允許安全的檔名
  if (!/^[\w.-]+$/.test(file)) return res.status(400).end();
  const filePath = path.join(__dirname, 'public', 'icons', file);
  if (file.endsWith('.svg')) {
    res.setHeader('Content-Type', 'image/svg+xml');
  } else if (file.endsWith('.png')) {
    // 如果是 SVG 內容偽裝成 PNG，改回 SVG Content-Type 讓瀏覽器正確渲染
    const svgPath = path.join(__dirname, 'public', 'icons', 'icon.svg');
    return res.setHeader('Content-Type', 'image/svg+xml'), res.sendFile(svgPath);
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).end();
  });
});

// ─── 玩家公開遊戲頁（顧客點 LINE/FB 連結進來玩，不需登入）───
app.use('/play', express.static(path.join(__dirname, 'public', 'play')));

// ─── Quiz 公開頁（顧客點連結進來做選香 quiz，不需登入）───
app.use('/quiz', express.static(path.join(__dirname, 'public', 'quiz')));

// ─── 結帳短連結重定向（公開，不需登入）───
app.get('/go/:code', (req, res) => {
  const { code } = req.params;
  if (!/^[0-9a-f]{8}$/.test(code)) return res.status(400).send('無效連結');
  const fullUrl = recordCheckoutClick(code);
  if (!fullUrl) return res.status(404).send('連結不存在或已失效');
  res.redirect(302, fullUrl);
});

// ─── Quiz 公開 API（requireAuth 之前）───
app.use('/api/quiz', quizRouter);

// ─── 顧客評價頁（公開，不需登入）───
app.use('/feedback', express.static(path.join(__dirname, 'public', 'feedback')));

// ─── 評價公開 API（requireAuth 之前）───
app.use('/api/feedback', feedbackRouter);

// ─── 遊戲化：玩家公開路由（不需登入）───
// 簽到、分享回饋、MGM 邀請、點數查詢、排行榜
app.use('/api/play', playRouter);

// ─── 玩家公開 API（活動資訊 + 抽獎）───
app.get('/api/play/:activity_id/info', (req, res) => {
  const id = parseInt(req.params.activity_id, 10);
  const activity = getActivity(id);
  if (!activity || activity.status !== 'active') {
    return res.status(404).json({ error: '活動不存在或尚未開始' });
  }
  const prizes = getActivityPrizes(id).map(p => ({
    id: p.id, name: p.name, description: p.description,
    image_url: p.image_url, display_order: p.display_order,
  }));
  let config = {};
  try { config = JSON.parse(activity.config || '{}'); } catch {}
  const rem = getActivityRemaining(id);
  res.json({
    id: activity.id, name: activity.name, type: activity.type,
    start_at: activity.start_at, end_at: activity.end_at,
    participation_limit_per_user: activity.participation_limit_per_user,
    draws_per_participation: activity.draws_per_participation || 1,
    sound_effect: activity.sound_effect || 'silent',
    share_bonus_enabled: activity.share_bonus_enabled || 0,
    config: { background_image: config.background_image, description: config.description },
    prizes,
    remaining_winners: rem?.remaining_winners ?? null,
    time_remaining_seconds: rem?.time_remaining_seconds ?? null,
  });
});

app.post('/api/play/:activity_id/draw', (req, res) => {
  const id = parseInt(req.params.activity_id, 10);
  const { channel_user_id, customer_id, times } = req.body || {};
  const result = drawPrize(id, {
    customer_id: customer_id ? parseInt(customer_id, 10) : null,
    channel_user_id: channel_user_id || null,
    ip: req.ip,
    user_agent: req.headers['user-agent'] || null,
    times: times ? parseInt(times, 10) : undefined,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  try {
    const activity = getActivity(id);
    if (activity) emitToClient(activity.client_id, 'game:draw', {
      activity_id: id, won: result.won, prize: result.prize?.name,
    });
  } catch {}
  res.json(result);
});

// ─── Health（C2 強化）───
const SERVER_START_AT = Date.now();

app.get('/api/health', (_req, res) => {
  let db_ok = false;
  let tables_count = 0;
  try {
    db.prepare('SELECT 1').get();
    db_ok = true;
    const tables = db.prepare(`SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table'`).get();
    tables_count = tables.cnt;
  } catch {}
  const memory_mb = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
  const active_sessions = countActiveSessions();

  // disk_free_mb（fs.statfs 在 Node 18+ 可用）
  let disk_free_mb = null;
  try {
    const stat = fs.statfsSync('.');
    disk_free_mb = Math.round(stat.bfree * stat.bsize / 1024 / 1024);
  } catch {}

  // git_sha：從環境變數或讀 .git/HEAD
  let git_sha = process.env.GIT_SHA || null;
  if (!git_sha) {
    try {
      const gitDir = path.join(__dirname, '.git');
      if (fs.existsSync(gitDir)) {
        const headContent = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        if (headContent.startsWith('ref: ')) {
          const refPath = path.join(gitDir, headContent.slice(5));
          if (fs.existsSync(refPath)) {
            git_sha = fs.readFileSync(refPath, 'utf8').trim().slice(0, 7);
          }
        } else {
          git_sha = headContent.slice(0, 7);
        }
      }
    } catch {}
  }

  const liveness = db_ok && memory_mb < 800 && (disk_free_mb === null || disk_free_mb > 100);

  res.json({
    status: 'ok',
    liveness,
    uptime: process.uptime(),
    version: pkg.version,
    db_ok,
    tables_count,
    memory_mb,
    active_sessions,
    node_env: process.env.NODE_ENV || 'development',
    started_at: SERVER_START_AT,
    disk_free_mb,
    git_sha,
  });
});

// ─── Auth ───
app.post('/api/login', loginRateLimiter, (req, res) => {
  const { username, password } = req.body || {};

  // 先取 user row 以便做鎖定檢查
  const userRow = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  // 鎖定檢查
  if (userRow?.locked_until && userRow.locked_until > Date.now()) {
    const remainSec = Math.ceil((userRow.locked_until - Date.now()) / 1000);
    return res.status(429).json({ error: `帳號暫時鎖定，請 ${remainSec} 秒後再試` });
  }

  const user = checkLogin(username, password);

  if (!user) {
    // 登入失敗：累加 failed_attempts
    if (userRow) {
      const attempts = (userRow.failed_attempts || 0) + 1;
      const lockedUntil = attempts >= 5 ? Date.now() + 15 * 60 * 1000 : null;
      db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
        .run(attempts, lockedUntil, userRow.id);
      if (lockedUntil) {
        log.warn({ user_id: userRow.id, attempts }, 'user account locked after 5 failures');
        // P6: 記錄安全事件
        recordLoginAttempt(username, req.ip, false, req.headers['user-agent'],
          req.headers['cf-ipcountry'] || null);
        return res.status(429).json({ error: '登入失敗次數過多，帳號鎖定 15 分鐘' });
      }
    }
    // P6: 記錄失敗登入
    recordLoginAttempt(username, req.ip, false, req.headers['user-agent'],
      req.headers['cf-ipcountry'] || null);
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  // 成功：清除失敗計數
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);

  // 2FA 檢查
  if (user.totp_enabled) {
    // 暫存一個短效 session token（60 秒有效），讓前端做第二步
    const tempToken = crypto.randomBytes(16).toString('hex');
    db.prepare(`INSERT INTO sessions (id, user_id, username, role, client_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(`2fa:${tempToken}`, user.id, user.username, user.role, user.client_id, Date.now(), Date.now() + 120_000);
    return res.json({ require_2fa: true, temp_token: tempToken });
  }

  const { id, expiresAt } = createSession(user);
  setSessionCookie(res, id, expiresAt);
  generateCsrfToken(res); // B3: 寫入 CSRF cookie
  insertAuditLog({ user_id: user.id, action: 'login', ip: req.ip });
  // P6: 記錄成功登入
  recordLoginAttempt(user.username, req.ip, true, req.headers['user-agent'],
    req.headers['cf-ipcountry'] || null);
  log.info({ user_id: user.id, username: user.username, request_id: req.id }, 'user login');
  res.json({ ok: true, role: user.role, client_id: user.client_id });
});

// ─── 2FA 第二步 ───
app.post('/api/login/2fa', (req, res) => {
  const { temp_token, code } = req.body || {};
  if (!temp_token || !code) return res.status(400).json({ error: '缺少 temp_token 或 code' });

  const tempSess = db.prepare(`SELECT * FROM sessions WHERE id = ? AND expires_at > ?`)
    .get(`2fa:${temp_token}`, Date.now());
  if (!tempSess) return res.status(401).json({ error: 'temp_token 無效或已過期' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(tempSess.user_id);
  if (!user || !user.totp_secret) return res.status(401).json({ error: '2FA 設定異常' });

  // 驗 TOTP
  if (!verifyTotp(user.totp_secret, code)) {
    // 也檢查備援碼
    let usedBackup = false;
    try {
      const backupCodes = JSON.parse(user.backup_codes || '[]');
      const normalizedCode = String(code).toUpperCase().trim();
      const idx = backupCodes.indexOf(normalizedCode);
      if (idx !== -1) {
        backupCodes.splice(idx, 1);
        db.prepare('UPDATE users SET backup_codes = ? WHERE id = ?').run(JSON.stringify(backupCodes), user.id);
        usedBackup = true;
      }
    } catch {}

    if (!usedBackup) {
      return res.status(401).json({ error: '驗證碼錯誤' });
    }
  }

  // 清除 temp session
  db.prepare('DELETE FROM sessions WHERE id = ?').run(`2fa:${temp_token}`);

  const { id, expiresAt } = createSession(user);
  setSessionCookie(res, id, expiresAt);
  generateCsrfToken(res); // B3: 寫入 CSRF cookie
  insertAuditLog({ user_id: user.id, action: 'login_2fa', ip: req.ip });
  log.info({ user_id: user.id, request_id: req.id }, '2FA login success');
  res.json({ ok: true, role: user.role, client_id: user.client_id });
});

app.post('/api/logout', (req, res) => {
  const sid = getCookie(req);
  const uid = req.session?.user_id ?? null;
  if (sid) destroySession(sid);
  clearSessionCookie(res);
  if (uid) {
    insertAuditLog({ user_id: uid, action: 'logout', ip: req.ip });
    log.info({ user_id: uid, request_id: req.id }, 'user logout');
  }
  res.json({ ok: true });
});

// ─── Webhooks（空殼，等 token 進來再實作業務邏輯）───

// LINE webhook
app.post('/webhook/line/:client_id', async (req, res) => {
  const clientId = parseInt(req.params.client_id, 10);
  const client = getClient(clientId);
  if (!client) return res.status(404).json({ error: '業主不存在' });

  // ── 簽章驗證 ──
  if (!client.line_channel_secret_enc) {
    log.warn({ client_id: clientId }, 'LINE channel secret 未設定，略過簽章驗證');
  } else {
    const secret = decrypt(client.line_channel_secret_enc);
    const sig = req.headers['x-line-signature'];
    if (!secret || !lineVerify(secret, req.rawBody, sig)) {
      log.warn({ client_id: clientId, sig: sig?.slice(0, 20) }, 'LINE 簽章驗證失敗');
      return res.status(401).json({ error: 'invalid signature' });
    }
  }

  // ── 立刻回 200（LINE 規定 5 秒內回應）──
  res.status(200).json({ ok: true });

  // ── 非同步處理每個 event ──
  const events = req.body?.events || [];
  log.info({ client_id: clientId, event_count: events.length }, 'LINE webhook 收到');
  for (const event of events) {
    try {
      await processLineEvent(clientId, client, event);
    } catch (e) {
      log.error({ err: e.message, event_type: event.type, client_id: clientId }, 'LINE event 處理失敗');
    }
  }
});

// ─── LINE Event 核心處理函式 ───
async function processLineEvent(clientId, client, event) {
  // ── follow 事件：加好友 ──
  if (event.type === 'follow') {
    const userId = event.source?.userId;
    log.info({ client_id: clientId, line_user_id: userId }, 'LINE 新好友 follow');
    if (userId) {
      // 嘗試建立/更新顧客
      let chRow = getChannelIdentity('line', userId);
      let customerId;
      if (!chRow) {
        let profile = {};
        try {
          const accessToken = decrypt(client.line_access_token_enc);
          profile = await lineGetUserProfile(accessToken, userId, clientId);
        } catch (e) {
          log.warn({ err: e.message }, 'follow：getUserProfile 失敗');
        }
        customerId = insertCustomer({ client_id: clientId, name: profile.displayName || 'LINE 顧客' });
        insertChannelIdentity({
          customer_id: customerId,
          channel: 'line',
          channel_user_id: userId,
          channel_display_name: profile.displayName || null,
          channel_avatar_url: profile.pictureUrl || null,
        });
        insertAuditLog({ action: 'customer_created', entity_type: 'customer', entity_id: customerId, details: JSON.stringify({ source: 'line_follow', line_user_id: userId }) });
        checkAndEnrollJourneyTrigger('customer_created', { client_id: clientId, customer_id: customerId });
        log.info({ client_id: clientId, customer_id: customerId }, 'LINE follow：新顧客已建立');
      }
    }
    return;
  }

  // ── unfollow 事件：封鎖或刪好友 ──
  if (event.type === 'unfollow') {
    const userId = event.source?.userId;
    log.info({ client_id: clientId, line_user_id: userId }, 'LINE unfollow');
    if (userId) {
      const chRow = getChannelIdentity('line', userId);
      if (chRow) {
        // 在 tags 加上「不再接收廣播」標記
        const cust = getCustomer(chRow.customer_id, clientId);
        if (cust) {
          let tags = [];
          try { tags = JSON.parse(cust.tags || '[]'); } catch { tags = []; }
          if (!tags.includes('不再接收廣播')) {
            tags.push('不再接收廣播');
            updateCustomer(chRow.customer_id, clientId, { tags: JSON.stringify(tags) });
            log.info({ customer_id: chRow.customer_id }, 'LINE unfollow：已標記不再接收廣播');
          }
        }
      }
    }
    return;
  }

  // ── 非 message event，略過 ──
  if (event.type !== 'message') {
    log.debug({ event_type: event.type, client_id: clientId }, 'LINE 非訊息事件略過');
    return;
  }

  const normalized = normalizeLine(event);
  const lineUserId = normalized.external_user_id;
  if (!lineUserId) {
    log.warn({ client_id: clientId }, 'LINE event 缺少 source.userId，略過');
    return;
  }

  // ── Upsert customer ──
  let chRow = getChannelIdentity('line', lineUserId);
  let customerId;
  let isBlocked = false;

  if (chRow) {
    customerId = chRow.customer_id;
    // 取黑名單狀態
    const cust = getCustomer(customerId, clientId);
    isBlocked = cust?.is_blocked === 1;
  } else {
    // 新顧客：先撈 LINE profile
    let profile = {};
    try {
      const accessToken = decrypt(client.line_access_token_enc);
      profile = await lineGetUserProfile(accessToken, lineUserId, clientId);
    } catch (e) {
      log.warn({ err: e.message }, 'getUserProfile 失敗，用預設名稱');
    }

    customerId = insertCustomer({ client_id: clientId, name: profile.displayName || 'LINE 顧客' });
    insertChannelIdentity({
      customer_id: customerId,
      channel: 'line',
      channel_user_id: lineUserId,
      channel_display_name: profile.displayName || null,
      channel_avatar_url: profile.pictureUrl || null,
    });

    checkAndEnrollJourneyTrigger('customer_created', { client_id: clientId, customer_id: customerId });
    log.info({ client_id: clientId, customer_id: customerId }, 'LINE 新顧客建立完成');
  }

  // ── 黑名單 ──
  if (isBlocked) {
    log.info({ client_id: clientId, customer_id: customerId }, '黑名單顧客訊息已略過');
    return;
  }

  // ── Upsert conversation ──
  let conv = findOpenConversation(clientId, customerId, 'line');
  if (!conv) {
    const convId = insertConversation({ client_id: clientId, customer_id: customerId, channel: 'line' });
    conv = getConversation(convId);
  }

  // 更新 conversation 最後訊息資訊
  updateConversation(conv.id, clientId, {
    last_message_at: Date.now(),
    last_message_preview: normalized.content?.slice(0, 100) || '',
    unread_count: (conv.unread_count || 0) + 1,
  });

  // ── 寫入 message ──
  const msgId = insertMessage({
    conversation_id: conv.id,
    direction: 'inbound',
    sender_type: 'customer',
    content_type: normalized.content_type || 'text',
    content: normalized.content || null,
    media_url: normalized.media_url || null,
    metadata: JSON.stringify({ reply_token: normalized.reply_token, raw_event: event }),
    external_message_id: normalized.external_message_id || null,
  });

  // ── Billing：incoming 免費 ──
  recordBilling({
    client_id: clientId,
    channel: 'line',
    api_type: 'incoming',
    message_id: msgId,
    conversation_id: conv.id,
    metadata: { event_type: event.type },
  });

  // ── SLA：記錄第一則 inbound 時間 ──
  if (!conv.first_inbound_at) {
    db.prepare('UPDATE conversations SET first_inbound_at = ?, sla_status = ? WHERE id = ?')
      .run(Date.now(), 'within', conv.id);
  }

  // ── 推播 message:new ──
  emitToClient(clientId, 'message:new', {
    conversation_id: conv.id,
    message_id: msgId,
    customer_id: customerId,
    channel: 'line',
    content: normalized.content,
    content_type: normalized.content_type,
  });

  // ── 語音訊息自動轉文字（async，不阻塞 webhook）──
  if (normalized.content_type === 'audio') {
    Promise.resolve().then(async () => {
      try {
        const accessToken = decrypt(client.line_access_token_enc);
        const { ok, buffer, contentType } = await lineGetMessageContent(accessToken, event.message.id, clientId);
        if (!ok) {
          log.warn({ msg_id: msgId }, '語音取得失敗，跳過轉文字');
          return;
        }
        // 寫入 audio_duration_ms（LINE 提供 ms）
        const durationMs = event.message.duration || null;
        if (durationMs) {
          db.prepare('UPDATE messages SET audio_duration_ms = ? WHERE id = ?').run(durationMs, msgId);
        }

        const tr = await transcribeAudio(buffer, contentType || 'audio/m4a');
        if (tr.ok && tr.text) {
          db.prepare('UPDATE messages SET content = ?, transcript = ? WHERE id = ?')
            .run(tr.text, tr.text, msgId);
          // 更新對話 preview
          db.prepare('UPDATE conversations SET last_message_preview = ? WHERE id = ?')
            .run(tr.text.slice(0, 100), conv.id);
          // 通知前端即時更新
          emitToClient(clientId, 'message:transcribed', {
            conversation_id: conv.id,
            message_id: msgId,
            transcript: tr.text,
            duration_ms: durationMs,
          });
          log.info({ msg_id: msgId, text_len: tr.text.length }, '語音轉文字完成');
        } else if (!tr.ok) {
          log.warn({ msg_id: msgId, err: tr.error }, '語音轉文字失敗（已標 TODO）');
          db.prepare("UPDATE messages SET content = ? WHERE id = ?").run('[語音訊息 - 轉文字失敗，請人工處理]', msgId);
        }
      } catch (e) {
        log.error({ err: e.message, msg_id: msgId }, '語音轉文字流程錯誤');
      }
    });
  }

  log.info({ client_id: clientId, conv_id: conv.id, msg_id: msgId, content_type: normalized.content_type }, 'LINE 訊息已寫入');

  // ── AI 離線自動回覆（async，不阻塞）──
  if (normalized.content && normalized.content_type === 'text') {
    Promise.resolve().then(async () => {
      try {
        // LINE 回覆函式：用 reply_token 或 push
        const lineReplyFn = async (convId, replyText, outboundMsgId) => {
          let meta = {};
          try { meta = JSON.parse(db.prepare('SELECT metadata FROM messages WHERE id = ?').get(msgId)?.metadata || '{}'); } catch {}
          const replyToken = meta?.reply_token;
          const accessToken = decrypt(client.line_access_token_enc);
          if (replyToken) {
            await lineReplyText(accessToken, replyToken, replyText, clientId);
          } else {
            await lineSendText(accessToken, normalized.external_user_id || lineUserId, replyText, clientId);
          }
          // 推播 message:reply
          emitToClient(clientId, 'message:reply', {
            conversation_id: convId,
            message: { id: outboundMsgId, direction: 'outbound', sender_type: 'ai', content: replyText, created_at: Date.now() },
          });
        };
        await processAutoReply(conv.id, normalized.content, clientId, msgId, lineReplyFn);
      } catch (e) {
        log.warn({ err: e.message, conv_id: conv.id }, 'AI 自動回覆失敗');
      }
    });
  }

  // ── 非同步後處理：規則引擎 + 意圖分類 + 自動摘要（不阻塞 webhook）──
  Promise.resolve().then(async () => {
    try {
      // 規則引擎（第二參數是訊息文字，第三參數是 context）
      await evaluateRules(clientId, normalized.content || '', {
        conversation_id: conv.id,
        customer_id: customerId,
      });
    } catch (e) {
      console.error('[rules] 規則引擎執行失敗：', e.message, e.stack);
      log.error({ err: e.message, stack: e.stack }, '規則引擎執行失敗');
    }

    try {
      // 意圖分類（取最近 3 則訊息做上下文，brandDna 從業主設定取）
      const recentMsgs = listMessages(conv.id, { limit: 4 }).slice(0, -1); // 排除剛寫入的這則
      const clientRow = getClient(clientId);
      let brandDna = {};
      try { brandDna = JSON.parse(clientRow?.brand_dna || '{}'); } catch {}
      const classified = await classifyMessage(normalized.content || '', recentMsgs, brandDna);
      if (classified) {
        updateConversation(conv.id, clientId, {
          intent: classified.intent,
          emotion: classified.emotion,
          urgency: classified.urgency,
        });
        emitToClient(clientId, 'conversation:update', {
          id: conv.id,
          intent: classified.intent,
          emotion: classified.emotion,
          urgency: classified.urgency,
        });

        if (classified.emotion === 'angry' || classified.urgency === 'high') {
          emitToClient(clientId, 'alert:urgent', {
            conversation_id: conv.id,
            customer_id: customerId,
            reason: classified.emotion === 'angry' ? 'angry' : 'high_urgency',
          });
          log.warn({ conv_id: conv.id, emotion: classified.emotion, urgency: classified.urgency }, '緊急訊息警示已推播');
        }
      }
    } catch (e) {
      console.error('[intent] 意圖分類失敗：', e.message, e.stack);
      log.error({ err: e.message, stack: e.stack }, '意圖分類失敗');
    }

    // P8：自動摘要觸發
    try {
      await maybeAutoSummarize(conv.id, clientId);
    } catch (e) {
      log.warn({ err: e.message, conv_id: conv.id }, '自動摘要失敗');
    }

    // VoC：非同步分析，不阻塞主流程
    setImmediate(() => {
      vocAnalyzeMessage(msgId).catch(e =>
        log.warn({ err: e.message, msgId }, 'VoC analyzeMessage async error')
      );
    });
  });
}

// ─── P8：自動摘要判斷邏輯（供 LINE / FB / IG 共用）───
async function maybeAutoSummarize(convId, clientId) {
  const conv = getConversation(convId, clientId);
  if (!conv) return;

  // 只計算 inbound 訊息數
  const inboundCount = db.prepare(
    "SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ? AND direction = 'inbound'"
  ).get(convId)?.cnt || 0;

  let shouldSummarize = false;

  if (!conv.summary) {
    // 無摘要：等累積 >= 5 則 inbound 才開始摘
    shouldSummarize = inboundCount >= 5;
  } else if (conv.summary_updated_at) {
    // 有摘要：摘要後新增 >= 10 則訊息 → 重摘
    const newCount = db.prepare(
      'SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ? AND created_at > ?'
    ).get(convId, conv.summary_updated_at)?.cnt || 0;
    shouldSummarize = newCount >= 10;
  }

  if (!shouldSummarize) return;

  const messages = listMessages(convId, { limit: 30 });
  const result = await summarizeConversation(messages);
  if (!result?.summary) return;

  const updateFields = { summary: result.summary, summary_updated_at: Date.now() };
  if (result.key_intent) updateFields.intent = result.key_intent;

  updateConversation(convId, clientId, updateFields);
  emitToClient(clientId, 'conversation:update', {
    conversation_id: convId,
    summary: result.summary,
    intent: result.key_intent || conv.intent,
  });
  log.info({ conv_id: convId, client_id: clientId }, 'P8 自動摘要完成');
}

// FB webhook verify (GET)
app.get('/webhook/fb/:client_id', (req, res) => {
  const clientId = parseInt(req.params.client_id, 10);
  const client = getClient(clientId);

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe') {
    // TODO: 等業主設定 fb_verify_token 後驗證
    // if (!client?.fb_verify_token) {
    //   return res.status(403).send('verify_token 未設定');
    // }
    // const { ok, challenge: ch } = handleVerifyChallenge(client.fb_verify_token, token, challenge);
    // if (!ok) return res.status(403).send('verify_token 不符');
    // return res.status(200).send(ch);

    log.info({ request_id: req.id, client_id: clientId, token }, 'FB webhook verify');
    return res.status(200).send(challenge || 'ok');
  }

  res.status(400).send('bad request');
});

// FB webhook receive (POST)
app.post('/webhook/fb/:client_id', (req, res) => {
  const clientId = parseInt(req.params.client_id, 10);
  const client = getClient(clientId);
  if (!client) return res.status(404).json({ error: '業主不存在' });

  // TODO: 等業主提供 FB App Secret 後啟用簽名驗證
  // const appSecret = process.env.FB_APP_SECRET;
  // const sig = req.headers['x-hub-signature-256'];
  // if (!appSecret || !fbVerify(appSecret, req.rawBody, sig)) {
  //   return res.status(401).json({ error: 'invalid signature' });
  // }

  // 立刻回 200（Meta 要求）
  res.status(200).json({ ok: true });

  const entries = req.body?.entry || [];

  // TODO: 等業主提供 FB token 後解除 DM 處理的 TODO 區塊
  // for (const entry of entries) {
  //   for (const messaging of entry.messaging || []) {
  //     const normalized = normalizeFb(messaging);
  //     // ... upsert customer, conversation, message
  //   }
  // }

  // P8：FB 貼文留言自動回覆 DM
  // entry.changes[].field === 'feed' && value.item === 'comment'
  Promise.resolve().then(async () => {
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field !== 'feed') continue;
        const v = change.value || {};
        if (v.item !== 'comment') continue;
        // 跳過業主自己的留言
        if (v.from?.id === client.fb_page_id) continue;

        try {
          await processComment(clientId, 'fb', {
            comment_id: v.comment_id || v.id,
            post_id: v.post_id || entry.id,
            commenter_id: v.from?.id,
            text: v.message || v.comment || '',
            timestamp: v.created_time ? v.created_time * 1000 : Date.now(),
          });
        } catch (e) {
          log.error({ err: e.message, client_id: clientId }, 'FB comment processComment 失敗');
        }
      }
    }
  });

  log.info({
    request_id: req.id,
    client_id: clientId,
    body_bytes: req.rawBody?.length,
  }, 'FB webhook received');
});

// IG webhook verify (GET)
app.get('/webhook/ig/:client_id', (req, res) => {
  const clientId = parseInt(req.params.client_id, 10);
  const client = getClient(clientId);

  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe') {
    // 若業主已設定 ig_verify_token，進行驗證；否則開發期直接回應 challenge
    if (client?.ig_verify_token) {
      const { ok, challenge: ch } = igHandleVerifyChallenge(client.ig_verify_token, token, challenge);
      if (!ok) {
        log.warn({ request_id: req.id, client_id: clientId }, 'IG webhook verify_token 不符');
        return res.status(403).send('verify_token 不符');
      }
      log.info({ request_id: req.id, client_id: clientId, token }, 'IG webhook verified');
      return res.status(200).send(ch);
    }
    // TODO: 等業主設定 ig_verify_token 後，移除下方 stub（目前開發期直接回應）
    log.info({ request_id: req.id, client_id: clientId, token }, 'IG webhook verify（stub，未設 token）');
    return res.status(200).send(challenge || 'ok');
  }

  res.status(400).send('bad request');
});

// IG webhook receive (POST)
app.post('/webhook/ig/:client_id', (req, res) => {
  const clientId = parseInt(req.params.client_id, 10);
  const client = getClient(clientId);
  if (!client) return res.status(404).json({ error: '業主不存在' });

  // TODO: 等業主提供 Meta App Secret 後啟用簽名驗證
  // const appSecret = process.env.META_APP_SECRET || process.env.FB_APP_SECRET;
  // const sig = req.headers['x-hub-signature-256'];
  // if (!appSecret || !igVerify(appSecret, req.rawBody, sig)) {
  //   return res.status(401).json({ error: 'invalid signature' });
  // }

  // TODO: 等 IG token 進來實作：解析 entry.messaging，寫入 messages + 更新 conversation
  // const entries = req.body?.entry || [];
  // for (const entry of entries) {
  //   for (const messaging of entry.messaging || []) {
  //     // 跳過回聲（IG Business 帳號自己送的訊息）
  //     if (messaging.message?.is_echo) continue;
  //     // 跳過 seen 事件
  //     if (messaging.read) continue;
  //
  //     const normalized = normalizeIg(messaging);
  //     if (!normalized.channelUserId) continue;
  //
  //     // ─── 跨通道顧客身份合併（簡化版：exact name match）───
  //     let channelRecord = getChannelIdentity('ig', normalized.channelUserId);
  //     let customerId;
  //     if (channelRecord) {
  //       customerId = channelRecord.customer_id;
  //     } else {
  //       // 嘗試從 IG profile 拿 username（需要 token）
  //       // const profile = await igGetUserProfile(decrypt(client.ig_access_token_enc), normalized.channelUserId);
  //       // const igName = profile?.name || null;
  //       // 若 username 跟既有 customer.name exact match → 合併到既有顧客
  //       // const existing = igName ? db.prepare('SELECT id FROM customers WHERE client_id=? AND name=?').get(clientId, igName) : null;
  //       // customerId = existing ? existing.id : insertCustomer({ client_id: clientId, name: igName || '未知 IG 顧客' });
  //       // 目前 stub：直接建新顧客
  //       customerId = insertCustomer({ client_id: clientId, name: '未知 IG 顧客' });
  //       insertChannelIdentity({ customer_id: customerId, channel: 'ig', channel_user_id: normalized.channelUserId });
  //     }
  //
  //     // 黑名單
  //     const cust = getCustomer(customerId, clientId);
  //     if (cust?.is_blocked) { log.info({ customer_id: customerId }, 'IG: 黑名單顧客忽略'); continue; }
  //
  //     // Upsert conversation
  //     let conv = findOpenConversation(clientId, customerId, 'ig');
  //     if (!conv) {
  //       const convId = insertConversation({ client_id: clientId, customer_id: customerId, channel: 'ig' });
  //       conv = getConversation(convId);
  //     }
  //
  //     // 寫 message
  //     const msgId = insertMessage({
  //       conversation_id: conv.id,
  //       direction: 'inbound',
  //       sender_type: 'customer',
  //       sender_id: normalized.channelUserId,
  //       content_type: normalized.contentType,
  //       content: normalized.content,
  //       media_url: normalized.mediaUrl,
  //       metadata: JSON.stringify(normalized.metadata),
  //       external_message_id: normalized.externalMessageId,
  //     });
  //
  //     updateConversation(conv.id, clientId, {
  //       last_message_at: normalized.timestamp,
  //       last_message_preview: (normalized.content || '[IG 媒體訊息]').slice(0, 100),
  //       unread_count: (conv.unread_count || 0) + 1,
  //     });
  //
  //     emitToClient(clientId, 'message:new', {
  //       conversation_id: conv.id,
  //       message: { id: msgId, direction: 'inbound', sender_type: 'customer', content: normalized.content, created_at: normalized.timestamp },
  //     });
  //
  //     // 觸發 AI 分析（async，不擋回應）
  //     classifyMessage(normalized.content || '', [], {}).then(({ intent, emotion, urgency }) => {
  //       updateConversation(conv.id, clientId, { intent, emotion, urgency });
  //     }).catch(() => {});
  //
  //     // 觸發規則引擎
  //     evaluateRules(clientId, normalized.content || '', { conversation_id: conv.id, customer_id: customerId }).catch(() => {});
  //
  //     // 計費記錄
  //     recordBilling({ client_id: clientId, channel: 'ig', api_type: 'incoming', conversation_id: conv.id });
  //   }
  // }

  // 立刻回 200（Meta 要求）
  res.status(200).json({ ok: true });

  const entries = req.body?.entry || [];

  // P8：IG 貼文留言自動回覆 DM
  // changes[].field === 'comments'
  Promise.resolve().then(async () => {
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field !== 'comments') continue;
        const v = change.value || {};
        // 跳過業主自己的留言
        if (v.from?.id === client.ig_business_account_id) continue;

        try {
          await processComment(clientId, 'ig', {
            comment_id: v.id,
            post_id: v.media?.id || null,
            commenter_id: v.from?.id,
            text: v.text || '',
            timestamp: v.timestamp ? new Date(v.timestamp).getTime() : Date.now(),
          });
        } catch (e) {
          log.error({ err: e.message, client_id: clientId }, 'IG comment processComment 失敗');
        }
      }
    }
  });

  log.info({
    request_id: req.id,
    client_id: clientId,
    body_bytes: req.rawBody?.length,
  }, 'IG webhook received');
});

// ─── 公開路由（玩家抽獎，不需登入）───
// /api/play/:activity_id/info → play-info 子路由
app.get('/api/play/:activity_id/info', (req, res) => {
  const id = parseInt(req.params.activity_id, 10);
  // 委派給 gamesRouter 的 play-info 路由
  req.params.activity_id = id;
  req.url = `/play-info/${id}`;
  gamesRouter(req, res, (err) => {
    if (err) res.status(500).json({ error: err.message });
  });
});
app.post('/api/play/:activity_id/draw', (req, res) => {
  const id = parseInt(req.params.activity_id, 10);
  req.params.activity_id = id;
  req.url = `/play-draw/${id}`;
  gamesRouter(req, res, (err) => {
    if (err) res.status(500).json({ error: err.message });
  });
});

// 電商 Webhook（不需登入）
app.post('/api/webhooks/ecommerce/:client_id', (req, res) => {
  const clientId = parseInt(req.params.client_id, 10);
  const clientRow = db.prepare('SELECT id, name FROM clients WHERE id = ?').get(clientId);
  if (!clientRow) return res.status(404).json({ error: '業主不存在' });

  // TODO: 根據 req.headers['x-shopify-shop-domain'] / 'x-shopline-event' / 其他 header 判斷來源
  // TODO: 實作各平台 webhook 格式解析：
  //   Shopify:  req.headers['x-shopify-hmac-sha256'] 簽名驗證 + orders/create webhook 格式
  //   SHOPLINE: req.headers['x-shopline-hmac-sha256'] 驗證 + 訂單格式
  //   91APP:    各自規格等業主提供文件
  //   CyberBiz: 同上

  const source = req.headers['x-ecommerce-source'] || req.query.source || 'webhook';
  const payload = req.body;
  const now = Date.now();

  // stub：把 payload 當作訂單資料 upsert
  if (payload?.order_id || payload?.external_order_id) {
    const extId = String(payload.order_id || payload.external_order_id);
    try {
      db.prepare(`
        INSERT INTO orders (client_id, external_order_id, source, status, total_amount, items_json, ordered_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(client_id, external_order_id) DO UPDATE SET
          status = excluded.status,
          total_amount = excluded.total_amount,
          updated_at = excluded.updated_at
      `).run(
        clientId, extId, source,
        payload.status || 'pending',
        payload.total_amount ?? payload.total ?? null,
        payload.items ? JSON.stringify(payload.items) : null,
        payload.ordered_at ?? now, now, now
      );
      log.info({ client_id: clientId, external_order_id: extId, source }, 'ecommerce webhook upserted order');
    } catch (e) {
      log.error({ err: e.message, client_id: clientId }, 'ecommerce webhook upsert failed');
    }
  }

  res.status(200).json({ ok: true, received: true });
});

// ─── 以下路由需要登入 ───
app.use(requireAuth);

// ─── B3. CSRF 驗證（requireAuth 之後，static 之前）───
app.use(csrfMiddleware);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Checkout 需登入路由 ───
app.use('/api', checkoutRouter);

app.get('/api/me', (req, res) => {
  const { user_id, username, role, client_id } = req.session;
  const user = getUser(user_id);
  res.json({
    user_id, username, role, client_id,
    online_status: user?.online_status || 'online',
    status_message: user?.status_message || '',
    totp_enabled: user?.totp_enabled || 0,
  });
});

// ─── 業主公開設定（品牌教練門檻等）供客服讀取 ───
app.get('/api/clients/:id/config', requireAuth, (req, res) => {
  const clientId = parseInt(req.params.id, 10);
  // 只允許查詢自己所屬業主（admin 可查所有）
  if (req.session.role !== 'admin' && req.session.client_id !== clientId) {
    return res.status(403).json({ error: '無權限' });
  }
  const row = db.prepare('SELECT id, name, display_name, brand_coach_threshold FROM clients WHERE id = ?').get(clientId);
  if (!row) return res.status(404).json({ error: '業主不存在' });
  return res.json({ client: row });
});

// ─── 客服上線狀態 ───
app.put('/api/me/status', (req, res) => {
  const { status, status_message } = req.body || {};
  const validStatuses = ['online', 'away', 'busy', 'offline'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status 必須是 ${validStatuses.join('/')}` });
  }
  const fields = {};
  if (status) fields.online_status = status;
  if (status_message !== undefined) fields.status_message = status_message;
  updateUserFull(req.session.user_id, fields);

  const clientId = req.session.client_id ?? null;
  emitToClient(clientId, 'user:status', { user_id: req.session.user_id, ...fields });
  res.json({ ok: true });
});

app.get('/api/users/online', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  const rows = db.prepare(`
    SELECT id, username, role, online_status, last_seen_at, status_message
    FROM users WHERE client_id = ? AND online_status != 'offline'
    ORDER BY online_status ASC, last_seen_at DESC
  `).all(clientId ?? 0);
  res.json({ users: rows });
});

// ─── 2FA Setup ───
app.post('/api/me/2fa/setup', (req, res) => {
  const userId = req.session.user_id;
  const user = getUser(userId);
  if (!user) return res.status(404).json({ error: '使用者不存在' });

  const secret = generateSecret();
  const url = getOtpauthUrl(secret, user.username, '客服中心');

  // 暫存 secret（尚未啟用，等 verify 後才真正啟用）
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, userId);

  // 組 QR code 圖片 URL（免費 API，零依賴）
  const qr_code_url = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(url)}&size=200x200`;

  res.json({ ok: true, secret, otpauth_url: url, qrcode_url: url, qr_code_url });
});

app.post('/api/me/2fa/verify', (req, res) => {
  const userId = req.session.user_id;
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: '缺少 code' });

  const user = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId);
  if (!user?.totp_secret) return res.status(400).json({ error: '請先呼叫 /api/me/2fa/setup' });

  if (!verifyTotp(user.totp_secret, code)) {
    return res.status(400).json({ error: '驗證碼錯誤，請確認手機時間正確' });
  }

  const backupCodes = generateBackupCodes(8);
  db.prepare('UPDATE users SET totp_enabled = 1, backup_codes = ? WHERE id = ?')
    .run(JSON.stringify(backupCodes), userId);

  insertAuditLog({ user_id: userId, action: 'enable_2fa', ip: req.ip });
  res.json({ ok: true, backup_codes: backupCodes });
});

app.post('/api/me/2fa/disable', async (req, res) => {
  const userId = req.session.user_id;
  const { password, code } = req.body || {};
  if (!password || !code) return res.status(400).json({ error: '缺少 password 或 code' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: '使用者不存在' });

  // 驗密碼（用 bcryptjs）
  let pwOk = false;
  try {
    const { default: bcryptMod } = await import('bcryptjs');
    pwOk = bcryptMod.compareSync(password, user.password_hash);
  } catch {}

  if (!pwOk) return res.status(401).json({ error: '密碼錯誤' });
  if (!user.totp_secret || !verifyTotp(user.totp_secret, code)) return res.status(401).json({ error: '驗證碼錯誤' });

  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, backup_codes = NULL WHERE id = ?').run(userId);
  insertAuditLog({ user_id: userId, action: 'disable_2fa', ip: req.ip });
  res.json({ ok: true });
});

// ─── @提及 ───
app.get('/api/me/mentions', (req, res) => {
  const userId = req.session.user_id;
  const unread = req.query.unread === 'true';
  const where = ['m.mentioned_user_id = ?'];
  const args = [userId];
  if (unread) { where.push('m.read_at IS NULL'); }
  const rows = db.prepare(`
    SELECT m.*, msg.content AS message_content, msg.conversation_id,
           c.customer_id
    FROM mentions m
    JOIN messages msg ON msg.id = m.message_id
    LEFT JOIN conversations c ON c.id = msg.conversation_id
    WHERE ${where.join(' AND ')}
    ORDER BY m.created_at DESC
    LIMIT 50
  `).all(...args);
  res.json({ mentions: rows });
});

app.post('/api/mentions/:id/read', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const userId = req.session.user_id;
  const mention = db.prepare('SELECT * FROM mentions WHERE id = ? AND mentioned_user_id = ?').get(id, userId);
  if (!mention) return res.status(404).json({ error: '提及不存在或無權限' });
  if (!mention.read_at) {
    db.prepare('UPDATE mentions SET read_at = ? WHERE id = ?').run(Date.now(), id);
  }
  res.json({ ok: true });
});

// ─── 可用範本變數 ───
app.get('/api/template-variables', (_req, res) => {
  res.json({ variables: AVAILABLE_VARIABLES });
});

// ─── 業主管理（admin only）───
app.get('/api/clients', requireAdmin, (_req, res) => {
  const clients = listClients().map(c => {
    const full = getClient(c.id);
    // BV 訂單數統計
    let bvOrderCount = 0;
    try { bvOrderCount = db.prepare("SELECT COUNT(*) AS cnt FROM orders WHERE client_id = ? AND source = 'bvshop'").get(c.id)?.cnt || 0; } catch {}
    return {
      ...c,
      brand_dna: JSON.parse(c.brand_dna || '{}'),
      has_line_token: !!(full?.line_access_token_enc),
      has_line_secret: !!(full?.line_channel_secret_enc),
      has_fb_token: !!(full?.fb_page_token_enc),
      has_fb_verify_token: !!(full?.fb_verify_token),
      // IG DM 欄位
      has_ig_token: !!(full?.ig_access_token_enc),
      ig_business_account_id: full?.ig_business_account_id || null,
      ig_verify_token: full?.ig_verify_token || null,
      // P8 BV SHOP
      bv_shop_url: full?.bv_shop_url || null,
      has_bv_api_key: !!(full?.bv_api_key_enc),
      bv_last_sync_at: full?.bv_last_sync_at || null,
      bv_order_count: bvOrderCount,
      // 結帳連結設定
      cart_url_template: full?.cart_url_template || null,
    };
  });
  res.json({ clients });
});

app.post('/api/clients', requireAdmin, (req, res) => {
  const { name, display_name, brand_dna } = req.body || {};
  if (!name || !display_name) return res.status(400).json({ error: '缺少 name 或 display_name' });
  const brandStr = typeof brand_dna === 'object' ? JSON.stringify(brand_dna) : (brand_dna || '{}');
  const id = insertClient({ name, display_name, brand_dna: brandStr });
  insertAuditLog({ user_id: req.session.user_id, action: 'create_client', entity_type: 'client', entity_id: id, ip: req.ip });
  res.json({ id, ok: true });
});

app.put('/api/clients/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, display_name, brand_dna,
    line_channel_id, line_channel_secret, line_access_token,
    fb_page_id, fb_page_token, fb_verify_token,
    // IG DM 欄位
    ig_business_account_id, ig_access_token, ig_verify_token,
    // P8 BV SHOP 欄位
    bv_shop_url, bv_api_key } = req.body || {};

  const fields = {};
  if (name !== undefined) fields.name = name;
  if (display_name !== undefined) fields.display_name = display_name;
  if (brand_dna !== undefined) fields.brand_dna = typeof brand_dna === 'object' ? JSON.stringify(brand_dna) : brand_dna;
  if (line_channel_id !== undefined) fields.line_channel_id = line_channel_id;
  if (line_channel_secret !== undefined) fields.line_channel_secret_enc = encrypt(line_channel_secret);
  if (line_access_token !== undefined) fields.line_access_token_enc = encrypt(line_access_token);
  if (fb_page_id !== undefined) fields.fb_page_id = fb_page_id;
  if (fb_page_token !== undefined) fields.fb_page_token_enc = encrypt(fb_page_token);
  if (fb_verify_token !== undefined) fields.fb_verify_token = fb_verify_token;
  // IG DM：token 加密存儲
  if (ig_business_account_id !== undefined) fields.ig_business_account_id = ig_business_account_id;
  if (ig_access_token !== undefined) fields.ig_access_token_enc = encrypt(ig_access_token);
  if (ig_verify_token !== undefined) fields.ig_verify_token = ig_verify_token;
  // P8 BV SHOP
  if (bv_shop_url !== undefined) fields.bv_shop_url = bv_shop_url;
  if (bv_api_key !== undefined) fields.bv_api_key_enc = encrypt(bv_api_key);

  updateClientFull(id, fields);
  insertAuditLog({ user_id: req.session.user_id, action: 'update_client', entity_type: 'client', entity_id: id, ip: req.ip });
  res.json({ ok: true });
});

app.delete('/api/clients/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  deleteClient(id);
  insertAuditLog({ user_id: req.session.user_id, action: 'delete_client', entity_type: 'client', entity_id: id, ip: req.ip });
  res.json({ ok: true });
});

// Token 測試（stub，等 P1.5 補；LINE/FB API 整合後啟用）
app.post('/api/clients/:id/test', requireAdmin, (req, res) => {
  res.json({ ok: false, note: 'token 未實作，等 P1.5 補；LINE/FB API 整合後啟用' });
});

// ─── 使用者管理（admin only）───
app.get('/api/users', requireAdmin, (req, res) => {
  const clientId = req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  const users = listUsers(clientId).map(u => ({ ...u, password_hash: undefined }));
  res.json({ users });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role = 'agent', client_id } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '缺少 username 或 password' });
  const password_hash = hashPassword(password);
  const id = insertUser({ username, password_hash, role, client_id: client_id ?? null });
  insertAuditLog({ user_id: req.session.user_id, action: 'create_user', entity_type: 'user', entity_id: id, ip: req.ip });
  res.json({ id, ok: true });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { password, role, client_id } = req.body || {};
  const fields = {};
  if (password) fields.password_hash = hashPassword(password);
  if (role !== undefined) fields.role = role;
  if (client_id !== undefined) fields.client_id = client_id;
  updateUser(id, fields);
  insertAuditLog({ user_id: req.session.user_id, action: 'update_user', entity_type: 'user', entity_id: id, ip: req.ip });
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  deleteUser(id);
  insertAuditLog({ user_id: req.session.user_id, action: 'delete_user', entity_type: 'user', entity_id: id, ip: req.ip });
  res.json({ ok: true });
});

// ─── 對話 ───

// 解析 session 決定 client_id filter（agent 只能看自己業主；admin 可指定）
const resolveClientId = (req) => {
  const sess = req.session;
  if (sess.role === 'admin' && sess.client_id === null) {
    return req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  }
  return sess.client_id;
};

// ─── #1：增量同步 endpoint（Polling 保底）───
app.get('/api/sync', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const since = parseInt(req.query.since || '0', 10);

  // 有變動的 conversations
  const convs = db.prepare(`
    SELECT c.*, cu.name AS customer_name, cu.tags AS customer_tags,
           cc.channel_avatar_url AS customer_avatar_url,
           cc.channel_display_name AS customer_display_name
    FROM conversations c
    LEFT JOIN customers cu ON cu.id = c.customer_id
    LEFT JOIN customer_channels cc ON cc.customer_id = c.customer_id AND cc.channel = c.channel
    WHERE c.client_id = ? AND (c.last_message_at >= ? OR c.updated_at >= ?)
    ORDER BY c.last_message_at DESC LIMIT 50
  `).all(clientId, since, since);

  // 該時間後新增的 messages
  const messages = db.prepare(`
    SELECT m.* FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.client_id = ? AND m.created_at > ?
    ORDER BY m.created_at ASC LIMIT 100
  `).all(clientId, since);

  res.json({
    server_time: Date.now(),
    conversations: convs,
    messages,
  });
});

app.get('/api/conversations', (req, res) => {
  const clientId = resolveClientId(req);
  if (clientId === null) {
    return res.json({ conversations: [], note: '請帶 client_id 查詢' });
  }
  const status = req.query.status || null;
  const tag    = req.query.tag    || null;
  const view   = req.query.view   || null;
  const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);

  // 自訂視圖過濾
  if (view) {
    let extraWhere = '';
    const extraArgs = [];
    if (view === 'mine') {
      extraWhere = `AND c.assigned_user_id = ${req.session.user_id}`;
    } else if (view === 'unassigned') {
      extraWhere = `AND c.assigned_user_id IS NULL AND c.status = 'open'`;
    } else if (view === 'urgent') {
      extraWhere = `AND c.urgency = 'high' AND c.status != 'closed'`;
    } else if (view === 'pinned') {
      extraWhere = `AND c.is_pinned = 1`;
    } else if (view === 'archived') {
      extraWhere = `AND c.archived_at IS NOT NULL`;
    }
    const rows = db.prepare(`
      SELECT c.*, cu.name AS customer_name, cu.tags AS customer_tags
      FROM conversations c
      LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE c.client_id = ? ${extraWhere} AND (c.archived_at IS NULL OR '${view}' = 'archived')
      ORDER BY c.is_pinned DESC, c.last_message_at DESC
      LIMIT ? OFFSET ?
    `).all(clientId, limit, offset);
    return res.json({ conversations: rows, view });
  }

  let rows = listConversations({ client_id: clientId, status, limit, offset });

  // tag 過濾（在 JS 層做，資料量不大）
  if (tag) {
    rows = rows.filter(r => {
      try { return JSON.parse(r.tags || '[]').includes(tag); } catch { return false; }
    });
  }
  res.json({ conversations: rows });
});

app.get('/api/conversations/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });
  res.json({ conversation: conv });
});

app.put('/api/conversations/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });

  const { status, assigned_user_id } = req.body || {};
  const fields = {};
  if (status !== undefined) fields.status = status;
  if (assigned_user_id !== undefined) fields.assigned_user_id = assigned_user_id;

  // 關閉時發送 CSAT（TODO: 改用 LINE/FB quick reply / template 訊息發送）
  if (status === 'closed' && conv.status !== 'closed' && !conv.csat_sent_at) {
    const csatContent = '感謝您今天的洽詢～請給我們一個評分（1-5）讓我們做得更好。';
    try {
      insertMessage({
        conversation_id: id,
        direction: 'outbound',
        sender_type: 'system',
        content_type: 'text',
        content: csatContent,
      });
      fields.csat_sent_at = Date.now();
    } catch {}
  }

  // B: 關閉時 snapshot 主責客服（即使顧客還沒評分）
  if (status === 'closed' && conv.status !== 'closed') {
    import('./lib/csat.js').then(({ resolvePrimaryAgent }) => {
      const { user_id: agentId } = resolvePrimaryAgent(id);
      if (agentId) {
        updateConversation(id, clientId, { csat_agent_id: agentId });
      }
    }).catch(() => {});
  }

  updateConversation(id, clientId, fields);
  insertAuditLog({
    user_id: req.session.user_id,
    action: 'update_conversation',
    entity_type: 'conversation',
    entity_id: id,
    details: JSON.stringify({ status, assigned_user_id }),
    ip: req.ip,
  });

  emitToClient(clientId, 'conversation:update', { conversation_id: id, fields });
  res.json({ ok: true });
});

// ─── 對話標籤 ───
app.put('/api/conversations/:id/tags', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? (req.body?.client_id ? parseInt(req.body.client_id, 10) : null)
    ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });

  const { tags } = req.body || {};
  if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags 必須是陣列' });

  updateConversation(id, clientId, { tags: JSON.stringify(tags) });
  emitToClient(clientId, 'conversation:update', { conversation_id: id, tags });
  res.json({ ok: true, tags });
});

app.get('/api/conversations/:id/messages', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const offset = parseInt(req.query.offset || '0', 10);
  const messages = listMessages(id, { limit, offset });
  res.json({ messages });
});

// ─── 手動回覆（P1 核心）───
// 後端 idempotency cache（5 秒視窗去重 — 防雙送）
const _replyDedupCache = new Map();
const REPLY_DEDUP_WINDOW_MS = 5000;
setInterval(() => {
  const cutoff = Date.now() - REPLY_DEDUP_WINDOW_MS;
  for (const [k, ts] of _replyDedupCache) if (ts < cutoff) _replyDedupCache.delete(k);
}, 60_000).unref();

app.post('/api/conversations/:id/reply', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? (req.body?.client_id ? parseInt(req.body.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });
  if (conv.status === 'closed') return res.status(400).json({ error: '對話已關閉，請先重新開啟' });

  const { content, content_type = 'text' } = req.body || {};
  if (!content?.trim()) return res.status(400).json({ error: '訊息內容不可為空' });

  // ─── 後端去重：同 user/conv/content 在 5 秒內第二次 → 直接回 200 不送 ───
  const dedupKey = `${req.session.user_id}|${id}|${content.trim()}`;
  const lastSent = _replyDedupCache.get(dedupKey);
  if (lastSent && (Date.now() - lastSent) < REPLY_DEDUP_WINDOW_MS) {
    log.warn({ conversation_id: id, user_id: req.session.user_id }, '5 秒內重複送出，已去重');
    return res.json({ ok: true, deduped: true });
  }
  _replyDedupCache.set(dedupKey, Date.now());

  // P3：範本變數替換
  let finalContent = content.trim();
  try {
    const ctx = buildTemplateContext(id, clientId);
    finalContent = renderTemplate(finalContent, ctx);
  } catch {}

  const msgId = insertMessage({
    conversation_id: id,
    direction: 'outbound',
    sender_type: 'agent',
    sender_id: String(req.session.user_id),
    content_type,
    content: finalContent,
  });

  updateConversation(id, clientId, {
    last_message_at: Date.now(),
    last_message_preview: finalContent.slice(0, 100),
  });

  // ── SLA：記錄第一則 outbound 時間，並重設 sla_status ──
  if (!conv.first_outbound_at) {
    db.prepare("UPDATE conversations SET first_outbound_at = ?, sla_status = 'within' WHERE id = ?")
      .run(Date.now(), id);
  }

  insertAuditLog({
    user_id: req.session.user_id,
    action: 'send_message',
    entity_type: 'conversation',
    entity_id: id,
    details: JSON.stringify({ message_id: msgId, content_type }),
    ip: req.ip,
  });

  emitToClient(clientId, 'message:reply', {
    conversation_id: id,
    message: { id: msgId, direction: 'outbound', sender_type: 'agent', content: finalContent, created_at: Date.now() },
  });

  // ── LINE：真實送出訊息 ──
  if (conv.channel === 'line') {
    try {
      const lineClient = getClient(clientId);
      if (!lineClient?.line_access_token_enc) {
        log.warn({ conversation_id: id }, 'LINE access token 未設定，略過送出');
      } else {
        const accessToken = decrypt(lineClient.line_access_token_enc);

        // 取最近一筆 inbound message 的 reply_token
        const lastInbound = db.prepare(`
          SELECT metadata, created_at FROM messages
          WHERE conversation_id = ? AND direction = 'inbound'
          ORDER BY created_at DESC LIMIT 1
        `).get(id);

        let replyToken = null;
        let inboundAge = Infinity;
        if (lastInbound) {
          try {
            const meta = JSON.parse(lastInbound.metadata || '{}');
            replyToken = meta.reply_token || null;
            inboundAge = Date.now() - (lastInbound.created_at || 0);
          } catch {}
        }

        // 取 LINE channel_user_id
        const cc = db.prepare(`
          SELECT channel_user_id FROM customer_channels
          WHERE customer_id = ? AND channel = 'line'
          LIMIT 1
        `).get(conv.customer_id);

        if (!cc) {
          log.error({ conversation_id: id, customer_id: conv.customer_id }, '找不到顧客的 LINE 識別碼');
          throw new Error('找不到顧客的 LINE 識別碼');
        }

        let billingApiType;
        const within24h = inboundAge < 24 * 60 * 60 * 1000;

        if (replyToken && within24h) {
          // 先嘗試 reply（免費），reply token 若已用過會拋錯，fallback push
          try {
            await lineReplyText(accessToken, replyToken, finalContent, clientId);
            billingApiType = 'reply';
            log.info({ conversation_id: id }, 'LINE reply 送出成功');
          } catch (replyErr) {
            log.warn({ err: replyErr.message, conversation_id: id }, 'LINE reply 失敗，改用 push');
            await lineSendText(accessToken, cc.channel_user_id, finalContent, clientId);
            billingApiType = 'push';
            log.info({ conversation_id: id }, 'LINE push fallback 送出成功');
          }
        } else {
          // 超出 24h 或沒有 reply token → push
          await lineSendText(accessToken, cc.channel_user_id, finalContent, clientId);
          billingApiType = 'push';
          log.info({ conversation_id: id, reason: !replyToken ? 'no_reply_token' : 'over_24h' }, 'LINE push 送出成功');
        }

        // Billing
        recordBilling({
          client_id: clientId,
          channel: 'line',
          api_type: billingApiType,
          message_id: msgId,
          conversation_id: id,
        });
      }
    } catch (e) {
      log.error({ err: e.message, conversation_id: id }, 'LINE 訊息送出失敗');
      // 不中斷 API 回應，讓前端知道訊息已寫入 DB 但 LINE 送出失敗
      return res.status(207).json({ ok: false, message_id: msgId, error: `LINE 送出失敗：${e.message}` });
    }
  } else if (conv.channel === 'fb') {
    // TODO: 等 FB token 進來實作
    log.warn({ conversation_id: id }, 'FB 回覆尚未實作，等 token 後啟用');
  } else if (conv.channel === 'ig') {
    // TODO: 等 IG token 進來實作
    log.warn({ conversation_id: id }, 'IG 回覆尚未實作，等 token 後啟用');
  }

  res.json({ ok: true, message_id: msgId });
});

// ─── 內部備忘（P2 #5）+ @提及解析（P3）───
app.post('/api/conversations/:id/note', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? (req.body?.client_id ? parseInt(req.body.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });

  const { content } = req.body || {};
  if (!content?.trim()) return res.status(400).json({ error: '備忘內容不可為空' });

  const msgId = insertMessage({
    conversation_id: id,
    direction: 'internal',
    sender_type: 'note',
    sender_id: String(req.session.user_id),
    content_type: 'internal_note',
    content: content.trim(),
  });

  emitToClient(clientId, 'message:new', {
    conversation_id: id,
    message: { id: msgId, direction: 'internal', sender_type: 'note', content: content.trim(), created_at: Date.now() },
  });

  // ─── P3：@提及解析 ───
  const mentionRegex = /@(\w+)/g;
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    const mentionedUsername = match[1];
    const mentionedUser = db.prepare('SELECT id FROM users WHERE username = ?').get(mentionedUsername);
    if (!mentionedUser) continue;

    const now = Date.now();
    const mentionId = db.prepare(`
      INSERT INTO mentions (message_id, conversation_id, mentioned_user_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(msgId, id, mentionedUser.id, now).lastInsertRowid;

    // emit 給被提及的 user
    emitToUser(mentionedUser.id, 'mention', {
      mention_id: mentionId,
      conversation_id: id,
      message_id: msgId,
      from_user_id: req.session.user_id,
      content_preview: content.trim().slice(0, 100),
    });

    insertAuditLog({
      user_id: req.session.user_id,
      action: 'mention_user',
      entity_type: 'conversation',
      entity_id: id,
      details: JSON.stringify({ mentioned_user_id: mentionedUser.id, mention_id: mentionId }),
      ip: req.ip,
    });
  }

  res.json({ ok: true, message_id: msgId });
});

// ─── AI 草擬（P2 #2）───
app.post('/api/conversations/:id/draft', aiRateLimiter, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? (req.body?.client_id ? parseInt(req.body.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });

  try {
    const result = await generateDrafts({
      conversation_id: id,
      client_id: clientId,
      user_id: req.session.user_id,
      realtime: { emitToClient },
    });
    if (!result.ok) {
      return res.status(502).json({ error: result.error || 'AI 生成失敗' });
    }
    res.json({ ok: true, drafts: result.drafts });
  } catch (e) {
    log.error({ err: e.message, conversation_id: id }, 'draft generation error');
    res.status(500).json({ error: '草擬內部錯誤' });
  }
});

app.get('/api/conversations/:id/drafts', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });

  const drafts = db.prepare(`SELECT * FROM drafts WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(id);
  res.json({ drafts });
});

app.post('/api/drafts/:id/approve', async (req, res) => {
  const draftId = parseInt(req.params.id, 10);
  const { edited_content } = req.body || {};

  const result = await approveDraft({
    draft_id: draftId,
    edited_content: edited_content || null,
    user_id: req.session.user_id,
  });

  if (!result.ok) return res.status(404).json({ error: result.error });

  // 自動送出回覆
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  if (draft) {
    const conv = getConversation(draft.conversation_id, null);
    if (conv) {
      const msgId = insertMessage({
        conversation_id: draft.conversation_id,
        direction: 'outbound',
        sender_type: 'ai',
        sender_id: String(req.session.user_id),
        content_type: 'text',
        content: result.content,
      });
      updateConversation(draft.conversation_id, conv.client_id, {
        last_message_at: Date.now(),
        last_message_preview: result.content.slice(0, 100),
      });
      emitToClient(conv.client_id, 'message:reply', {
        conversation_id: draft.conversation_id,
        message: { id: msgId, direction: 'outbound', sender_type: 'ai', content: result.content, created_at: Date.now() },
      });
      insertAuditLog({
        user_id: req.session.user_id,
        action: 'approve_draft',
        entity_type: 'draft',
        entity_id: draftId,
        ip: req.ip,
      });

      // P3 #10：知識庫自學 — approve 後嘗試寫入 qa_pairs
      try {
        const messages = listMessages(draft.conversation_id, { limit: 20 });
        const lastInbound = [...messages].reverse().find(m => m.direction === 'inbound');
        if (lastInbound?.content && result.content) {
          // 簡單 keyword 比對（防止重複）
          const words = lastInbound.content.split(/[\s，。！？,.!?]+/).filter(w => w.length >= 2).slice(0, 3);
          let isDuplicate = false;
          if (words.length) {
            const conds = words.map(() => 'question LIKE ?').join(' OR ');
            const params = words.map(w => `%${w}%`);
            const existing = db.prepare(`SELECT id FROM qa_pairs WHERE client_id = ? AND (${conds}) LIMIT 1`)
              .get(conv.client_id, ...params);
            isDuplicate = !!existing;
          }
          if (!isDuplicate) {
            db.prepare(`
              INSERT INTO qa_pairs (client_id, question, answer, category, source, auto_learned, confidence, review_status, hit_count, created_at, updated_at)
              VALUES (?, ?, ?, 'auto', 'auto_learned', 1, 0.6, 'pending', 0, ?, ?)
            `).run(conv.client_id, lastInbound.content.slice(0, 500), result.content.slice(0, 1000), Date.now(), Date.now());
            log.info({ conversation_id: draft.conversation_id, client_id: conv.client_id }, 'auto-learned QA pair created');
          }
        }
      } catch (e) {
        log.warn({ err: e.message }, 'auto-learn QA failed');
      }
    }
  }

  res.json({ ok: true, ...result });
});

app.post('/api/drafts/:id/reject', (req, res) => {
  const draftId = parseInt(req.params.id, 10);
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  if (!draft) return res.status(404).json({ error: '草擬不存在' });
  db.prepare(`UPDATE drafts SET status = 'rejected' WHERE id = ?`).run(draftId);
  res.json({ ok: true });
});

// ─── AI 對話摘要（P2 #8 / P8 升級：結構化 JSON）───
app.post('/api/conversations/:id/summarize', aiRateLimiter, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? (req.body?.client_id ? parseInt(req.body.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });

  try {
    const messages = listMessages(id, { limit: 20 });
    const result = await summarizeConversation(messages);

    if (!result?.summary) {
      return res.status(502).json({ error: 'AI 摘要失敗（API key 未設定或 AI 服務不可用）' });
    }

    const summaryText = result.summary;
    const updateFields = { summary: summaryText, summary_updated_at: Date.now() };

    // P8：把 key_intent 寫進 conversations.intent（比 classifyMessage 更準確，因為看完整上下文）
    if (result.key_intent) updateFields.intent = result.key_intent;

    updateConversation(id, clientId, updateFields);
    emitToClient(clientId, 'conversation:update', {
      conversation_id: id,
      summary: summaryText,
      intent: result.key_intent || conv.intent,
    });
    res.json({ ok: true, summary: summaryText, key_intent: result.key_intent, key_entities: result.key_entities, action_required: result.action_required });
  } catch (e) {
    log.error({ err: e.message, conversation_id: id }, 'summarize error');
    res.status(500).json({ error: '摘要內部錯誤' });
  }
});

// ─── 對話轉接（P2 #7）───
app.post('/api/conversations/:id/transfer', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? (req.body?.client_id ? parseInt(req.body.client_id, 10) : null);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });

  const { to_user_id, reason } = req.body || {};
  if (!to_user_id) return res.status(400).json({ error: '缺少 to_user_id' });

  const toUser = getUser(parseInt(to_user_id, 10));
  if (!toUser) return res.status(404).json({ error: '目標使用者不存在' });

  const transferId = insertTransfer({
    conversation_id: id,
    from_user_id: conv.assigned_user_id ?? null,
    to_user_id: parseInt(to_user_id, 10),
    reason: reason || null,
  });

  updateConversation(id, clientId, { assigned_user_id: parseInt(to_user_id, 10) });

  insertAuditLog({
    user_id: req.session.user_id,
    action: 'transfer_conversation',
    entity_type: 'conversation',
    entity_id: id,
    details: JSON.stringify({ to_user_id, reason }),
    ip: req.ip,
  });

  emitToClient(clientId, 'conversation:update', {
    conversation_id: id,
    assigned_user_id: parseInt(to_user_id, 10),
  });

  res.json({ ok: true, transfer_id: transferId });
});

app.get('/api/conversations/:id/transfers', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req);
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });
  res.json({ transfers: listTransfers(id) });
});

// ─── CSAT 滿意度（P2 #10 + B 客服個人評分）───
app.post('/api/csat/:conversation_id', async (req, res) => {
  const id = parseInt(req.params.conversation_id, 10);
  const { score, comment } = req.body || {};
  const scoreNum = parseInt(score, 10);
  if (!scoreNum || scoreNum < 1 || scoreNum > 5) return res.status(400).json({ error: 'score 必須是 1-5' });

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!conv) return res.status(404).json({ error: '對話不存在' });

  // B: 找主責客服
  const { resolvePrimaryAgent } = await import('./lib/csat.js');
  const { user_id: agentId, username: agentUsername, source: agentSource } = resolvePrimaryAgent(id);

  updateConversation(id, conv.client_id, {
    csat_score: scoreNum,
    csat_comment: comment || null,
    csat_agent_id: agentId,
  });

  log.info({ conversation_id: id, score: scoreNum, agent_id: agentId, agent_source: agentSource }, 'CSAT received');

  // audit log
  insertAuditLog({
    action: 'csat_received',
    entity_type: 'conversation',
    entity_id: id,
    details: JSON.stringify({ score: scoreNum, comment: comment || null, agent_id: agentId, agent_source: agentSource }),
  });

  // P3 #14：推 webhook（所有 CSAT 都推，帶 agent_id）
  dispatchEvent(conv.client_id, 'csat:received', {
    conversation_id: id,
    score: scoreNum,
    comment: comment || '',
    agent_id: agentId,
    agent_username: agentUsername,
  }).catch(() => {});

  res.json({ ok: true, agent_id: agentId });
});

// ─── 全文搜尋（P2 #4）───
app.get('/api/search', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: '需指定 q 查詢詞' });
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const matches = searchMessages(clientId, q, limit);
  res.json({ matches });
});

// ─── 模板 ───
app.get('/api/templates', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  res.json({ templates: listTemplates(clientId) });
});

app.post('/api/templates', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const { shortcut, title, content, category } = req.body || {};
  if (!shortcut || !title || !content) return res.status(400).json({ error: '缺少 shortcut / title / content' });
  const id = insertTemplate({ client_id: clientId, shortcut, title, content, category });
  insertAuditLog({
    user_id: req.session.user_id,
    action: 'create_template',
    entity_type: 'template',
    entity_id: id,
    ip: req.ip,
  });
  res.json({ id, ok: true });
});

app.put('/api/templates/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const tpl = getTemplate(id, clientId);
  if (!tpl) return res.status(404).json({ error: '模板不存在或無權限' });
  const { shortcut, title, content, category } = req.body || {};
  updateTemplate(id, clientId, { shortcut, title, content, category });
  insertAuditLog({
    user_id: req.session.user_id,
    action: 'update_template',
    entity_type: 'template',
    entity_id: id,
    ip: req.ip,
  });
  res.json({ ok: true });
});

app.delete('/api/templates/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  deleteTemplate(id, clientId);
  insertAuditLog({
    user_id: req.session.user_id,
    action: 'delete_template',
    entity_type: 'template',
    entity_id: id,
    ip: req.ip,
  });
  res.json({ ok: true });
});

// ─── 顧客 CRUD ───
app.get('/api/customers', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const search = req.query.search || null;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const customers = listCustomers(clientId, { search, limit, offset });
  res.json({ customers });
});

app.get('/api/customers/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const customer = getCustomer(id, clientId);
  if (!customer) return res.status(404).json({ error: '顧客不存在或無權限' });
  const channels = getCustomerChannels(id);
  res.json({ customer: { ...customer, channels } });
});

app.put('/api/customers/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const customer = getCustomer(id, clientId);
  if (!customer) return res.status(404).json({ error: '顧客不存在或無權限' });
  const { name, phone, email, notes, tags } = req.body || {};
  const fields = {};
  if (name !== undefined) fields.name = name;
  if (phone !== undefined) fields.phone = phone;
  if (email !== undefined) fields.email = email;
  if (notes !== undefined) fields.notes = notes;
  if (tags !== undefined) fields.tags = Array.isArray(tags) ? JSON.stringify(tags) : tags;
  updateCustomer(id, clientId, fields);
  insertAuditLog({
    user_id: req.session.user_id,
    action: 'update_customer',
    entity_type: 'customer',
    entity_id: id,
    ip: req.ip,
  });

  // 旅程觸發：tag_added — 比對新舊 tags 找新增的標籤
  if (tags !== undefined) {
    try {
      const oldTags = JSON.parse(customer.tags || '[]');
      const newTags = Array.isArray(tags) ? tags : JSON.parse(tags || '[]');
      const added = newTags.filter(t => !oldTags.includes(t));
      for (const tag of added) {
        checkAndEnrollJourneyTrigger('tag_added', { client_id: clientId, customer_id: id, tag });
      }
    } catch (e) { /* 標籤解析失敗就跳過 */ }
  }

  res.json({ ok: true });
});

// ─── 自訂顧客屬性（P2 #6）───
app.put('/api/customers/:id/custom-fields', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const customer = getCustomer(id, clientId);
  if (!customer) return res.status(404).json({ error: '顧客不存在或無權限' });

  const { custom_fields } = req.body || {};
  if (typeof custom_fields !== 'object') return res.status(400).json({ error: 'custom_fields 必須是 object' });

  updateCustomer(id, clientId, { custom_fields: JSON.stringify(custom_fields) });
  res.json({ ok: true });
});

// ─── 黑名單（P2 #11）───
app.post('/api/customers/:id/block', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const customer = getCustomer(id, clientId);
  if (!customer) return res.status(404).json({ error: '顧客不存在或無權限' });

  const { reason } = req.body || {};
  updateCustomer(id, clientId, {
    is_blocked: 1,
    blocked_reason: reason || null,
    blocked_at: Date.now(),
  });

  insertAuditLog({
    user_id: req.session.user_id,
    action: 'block_customer',
    entity_type: 'customer',
    entity_id: id,
    details: JSON.stringify({ reason }),
    ip: req.ip,
  });

  log.info({ customer_id: id, client_id: clientId, reason }, 'customer blocked');
  res.json({ ok: true });
});

app.post('/api/customers/:id/unblock', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const customer = getCustomer(id, clientId);
  if (!customer) return res.status(404).json({ error: '顧客不存在或無權限' });

  updateCustomer(id, clientId, { is_blocked: 0, blocked_reason: null, blocked_at: null });
  insertAuditLog({
    user_id: req.session.user_id,
    action: 'unblock_customer',
    entity_type: 'customer',
    entity_id: id,
    ip: req.ip,
  });
  res.json({ ok: true });
});

// ─── 知識庫 CRUD（P2 #12）───
app.get('/api/qa-pairs', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const category = req.query.category || null;
  const search   = req.query.search   || null;
  const limit    = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset   = parseInt(req.query.offset || '0', 10);
  const pairs = listQaPairs(clientId, { category, search, limit, offset });
  res.json({ qa_pairs: pairs });
});

app.post('/api/qa-pairs', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const { question, answer, category } = req.body || {};
  if (!question || !answer) return res.status(400).json({ error: '缺少 question 或 answer' });
  const id = insertQaPair({ client_id: clientId, question, answer, category });
  res.json({ id, ok: true });
});

app.put('/api/qa-pairs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const pair = getQaPair(id, clientId);
  if (!pair) return res.status(404).json({ error: 'QA pair 不存在或無權限' });
  const { question, answer, category } = req.body || {};
  updateQaPair(id, clientId, { question, answer, category });
  res.json({ ok: true });
});

app.delete('/api/qa-pairs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  deleteQaPair(id, clientId);
  res.json({ ok: true });
});

app.post('/api/qa-pairs/import', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items 必須是非空陣列' });

  const inserted = [];
  const errors   = [];

  for (const [i, item] of items.entries()) {
    if (!item.question || !item.answer) {
      errors.push({ index: i, error: '缺少 question 或 answer' });
      continue;
    }
    try {
      const id = insertQaPair({
        client_id: clientId,
        question: item.question,
        answer: item.answer,
        category: item.category || null,
        source: 'import',
      });
      inserted.push(id);
    } catch (e) {
      errors.push({ index: i, error: e.message });
    }
  }

  res.json({ ok: true, inserted: inserted.length, errors });
});

app.get('/api/qa-pairs/:id/similar', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: '需指定 q' });
  const similar = similarQaPairs(clientId, q, 5);
  res.json({ similar });
});

// ─── Audit Logs（admin only）───
app.get('/api/audit-logs', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const action = req.query.action || null;
  const user_id = req.query.user_id || null;
  const logs = listAuditLogs({ limit, offset, action, user_id });
  res.json({ logs });
});

// ─── Stats ───
app.get('/api/stats', (req, res) => {
  const clientId = resolveClientId(req) ?? (req.query.client_id ? parseInt(req.query.client_id, 10) : null);
  const stats = getStats(clientId);
  res.json(stats);
});

// ─── Status（admin only，完整健康度）───
app.get('/api/status', requireAdmin, (_req, res) => {
  const clients = listClients().map(c => {
    const full = getClient(c.id);
    const hasLine = !!(full?.line_access_token_enc && full?.line_channel_secret_enc);
    const hasFb = !!(full?.fb_page_token_enc);
    const status = (hasLine && hasFb) ? 'green' : (hasLine || hasFb) ? 'yellow' : 'red';
    return { id: c.id, name: c.name, display_name: c.display_name, token_status: status, has_line: hasLine, has_fb: hasFb };
  });
  let db_ok = false;
  try { db.prepare('SELECT 1').get(); db_ok = true; } catch {}
  const memory_mb = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
  const active_sessions = countActiveSessions();
  res.json({
    db_ok,
    memory_mb,
    active_sessions,
    uptime: process.uptime(),
    clients,
  });
});

// ─── 標記已讀（UX 修正：點開對話自動清零未讀）───
app.post('/api/conversations/:id/mark-read', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });
  db.prepare('UPDATE conversations SET unread_count = 0, updated_at = ? WHERE id = ? AND client_id = ?')
    .run(Date.now(), id, clientId);
  emitToClient(clientId, 'conversation:update', { conversation_id: id, unread_count: 0 });
  res.json({ ok: true });
});

// ─── 模板建議（按最後一則 inbound 訊息模糊匹配）───
app.get('/api/templates/suggest', (req, res) => {
  const convId = parseInt(req.query.conversation_id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!convId || !clientId || isNaN(convId) || isNaN(clientId)) {
    return res.status(400).json({ error: '參數不足' });
  }

  const lastInbound = db.prepare(`
    SELECT content FROM messages
    WHERE conversation_id = ? AND direction = 'inbound'
    ORDER BY created_at DESC LIMIT 1
  `).get(convId);

  if (!lastInbound?.content) return res.json({ templates: [] });

  const limit = Math.min(parseInt(req.query.limit || '3', 10), 10);
  const keywords = lastInbound.content.split(/[\s，。！？,.!?\n]+/).filter(w => w.length >= 2).slice(0, 8);

  if (!keywords.length) return res.json({ templates: [] });

  const all = db.prepare('SELECT * FROM templates WHERE client_id = ? ORDER BY updated_at DESC').all(clientId);
  const scored = all.map(t => {
    let score = 0;
    for (const kw of keywords) {
      if (t.title?.includes(kw)) score += 3;
      if (t.content?.includes(kw)) score += 2;
      if (t.shortcut?.includes(kw)) score += 1;
      if (t.category?.includes(kw)) score += 1;
    }
    return { ...t, score };
  }).filter(t => t.score > 0).sort((a, b) => b.score - a.score);

  res.json({ templates: scored.slice(0, limit) });
});

// ─── 知識庫匹配（按關鍵字模糊搜尋 QA pairs）───
app.get('/api/qa-pairs/match', (req, res) => {
  const q = (req.query.q || '').trim();
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  const limit = Math.min(parseInt(req.query.limit || '2', 10), 10);

  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  if (!q) return res.json({ qa_pairs: [] });

  const matches = similarQaPairs(clientId, q, limit);
  res.json({ qa_pairs: matches });
});

// ─── P3 路由掛載 ───
app.use('/api/rules', rulesRouter);
app.use('/api', scheduledRouter);           // /api/conversations/:id/schedule-message + /api/scheduled-messages
app.use('/api', integrationsRouter);        // /api/webhooks-out

// ─── 對話進階操作（P3 #8）───
app.post('/api/conversations/:id/pin', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });
  updateConversationFull(id, clientId, { is_pinned: 1 });
  emitToClient(clientId, 'conversation:update', { conversation_id: id, is_pinned: 1 });
  res.json({ ok: true });
});

app.post('/api/conversations/:id/unpin', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });
  updateConversationFull(id, clientId, { is_pinned: 0 });
  emitToClient(clientId, 'conversation:update', { conversation_id: id, is_pinned: 0 });
  res.json({ ok: true });
});

app.post('/api/conversations/:id/remind', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });
  const { reminder_at, note } = req.body || {};
  if (!reminder_at) return res.status(400).json({ error: '需指定 reminder_at' });
  updateConversationFull(id, clientId, { reminder_at: parseInt(reminder_at, 10), reminder_note: note || null });
  res.json({ ok: true });
});

app.post('/api/conversations/:id/archive', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const conv = getConversation(id, clientId);
  if (!conv) return res.status(404).json({ error: '對話不存在或無權限' });
  updateConversationFull(id, clientId, { archived_at: Date.now(), status: 'closed' });
  emitToClient(clientId, 'conversation:update', { conversation_id: id, archived_at: Date.now() });
  res.json({ ok: true });
});

// 批次操作
app.post('/api/conversations/bulk', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const { ids, action, payload } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids 必須是非空陣列' });
  if (!['close', 'archive', 'tag'].includes(action)) return res.status(400).json({ error: 'action 必須是 close/archive/tag' });

  const results = [];
  for (const convId of ids) {
    const conv = getConversation(parseInt(convId, 10), clientId);
    if (!conv) { results.push({ id: convId, ok: false, error: '不存在' }); continue; }

    if (action === 'close') {
      updateConversationFull(convId, clientId, { status: 'closed' });
    } else if (action === 'archive') {
      updateConversationFull(convId, clientId, { archived_at: Date.now(), status: 'closed' });
    } else if (action === 'tag') {
      const newTags = payload?.tags || [];
      let existing = [];
      try { existing = JSON.parse(conv.tags || '[]'); } catch {}
      const merged = [...new Set([...existing, ...newTags])];
      updateConversationFull(convId, clientId, { tags: JSON.stringify(merged) });
    }
    results.push({ id: convId, ok: true });
  }

  insertAuditLog({
    user_id: req.session.user_id,
    action: `bulk_${action}_conversations`,
    details: JSON.stringify({ ids, count: ids.length }),
    ip: req.ip,
  });

  res.json({ ok: true, results });
});

// 自訂視圖（GET /api/conversations?view=mine|unassigned|urgent|pinned|archived）
// 擴充現有 GET /api/conversations
// （在現有 endpoint 中加 view 過濾，下面單獨覆寫）

// ─── AI 用量查詢（P3 #9）───
app.get('/api/ai-usage', requireAdmin, (req, res) => {
  const clientId = req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  const from = req.query.from ? parseInt(req.query.from, 10) : Date.now() - 30 * 24 * 3600 * 1000;
  const to   = req.query.to   ? parseInt(req.query.to,   10) : Date.now();
  const groupBy = req.query.group_by || 'feature';

  let groupCol;
  if (groupBy === 'user')    groupCol = 'user_id';
  else if (groupBy === 'day') groupCol = "strftime('%Y-%m-%d', datetime(created_at/1000, 'unixepoch'))";
  else                        groupCol = 'feature';

  const where = ['created_at BETWEEN ? AND ?'];
  const args  = [from, to];
  if (clientId) { where.push('client_id = ?'); args.push(clientId); }

  const rows = db.prepare(`
    SELECT ${groupCol} AS group_key,
           SUM(input_tokens) AS total_input, SUM(output_tokens) AS total_output,
           SUM(cost_usd) AS total_cost, COUNT(*) AS calls,
           provider
    FROM ai_usage
    WHERE ${where.join(' AND ')}
    GROUP BY ${groupCol}, provider
    ORDER BY total_cost DESC
  `).all(...args);

  res.json({ usage: rows, from, to, group_by: groupBy });
});

// ─── A4 後端：AI 預算（相容新舊欄位）───
app.get('/api/clients/:id/ai-budget', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = getClient(id);
  if (!client) return res.status(404).json({ error: '業主不存在' });

  // 本月用量
  const d = new Date();
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  let row = { used: 0, input_tokens: 0, output_tokens: 0 };
  try {
    row = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS used, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM ai_usage WHERE client_id = ? AND created_at >= ?
    `).get(id, monthStart) || row;
  } catch {}

  // 讀取新 JSON 欄位（若存在），否則 fallback 到舊欄位
  let budgetJson = {};
  try { budgetJson = JSON.parse(client.ai_budget || '{}'); } catch {}

  const monthlyBudget = budgetJson.monthly_budget_usd ?? client.ai_budget_usd ?? 0;
  const budgetCycle   = budgetJson.budget_cycle ?? client.ai_budget_period ?? 'monthly';
  const piiMasking    = budgetJson.pii_masking_enabled ?? (client.pii_masking_enabled === 1);
  const usedPct       = monthlyBudget > 0 ? Math.round(row.used / monthlyBudget * 100) : 0;

  res.json({
    client_id: id,
    monthly_budget_usd: monthlyBudget,
    budget_cycle: budgetCycle,
    pii_masking_enabled: piiMasking,
    used_usd: Math.round((row.used || 0) * 10000) / 10000,
    used_pct: usedPct,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    // backward compat fields
    ai_budget_usd: monthlyBudget,
    ai_budget_period: budgetCycle,
    current_month_cost: row.used,
    remaining: Math.max(0, monthlyBudget - row.used),
  });
});

app.put('/api/clients/:id/ai-budget', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = getClient(id);
  if (!client) return res.status(404).json({ error: '業主不存在' });

  // 支援新欄位格式 (monthly_budget_usd) 和舊欄位格式 (ai_budget_usd)
  const { monthly_budget_usd, ai_budget_usd, budget_cycle, ai_budget_period, pii_masking_enabled } = req.body || {};

  // 讀現有 JSON budget
  let budgetJson = {};
  try { budgetJson = JSON.parse(client.ai_budget || '{}'); } catch {}

  const newBudget = parseFloat(monthly_budget_usd ?? ai_budget_usd ?? budgetJson.monthly_budget_usd) || 0;
  const newCycle = budget_cycle ?? ai_budget_period ?? budgetJson.budget_cycle ?? 'monthly';
  const newPii = pii_masking_enabled !== undefined ? !!pii_masking_enabled : (budgetJson.pii_masking_enabled ?? false);

  budgetJson.monthly_budget_usd = newBudget;
  budgetJson.budget_cycle = ['monthly', 'weekly'].includes(newCycle) ? newCycle : 'monthly';
  budgetJson.pii_masking_enabled = newPii;

  // 確保 ai_budget 欄位存在
  try { db.prepare(`ALTER TABLE clients ADD COLUMN ai_budget TEXT`).run(); } catch {}

  // 同時更新新舊欄位確保相容性
  const fields = {
    ai_budget: JSON.stringify(budgetJson),
    ai_budget_usd: newBudget,
    ai_budget_period: budgetJson.budget_cycle,
    pii_masking_enabled: newPii ? 1 : 0,
  };
  updateClientFull(id, fields);

  insertAuditLog({ user_id: req.session.user_id, action: 'update_ai_budget', entity_type: 'client', entity_id: id, ip: req.ip });
  res.json({ ok: true, budget: budgetJson });
});

// ─── 知識庫自學審核（P3 #10）───
app.get('/api/qa-pairs/auto-learned', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const reviewStatus = req.query.review_status || 'pending';
  const rows = db.prepare(`
    SELECT * FROM qa_pairs WHERE client_id = ? AND auto_learned = 1 AND review_status = ?
    ORDER BY created_at DESC
  `).all(clientId, reviewStatus);
  res.json({ qa_pairs: rows });
});

app.post('/api/qa-pairs/:id/review', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const pair = getQaPair(id, clientId);
  if (!pair) return res.status(404).json({ error: 'QA pair 不存在或無權限' });
  const { status } = req.body || {};
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'status 必須是 approved/rejected' });
  updateQaPairFull(id, clientId, { review_status: status });
  res.json({ ok: true });
});

// ─── 顧客 CSV 匯入匯出（P3 #12）───
app.get('/api/customers/export', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });

  const customers = listCustomers(clientId, { limit: 5000 });
  const headers = ['id', 'name', 'phone', 'email', 'notes', 'tags', 'is_blocked', 'created_at'];

  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines = [
    headers.join(','),
    ...customers.map(c => headers.map(h => {
      if (h === 'created_at') return escape(c[h] ? new Date(c[h]).toISOString() : '');
      return escape(c[h]);
    }).join(',')),
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="customers_${clientId}_${Date.now()}.csv"`);
  res.send('﻿' + lines.join('\r\n'));  // BOM for Excel
});

app.post('/api/customers/import', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id || req.body?.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });

  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items 必須是非空陣列' });

  let inserted = 0, updated = 0, skipped = 0;
  const errors = [];
  const now = Date.now();

  for (const [i, item] of items.entries()) {
    if (!item.name && !item.phone && !item.email) {
      errors.push({ index: i, error: '至少需要 name / phone / email 其中一個' });
      skipped++;
      continue;
    }
    try {
      // upsert by phone or email
      let existing = null;
      if (item.phone) existing = db.prepare('SELECT id FROM customers WHERE client_id = ? AND phone = ?').get(clientId, item.phone);
      if (!existing && item.email) existing = db.prepare('SELECT id FROM customers WHERE client_id = ? AND email = ?').get(clientId, item.email);

      if (existing) {
        const fields = {};
        if (item.name) fields.name = item.name;
        if (item.phone) fields.phone = item.phone;
        if (item.email) fields.email = item.email;
        if (item.notes) fields.notes = item.notes;
        if (item.tags) fields.tags = Array.isArray(item.tags) ? JSON.stringify(item.tags) : item.tags;
        if (Object.keys(fields).length) updateCustomer(existing.id, clientId, fields);
        updated++;
      } else {
        db.prepare(`
          INSERT INTO customers (client_id, name, phone, email, notes, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          clientId,
          item.name || '未知顧客',
          item.phone || null,
          item.email || null,
          item.notes || null,
          item.tags ? (Array.isArray(item.tags) ? JSON.stringify(item.tags) : item.tags) : '[]',
          now, now
        );
        inserted++;
      }
    } catch (e) {
      errors.push({ index: i, error: e.message });
      skipped++;
    }
  }

  res.json({ ok: true, inserted, updated, skipped, errors });
});

// ─── 顧客互動時間軸（P3 #12B）───
app.get('/api/customers/:id/timeline', (req, res) => {
  const customerId = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const customer = getCustomer(customerId, clientId);
  if (!customer) return res.status(404).json({ error: '顧客不存在或無權限' });

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);

  // 整合多來源
  const events = [];

  // messages（最近 N 筆）
  const msgs = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.direction, m.sender_type, m.content_type, c.id AS conv_id
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.customer_id = ? AND c.client_id = ?
    ORDER BY m.created_at DESC LIMIT ?
  `).all(customerId, clientId, limit);
  for (const m of msgs) {
    events.push({ type: 'message', icon: m.direction === 'inbound' ? '💬' : '📤', title: `${m.direction === 'inbound' ? '顧客訊息' : '客服回覆'}`, preview: (m.content || '').slice(0, 80), ts: m.created_at, conversation_id: m.conv_id, id: m.id });
  }

  // orders
  try {
    const orders = db.prepare('SELECT * FROM orders WHERE client_id = ? AND customer_id = ? ORDER BY ordered_at DESC LIMIT 20').all(clientId, customerId);
    for (const o of orders) {
      events.push({ type: 'order', icon: '🛒', title: `訂單 ${o.external_order_id || o.id}`, preview: `狀態：${o.status}，金額：${o.total_amount || '?'}`, ts: o.ordered_at || o.created_at, id: o.id });
    }
  } catch {}

  // broadcast_recipients
  try {
    const bcast = db.prepare(`
      SELECT br.*, b.name AS broadcast_name FROM broadcast_recipients br
      JOIN broadcasts b ON b.id = br.broadcast_id
      WHERE br.customer_id = ? ORDER BY br.sent_at DESC LIMIT 10
    `).all(customerId);
    for (const b of bcast) {
      events.push({ type: 'broadcast', icon: '📢', title: `廣播：${b.broadcast_name}`, preview: `狀態：${b.status}`, ts: b.sent_at || 0, id: b.id });
    }
  } catch {}

  // journey_runs
  try {
    const runs = db.prepare(`
      SELECT jr.*, j.name AS journey_name FROM journey_runs jr
      JOIN journeys j ON j.id = jr.journey_id
      WHERE jr.customer_id = ? ORDER BY jr.started_at DESC LIMIT 10
    `).all(customerId);
    for (const r of runs) {
      events.push({ type: 'journey', icon: '🗺', title: `旅程：${r.journey_name}`, preview: `狀態：${r.status}`, ts: r.started_at, id: r.id });
    }
  } catch {}

  // audit_logs（與此顧客相關）
  const auditRows = db.prepare(`
    SELECT * FROM audit_logs WHERE entity_type = 'customer' AND entity_id = ?
    ORDER BY created_at DESC LIMIT 20
  `).all(customerId);
  for (const a of auditRows) {
    events.push({ type: 'audit', icon: '📋', title: `操作：${a.action}`, preview: a.details || '', ts: a.created_at, id: a.id });
  }

  // 排序
  events.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  res.json({ customer_id: customerId, events: events.slice(0, limit) });
});

// ─── 顧客會員資訊聚合（GET /api/customers/:id/membership）───
app.get('/api/customers/:id/membership', (req, res) => {
  const customerId = parseInt(req.params.id, 10);
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId || isNaN(clientId)) return res.status(400).json({ error: '需指定 client_id' });
  const customer = getCustomer(customerId, clientId);
  if (!customer) return res.status(404).json({ error: '顧客不存在或無權限' });

  const now = Date.now();

  // 等級徽章
  const stageLabel = { new: '新客', active: '活躍', vip: 'VIP', at_risk: '流失預警', lost: '已流失' };
  const stageEmoji = { new: '', active: '', vip: '', at_risk: '', lost: '' };
  const stage = customer.lifecycle_stage || 'new';

  // 加入時間
  const joinedMsAgo = now - (customer.created_at || now);
  const joinedDays = Math.floor(joinedMsAgo / 86400000);
  const joinedLabel = joinedDays < 1 ? '今天' : joinedDays < 30 ? `${joinedDays} 天前` :
    joinedDays < 365 ? `${Math.floor(joinedDays/30)} 個月前` : `${Math.floor(joinedDays/365)} 年前`;

  // 訂單聚合
  let orderStats = { total_amount: 0, order_count: 0, avg_amount: 0, last_order_at: null };
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount),0) AS total, MAX(ordered_at) AS last_at
      FROM orders WHERE client_id = ? AND customer_id = ? AND status = 'paid'
    `).get(clientId, customerId);
    if (row) {
      orderStats.order_count = row.cnt;
      orderStats.total_amount = row.total;
      orderStats.avg_amount = row.cnt > 0 ? Math.round(row.total / row.cnt) : 0;
      orderStats.last_order_at = row.last_at;
    }
  } catch {}

  // 最近消費多久前
  let lastOrderLabel = '尚無';
  if (orderStats.last_order_at) {
    const days = Math.floor((now - orderStats.last_order_at) / 86400000);
    lastOrderLabel = days === 0 ? '今天' : `${days} 天前`;
  }

  // 點數
  let pointsBalance = 0;
  try {
    const acct = db.prepare('SELECT balance FROM points_accounts WHERE client_id = ? AND customer_id = ?').get(clientId, customerId);
    pointsBalance = acct?.balance ?? 0;
  } catch {}

  // 連續簽到
  let streakDays = 0;
  try {
    const ci = db.prepare('SELECT streak_days FROM check_ins WHERE client_id = ? AND customer_id = ?').get(clientId, customerId);
    streakDays = ci?.streak_days ?? 0;
  } catch {}

  // 中獎次數
  let winCount = 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt FROM participations pa
      JOIN activities a ON a.id = pa.activity_id
      WHERE a.client_id = ? AND pa.customer_id = ? AND pa.is_winner = 1
    `).get(clientId, customerId);
    winCount = row?.cnt ?? 0;
  } catch {}

  // CSAT 平均
  let csatAvg = null;
  try {
    const row = db.prepare(`
      SELECT AVG(csat_score) AS avg_score, COUNT(csat_score) AS cnt
      FROM conversations WHERE client_id = ? AND customer_id = ? AND csat_score IS NOT NULL
    `).get(clientId, customerId);
    if (row?.cnt > 0) csatAvg = Math.round(row.avg_score * 10) / 10;
  } catch {}

  res.json({
    customer_id: customerId,
    stage,
    stage_label: stageLabel[stage] || stage,
    stage_emoji: stageEmoji[stage] || '',
    joined_label: joinedLabel,
    joined_at: customer.created_at,
    order_count: orderStats.order_count,
    total_amount: orderStats.total_amount,
    avg_amount: orderStats.avg_amount,
    last_order_label: lastOrderLabel,
    last_order_at: orderStats.last_order_at,
    points_balance: pointsBalance,
    streak_days: streakDays,
    win_count: winCount,
    csat_avg: csatAvg,
    // TODO: BV SHOP 同步欄位（等 BV API token 接入後補）
    bv_member_id: null,
    bv_points: null,
    bv_coupons: null,
    bv_level: null,
  });
});

// ─── PII 測試（P3 #11C）─── （lib/pii.js 直接 export，不需 endpoint）

// ─── 每日報表（P3 #13）───
app.get('/api/daily-reports', requireAdmin, (req, res) => {
  const clientId = req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  const from = req.query.from || null;
  const to   = req.query.to   || null;
  const where = [];
  const args  = [];
  if (clientId) { where.push('client_id = ?'); args.push(clientId); }
  if (from) { where.push('report_date >= ?'); args.push(from); }
  if (to)   { where.push('report_date <= ?'); args.push(to); }
  const rows = db.prepare(`
    SELECT id, client_id, report_date, created_at FROM daily_reports
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY report_date DESC LIMIT 90
  `).all(...args);
  res.json({ reports: rows });
});

app.get('/api/daily-reports/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM daily_reports WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '報表不存在' });
  let data;
  try { data = JSON.parse(row.data); } catch { data = {}; }
  res.json({ ...row, data });
});

// ─── P4 路由掛載（需要登入）───
app.use('/api/games', gamesRouter);
app.use('/api/broadcasts', broadcastRouter);
app.use('/api/ab-tests', abTestRouter);

// ─── 評價後台統計（需要登入）───
// broadcastFeedbackRouter 內部路由為 /:id/feedback 和 /:id/feedback-stats
// 掛在 /api/broadcasts 前綴，完整路徑為 /api/broadcasts/:id/feedback[-stats]
app.use('/api/broadcasts', broadcastFeedbackRouter);
// activityFeedbackRouter 同理，掛在 /api/games 前綴
app.use('/api/games', activityFeedbackRouter);
app.use('/api', ecommerceRouter);       // /api/orders + /api/cart-events
app.use('/api/rich-menus', richmenuRouter);
app.use('/api/journeys', journeyRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/voc', requireAuth, vocRouter);

// ─── SLA API ───

app.get('/api/sla/config', requireAuth, (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  try {
    const config = getSlaConfigForApi(clientId);
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/sla/config', requireAuth, (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });

  const { sla_first_reply_minutes, sla_resolution_hours, sla_business_hours } = req.body || {};

  const updates = {};
  if (sla_first_reply_minutes !== undefined) {
    const v = parseInt(sla_first_reply_minutes, 10);
    if (isNaN(v) || v < 1) return res.status(400).json({ error: 'sla_first_reply_minutes 需為正整數' });
    updates.sla_first_reply_minutes = v;
  }
  if (sla_resolution_hours !== undefined) {
    const v = parseInt(sla_resolution_hours, 10);
    if (isNaN(v) || v < 1) return res.status(400).json({ error: 'sla_resolution_hours 需為正整數' });
    updates.sla_resolution_hours = v;
  }
  if (sla_business_hours !== undefined) {
    updates.sla_business_hours = sla_business_hours ? JSON.stringify(sla_business_hours) : null;
  }

  if (!Object.keys(updates).length) return res.status(400).json({ error: '無可更新欄位' });

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(updates);
  db.prepare(`UPDATE clients SET ${setClauses}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), clientId);

  insertAuditLog({
    user_id: req.session.user_id,
    action: 'update_sla_config',
    entity_type: 'client',
    entity_id: clientId,
    details: JSON.stringify(updates),
    ip: req.ip,
  });

  res.json({ ok: true });
});

app.get('/api/sla/dashboard', requireAuth, (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  try {
    const stats = getSlaDashboard(clientId);
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── #2：AI 自動回覆設定 ───

app.get('/api/auto-reply/config', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const client = db.prepare(`
    SELECT auto_reply_enabled, auto_reply_schedule, auto_reply_confidence_threshold, auto_reply_disclaimer
    FROM clients WHERE id = ?
  `).get(clientId);
  if (!client) return res.status(404).json({ error: '業主不存在' });
  let schedule = null;
  try { schedule = JSON.parse(client.auto_reply_schedule || 'null'); } catch {}
  res.json({
    enabled: !!client.auto_reply_enabled,
    schedule,
    confidence_threshold: client.auto_reply_confidence_threshold ?? 0.7,
    disclaimer: client.auto_reply_disclaimer || '',
  });
});

app.put('/api/auto-reply/config', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const { enabled, schedule, confidence_threshold, disclaimer } = req.body || {};
  const fields = {};
  if (enabled !== undefined) fields.auto_reply_enabled = enabled ? 1 : 0;
  if (schedule !== undefined) fields.auto_reply_schedule = JSON.stringify(schedule);
  if (confidence_threshold !== undefined) fields.auto_reply_confidence_threshold = parseFloat(confidence_threshold);
  if (disclaimer !== undefined) fields.auto_reply_disclaimer = disclaimer;
  if (!Object.keys(fields).length) return res.status(400).json({ error: '沒有可更新的欄位' });
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE clients SET ${sets}, updated_at = ? WHERE id = ?`).run(...Object.values(fields), Date.now(), clientId);
  insertAuditLog({ user_id: req.session.user_id, action: 'update_auto_reply_config', entity_type: 'client', entity_id: clientId, ip: req.ip });
  res.json({ ok: true });
});

app.get('/api/auto-reply/logs', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const from  = req.query.from ? parseInt(req.query.from, 10) : Date.now() - 7 * 86400000;
  const to    = req.query.to   ? parseInt(req.query.to, 10) : Date.now();
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const logs  = db.prepare(`
    SELECT l.*, c.customer_id,
           cu.name AS customer_name
    FROM auto_reply_logs l
    LEFT JOIN conversations c ON c.id = l.conversation_id
    LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE l.client_id = ? AND l.created_at BETWEEN ? AND ?
    ORDER BY l.created_at DESC LIMIT ?
  `).all(clientId, from, to, limit);
  res.json({ logs });
});

app.get('/api/auto-reply/stats', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const todayStart = (() => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); })();
  const total = db.prepare('SELECT COUNT(*) AS cnt FROM auto_reply_logs WHERE client_id = ? AND created_at >= ?').get(clientId, todayStart)?.cnt ?? 0;
  const avgConf = db.prepare('SELECT AVG(confidence) AS avg FROM auto_reply_logs WHERE client_id = ? AND created_at >= ?').get(clientId, todayStart)?.avg ?? 0;
  const matched = db.prepare('SELECT COUNT(*) AS cnt FROM auto_reply_logs WHERE client_id = ? AND created_at >= ? AND matched_qa_id IS NOT NULL').get(clientId, todayStart)?.cnt ?? 0;
  const recent = db.prepare(`
    SELECT l.*, cu.name AS customer_name
    FROM auto_reply_logs l
    LEFT JOIN conversations c ON c.id = l.conversation_id
    LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE l.client_id = ?
    ORDER BY l.created_at DESC LIMIT 10
  `).all(clientId);
  res.json({
    today_count: total,
    hit_rate: total > 0 ? Math.round(matched / total * 100) : 0,
    avg_confidence: Math.round((avgConf || 0) * 100) / 100,
    recent,
  });
});

// ─── #3：CLV 顧客生命週期 ───

app.get('/api/clv/overview', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  res.json(getClvOverview(clientId));
});

app.get('/api/clv/customers', (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.query.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  const stage  = req.query.stage  || null;
  const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const customers = getClvCustomers(clientId, { stage, limit, offset });
  res.json({ customers });
});

app.post('/api/clv/recompute', requireAdmin, (req, res) => {
  const clientId = resolveClientId(req) ?? parseInt(req.body?.client_id, 10);
  if (!clientId) return res.status(400).json({ error: '需指定 client_id' });
  try {
    const updated = computeLifecycle(clientId);
    insertAuditLog({ user_id: req.session.user_id, action: 'clv_recompute', entity_type: 'client', entity_id: clientId, ip: req.ip });
    res.json({ ok: true, updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── P6 路由掛載 ───
app.use('/api/billing', billingRouter);
app.use('/api/logs', logsRouter);
// /api/logs/security-events 與 /api/logs/security-events/:id/resolve 都在 logsRouter 內

// ─── 品牌教練 ───
app.use('/api/brand-coach', brandCoachRouter);

// ─── P6: 每日報表手動觸發 ───
app.post('/api/daily-reports/generate', requireAdmin, async (req, res) => {
  try {
    await generateDailyReports();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 一次性 backfill：對所有 LINE 顧客重抓 profile（admin only）───
app.post('/api/admin/backfill-line-profiles', requireAdmin, async (req, res) => {
  const clients = db.prepare('SELECT id, line_access_token_enc FROM clients WHERE line_access_token_enc IS NOT NULL').all();
  let processed = 0, ok = 0, failed = 0;
  for (const c of clients) {
    const token = decrypt(c.line_access_token_enc);
    const channels = db.prepare(`
      SELECT cc.* FROM customer_channels cc
      JOIN customers cu ON cu.id = cc.customer_id
      WHERE cc.channel = 'line' AND cu.client_id = ?
    `).all(c.id);

    for (const ch of channels) {
      processed++;
      try {
        const profile = await lineGetUserProfile(token, ch.channel_user_id, c.id);
        const displayName = profile.displayName || ch.channel_display_name;
        const pictureUrl = profile.pictureUrl || null;
        db.prepare('UPDATE customer_channels SET channel_display_name = ?, channel_avatar_url = ? WHERE id = ?')
          .run(displayName, pictureUrl, ch.id);
        if (displayName) {
          db.prepare('UPDATE customers SET name = ?, updated_at = ? WHERE id = ? AND (name IS NULL OR name LIKE \'%顧客\')')
            .run(displayName, Date.now(), ch.customer_id);
        }
        ok++;
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        failed++;
      }
    }
  }
  insertAuditLog({ user_id: req.session.user_id, action: 'backfill_line_profiles', details: JSON.stringify({ processed, ok, failed }), ip: req.ip });
  res.json({ ok: true, processed, success: ok, failed });
});

// ─── B7. 手動備份 endpoint（admin only）───
app.post('/api/backup/now', requireAdmin, (req, res) => {
  const result = runBackup();
  if (!result.ok) return res.status(500).json({ error: result.error });
  insertAuditLog({ user_id: req.session.user_id, action: 'manual_backup', ip: req.ip });
  res.json({ ok: true, dest: result.dest, ts: result.ts });
});

// ─── 加密備份上傳 GitHub Release（admin only）───
app.post('/api/backup/upload-now', requireAdmin, async (req, res) => {
  if (!process.env.GITHUB_TOKEN) {
    return res.status(503).json({ error: 'GITHUB_TOKEN not configured' });
  }
  try {
    const result = await runBackupAndUpload();
    insertAuditLog({ user_id: req.session.user_id, action: 'remote_backup_upload', ip: req.ip });
    res.json(result);
  } catch (e) {
    log.error({ err: e.message }, 'remote backup upload failed');
    res.status(500).json({ error: e.message });
  }
});

// ─── 404 ───
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path, request_id: req.id });
});

// ─── B6. Global Error Handler（生產模式不洩漏 stack）───
app.use((err, req, res, _next) => {
  log.error({ err: err.stack, request_id: req.id }, 'unhandled error');
  const isProduction = process.env.NODE_ENV === 'production';
  res.status(500).json({
    error: 'Internal Server Error',
    request_id: req.id,
    ...(isProduction ? {} : { details: err.message, stack: err.stack }),
  });
});

// ─── 每日報表生成 ───
const generateDailyReports = async () => {
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  const reportDate = `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, '0')}-${String(yesterday.getUTCDate()).padStart(2, '0')}`;
  const from = Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate());
  const to   = from + 24 * 3600 * 1000;

  const clients = db.prepare("SELECT id, name, display_name FROM clients").all();
  for (const client of clients) {
    try {
      const cid = client.id;

      const totalMsgs     = db.prepare(`SELECT COUNT(*) AS cnt FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.client_id = ? AND m.created_at BETWEEN ? AND ?`).get(cid, from, to).cnt;
      const inboundMsgs   = db.prepare(`SELECT COUNT(*) AS cnt FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.client_id = ? AND m.direction = 'inbound' AND m.created_at BETWEEN ? AND ?`).get(cid, from, to).cnt;
      const newConvs      = db.prepare(`SELECT COUNT(*) AS cnt FROM conversations WHERE client_id = ? AND created_at BETWEEN ? AND ?`).get(cid, from, to).cnt;
      const closedConvs   = db.prepare(`SELECT COUNT(*) AS cnt FROM conversations WHERE client_id = ? AND status = 'closed' AND updated_at BETWEEN ? AND ?`).get(cid, from, to).cnt;
      const csatRow       = db.prepare(`SELECT AVG(csat_score) AS avg, COUNT(*) AS cnt FROM conversations WHERE client_id = ? AND csat_score IS NOT NULL AND updated_at BETWEEN ? AND ?`).get(cid, from, to);
      const aiCost        = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS inp, COALESCE(SUM(output_tokens), 0) AS out FROM ai_usage WHERE client_id = ? AND created_at BETWEEN ? AND ?`).get(cid, from, to);

      // 客服績效
      const agentPerf = db.prepare(`
        SELECT m.sender_id AS user_id, COUNT(*) AS msg_count
        FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.client_id = ? AND m.direction = 'outbound' AND m.sender_type = 'agent' AND m.created_at BETWEEN ? AND ?
        GROUP BY m.sender_id
      `).all(cid, from, to);

      // ─── P6 新增指標 ───
      // 廣播數
      const broadcastStats = db.prepare(`
        SELECT COUNT(*) AS cnt, COALESCE(SUM(sent_count), 0) AS total_sent
        FROM broadcasts WHERE client_id = ? AND sent_at BETWEEN ? AND ?
      `).get(cid, from, to);

      // 計費
      const billingStats = (() => {
        try {
          return db.prepare(`
            SELECT COALESCE(SUM(cost_units), 0) AS push_units,
                   COUNT(CASE WHEN api_type='push' THEN 1 END) AS push_count,
                   COUNT(CASE WHEN api_type='multicast' THEN 1 END) AS broadcast_count
            FROM message_billing WHERE client_id = ? AND is_billable = 1 AND created_at BETWEEN ? AND ?
          `).get(cid, from, to);
        } catch { return { push_units: 0, push_count: 0, broadcast_count: 0 }; }
      })();

      // 安全事件
      const securityStats = (() => {
        try {
          return db.prepare(`
            SELECT COUNT(*) AS total,
                   COUNT(CASE WHEN severity='critical' THEN 1 END) AS critical_count,
                   COUNT(CASE WHEN event_type='login_fail' THEN 1 END) AS login_fail_count
            FROM security_events WHERE created_at BETWEEN ? AND ?
          `).get(from, to);
        } catch { return { total: 0, critical_count: 0, login_fail_count: 0 }; }
      })();

      // 慢 endpoint top 5
      const slowTop5 = (() => {
        try {
          return db.prepare(`
            SELECT path, AVG(duration_ms) AS avg_ms, COUNT(*) AS cnt
            FROM slow_logs WHERE type = 'endpoint' AND created_at BETWEEN ? AND ?
            GROUP BY path ORDER BY avg_ms DESC LIMIT 5
          `).all(from, to);
        } catch { return []; }
      })();

      // 排程失敗次數
      const schedulerErrors = (() => {
        try {
          return db.prepare(`
            SELECT scheduler_name, COUNT(*) AS fail_count
            FROM scheduler_runs WHERE status = 'failed' AND started_at BETWEEN ? AND ?
            GROUP BY scheduler_name
          `).all(from, to);
        } catch { return []; }
      })();

      const data = {
        report_date: reportDate,
        client_id: cid,
        total_messages: totalMsgs,
        inbound_messages: inboundMsgs,
        new_conversations: newConvs,
        closed_conversations: closedConvs,
        csat_avg: csatRow?.avg ? Math.round(csatRow.avg * 10) / 10 : null,
        csat_count: csatRow?.cnt || 0,
        ai_cost_usd: aiCost?.cost || 0,
        ai_input_tokens: aiCost?.inp || 0,
        ai_output_tokens: aiCost?.out || 0,
        agent_performance: agentPerf,
        // P6 新增
        broadcasts_sent: broadcastStats?.cnt || 0,
        broadcast_total_recipients: broadcastStats?.total_sent || 0,
        billing_push_units: billingStats?.push_units || 0,
        billing_push_count: billingStats?.push_count || 0,
        billing_broadcast_count: billingStats?.broadcast_count || 0,
        security_events_total: securityStats?.total || 0,
        security_critical: securityStats?.critical_count || 0,
        login_fail_count: securityStats?.login_fail_count || 0,
        slow_endpoints_top5: slowTop5,
        scheduler_errors: schedulerErrors,
        generated_at: Date.now(),
      };

      db.prepare(`
        INSERT INTO daily_reports (client_id, report_date, data, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(client_id, report_date) DO UPDATE SET data = excluded.data, created_at = excluded.created_at
      `).run(cid, reportDate, JSON.stringify(data), Date.now());

      emitToClient(cid, 'report:daily', { report_date: reportDate, summary: { total_messages: totalMsgs, new_conversations: newConvs } });
      log.info({ client_id: cid, report_date: reportDate }, 'daily report generated');
    } catch (e) {
      log.error({ client_id: client.id, err: e.message }, 'daily report failed');
    }
  }
};

// ─── 啟動 ───
httpServer.listen(PORT, () => {
  log.info({ port: PORT, version: pkg.version }, `server started on :${PORT}`);
  log.info(`Health: http://localhost:${PORT}/api/health`);
  log.info(`UI:     http://localhost:${PORT}/`);

  // ─── VoC 初次分析（啟動 5 秒後，非阻塞）───
  // 讓老闆登入時立刻有歷史主題排行可看，不用手動按「立即分析」
  setTimeout(async () => {
    try {
      const clients = db.prepare('SELECT id FROM clients').all();
      const sinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000; // 過去 30 天
      for (const c of clients) {
        log.info({ client_id: c.id }, '[VoC] 啟動初次分析');
        await runVocBatch(c.id, sinceMs);
      }
    } catch (e) {
      log.error({ err: e.message }, '[VoC] 初次分析失敗');
    }
  }, 5000);

  // 每天清除過期 session
  setInterval(purgeExpiredSessions, 24 * 60 * 60 * 1000);

  // ─── P4 排程任務（改用 wrapScheduler）───

  // 廣播排程：每分鐘
  setInterval(() => {
    wrapScheduler('broadcasts', () => runScheduledBroadcasts());
  }, 60_000);

  // 旅程排程：每 30 秒
  setInterval(() => {
    wrapScheduler('journeys', () => runScheduledJourneys());
  }, 30_000);

  // ─── P3 排程任務 ───

  // 訊息排程：每 30 秒
  setInterval(() => {
    wrapScheduler('scheduled_messages', () => runScheduledMessages());
  }, 30_000);

  // 跟催提醒：每分鐘
  setInterval(() => {
    wrapScheduler('reminders', async () => {
      const now = Date.now();
      const due = db.prepare(`
        SELECT c.*, cl.id AS client_id_real
        FROM conversations c
        LEFT JOIN clients cl ON cl.id = c.client_id
        WHERE c.reminder_at IS NOT NULL AND c.reminder_at <= ? AND c.archived_at IS NULL
      `).all(now);
      for (const conv of due) {
        emitToClient(conv.client_id, 'conversation:reminder', {
          conversation_id: conv.id,
          reminder_note: conv.reminder_note || '',
          customer_id: conv.customer_id,
        });
        db.prepare('UPDATE conversations SET reminder_at = NULL, reminder_note = NULL, updated_at = ? WHERE id = ?')
          .run(now, conv.id);
      }
      return { processed: due.length, success: due.length };
    });
  }, 60_000);

  // 每日報表：每天 00:30 UTC
  const scheduleDailyReport = () => {
    const now = new Date();
    const nextRun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 30, 0));
    const delay = nextRun.getTime() - Date.now();
    setTimeout(async () => {
      await wrapScheduler('daily_reports', generateDailyReports);
      setInterval(() => wrapScheduler('daily_reports', generateDailyReports), 24 * 60 * 60 * 1000);
    }, delay);
  };
  scheduleDailyReport();

  // ─── P8：BV SHOP 訂單同步排程（每 15 分鐘）───
  // 架構已鋪好，等用戶提供 BV API key 才實際拉資料（stub mode 會直接跳過）
  setInterval(() => {
    wrapScheduler('bv_sync', async () => {
      const clients = db.prepare("SELECT id FROM clients WHERE bv_api_key_enc IS NOT NULL AND bv_shop_url IS NOT NULL").all();
      if (!clients.length) return { processed: 0, success: 0, note: 'BV API key 尚未設定' };
      let success = 0;
      for (const c of clients) {
        try {
          const result = await syncOrdersForClient(c.id);
          if (result.ok) success++;
        } catch (e) {
          log.error({ err: e.message, client_id: c.id }, 'BV sync scheduler error');
        }
      }
      return { processed: clients.length, success };
    });
  }, 15 * 60_000);
  log.info('P8 BV SHOP sync scheduler started (every 15 min)');

  // ─── B7. 備份排程（本地）───
  scheduleBackup();

  // ─── B7+. 加密備份上傳 GitHub Releases ───
  if (process.env.GITHUB_TOKEN) {
    scheduleRemoteBackup();
    log.info('remote backup scheduler started (GitHub Releases, daily UTC 03:00)');
  } else {
    log.warn('GITHUB_TOKEN not set — remote backup to GitHub disabled');
  }

  // ─── P6 排程任務 ───

  // LINE 額度掃描：每 30 分鐘
  setInterval(() => {
    wrapScheduler('quota_check', () => scanAllClientsQuota());
  }, 30 * 60_000);

  // Token 過期警示：每天 09:00 UTC
  const scheduleTokenWarning = () => {
    const checkTokens = async () => {
      await wrapScheduler('token_warning', async () => {
        const clients = db.prepare('SELECT * FROM clients').all();
        const now = Date.now();
        let warned = 0;

        for (const client of clients) {
          // FB Token
          if (client.fb_token_expires_at) {
            const daysLeft = Math.ceil((client.fb_token_expires_at - now) / 86400_000);

            if (daysLeft <= 0) {
              // 已過期
              try {
                db.prepare(`
                  INSERT INTO security_events (event_type, user_id, username, ip, details, severity, resolved, created_at)
                  VALUES ('token_expired', NULL, ?, NULL, ?, 'critical', 0, ?)
                `).run(
                  client.name,
                  JSON.stringify({ channel: 'fb', client_id: client.id, expired_at: client.fb_token_expires_at }),
                  now
                );
              } catch {}
              warned++;
            } else if (daysLeft <= 3 && !client.fb_token_warned_3d) {
              db.prepare('UPDATE clients SET fb_token_warned_3d = 1 WHERE id = ?').run(client.id);
              emitToAdmin('token:expiring', { client_id: client.id, channel: 'fb', days_left: daysLeft, severity: 'critical' });
              insertAuditLog({ action: 'fb_token_warn_3d', entity_type: 'client', entity_id: client.id });
              warned++;
            } else if (daysLeft <= 7 && !client.fb_token_warned_7d) {
              db.prepare('UPDATE clients SET fb_token_warned_7d = 1 WHERE id = ?').run(client.id);
              emitToAdmin('token:expiring', { client_id: client.id, channel: 'fb', days_left: daysLeft, severity: 'warn' });
              insertAuditLog({ action: 'fb_token_warn_7d', entity_type: 'client', entity_id: client.id });
              warned++;
            }
          }

          // LINE token（短效 30 天）
          if (client.line_token_expires_at) {
            const daysLeft = Math.ceil((client.line_token_expires_at - now) / 86400_000);

            if (daysLeft <= 3 && !client.line_token_warned_3d) {
              db.prepare('UPDATE clients SET line_token_warned_3d = 1 WHERE id = ?').run(client.id);
              emitToAdmin('token:expiring', { client_id: client.id, channel: 'line', days_left: daysLeft, severity: 'critical' });
              insertAuditLog({ action: 'line_token_warn_3d', entity_type: 'client', entity_id: client.id });
              warned++;
            } else if (daysLeft <= 7 && !client.line_token_warned_7d) {
              db.prepare('UPDATE clients SET line_token_warned_7d = 1 WHERE id = ?').run(client.id);
              emitToAdmin('token:expiring', { client_id: client.id, channel: 'line', days_left: daysLeft, severity: 'warn' });
              insertAuditLog({ action: 'line_token_warn_7d', entity_type: 'client', entity_id: client.id });
              warned++;
            }
          }
        }

        return { processed: clients.length, success: warned };
      });
    };

    // 計算到今天 09:00 UTC 的 delay
    const now = new Date();
    let nextRun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0));
    if (nextRun.getTime() <= Date.now()) nextRun.setUTCDate(nextRun.getUTCDate() + 1);
    const delay = nextRun.getTime() - Date.now();
    setTimeout(() => {
      checkTokens();
      setInterval(checkTokens, 24 * 60 * 60 * 1000);
    }, delay);
  };
  scheduleTokenWarning();

  // 每日 cleanup（每 24h）
  setInterval(() => {
    wrapScheduler('cleanup', async () => {
      cleanOldApiLogs();
      cleanOldSecurityEvents();
      cleanOldSchedulerRuns();
      // slow_logs 30 天
      try {
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        db.prepare('DELETE FROM slow_logs WHERE created_at < ?').run(cutoff);
        // socket_events 30 天
        db.prepare('DELETE FROM socket_events WHERE created_at < ?').run(cutoff);
      } catch {}
      return { processed: 1, success: 1 };
    });
  }, 24 * 60 * 60 * 1000);

  // ─── CLV 排程（每天 04:00 UTC）───
  scheduleClvJob();
  log.info('CLV scheduler started (daily 04:00 UTC)');

  // ─── VoC 批次分析排程（每天 02:00 UTC）───
  const scheduleVocBatch = () => {
    const now = new Date();
    let nextRun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 0, 0));
    if (nextRun.getTime() <= Date.now()) nextRun.setUTCDate(nextRun.getUTCDate() + 1);
    const delay = nextRun.getTime() - Date.now();

    const runVoc = async () => {
      await wrapScheduler('voc_batch', async () => {
        const yesterday = Date.now() - 2 * 24 * 3600_000; // 前 48 小時確保不遺漏
        const clients = db.prepare('SELECT id FROM clients').all();
        let processed = 0, success = 0, errorCount = 0;

        for (const c of clients) {
          try {
            const r = await runVocBatch(c.id, yesterday, { batchSize: 100 });
            processed += r.processed;
            success   += r.success;
            errorCount += r.error;
            recomputeVocTopics(c.id);
          } catch (e) {
            log.error({ err: e.message, client_id: c.id }, 'VoC batch scheduler error');
            errorCount++;
          }
        }

        return { processed, success, error: errorCount, details: { clients: clients.length } };
      });

      // 設定下一次（24 小時後）
      setTimeout(runVoc, 24 * 60 * 60 * 1000);
    };

    setTimeout(runVoc, delay);
    log.info({ next_run: nextRun.toISOString() }, 'VoC batch scheduler started (daily 02:00 UTC)');
  };
  scheduleVocBatch();

  // ─── 啟動後 5 秒自動跑一次 CLV 重算（確保 redeploy 後資料不殘留 new）───
  setTimeout(() => {
    wrapScheduler('clv_startup', async () => {
      const clients = db.prepare('SELECT id FROM clients').all();
      let total = 0;
      for (const c of clients) {
        try {
          const updated = computeLifecycle(c.id);
          total += updated;
        } catch (e) {
          log.error({ err: e.message, client_id: c.id }, 'CLV 啟動重算失敗');
        }
      }
      log.info({ total_updated: total, client_count: clients.length }, `CLV 重算完成：${total} 個客戶`);
      console.log(`[CLV] 啟動重算完成：${total} 個客戶，共 ${clients.length} 個業主`);
      return { processed: clients.length, success: clients.length, details: { total_customers: total } };
    });
  }, 5000);

  log.info('P3+P4+P6 schedulers started');
});
