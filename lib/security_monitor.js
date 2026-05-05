/**
 * lib/security_monitor.js — 異常登入偵測 + 安全事件記錄
 *
 * recordLoginAttempt(username, ip, success, user_agent, country_code?)
 * ensureSecuritySchema()
 * cleanOldSecurityEvents()
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';
import { emitToAdmin } from './realtime.js';
import { dispatchEvent } from './webhooks_out.js';

const log = rootLogger.child({ module: 'security_monitor' });

// ─── Schema ───
export const ensureSecuritySchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      user_id INTEGER,
      username TEXT,
      ip TEXT,
      user_agent TEXT,
      details TEXT,
      severity TEXT NOT NULL,
      resolved INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_secevents_severity ON security_events(severity, resolved, created_at);
    CREATE INDEX IF NOT EXISTS idx_secevents_type ON security_events(event_type, created_at);
  `);
  log.info('security schema ready');
};

// ─── 寫入安全事件 ───
const insertSecurityEvent = ({ event_type, user_id = null, username = null, ip = null, user_agent = null, details = {}, severity }) => {
  try {
    const id = db.prepare(`
      INSERT INTO security_events (event_type, user_id, username, ip, user_agent, details, severity, resolved, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(event_type, user_id, username, ip, user_agent, JSON.stringify(details), severity, Date.now()).lastInsertRowid;

    // info 等級用 debug，避免正常登入事件塞滿 warn log
    if (severity === 'critical') {
      log.error({ event_type, severity, username, ip }, '安全事件：critical');
    } else if (severity === 'warn') {
      log.warn({ event_type, severity, username, ip }, '安全事件：warn');
    } else {
      log.debug({ event_type, severity, username, ip }, '安全事件：info（debug only）');
    }

    // critical → emit + webhook
    if (severity === 'critical') {
      const payload = { id, event_type, username, ip, details, severity, created_at: Date.now() };
      emitToAdmin('security:alert', payload);
      // 找業主 client_id（若 username 存在）
      try {
        const user = username ? db.prepare('SELECT client_id FROM users WHERE username = ?').get(username) : null;
        if (user?.client_id) {
          Promise.resolve().then(() => dispatchEvent(user.client_id, 'security:alert', payload)).catch(() => {});
        }
      } catch {}
    }

    return id;
  } catch (e) {
    log.error({ err: e.message }, 'insertSecurityEvent failed');
    return null;
  }
};

// ─── 登入嘗試記錄 + 偵測 ───
export const recordLoginAttempt = (username, ip, success, user_agent = null, country_code = null) => {
  const now = Date.now();
  const oneHour = now - 60 * 60 * 1000;
  const fiveMin = now - 5 * 60 * 1000;

  try {
    // 查使用者
    const userRow = username
      ? db.prepare('SELECT id, failed_attempts, locked_until FROM users WHERE username = ?').get(username)
      : null;

    // 1. 帳號被鎖偵測
    if (!success && userRow?.locked_until && userRow.locked_until > now) {
      insertSecurityEvent({
        event_type: 'locked_out',
        user_id: userRow?.id,
        username,
        ip,
        user_agent,
        details: { locked_until: userRow.locked_until, country_code },
        severity: 'warn',
      });
    }

    // 2. 同 username 1 小時內 ≥ 3 個不同 IP（只看 login_fail；login_success 不入表）
    if (username) {
      try {
        const recentIps = db.prepare(`
          SELECT details FROM security_events
          WHERE username = ? AND event_type = 'login_fail' AND created_at >= ?
          LIMIT 50
        `).all(username, oneHour);

        const ipSet = new Set();
        if (ip) ipSet.add(ip);
        for (const r of recentIps) {
          try {
            const d = JSON.parse(r.details || '{}');
            if (d.ip) ipSet.add(d.ip);
          } catch {}
        }

        if (ipSet.size >= 3) {
          // 只在第一次偵測到時發警告（避免重複）
          const existing = db.prepare(`
            SELECT id FROM security_events
            WHERE username = ? AND event_type = 'multi_ip_login' AND created_at >= ?
          `).get(username, oneHour);

          if (!existing) {
            insertSecurityEvent({
              event_type: 'multi_ip_login',
              user_id: userRow?.id,
              username,
              ip,
              user_agent,
              details: { distinct_ips: [...ipSet], country_code },
              severity: 'warn',
            });
          }
        }
      } catch {}
    }

    // 3. 任何 IP 5 分鐘內 ≥ 20 次登入失敗
    if (!success && ip) {
      try {
        const failCount = db.prepare(`
          SELECT COUNT(*) AS cnt FROM security_events
          WHERE ip = ? AND event_type = 'login_fail' AND created_at >= ?
        `).get(ip, fiveMin)?.cnt || 0;

        if (failCount >= 19) { // 第 20 次時觸發
          const existing = db.prepare(`
            SELECT id FROM security_events
            WHERE ip = ? AND event_type = 'high_fail_rate' AND created_at >= ?
          `).get(ip, fiveMin);

          if (!existing) {
            insertSecurityEvent({
              event_type: 'high_fail_rate',
              user_id: null,
              username,
              ip,
              user_agent,
              details: { fail_count: failCount + 1, window_minutes: 5, country_code },
              severity: 'critical',
            });
          }
        }
      } catch {}
    }

    // 4. 可疑國家（Cloudflare CF-IPCountry — 從外部傳進來）
    // 歷史國家改從 suspicious_pattern 自身記錄往回查（login_success 不入表）
    if (success && country_code && username) {
      try {
        const knownPatterns = db.prepare(`
          SELECT details FROM security_events
          WHERE username = ? AND event_type = 'suspicious_pattern' AND created_at >= ?
          ORDER BY created_at DESC LIMIT 20
        `).all(username, now - 90 * 24 * 60 * 60 * 1000);

        const countrySet = new Set();
        // 也從 login_fail 記錄的 details 抓歷史國家（失敗登入也帶 country_code）
        const failRecords = db.prepare(`
          SELECT details FROM security_events
          WHERE username = ? AND event_type = 'login_fail' AND created_at >= ?
          LIMIT 50
        `).all(username, now - 90 * 24 * 60 * 60 * 1000);
        for (const r of [...knownPatterns, ...failRecords]) {
          try {
            const d = JSON.parse(r.details || '{}');
            if (d.country_code) countrySet.add(d.country_code);
            // suspicious_pattern 記的 known_countries 陣列
            if (Array.isArray(d.known_countries)) d.known_countries.forEach(c => countrySet.add(c));
          } catch {}
        }

        if (countrySet.size > 0 && !countrySet.has(country_code)) {
          insertSecurityEvent({
            event_type: 'suspicious_pattern',
            user_id: userRow?.id,
            username,
            ip,
            user_agent,
            details: { country_code, known_countries: [...countrySet] },
            severity: 'warn',
          });
        }
      } catch {}
    }

    // 登入失敗才寫進 security_events（login_success 不寫，那是 audit_log 的工作）
    // 連續失敗偵測：5 分鐘內同 username 失敗 >= 5 次 → 升級 critical
    if (!success) {
      // 計算此 username 近 5 分鐘失敗次數（不含本次）
      let failSeverity = 'info';
      if (username) {
        try {
          const recentFails = db.prepare(`
            SELECT COUNT(*) AS cnt FROM security_events
            WHERE username = ? AND event_type = 'login_fail' AND created_at >= ?
          `).get(username, fiveMin)?.cnt ?? 0;
          // 加上本次，共 recentFails + 1 次
          if (recentFails + 1 >= 5) failSeverity = 'critical';
        } catch {}
      }

      insertSecurityEvent({
        event_type: 'login_fail',
        user_id: userRow?.id,
        username,
        ip,
        user_agent,
        details: { ip, country_code },
        severity: failSeverity,
      });
    }

  } catch (e) {
    log.error({ err: e.message }, 'recordLoginAttempt error');
  }
};

// ─── 清除舊事件（365 天保留）───
export const cleanOldSecurityEvents = () => {
  try {
    const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const result = db.prepare('DELETE FROM security_events WHERE created_at < ?').run(cutoff);
    if (result.changes > 0) log.info({ deleted: result.changes }, 'old security_events cleaned');
  } catch (e) {
    log.error({ err: e.message }, 'cleanOldSecurityEvents failed');
  }
};

export default { ensureSecuritySchema, recordLoginAttempt, cleanOldSecurityEvents };
