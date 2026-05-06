import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'db' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cs.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ─── Schema ───
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    brand_dna TEXT NOT NULL DEFAULT '{}',
    line_channel_id TEXT,
    line_channel_secret_enc TEXT,
    line_access_token_enc TEXT,
    fb_page_id TEXT,
    fb_page_token_enc TEXT,
    fb_verify_token TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'agent',
    client_id INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '未知顧客',
    phone TEXT,
    email TEXT,
    notes TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS customer_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    channel_user_id TEXT NOT NULL,
    channel_display_name TEXT,
    channel_avatar_url TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    UNIQUE(channel, channel_user_id)
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    intent TEXT,
    emotion TEXT,
    assigned_user_id INTEGER,
    last_message_at INTEGER,
    last_message_preview TEXT,
    unread_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    sender_type TEXT NOT NULL,
    sender_id TEXT,
    content_type TEXT NOT NULL DEFAULT 'text',
    content TEXT,
    media_url TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    external_message_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    message_id INTEGER,
    variant TEXT NOT NULL DEFAULT 'professional',
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    edited_content TEXT,
    created_by_model TEXT,
    tokens_used INTEGER,
    approved_by_user_id INTEGER,
    approved_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS qa_pairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    category TEXT,
    embedding BLOB,
    hit_count INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual',
    source_conversation_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    shortcut TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    UNIQUE(client_id, shortcut)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    role TEXT NOT NULL,
    client_id INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    details TEXT NOT NULL DEFAULT '{}',
    ip TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_conv_client_status ON conversations(client_id, status);
  CREATE INDEX IF NOT EXISTS idx_conv_last_msg ON conversations(last_message_at DESC);
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_qa_client ON qa_pairs(client_id, category);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_customers_client ON customers(client_id, updated_at DESC);
`);

// ─── Seed 預設資料 ───
const seedDefaults = () => {
  const now = Date.now();

  // super admin
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'changeme123';
  const adminHash = process.env.ADMIN_PASS_HASH || bcrypt.hashSync(adminPass, 10);
  const existingAdmin = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(adminUser);
  if (!existingAdmin) {
    db.prepare(`INSERT INTO users (username, password_hash, role, client_id, created_at)
                VALUES (?, ?, 'admin', NULL, ?)`)
      .run(adminUser, adminHash, now);
    log.info(`已建立 super admin: ${adminUser}`);
  } else if (process.env.ADMIN_PASS_HASH && existingAdmin.password_hash !== process.env.ADMIN_PASS_HASH) {
    // 環境變數改了 → 自動同步 admin 密碼（金鑰輪替後生效）
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(process.env.ADMIN_PASS_HASH, existingAdmin.id);
    log.info(`super admin 密碼已從 ADMIN_PASS_HASH 同步`);
  }

  // 第一個業主：梵森
  const existingVansen = db.prepare('SELECT id FROM clients WHERE name = ?').get('vansen');
  if (!existingVansen) {
    db.prepare(`INSERT INTO clients (name, display_name, brand_dna, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)`)
      .run('vansen', '梵森', '{}', now, now);
    log.info('已建立業主：梵森 (vansen)');
  }

  // 取得梵森 id（可能剛建或早就存在）
  const vansen = db.prepare('SELECT id FROM clients WHERE name = ?').get('vansen');
  if (vansen) {
    seedDefaultTemplates(vansen.id, now);
  }
};

// ─── 預設模板 Seed ───
const DEFAULT_TEMPLATES = [
  { shortcut: '/出貨', title: '出貨通知',   content: '您好，您的訂單已出貨，物流追蹤號：{tracking}，預計 2-3 天送達。',                              category: '物流' },
  { shortcut: '/收到', title: '訊息確認',   content: '您好，已收到您的訊息，稍後為您處理～',                                                            category: '通用' },
  { shortcut: '/感謝', title: '感謝回覆',   content: '感謝您的支持，有任何問題都歡迎再來訊息！',                                                        category: '通用' },
  { shortcut: '/查單', title: '查詢訂單',   content: '請提供您的訂單編號或下單時的姓名手機，我為您查詢～',                                              category: '訂單' },
  { shortcut: '/休假', title: '休假通知',   content: '您好，目前為休息時間，將於上班時間優先回覆，造成不便請見諒。',                                    category: '通用' },
  { shortcut: '/退貨', title: '退貨流程',   content: '退貨流程：① 七日內聯繫客服 ② 寄回原包裝 ③ 確認後退款 3-5 工作天到帳。',                       category: '退換貨' },
  { shortcut: '/客服', title: '轉人工',     content: '您好，這個問題我請真人客服跟您說明，請稍等。',                                                    category: '通用' },
];

const seedDefaultTemplates = (clientId, now) => {
  const existing = db.prepare('SELECT COUNT(*) AS cnt FROM templates WHERE client_id = ?').get(clientId);
  if (existing.cnt > 0) return; // 已有模板，跳過
  const stmt = db.prepare(`INSERT OR IGNORE INTO templates (client_id, shortcut, title, content, category, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const tpl of DEFAULT_TEMPLATES) {
    stmt.run(clientId, tpl.shortcut, tpl.title, tpl.content, tpl.category, now, now);
  }
  log.info({ client_id: clientId, count: DEFAULT_TEMPLATES.length }, '已建立預設模板');
};

seedDefaults();

// ─── P2/P3 Migration（ALTER TABLE + 容錯）───
export const safeAlter = (sql) => {
  try { db.exec(sql); } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }
};

// conversations 新欄位
safeAlter('ALTER TABLE conversations ADD COLUMN tags TEXT DEFAULT \'[]\'');
safeAlter('ALTER TABLE conversations ADD COLUMN summary TEXT');
safeAlter('ALTER TABLE conversations ADD COLUMN summary_updated_at INTEGER');
safeAlter('ALTER TABLE conversations ADD COLUMN urgency TEXT');
safeAlter('ALTER TABLE conversations ADD COLUMN csat_score INTEGER');
safeAlter('ALTER TABLE conversations ADD COLUMN csat_comment TEXT');
safeAlter('ALTER TABLE conversations ADD COLUMN csat_sent_at INTEGER');

// B: 客服個人評分 — csat_agent_id snapshot
safeAlter('ALTER TABLE conversations ADD COLUMN csat_agent_id INTEGER');
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_conv_csat_agent ON conversations(csat_agent_id, csat_score)');
} catch {}

// customers 新欄位
safeAlter('ALTER TABLE customers ADD COLUMN custom_fields TEXT DEFAULT \'{}\'');
safeAlter('ALTER TABLE customers ADD COLUMN is_blocked INTEGER DEFAULT 0');
safeAlter('ALTER TABLE customers ADD COLUMN bv_customer_id INTEGER');
safeAlter('ALTER TABLE customers ADD COLUMN blocked_reason TEXT');
safeAlter('ALTER TABLE customers ADD COLUMN blocked_at INTEGER');

// conversation_transfers 表
db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    from_user_id INTEGER,
    to_user_id INTEGER NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL
  );
`);

// FTS5 全文搜尋（trigram tokenizer 支援中文子字串搜尋）
// 若舊表用 unicode61，先刪掉重建
try {
  const oldTbl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'`).get();
  if (oldTbl && !oldTbl.sql.includes('trigram')) {
    db.exec('DROP TABLE IF EXISTS messages_fts');
    log.info('dropped old messages_fts (unicode61), rebuilding with trigram');
  }
} catch {}

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, conversation_id UNINDEXED,
    tokenize='trigram'
  );

  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, conversation_id) VALUES (new.id, COALESCE(new.content,''), new.conversation_id);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
    INSERT INTO messages_fts(rowid, content, conversation_id) VALUES (new.id, COALESCE(new.content,''), new.conversation_id);
  END;
`);

// FTS5 backfill（若 fts 空但 messages 有資料）
try {
  const ftsCount  = db.prepare('SELECT COUNT(*) AS cnt FROM messages_fts').get().cnt;
  const msgCount  = db.prepare('SELECT COUNT(*) AS cnt FROM messages').get().cnt;
  if (ftsCount === 0 && msgCount > 0) {
    db.exec(`INSERT INTO messages_fts(rowid, content, conversation_id) SELECT id, COALESCE(content,''), conversation_id FROM messages`);
    log.info({ count: msgCount }, 'FTS5 backfill completed');
  }
} catch (e) {
  log.warn({ err: e.message }, 'FTS5 backfill skipped');
}

// ─── P6 Schema Migration ───

// messages 送達狀態
safeAlter('ALTER TABLE messages ADD COLUMN delivered_at INTEGER');
safeAlter('ALTER TABLE messages ADD COLUMN read_at INTEGER');
safeAlter('ALTER TABLE messages ADD COLUMN delivery_status TEXT');
safeAlter('ALTER TABLE messages ADD COLUMN delivery_error TEXT');

// clients token 過期相關
safeAlter('ALTER TABLE clients ADD COLUMN line_token_expires_at INTEGER');
safeAlter('ALTER TABLE clients ADD COLUMN fb_token_expires_at INTEGER');
safeAlter('ALTER TABLE clients ADD COLUMN line_token_warned_7d INTEGER DEFAULT 0');
safeAlter('ALTER TABLE clients ADD COLUMN line_token_warned_3d INTEGER DEFAULT 0');
safeAlter('ALTER TABLE clients ADD COLUMN fb_token_warned_7d INTEGER DEFAULT 0');
safeAlter('ALTER TABLE clients ADD COLUMN fb_token_warned_3d INTEGER DEFAULT 0');

// 慢日誌表
db.exec(`
  CREATE TABLE IF NOT EXISTS slow_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    path TEXT,
    duration_ms INTEGER NOT NULL,
    user_id INTEGER,
    client_id INTEGER,
    details TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_slow_type ON slow_logs(type, duration_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_slow_created ON slow_logs(created_at DESC);
`);

// WebSocket 連線事件
db.exec(`
  CREATE TABLE IF NOT EXISTS socket_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    user_id INTEGER,
    username TEXT,
    client_id INTEGER,
    socket_id TEXT,
    ip TEXT,
    user_agent TEXT,
    duration_ms INTEGER,
    reason TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_socket_events ON socket_events(event_type, created_at);
`);

log.info('P6 schema migration done');

// ─── IG DM Schema Migration ───
// ig_app_secret 共用 fb_app_secret（都是 Meta App 層級）
safeAlter('ALTER TABLE clients ADD COLUMN ig_business_account_id TEXT');
safeAlter('ALTER TABLE clients ADD COLUMN ig_access_token_enc TEXT');
safeAlter('ALTER TABLE clients ADD COLUMN ig_verify_token TEXT');

log.info('IG DM schema migration done');

// ─── P8 Schema Migration：BV SHOP 訂單同步 ───
safeAlter('ALTER TABLE clients ADD COLUMN bv_shop_url TEXT');
safeAlter('ALTER TABLE clients ADD COLUMN bv_api_key_enc TEXT');
safeAlter('ALTER TABLE clients ADD COLUMN bv_last_sync_at INTEGER');
safeAlter("ALTER TABLE clients ADD COLUMN bv_email TEXT");
safeAlter("ALTER TABLE clients ADD COLUMN bv_password_enc TEXT");
safeAlter("ALTER TABLE clients ADD COLUMN bv_type TEXT DEFAULT 'store'");

// CSAT 自動發送
db.prepare(`
  CREATE TABLE IF NOT EXISTS csat_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    customer_id INTEGER,
    sent_at INTEGER NOT NULL,
    replied_at INTEGER,
    score INTEGER,
    comment TEXT,
    UNIQUE(conversation_id)
  )
`).run();
safeAlter("CREATE INDEX IF NOT EXISTS idx_csat_client ON csat_responses(client_id, replied_at)");

// 多品牌 DNA：對話級別的活躍語調覆寫
safeAlter("ALTER TABLE conversations ADD COLUMN active_voice TEXT");

// 下班路由（off-hours auto-reply）
safeAlter("ALTER TABLE clients ADD COLUMN off_hours_enabled INTEGER DEFAULT 0");
safeAlter("ALTER TABLE clients ADD COLUMN off_hours_start TEXT DEFAULT '18:00'");
safeAlter("ALTER TABLE clients ADD COLUMN off_hours_end TEXT DEFAULT '09:00'");
safeAlter("ALTER TABLE clients ADD COLUMN off_hours_message TEXT DEFAULT '謝謝您的訊息 🌙 我們的客服時間是 09:00-18:00，明早會盡快回覆您～'");
safeAlter("ALTER TABLE conversations ADD COLUMN off_hours_sent_at INTEGER");

// AI 自學：把（顧客訊息 → 客服回覆）配對存起來，下次當 few-shot 範例
db.prepare(`
  CREATE TABLE IF NOT EXISTS learning_pairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    customer_msg TEXT NOT NULL,
    agent_msg TEXT NOT NULL,
    customer_msg_id INTEGER,
    agent_msg_id INTEGER,
    intent TEXT,
    csat_score INTEGER,
    used_ai_draft INTEGER DEFAULT 0,
    quality_score REAL DEFAULT 1.0,
    created_at INTEGER NOT NULL
  )
`).run();
safeAlter("CREATE INDEX IF NOT EXISTS idx_learn_client ON learning_pairs(client_id, created_at DESC)");
safeAlter("CREATE INDEX IF NOT EXISTS idx_learn_intent ON learning_pairs(client_id, intent)");

log.info('P8 BV SHOP schema migration done');

// ─── clients CRUD ───
export const listClients = () =>
  db.prepare('SELECT id, name, display_name, brand_dna, line_channel_id, fb_page_id, created_at, updated_at FROM clients ORDER BY created_at ASC').all();

export const getClient = (id) =>
  db.prepare('SELECT * FROM clients WHERE id = ?').get(id);

export const getClientByName = (name) =>
  db.prepare('SELECT * FROM clients WHERE name = ?').get(name);

export const insertClient = ({ name, display_name, brand_dna = '{}' }) => {
  const now = Date.now();
  return db.prepare(`INSERT INTO clients (name, display_name, brand_dna, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(name, display_name, brand_dna, now, now).lastInsertRowid;
};

export const updateClient = (id, fields) => {
  const allowed = ['name', 'display_name', 'brand_dna',
    'line_channel_id', 'line_channel_secret_enc', 'line_access_token_enc',
    'fb_page_id', 'fb_page_token_enc', 'fb_verify_token'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const sql = `UPDATE clients SET ${updates.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  db.prepare(sql).run(...updates.map(([, v]) => v), Date.now(), id);
};

export const deleteClient = (id) =>
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);

// ─── users CRUD ───
export const listUsers = (clientId = null) => {
  if (clientId === null) {
    return db.prepare('SELECT id, username, role, client_id, created_at FROM users ORDER BY created_at ASC').all();
  }
  return db.prepare('SELECT id, username, role, client_id, created_at FROM users WHERE client_id = ? OR (role = \'admin\' AND client_id IS NULL) ORDER BY created_at ASC').all(clientId);
};

export const getUser = (id) =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(id);

export const getUserByUsername = (username) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(username);

export const insertUser = ({ username, password_hash, role = 'agent', client_id = null }) =>
  db.prepare(`INSERT INTO users (username, password_hash, role, client_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(username, password_hash, role, client_id, Date.now()).lastInsertRowid;

// ─── customers CRUD ───
export const listCustomers = (clientId, { search = null, limit = 50, offset = 0 } = {}) => {
  if (search) {
    const like = `%${search}%`;
    return db.prepare(`
      SELECT * FROM customers
      WHERE client_id = ?
        AND (name LIKE ? OR phone LIKE ? OR email LIKE ? OR notes LIKE ?)
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(clientId, like, like, like, like, limit, offset);
  }
  return db.prepare('SELECT * FROM customers WHERE client_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?')
    .all(clientId, limit, offset);
};

export const getCustomer = (id, clientId) =>
  db.prepare('SELECT * FROM customers WHERE id = ? AND client_id = ?').get(id, clientId);

export const insertCustomer = ({ client_id, name = '未知顧客', phone = null, email = null, notes = null, tags = '[]' }) => {
  const now = Date.now();
  return db.prepare(`INSERT INTO customers (client_id, name, phone, email, notes, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(client_id, name, phone, email, notes, tags, now, now).lastInsertRowid;
};

export const updateCustomer = (id, clientId, fields) => {
  const allowed = ['name', 'phone', 'email', 'notes', 'tags', 'custom_fields',
    'is_blocked', 'blocked_reason', 'blocked_at'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const sql = `UPDATE customers SET ${updates.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND client_id = ?`;
  db.prepare(sql).run(...updates.map(([, v]) => v), Date.now(), id, clientId);
};

// ─── customer_channels ───
export const getChannelIdentity = (channel, channelUserId) =>
  db.prepare('SELECT * FROM customer_channels WHERE channel = ? AND channel_user_id = ?').get(channel, channelUserId);

export const insertChannelIdentity = ({ customer_id, channel, channel_user_id, channel_display_name = null, channel_avatar_url = null }) =>
  db.prepare(`INSERT OR IGNORE INTO customer_channels (customer_id, channel, channel_user_id, channel_display_name, channel_avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(customer_id, channel, channel_user_id, channel_display_name, channel_avatar_url, Date.now()).lastInsertRowid;

export const getCustomerChannels = (customerId) =>
  db.prepare('SELECT * FROM customer_channels WHERE customer_id = ?').all(customerId);

// ─── conversations CRUD ───
export const listConversations = ({ client_id, status = null, limit = 50, offset = 0 }) => {
  const where = ['c.client_id = ?'];
  const args = [client_id];
  if (status) { where.push('c.status = ?'); args.push(status); }
  const sql = `
    SELECT c.*, cu.name AS customer_name, cu.tags AS customer_tags,
           cc.channel_avatar_url AS customer_avatar_url,
           cc.channel_display_name AS customer_display_name
    FROM conversations c
    LEFT JOIN customers cu ON cu.id = c.customer_id
    LEFT JOIN customer_channels cc ON cc.customer_id = c.customer_id AND cc.channel = c.channel
    WHERE ${where.join(' AND ')}
    ORDER BY c.is_pinned DESC, c.last_message_at DESC
    LIMIT ? OFFSET ?
  `;
  args.push(limit, offset);
  return db.prepare(sql).all(...args);
};

export const getConversation = (id, clientId = null) => {
  if (clientId) {
    return db.prepare('SELECT * FROM conversations WHERE id = ? AND client_id = ?').get(id, clientId);
  }
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
};

export const findOpenConversation = (clientId, customerId, channel) =>
  db.prepare(`SELECT * FROM conversations WHERE client_id = ? AND customer_id = ? AND channel = ? AND status = 'open'`)
    .get(clientId, customerId, channel);

export const insertConversation = ({ client_id, customer_id, channel }) => {
  const now = Date.now();
  return db.prepare(`INSERT INTO conversations (client_id, customer_id, channel, status, last_message_at, unread_count, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, 0, ?, ?)`)
    .run(client_id, customer_id, channel, now, now, now).lastInsertRowid;
};

export const updateConversation = (id, clientId, fields) => {
  const allowed = ['status', 'assigned_user_id', 'intent', 'emotion', 'urgency',
    'last_message_at', 'last_message_preview', 'unread_count',
    'tags', 'summary', 'summary_updated_at', 'csat_score', 'csat_comment', 'csat_sent_at',
    'csat_agent_id', 'active_voice'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const sql = `UPDATE conversations SET ${updates.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND client_id = ?`;
  db.prepare(sql).run(...updates.map(([, v]) => v), Date.now(), id, clientId);
};

// ─── messages CRUD ───
export const listMessages = (conversationId, { limit = 100, offset = 0 } = {}) =>
  db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`)
    .all(conversationId, limit, offset);

export const insertMessage = ({ conversation_id, direction, sender_type, sender_id = null, content_type = 'text', content = null, media_url = null, metadata = '{}', external_message_id = null }) =>
  db.prepare(`INSERT INTO messages (conversation_id, direction, sender_type, sender_id, content_type, content, media_url, metadata, external_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversation_id, direction, sender_type, sender_id, content_type, content, media_url, metadata, external_message_id, Date.now()).lastInsertRowid;

// ─── templates CRUD ───
export const listTemplates = (clientId) =>
  db.prepare('SELECT * FROM templates WHERE client_id = ? ORDER BY category, shortcut').all(clientId);

export const getTemplate = (id, clientId) =>
  db.prepare('SELECT * FROM templates WHERE id = ? AND client_id = ?').get(id, clientId);

export const insertTemplate = ({ client_id, shortcut, title, content, category = null }) => {
  const now = Date.now();
  return db.prepare(`INSERT INTO templates (client_id, shortcut, title, content, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(client_id, shortcut, title, content, category, now, now).lastInsertRowid;
};

export const updateTemplate = (id, clientId, fields) => {
  const allowed = ['shortcut', 'title', 'content', 'category'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const sql = `UPDATE templates SET ${updates.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND client_id = ?`;
  db.prepare(sql).run(...updates.map(([, v]) => v), Date.now(), id, clientId);
};

export const deleteTemplate = (id, clientId) =>
  db.prepare('DELETE FROM templates WHERE id = ? AND client_id = ?').run(id, clientId);

// ─── sessions ───
export const insertSession = (id, userId, username, role, clientId, expiresAt) =>
  db.prepare('INSERT INTO sessions (id, user_id, username, role, client_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, username, role, clientId, Date.now(), expiresAt);

export const getSession = (id) =>
  db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(id, Date.now());

export const deleteSession = (id) =>
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);

export const purgeExpiredSessions = () =>
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

export const countActiveSessions = () =>
  (db.prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE expires_at > ?').get(Date.now())).cnt;

// ─── audit_logs ───
export const insertAuditLog = ({ user_id = null, action, entity_type = null, entity_id = null, details = '{}', ip = null }) =>
  db.prepare(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(user_id, action, entity_type, entity_id, details, ip, Date.now());

export const listAuditLogs = ({ limit = 50, offset = 0, action = null, user_id = null } = {}) => {
  const where = [];
  const args = [];
  if (action) { where.push('action = ?'); args.push(action); }
  if (user_id) { where.push('user_id = ?'); args.push(Number(user_id)); }
  const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT * FROM audit_logs ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  args.push(limit, offset);
  return db.prepare(sql).all(...args);
};

// ─── stats ───
export const getStats = (clientId = null) => {
  const now = Date.now();
  // 用 UTC 時間計算，避免時區問題（DB 裡 created_at 都是 Date.now() = UTC ms）
  const d = new Date();
  const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);

  const clientFilter = clientId ? 'AND c.client_id = ?' : '';
  const msgClientFilter = clientId ? 'AND m.conversation_id IN (SELECT id FROM conversations WHERE client_id = ?)' : '';
  const args1 = clientId ? [clientId] : [];
  const args2 = clientId ? [clientId] : [];

  const todayMsgs = db.prepare(`
    SELECT COUNT(*) AS cnt FROM messages m
    WHERE m.created_at >= ? ${msgClientFilter}
  `).get(todayStart, ...args2).cnt;

  const unread = db.prepare(`
    SELECT COUNT(*) AS cnt FROM conversations c
    WHERE c.status != 'closed' AND c.unread_count > 0 ${clientFilter}
  `).get(...args1).cnt;

  const open = db.prepare(`
    SELECT COUNT(*) AS cnt FROM conversations c
    WHERE c.status = 'open' ${clientFilter}
  `).get(...args1).cnt;

  const monthMsgs = db.prepare(`
    SELECT COUNT(*) AS cnt FROM messages m
    WHERE m.created_at >= ? ${msgClientFilter}
  `).get(monthStart, ...args2).cnt;

  // CSAT 最近 30 天平均
  const thirtyDaysAgo = now - 30 * 24 * 3600 * 1000;
  const csatFilter = clientId ? 'AND client_id = ?' : '';
  const csatArgs = clientId ? [thirtyDaysAgo, clientId] : [thirtyDaysAgo];
  const csatRow = db.prepare(`
    SELECT AVG(csat_score) AS avg_score, COUNT(csat_score) AS cnt
    FROM conversations
    WHERE csat_score IS NOT NULL AND updated_at >= ? ${csatFilter}
  `).get(...csatArgs);

  return {
    today_messages: todayMsgs,
    unread_conversations: unread,
    open_conversations: open,
    month_messages: monthMsgs,
    csat_avg: csatRow?.avg_score ? Math.round(csatRow.avg_score * 10) / 10 : null,
    csat_count: csatRow?.cnt || 0,
  };
};

// ─── users CRUD（新增 update + delete）───
export const updateUser = (id, fields) => {
  const allowed = ['username', 'password_hash', 'role', 'client_id'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const sql = `UPDATE users SET ${updates.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...updates.map(([, v]) => v), id);
};

export const deleteUser = (id) =>
  db.prepare('DELETE FROM users WHERE id = ? AND role != \'admin\'').run(id);

// ─── conversation_transfers ───
export const insertTransfer = ({ conversation_id, from_user_id, to_user_id, reason }) =>
  db.prepare(`INSERT INTO conversation_transfers (conversation_id, from_user_id, to_user_id, reason, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(conversation_id, from_user_id ?? null, to_user_id, reason ?? null, Date.now()).lastInsertRowid;

export const listTransfers = (conversationId) =>
  db.prepare('SELECT * FROM conversation_transfers WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId);

// ─── FTS5 全文搜尋 ───
export const searchMessages = (clientId, query, limit = 20) => {
  try {
    const rows = db.prepare(`
      SELECT
        m.id AS message_id,
        m.conversation_id,
        m.created_at,
        m.content AS snippet,
        c.customer_id,
        cu.name AS customer_name
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE messages_fts MATCH ?
        AND c.client_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(query, clientId, limit);
    return rows;
  } catch (e) {
    // FTS5 query 語法錯誤時，fallback LIKE
    const like = `%${query}%`;
    return db.prepare(`
      SELECT m.id AS message_id, m.conversation_id, m.created_at,
        m.content AS snippet, c.customer_id, cu.name AS customer_name
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE m.content LIKE ? AND c.client_id = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(like, clientId, limit);
  }
};

// ─── qa_pairs CRUD ───
export const listQaPairs = (clientId, { category = null, search = null, limit = 50, offset = 0 } = {}) => {
  const where = ['client_id = ?'];
  const args = [clientId];
  if (category) { where.push('category = ?'); args.push(category); }
  if (search) {
    const like = `%${search}%`;
    where.push('(question LIKE ? OR answer LIKE ?)');
    args.push(like, like);
  }
  args.push(limit, offset);
  return db.prepare(`SELECT * FROM qa_pairs WHERE ${where.join(' AND ')} ORDER BY hit_count DESC, updated_at DESC LIMIT ? OFFSET ?`).all(...args);
};

export const getQaPair = (id, clientId) =>
  db.prepare('SELECT * FROM qa_pairs WHERE id = ? AND client_id = ?').get(id, clientId);

export const insertQaPair = ({ client_id, question, answer, category = null, source = 'manual' }) => {
  const now = Date.now();
  return db.prepare(`INSERT INTO qa_pairs (client_id, question, answer, category, source, hit_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(client_id, question, answer, category, source, now, now).lastInsertRowid;
};

export const updateQaPair = (id, clientId, fields) => {
  const allowed = ['question', 'answer', 'category'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const sql = `UPDATE qa_pairs SET ${updates.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND client_id = ?`;
  db.prepare(sql).run(...updates.map(([, v]) => v), Date.now(), id, clientId);
};

export const deleteQaPair = (id, clientId) =>
  db.prepare('DELETE FROM qa_pairs WHERE id = ? AND client_id = ?').run(id, clientId);

export const similarQaPairs = (clientId, query, limit = 5) => {
  const words = query.split(/[\s，。！？,.!?]+/).filter(w => w.length >= 2);
  if (!words.length) return [];
  const conditions = words.map(() => '(question LIKE ? OR answer LIKE ?)').join(' OR ');
  const params = words.flatMap(w => [`%${w}%`, `%${w}%`]);
  return db.prepare(`
    SELECT * FROM qa_pairs WHERE client_id = ? AND (${conditions})
    ORDER BY hit_count DESC LIMIT ?
  `).all(clientId, ...params, limit);
};

// ─── P3（第三輪）Migration ───

// users 表：上線狀態 + 2FA + 登入鎖定
safeAlter("ALTER TABLE users ADD COLUMN online_status TEXT DEFAULT 'offline'");
safeAlter('ALTER TABLE users ADD COLUMN last_seen_at INTEGER');
safeAlter('ALTER TABLE users ADD COLUMN status_message TEXT');
safeAlter('ALTER TABLE users ADD COLUMN totp_secret TEXT');
safeAlter('ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0');
safeAlter('ALTER TABLE users ADD COLUMN backup_codes TEXT');
safeAlter('ALTER TABLE users ADD COLUMN failed_attempts INTEGER DEFAULT 0');
safeAlter('ALTER TABLE users ADD COLUMN locked_until INTEGER');

// conversations 表：置頂 / 跟催 / 封存
safeAlter('ALTER TABLE conversations ADD COLUMN is_pinned INTEGER DEFAULT 0');
safeAlter('ALTER TABLE conversations ADD COLUMN reminder_at INTEGER');
safeAlter('ALTER TABLE conversations ADD COLUMN reminder_note TEXT');
safeAlter('ALTER TABLE conversations ADD COLUMN archived_at INTEGER');

// clients 表：AI 預算 + PII 設定
safeAlter('ALTER TABLE clients ADD COLUMN ai_budget_usd REAL DEFAULT 0');
safeAlter('ALTER TABLE clients ADD COLUMN ai_budget_period TEXT DEFAULT \'monthly\'');
safeAlter('ALTER TABLE clients ADD COLUMN pii_masking_enabled INTEGER DEFAULT 1');

// updateClient 的 allowed 欄位擴充需在函式層處理（見下方 updateClientFull）

// qa_pairs 表：自學欄位
safeAlter('ALTER TABLE qa_pairs ADD COLUMN auto_learned INTEGER DEFAULT 0');
safeAlter('ALTER TABLE qa_pairs ADD COLUMN confidence REAL DEFAULT 0.5');
safeAlter('ALTER TABLE qa_pairs ADD COLUMN review_status TEXT DEFAULT \'pending\'');

// updateQaPair 擴充 allowed
export const updateQaPairFull = (id, clientId, fields) => {
  const allowed = ['question', 'answer', 'category', 'auto_learned', 'confidence', 'review_status'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const sql = `UPDATE qa_pairs SET ${updates.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND client_id = ?`;
  db.prepare(sql).run(...updates.map(([, v]) => v), Date.now(), id, clientId);
};

// ─── 新表：mentions ───
db.exec(`
  CREATE TABLE IF NOT EXISTS mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    mentioned_user_id INTEGER NOT NULL,
    read_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (mentioned_user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(mentioned_user_id, read_at);
`);

// ─── 新表：ai_usage ───
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    user_id INTEGER,
    feature TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    conversation_id INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_client_date ON ai_usage(client_id, created_at);
`);

// ─── 新表：daily_reports ───
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    report_date TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(client_id, report_date)
  );
`);

// ─── updateClient 擴充版（支援 ai_budget + pii_masking + IG DM）───
export const updateClientFull = (id, fields) => {
  const allowed = ['name', 'display_name', 'brand_dna',
    'line_channel_id', 'line_channel_secret_enc', 'line_access_token_enc',
    'fb_page_id', 'fb_page_token_enc', 'fb_verify_token',
    'ai_budget_usd', 'ai_budget_period', 'pii_masking_enabled',
    // IG DM 欄位
    'ig_business_account_id', 'ig_access_token_enc', 'ig_verify_token',
    // P8 BV SHOP 欄位
    'bv_shop_url', 'bv_api_key_enc', 'bv_last_sync_at',
    'bv_email', 'bv_password_enc', 'bv_type',
    // 下班路由
    'off_hours_enabled', 'off_hours_start', 'off_hours_end', 'off_hours_message'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const sql = `UPDATE clients SET ${updates.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  db.prepare(sql).run(...updates.map(([, v]) => v), Date.now(), id);
};

// ─── updateUser 擴充版（支援 online_status + 2FA + lock）───
export const updateUserFull = (id, fields) => {
  const allowed = ['username', 'password_hash', 'role', 'client_id',
    'online_status', 'last_seen_at', 'status_message',
    'totp_secret', 'totp_enabled', 'backup_codes',
    'failed_attempts', 'locked_until'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const sql = `UPDATE users SET ${updates.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...updates.map(([, v]) => v), id);
};

// ─── 語音轉文字 + SLA Migration ───
safeAlter('ALTER TABLE messages ADD COLUMN transcript TEXT');
safeAlter('ALTER TABLE messages ADD COLUMN transcript_summary TEXT');
safeAlter('ALTER TABLE messages ADD COLUMN audio_duration_ms INTEGER');

safeAlter('ALTER TABLE clients ADD COLUMN sla_first_reply_minutes INTEGER DEFAULT 30');
safeAlter('ALTER TABLE clients ADD COLUMN sla_resolution_hours INTEGER DEFAULT 24');
safeAlter('ALTER TABLE clients ADD COLUMN sla_business_hours TEXT');

safeAlter('ALTER TABLE conversations ADD COLUMN first_inbound_at INTEGER');
safeAlter('ALTER TABLE conversations ADD COLUMN first_outbound_at INTEGER');
safeAlter("ALTER TABLE conversations ADD COLUMN sla_status TEXT DEFAULT 'within'");

// ─── updateConversation 擴充版（支援 pin/archive/reminder）───
export const updateConversationFull = (id, clientId, fields) => {
  const allowed = ['status', 'assigned_user_id', 'intent', 'emotion', 'urgency',
    'last_message_at', 'last_message_preview', 'unread_count',
    'tags', 'summary', 'summary_updated_at', 'csat_score', 'csat_comment', 'csat_sent_at',
    'csat_agent_id',
    'is_pinned', 'reminder_at', 'reminder_note', 'archived_at',
    // SLA 欄位
    'first_inbound_at', 'first_outbound_at', 'sla_status'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  if (clientId) {
    const sql = `UPDATE conversations SET ${updates.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND client_id = ?`;
    db.prepare(sql).run(...updates.map(([, v]) => v), Date.now(), id, clientId);
  } else {
    const sql = `UPDATE conversations SET ${updates.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
    db.prepare(sql).run(...updates.map(([, v]) => v), Date.now(), id);
  }
};
