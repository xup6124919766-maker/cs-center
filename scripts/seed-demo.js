/**
 * seed-demo.js — Demo 資料種子
 *
 * 使用方式：
 *   node --experimental-sqlite scripts/seed-demo.js
 *
 * 或在 server 啟動時加 DEV_SEED=1：
 *   DEV_SEED=1 npm start
 *
 * 注意：只在資料庫尚無 demo 顧客時插入，不會重複執行。
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cs.db');

if (!fs.existsSync(dbPath)) {
  console.error(`[seed-demo] DB 不存在：${dbPath}\n請先啟動 server 完成 schema init 後再跑 seed。`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// 取得梵森 client
const vansen = db.prepare('SELECT id FROM clients WHERE name = ?').get('vansen');
if (!vansen) {
  console.error('[seed-demo] 找不到梵森 (vansen) 業主，請先啟動 server。');
  process.exit(1);
}
const CLIENT_ID = vansen.id;

// 防止重複 seed：檢查是否已有 demo 顧客（用 notes 欄位標記）
const existing = db.prepare('SELECT COUNT(*) AS cnt FROM customers WHERE client_id = ? AND notes LIKE ?').get(CLIENT_ID, '%[demo]%');
if (existing.cnt >= 5) {
  console.log('[seed-demo] Demo 資料已存在，跳過。');
  process.exit(0);
}

const now = Date.now();

// ─── 5 個假顧客 ───
const CUSTOMERS = [
  { name: '林曉萱', phone: '0912-345-678', email: 'hsuan@example.com', notes: '敏感肌，對香精過敏 [demo]', tags: '["VIP", "敏感肌"]', channel: 'line', uid: 'Uf001abc001' },
  { name: '王建志', phone: '0923-456-789', email: null,                 notes: '曾退貨一次，態度良好 [demo]',  tags: '["回購客"]',          channel: 'fb',   uid: 'fb_psid_002' },
  { name: '陳美玲', phone: null,            email: 'mei@example.com',   notes: '長期顧客，每季固定下單 [demo]', tags: '["長期客", "VIP"]', channel: 'line', uid: 'Uf003ccc003' },
  { name: '張偉宏', phone: '0934-567-890', email: null,                 notes: '詢問過退換貨政策 [demo]',      tags: '[]',                 channel: 'fb',   uid: 'fb_psid_004' },
  { name: '劉雅婷', phone: '0945-678-901', email: 'ya@example.com',     notes: '朋友介紹，第一次購買 [demo]',  tags: '["新客"]',           channel: 'line', uid: 'Uf005eee005' },
];

const STATUSES = ['open', 'pending', 'closed', 'open', 'open'];

// 對話訊息池（貼近保養/服飾情境）
const CONV_MESSAGES = [
  // 對話 0 - 敏感肌詢問
  [
    { dir: 'inbound',  content: '請問這款精華液適合敏感肌嗎？我的臉容易泛紅' },
    { dir: 'outbound', content: '您好！我們的輕感修護精華液特別為敏感肌設計，不含酒精、人工香精與防腐劑，臨床測試 92% 敏感肌適用。建議先從少量開始，觀察肌膚反應～' },
    { dir: 'inbound',  content: '那有試用裝嗎？想先試試看' },
    { dir: 'outbound', content: '有的！我們官網首購可申請 5ml 試用包，附在訂單備註欄填寫「申請試用」即可，數量有限，先到先得喔！' },
    { dir: 'inbound',  content: '好的謝謝，我等下去下單！' },
  ],
  // 對話 1 - 退貨詢問
  [
    { dir: 'inbound',  content: '我想退貨，上週買的面膜用了覺得悶' },
    { dir: 'outbound', content: '您好，已收到您的訊息，稍後為您處理～' },
    { dir: 'inbound',  content: '是退全額嗎' },
    { dir: 'outbound', content: '退貨流程：① 七日內聯繫客服 ② 寄回原包裝 ③ 確認後退款 3-5 工作天到帳。請問您是幾號下的訂單？我為您確認退貨資格。' },
    { dir: 'inbound',  content: '訂單編號 #20240128' },
    { dir: 'outbound', content: '感謝提供！已查到您的訂單，符合七天無理由退換貨，我們會發退貨標籤到您的 email，請留意收件。' },
    { dir: 'inbound',  content: '好，謝謝' },
  ],
  // 對話 2 - 長期顧客再次詢問
  [
    { dir: 'inbound',  content: '上次買的緊緻面霜快用完了，想再下一單，最近有優惠嗎？' },
    { dir: 'outbound', content: '感謝您的支持！本月會員日（15 號）全館 85 折，或現在下單可用代碼 LOYAL200 折抵 200 元。' },
    { dir: 'inbound',  content: '太好了！等 15 號再買' },
    { dir: 'outbound', content: '好的！記得 15 號零點開放，提前加入購物車比較保險，熱門品項常賣完。有任何問題都歡迎再來訊！' },
  ],
  // 對話 3 - 物流查詢
  [
    { dir: 'inbound',  content: '請問訂單 12345 物流到哪了？已經三天了' },
    { dir: 'outbound', content: '請提供您的訂單編號或下單時的姓名手機，我為您查詢～' },
    { dir: 'inbound',  content: '訂單 #20240125，王建志' },
    { dir: 'outbound', content: '您好，查到您的訂單已於昨天送至「新北物流中心」，預計明天配送。物流追蹤號：12345678，可至黑貓官網查詢即時狀態。' },
    { dir: 'inbound',  content: '好謝謝！' },
  ],
  // 對話 4 - 新客詢問
  [
    { dir: 'inbound',  content: '你好，我朋友推薦你們家的防曬乳，請問 SPF 多少？適合油肌嗎？' },
    { dir: 'outbound', content: '您好，歡迎！我們的每日輕感防曬乳 SPF50+/PA++++，質地清爽不黏膩，油肌、混合肌都非常適合。上臉後 3 分鐘自然吸收，夏天也不悶。' },
    { dir: 'inbound',  content: '聽起來很棒，一瓶多少錢？' },
    { dir: 'outbound', content: '售價 $680，首購使用代碼 NEWBIE88 折抵 88 元，等於 $592 入手！有任何問題再告訴我～' },
  ],
];

// 插入資料
const insertCustomerStmt = db.prepare(`
  INSERT INTO customers (client_id, name, phone, email, notes, tags, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertChannelStmt = db.prepare(`
  INSERT OR IGNORE INTO customer_channels (customer_id, channel, channel_user_id, channel_display_name, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const insertConvStmt = db.prepare(`
  INSERT INTO conversations (client_id, customer_id, channel, status, last_message_at, last_message_preview, unread_count, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertMsgStmt = db.prepare(`
  INSERT INTO messages (conversation_id, direction, sender_type, sender_id, content_type, content, metadata, created_at)
  VALUES (?, ?, ?, ?, 'text', ?, '{}', ?)
`);

let seededConvs = 0;
let seededMsgs = 0;

for (let i = 0; i < CUSTOMERS.length; i++) {
  const c = CUSTOMERS[i];

  // customer
  const baseTime = now - (5 - i) * 86400000; // 每個顧客差 1 天
  const custResult = insertCustomerStmt.run(CLIENT_ID, c.name, c.phone, c.email, c.notes, c.tags, baseTime, baseTime);
  const custId = Number(custResult.lastInsertRowid);

  // customer_channel
  insertChannelStmt.run(custId, c.channel, c.uid, c.name, baseTime);

  // conversation
  const msgs = CONV_MESSAGES[i] || [];
  const lastMsg = msgs[msgs.length - 1];
  const convStatus = STATUSES[i];
  const convResult = insertConvStmt.run(
    CLIENT_ID, custId, c.channel, convStatus,
    baseTime + msgs.length * 60000,
    lastMsg?.content?.slice(0, 100) || '',
    convStatus === 'open' ? 1 : 0,
    baseTime, baseTime
  );
  const convId = Number(convResult.lastInsertRowid);
  seededConvs++;

  // messages
  for (let j = 0; j < msgs.length; j++) {
    const m = msgs[j];
    const msgTime = baseTime + j * 60000 + 30000;
    insertMsgStmt.run(
      convId,
      m.dir,
      m.dir === 'inbound' ? 'customer' : 'agent',
      m.dir === 'inbound' ? String(custId) : '1', // agent user_id=1
      m.content,
      msgTime
    );
    seededMsgs++;
  }
}

console.log(`[seed-demo] 完成：${CUSTOMERS.length} 顧客 / ${seededConvs} 對話 / ${seededMsgs} 訊息`);
process.exit(0);
