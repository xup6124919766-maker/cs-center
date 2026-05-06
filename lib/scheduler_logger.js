/**
 * lib/scheduler_logger.js — 排程任務執行 LOG
 *
 * wrapScheduler(name, asyncFn) → 自動計時、錯誤處理、寫入 scheduler_runs
 * cleanOldSchedulerRuns() — 刪除 90 天前
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'scheduler' });

// ─── Schema ───
export const ensureSchedulerSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduler_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT,
      processed_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      details TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sched_runs ON scheduler_runs(scheduler_name, started_at DESC);
  `);
  log.info('scheduler_logger schema ready');
};

// ─── Wrap 排程任務 ───
export const wrapScheduler = async (name, fn) => {
  const startedAt = Date.now();
  let runId = null;

  try {
    runId = db.prepare(`
      INSERT INTO scheduler_runs (scheduler_name, started_at, status)
      VALUES (?, ?, 'running')
    `).run(name, startedAt).lastInsertRowid;
  } catch {}

  try {
    const result = await fn();
    const finishedAt = Date.now();

    // fn 可以回傳 { processed, success, error, details } 讓 wrap 記錄
    const processed = result?.processed ?? result?.processed_count ?? 0;
    const success   = result?.success   ?? result?.success_count   ?? 0;
    const errors    = result?.error     ?? result?.error_count     ?? 0;
    const details   = result?.details   ?? null;

    if (runId) {
      db.prepare(`
        UPDATE scheduler_runs
        SET finished_at = ?, status = 'success', processed_count = ?, success_count = ?, error_count = ?, details = ?
        WHERE id = ?
      `).run(finishedAt, processed, success, errors, details ? JSON.stringify(details) : null, runId);
    }

    const dur = finishedAt - startedAt;
    // 只有處理到東西時才 info；無事打 debug 避免 cron 心跳噪音
    const hadWork = (processed || 0) > 0 || (success || 0) > 0 || (errors || 0) > 0;
    (hadWork ? log.info : log.debug)({ scheduler: name, duration_ms: dur, processed, success, errors }, 'scheduler done');
    return result;
  } catch (e) {
    const finishedAt = Date.now();
    if (runId) {
      db.prepare(`
        UPDATE scheduler_runs
        SET finished_at = ?, status = 'failed', error = ?
        WHERE id = ?
      `).run(finishedAt, e.message?.slice(0, 500) || 'unknown error', runId);
    }
    log.error({ scheduler: name, err: e.message }, 'scheduler failed');
    // 不 rethrow，排程失敗不應該 crash 主程序
  }
};

// ─── 清除 90 天前 ───
export const cleanOldSchedulerRuns = () => {
  try {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const result = db.prepare('DELETE FROM scheduler_runs WHERE started_at < ?').run(cutoff);
    if (result.changes > 0) log.info({ deleted: result.changes }, 'old scheduler_runs cleaned');
  } catch (e) {
    log.error({ err: e.message }, 'cleanOldSchedulerRuns failed');
  }
};

export default { ensureSchedulerSchema, wrapScheduler, cleanOldSchedulerRuns };
