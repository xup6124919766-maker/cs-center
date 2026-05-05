/**
 * lib/backup.js — SQLite 熱備份排程（B7）
 *
 * runBackup()  — 立即備份 cs.db → backups/cs-YYYY-MM-DD-HHMMSS.db
 * scheduleBackup() — 每小時檢查，凌晨 3 點自動備份；保留最新 7 個
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './db.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'backup' });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BACKUPS_DIR = path.join(ROOT, 'backups');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'cs.db');
const KEEP_DAYS = 7;

// 確保 backups/ 目錄存在
const ensureBackupsDir = () => {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    log.info({ dir: BACKUPS_DIR }, 'backups directory created');
  }
};

// 格式化時間為 YYYY-MM-DD-HHMMSS（UTC）
const formatTs = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

// 清理超過 KEEP_DAYS 的舊備份（保留最新 KEEP_DAYS 個）
const pruneOldBackups = () => {
  try {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith('cs-') && f.endsWith('.db'))
      .sort()
      .reverse(); // 最新在前

    const toDelete = files.slice(KEEP_DAYS);
    for (const file of toDelete) {
      const fp = path.join(BACKUPS_DIR, file);
      fs.unlinkSync(fp);
      log.info({ file }, 'old backup pruned');
    }
  } catch (e) {
    log.warn({ err: e.message }, 'prune backups failed');
  }
};

// 執行備份
export const runBackup = () => {
  ensureBackupsDir();
  const ts = formatTs();
  const dest = path.join(BACKUPS_DIR, `cs-${ts}.db`);

  try {
    // SQLite VACUUM INTO — hot backup，不鎖定主資料庫
    db.prepare(`VACUUM INTO ?`).run(dest);
    const stat = fs.statSync(dest);
    log.info({ dest, size_kb: Math.round(stat.size / 1024) }, 'backup completed');

    pruneOldBackups();
    return { ok: true, dest, ts };
  } catch (e) {
    log.error({ err: e.message, dest }, 'backup failed');
    return { ok: false, error: e.message };
  }
};

// 排程：每小時檢查一次，UTC 03:xx 執行
export const scheduleBackup = () => {
  setInterval(() => {
    const h = new Date().getUTCHours();
    const m = new Date().getUTCMinutes();
    // 凌晨 3 點的第一分鐘
    if (h === 3 && m === 0) {
      log.info('scheduled backup triggered at UTC 03:00');
      runBackup();
    }
  }, 60 * 60 * 1000).unref(); // 每小時，unref 讓 process 可正常退出
  log.info('backup scheduler started (runs daily at UTC 03:00)');
};
