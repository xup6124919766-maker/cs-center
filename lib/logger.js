/**
 * logger.js — 輕量結構化 Logger（零依賴）
 *
 * 等級：DEBUG(0) / INFO(1) / WARN(2) / ERROR(3)
 * 開發模式：彩色 console + 檔案 append
 * 生產模式：純 JSON 一行 + 檔案 append
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');

// 確保 logs/ 存在
fs.mkdirSync(LOGS_DIR, { recursive: true });

const IS_PROD = process.env.NODE_ENV === 'production';

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
// 生產預設 INFO（避免 debug 噪音）；開發預設 DEBUG。LOG_LEVEL env 可覆寫
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? (IS_PROD ? LEVELS.INFO : LEVELS.DEBUG);

// ANSI 顏色（開發模式）
const COLORS = {
  DEBUG: '\x1b[36m', // cyan
  INFO:  '\x1b[32m', // green
  WARN:  '\x1b[33m', // yellow
  ERROR: '\x1b[31m', // red
  RESET: '\x1b[0m',
};

// ─── 當日 log 檔路徑 ───
let _currentDate = '';
let _logStream = null;

const getLogStream = () => {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (today !== _currentDate) {
    if (_logStream) { try { _logStream.end(); } catch {} }
    _currentDate = today;
    const filePath = path.join(LOGS_DIR, `app-${today}.log`);
    _logStream = fs.createWriteStream(filePath, { flags: 'a' });
  }
  return _logStream;
};

// ─── 核心輸出 ───
const write = (level, module, message, context) => {
  if (LEVELS[level] < MIN_LEVEL) return;

  const ts = new Date().toISOString();
  const entry = { ts, level, module, message };
  if (context && typeof context === 'object') {
    Object.assign(entry, context);
  }

  // 檔案永遠 JSON 一行
  try {
    getLogStream().write(JSON.stringify(entry) + '\n');
  } catch { /* 檔案寫入失敗不 crash */ }

  // console 輸出
  if (IS_PROD) {
    const method = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
    console[method](JSON.stringify(entry));
  } else {
    const c = COLORS[level] || '';
    const r = COLORS.RESET;
    const mod = module ? `[${module}] ` : '';
    const ctx = context ? ` ${JSON.stringify(context)}` : '';
    const method = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
    console[method](`[${ts}] ${c}[${level}]${r} ${mod}${message}${ctx}`);
  }
};

// ─── Logger 工廠 ───
const makeLogger = (defaultModule = '') => ({
  debug: (ctx_or_msg, msg) => {
    if (typeof ctx_or_msg === 'string') write('DEBUG', defaultModule, ctx_or_msg, undefined);
    else write('DEBUG', defaultModule, msg, ctx_or_msg);
  },
  info: (ctx_or_msg, msg) => {
    if (typeof ctx_or_msg === 'string') write('INFO', defaultModule, ctx_or_msg, undefined);
    else write('INFO', defaultModule, msg, ctx_or_msg);
  },
  warn: (ctx_or_msg, msg) => {
    if (typeof ctx_or_msg === 'string') write('WARN', defaultModule, ctx_or_msg, undefined);
    else write('WARN', defaultModule, msg, ctx_or_msg);
  },
  error: (ctx_or_msg, msg) => {
    if (typeof ctx_or_msg === 'string') write('ERROR', defaultModule, ctx_or_msg, undefined);
    else write('ERROR', defaultModule, msg, ctx_or_msg);
  },
  child: ({ module }) => makeLogger(module || defaultModule),
});

export const logger = makeLogger('app');
export default logger;
