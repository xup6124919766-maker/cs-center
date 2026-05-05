/**
 * lib/quiz.js — AI 互動式選香 Quiz
 *
 * startQuiz({ client_id, channel_user_id, source, utm_source })
 * submitAnswer(token, questionId, value)
 * getQuizSession(token)
 * getRecommendation(token)          ← 呼叫 Gemini Flash 推薦
 * listQuizSessions({ client_id, status, limit, offset })
 * getQuizStats({ client_id, from, to })
 */

import crypto from 'crypto';
import { db } from './db.js';
import { chat } from './ai.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'quiz' });

// ─── Schema ───
export const ensureQuizSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quiz_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      session_token TEXT UNIQUE NOT NULL,
      channel_user_id TEXT,
      customer_id INTEGER,
      answers TEXT NOT NULL DEFAULT '{}',
      recommended_product TEXT,
      recommended_reason TEXT,
      checkout_url TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress',
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      source TEXT,
      utm_source TEXT,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );
    CREATE INDEX IF NOT EXISTS idx_quiz_status ON quiz_sessions(client_id, status);
    CREATE INDEX IF NOT EXISTS idx_quiz_token  ON quiz_sessions(session_token);
    CREATE INDEX IF NOT EXISTS idx_quiz_utm    ON quiz_sessions(client_id, utm_source);
  `);
};

ensureQuizSchema();

// ─── 7 題 Quiz（梵森客製）───
export const QUIZ_QUESTIONS = [
  {
    id: 'mood',
    question: '妳希望別人聞到妳時的第一感覺是？',
    options: [
      { value: 'safe',       label: '安心、可靠',       emoji: '🌿' },
      { value: 'attractive', label: '想多靠近一點',     emoji: '✨' },
      { value: 'confident',  label: '有存在感',         emoji: '💎' },
      { value: 'fresh',      label: '清新自然',         emoji: '🍃' },
    ],
  },
  {
    id: 'occasion',
    question: '妳最常使用香氛的場合是？',
    options: [
      { value: 'work',    label: '上班、上課', emoji: '💼' },
      { value: 'date',    label: '約會、社交', emoji: '🌙' },
      { value: 'daily',   label: '日常隨身',   emoji: '☀️' },
      { value: 'special', label: '特別場合',   emoji: '🌸' },
    ],
  },
  {
    id: 'personality',
    question: '妳覺得自己的個性比較像？',
    options: [
      { value: 'low_key',  label: '低調、不張揚',     emoji: '🌱' },
      { value: 'warm',     label: '溫柔、有深度',     emoji: '🍂' },
      { value: 'magnetic', label: '有魅力但不刻意',   emoji: '🌹' },
      { value: 'bright',   label: '明亮、活潑',       emoji: '☀️' },
    ],
  },
  {
    id: 'concern',
    question: '妳最想透過香氛解決什麼？',
    options: [
      { value: 'memorable',  label: '想被記住',           emoji: '💝' },
      { value: 'confidence', label: '提升自信',           emoji: '👑' },
      { value: 'closeness',  label: '近距離有安全感',     emoji: '🤍' },
      { value: 'unique',     label: '想跟別人不一樣',     emoji: '✨' },
    ],
  },
  {
    id: 'time',
    question: '一天中最希望香氣表現好的時段？',
    options: [
      { value: 'morning',  label: '早晨、白天', emoji: '🌅' },
      { value: 'evening',  label: '傍晚、夜晚', emoji: '🌙' },
      { value: 'all_day',  label: '一整天都要', emoji: '☀️' },
      { value: 'specific', label: '特定時刻',   emoji: '⏰' },
    ],
  },
  {
    id: 'budget',
    question: '預算範圍？',
    options: [
      { value: 'try',  label: '想先試試看', emoji: '🎁' },
      { value: 'one',  label: '入手一支',   emoji: '💎' },
      { value: 'set',  label: '想要組合',   emoji: '🎀' },
      { value: 'gift', label: '送禮用',     emoji: '🌺' },
    ],
  },
  {
    id: 'experience',
    question: '妳之前用香氛的經驗？',
    options: [
      { value: 'beginner', label: '第一次嘗試', emoji: '🌱' },
      { value: 'casual',   label: '偶爾用',     emoji: '🌷' },
      { value: 'fan',      label: '香氛愛好者', emoji: '👑' },
      { value: 'switch',   label: '想換品牌',   emoji: '🔄' },
    ],
  },
];

// ─── 取得業主商品（從 brand_dna.products 或 product_catalog）───
const getClientProducts = (clientId) => {
  const client = db.prepare('SELECT brand_dna, product_catalog FROM clients WHERE id = ?').get(clientId);
  if (!client) return [];

  // 優先用 product_catalog（checkout 模組設定的）
  if (client.product_catalog) {
    try {
      const catalog = JSON.parse(client.product_catalog);
      if (Array.isArray(catalog) && catalog.length > 0) return catalog;
    } catch {}
  }

  // fallback：從 brand_dna 拿
  try {
    const dna = JSON.parse(client.brand_dna || '{}');
    if (Array.isArray(dna.products)) return dna.products;
  } catch {}

  // 梵森預設商品
  return [
    { sku: 'the_twilight',        name: '晨光 The Twilight',         description: '清新安心型，讓人安心的存在', occasion: 'work,daily',  personality: 'low_key,warm' },
    { sku: 'the_echo',            name: '回聲 The Echo',             description: '溫暖木質，讓人想靠近',       occasion: 'date,special', personality: 'warm,magnetic' },
    { sku: 'the_original_sin',    name: '原罪 The Original Sin',     description: '吸引力型，自然被注意',       occasion: 'date',         personality: 'magnetic' },
    { sku: 'spray_peach_oolong',  name: '口噴 白桃烏龍',             description: '隨身自信，近距離安心感',     occasion: 'daily',        personality: 'low_key,bright' },
    { sku: 'spray_pomelo',        name: '口噴 青柚',                 description: '清新明亮，隨時保持清新感',   occasion: 'daily',        personality: 'bright' },
  ];
};

// ─── 開始 Quiz ───
export const startQuiz = ({ client_id, channel_user_id = null, source = 'web', utm_source = null }) => {
  const token = crypto.randomBytes(16).toString('hex');
  const now = Date.now();

  db.prepare(`
    INSERT INTO quiz_sessions (client_id, session_token, channel_user_id, answers, status, started_at, source, utm_source)
    VALUES (?, ?, ?, '{}', 'in_progress', ?, ?, ?)
  `).run(client_id, token, channel_user_id, now, source, utm_source);

  log.info({ client_id, token, source, utm_source }, 'quiz started');
  return { session_token: token, questions: QUIZ_QUESTIONS };
};

// ─── 提交單題答案 ───
export const submitAnswer = (token, questionId, value) => {
  const session = db.prepare('SELECT * FROM quiz_sessions WHERE session_token = ?').get(token);
  if (!session) return { ok: false, error: 'session 不存在' };
  if (session.status !== 'in_progress') return { ok: false, error: 'quiz 已完成或廢棄' };

  // 驗證題目 ID
  const question = QUIZ_QUESTIONS.find(q => q.id === questionId);
  if (!question) return { ok: false, error: `題目 ${questionId} 不存在` };

  let answers = {};
  try { answers = JSON.parse(session.answers || '{}'); } catch {}
  answers[questionId] = value;

  db.prepare('UPDATE quiz_sessions SET answers = ? WHERE session_token = ?')
    .run(JSON.stringify(answers), token);

  const answeredCount = Object.keys(answers).length;
  const totalCount = QUIZ_QUESTIONS.length;
  log.debug({ token, questionId, answeredCount, totalCount }, 'quiz answer saved');

  return { ok: true, answered: answeredCount, total: totalCount, completed: answeredCount >= totalCount };
};

// ─── 取得 session 狀態 ───
export const getQuizSession = (token) => {
  const session = db.prepare('SELECT * FROM quiz_sessions WHERE session_token = ?').get(token);
  if (!session) return null;

  let answers = {};
  try { answers = JSON.parse(session.answers || '{}'); } catch {}

  return {
    ...session,
    answers,
    answered_count: Object.keys(answers).length,
    total_count: QUIZ_QUESTIONS.length,
  };
};

// ─── AI 推薦（Gemini Flash）───
export const getRecommendation = async (token) => {
  const session = db.prepare('SELECT * FROM quiz_sessions WHERE session_token = ?').get(token);
  if (!session) return { ok: false, error: 'session 不存在' };

  let answers = {};
  try { answers = JSON.parse(session.answers || '{}'); } catch {}

  const answeredCount = Object.keys(answers).length;
  if (answeredCount < 3) return { ok: false, error: `至少需要回答 3 題才能推薦（目前 ${answeredCount} 題）` };

  const products = getClientProducts(session.client_id);

  // 組問題答案的可讀說明
  const answerSummary = QUIZ_QUESTIONS
    .filter(q => answers[q.id])
    .map(q => {
      const opt = q.options.find(o => o.value === answers[q.id]);
      return `- ${q.question}：${opt ? opt.label : answers[q.id]}`;
    })
    .join('\n');

  const productList = products.map((p, i) =>
    `${i + 1}. ${p.name}（SKU: ${p.sku}）：${p.description || ''}`
  ).join('\n');

  const system = `你是梵森香氛品牌的選品 AI 顧問。梵森的品牌精神：讓沒有自信的女生，也能慢慢喜歡上自己。主要商品：香水與口噴香。你的任務是根據顧客的 quiz 答案，推薦最適合她的 1-2 款商品，並用溫柔、真誠的語氣說明原因。不要過度推銷，要讓她感覺被理解。`;

  const userPrompt = `顧客的 quiz 答案如下：
${answerSummary}

梵森現有商品：
${productList}

請回傳 JSON 格式：
{
  "products": [
    {
      "sku": "商品 SKU",
      "name": "商品名稱",
      "reason": "為什麼推薦她這款（溫柔口吻，2-3 句）"
    }
  ],
  "opening": "給顧客的開場白（1 句，溫柔引導）",
  "closing": "結尾句（引導她下單，不強迫，1 句）"
}

最多推薦 2 款。`;

  const result = await chat({
    messages: [{ role: 'user', content: userPrompt }],
    system,
    model: 'gemini-2.5-flash',
    max_tokens: 1024,
    json_schema: true,
    client_id: session.client_id,
    feature: 'quiz',
  });

  if (!result.ok) {
    log.error({ token, err: result.error }, 'quiz AI recommendation failed');
    return { ok: false, error: result.error };
  }

  let rec = result.json;
  if (!rec || !Array.isArray(rec.products)) {
    // 嘗試 fallback 解析
    log.warn({ token, text: result.text?.slice(0, 200) }, 'quiz AI JSON parse failed, using fallback');
    rec = {
      products: [{ sku: products[0]?.sku, name: products[0]?.name, reason: '這款非常適合妳目前的狀態。' }],
      opening: '根據妳的回答，我幫妳找到了很適合的香氛。',
      closing: '如果妳有興趣，可以點下方連結了解更多。',
    };
  }

  // 查商品的結帳 URL
  const client = db.prepare('SELECT cart_url_template FROM clients WHERE id = ?').get(session.client_id);
  const template = client?.cart_url_template || 'https://www.faisem.tw/products/{sku}';

  const recommendedProducts = rec.products.map(p => {
    const productInfo = products.find(prod => prod.sku === p.sku) || {};
    const checkoutUrl = template.replace('{sku}', encodeURIComponent(p.sku))
                                .replace('{items}', encodeURIComponent(`${p.sku}:1`));
    return {
      sku: p.sku,
      name: p.name || productInfo.name,
      reason: p.reason,
      checkout_url: checkoutUrl,
      image_url: productInfo.image_url || null,
      price: productInfo.price || null,
    };
  });

  const recommendedJson = JSON.stringify(recommendedProducts);
  const primaryProduct = recommendedProducts[0]?.name || '';
  const reasonText = `${rec.opening || ''}\n${recommendedProducts.map(p => `【${p.name}】${p.reason}`).join('\n')}\n${rec.closing || ''}`.trim();

  db.prepare(`
    UPDATE quiz_sessions
    SET recommended_product = ?, recommended_reason = ?, status = 'completed', completed_at = ?
    WHERE session_token = ?
  `).run(primaryProduct, reasonText, Date.now(), token);

  log.info({ token, products: recommendedProducts.map(p => p.sku) }, 'quiz recommendation done');

  return {
    ok: true,
    opening: rec.opening,
    closing: rec.closing,
    products: recommendedProducts,
    recommendation_text: reasonText,
  };
};

// ─── 列出 sessions（後台）───
export const listQuizSessions = ({ client_id, status = null, limit = 50, offset = 0 }) => {
  let sql = 'SELECT * FROM quiz_sessions WHERE client_id = ?';
  const params = [client_id];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
};

// ─── 統計（後台）───
export const getQuizStats = ({ client_id, from = 0, to = null }) => {
  const toTs = to || Date.now();

  const total = db.prepare(
    'SELECT COUNT(*) AS cnt FROM quiz_sessions WHERE client_id = ? AND started_at >= ? AND started_at <= ?'
  ).get(client_id, from, toTs);

  const completed = db.prepare(
    "SELECT COUNT(*) AS cnt FROM quiz_sessions WHERE client_id = ? AND status = 'completed' AND started_at >= ? AND started_at <= ?"
  ).get(client_id, from, toTs);

  // 推薦商品分布
  const productDist = db.prepare(`
    SELECT recommended_product AS product, COUNT(*) AS count
    FROM quiz_sessions
    WHERE client_id = ? AND status = 'completed' AND started_at >= ? AND started_at <= ?
    GROUP BY recommended_product
    ORDER BY count DESC
  `).all(client_id, from, toTs);

  // UTM 來源分布
  const utmDist = db.prepare(`
    SELECT COALESCE(utm_source, 'direct') AS utm, COUNT(*) AS count
    FROM quiz_sessions
    WHERE client_id = ? AND started_at >= ? AND started_at <= ?
    GROUP BY utm_source
    ORDER BY count DESC
    LIMIT 20
  `).all(client_id, from, toTs);

  const completionRate = total.cnt > 0 ? Math.round((completed.cnt / total.cnt) * 100) : 0;

  return {
    total: total.cnt,
    completed: completed.cnt,
    completion_rate: completionRate,
    product_distribution: productDist,
    utm_distribution: utmDist,
  };
};
