/**
 * journey.js — 顧客旅程引擎
 *
 * ensureJourneySchema()
 * enrollCustomer(journey_id, customer_id)
 * processJourneyRun(run_id)
 * runScheduledJourneys()  — 每 30 秒 setInterval
 * checkAndEnrollJourneyTrigger(trigger_type, trigger_data)  — 供其他模組呼叫觸發
 */

import { db } from './db.js';
import { logger as rootLogger } from './logger.js';
import { emitToClient } from './realtime.js';

const log = rootLogger.child({ module: 'journey' });

// ─── Schema ───
export const ensureJourneySchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS journeys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      trigger_type TEXT NOT NULL,
      trigger_config TEXT,
      status TEXT DEFAULT 'draft',
      steps_json TEXT NOT NULL DEFAULT '[]',
      total_enrolled INTEGER DEFAULT 0,
      total_completed INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS journey_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journey_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      current_step INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running',
      next_run_at INTEGER,
      context TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (journey_id) REFERENCES journeys(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_journey_runs_next ON journey_runs(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_journey_runs_customer ON journey_runs(customer_id, journey_id);
  `);
  log.info('journey schema ready');
};

// ─── 加入旅程 ───
export const enrollCustomer = (journeyId, customerId) => {
  const journey = db.prepare('SELECT * FROM journeys WHERE id = ?').get(journeyId);
  if (!journey || journey.status !== 'active') return null;

  // 防止重複進入同一旅程
  const existing = db.prepare(
    "SELECT id FROM journey_runs WHERE journey_id = ? AND customer_id = ? AND status = 'running'"
  ).get(journeyId, customerId);
  if (existing) return existing.id;

  const now = Date.now();
  const runId = db.prepare(`
    INSERT INTO journey_runs (journey_id, customer_id, current_step, status, next_run_at, context, started_at)
    VALUES (?, ?, 0, 'running', ?, '{}', ?)
  `).run(journeyId, customerId, now, now).lastInsertRowid;

  db.prepare('UPDATE journeys SET total_enrolled = total_enrolled + 1, updated_at = ? WHERE id = ?').run(now, journeyId);
  log.info({ journey_id: journeyId, customer_id: customerId, run_id: runId }, 'customer enrolled in journey');

  emitToClient(journey.client_id, 'journey:enrolled', { journey_id: journeyId, customer_id: customerId, run_id: runId });
  return runId;
};

// ─── 執行旅程步驟 ───
export const processJourneyRun = async (runId) => {
  const run = db.prepare('SELECT * FROM journey_runs WHERE id = ?').get(runId);
  if (!run || run.status !== 'running') return;

  const journey = db.prepare('SELECT * FROM journeys WHERE id = ?').get(run.journey_id);
  if (!journey) {
    db.prepare("UPDATE journey_runs SET status = 'failed', completed_at = ? WHERE id = ?").run(Date.now(), runId);
    return;
  }

  let steps = [];
  try { steps = JSON.parse(journey.steps_json || '[]'); } catch {}

  if (run.current_step >= steps.length) {
    // 所有步驟完成
    const now = Date.now();
    db.prepare("UPDATE journey_runs SET status = 'completed', completed_at = ? WHERE id = ?").run(now, runId);
    db.prepare('UPDATE journeys SET total_completed = total_completed + 1, updated_at = ? WHERE id = ?').run(now, journey.id);
    log.info({ run_id: runId, journey_id: journey.id }, 'journey run completed');
    emitToClient(journey.client_id, 'journey:completed', { journey_id: journey.id, run_id: runId });
    return;
  }

  const step = steps[run.current_step];
  let ctx = {};
  try { ctx = JSON.parse(run.context || '{}'); } catch {}

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(run.customer_id);
  if (!customer) {
    db.prepare("UPDATE journey_runs SET status = 'exited', completed_at = ? WHERE id = ?").run(Date.now(), runId);
    return;
  }

  const now = Date.now();

  try {
    switch (step.type) {
      case 'wait': {
        const duration = parseInt(step.config?.duration_ms || 0, 10);
        db.prepare('UPDATE journey_runs SET next_run_at = ?, updated_at = ? WHERE id = ?')
          .run(now + duration, now, runId);
        log.info({ run_id: runId, step: run.current_step, next_run_at: now + duration }, 'journey wait step');
        // 不推進 current_step，下次到期再繼續
        return;
      }

      case 'send_message': {
        const content = step.config?.content || '';
        if (content && customer) {
          // 找最近 open conversation 或建新的
          let conv = db.prepare(
            "SELECT id FROM conversations WHERE client_id = ? AND customer_id = ? AND status = 'open' ORDER BY last_message_at DESC LIMIT 1"
          ).get(journey.client_id, run.customer_id);

          if (conv) {
            db.prepare(`
              INSERT INTO messages (conversation_id, direction, sender_type, content_type, content, created_at)
              VALUES (?, 'outbound', 'system', 'text', ?, ?)
            `).run(conv.id, content, now);

            db.prepare('UPDATE conversations SET last_message_at = ?, last_message_preview = ?, updated_at = ? WHERE id = ?')
              .run(now, content.slice(0, 100), now, conv.id);
          }
          // TODO: 等 LINE/FB token 後呼叫 lineSend/fbSend 實際送出
        }
        break;
      }

      case 'add_tag': {
        const tag = step.config?.tag;
        if (tag) {
          let tags = [];
          try { tags = JSON.parse(customer.tags || '[]'); } catch {}
          if (!tags.includes(tag)) {
            tags.push(tag);
            db.prepare('UPDATE customers SET tags = ?, updated_at = ? WHERE id = ?')
              .run(JSON.stringify(tags), now, run.customer_id);
          }
        }
        break;
      }

      case 'remove_tag': {
        const tag = step.config?.tag;
        if (tag) {
          let tags = [];
          try { tags = JSON.parse(customer.tags || '[]'); } catch {}
          tags = tags.filter(t => t !== tag);
          db.prepare('UPDATE customers SET tags = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(tags), now, run.customer_id);
        }
        break;
      }

      case 'condition': {
        const field = step.config?.field;
        const value = step.config?.value;
        let customerTags = [];
        try { customerTags = JSON.parse(customer.tags || '[]'); } catch {}

        let conditionMet = false;
        if (field === 'tag' && value) {
          conditionMet = customerTags.includes(value);
        } else if (field === 'custom_field' && step.config?.key) {
          let cf = {};
          try { cf = JSON.parse(customer.custom_fields || '{}'); } catch {}
          conditionMet = cf[step.config.key] === value;
        }

        if (!conditionMet) {
          // 條件不符：跳到下個步驟（或跳到 else_step 指定的步驟）
          const elseStep = step.config?.else_step_index ?? run.current_step + 1;
          db.prepare('UPDATE journey_runs SET current_step = ?, context = ?, next_run_at = ? WHERE id = ?')
            .run(elseStep, JSON.stringify(ctx), now, runId);
          log.info({ run_id: runId, condition: 'not met', skip_to: elseStep }, 'journey condition step');
          return;
        }
        break;
      }

      case 'add_to_journey': {
        const targetJourneyId = step.config?.journey_id;
        if (targetJourneyId) {
          enrollCustomer(parseInt(targetJourneyId, 10), run.customer_id);
        }
        break;
      }

      default:
        log.warn({ run_id: runId, step_type: step.type }, 'unknown journey step type');
    }

    // 推進到下一步
    const nextStep = run.current_step + 1;
    db.prepare('UPDATE journey_runs SET current_step = ?, context = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(nextStep, JSON.stringify(ctx), now, now, runId);

    // 如果還有步驟，立即繼續（除非是 wait 類型）
    if (nextStep < steps.length && step.type !== 'wait') {
      await processJourneyRun(runId);
    } else if (nextStep >= steps.length) {
      // 最後一步完成
      db.prepare("UPDATE journey_runs SET status = 'completed', completed_at = ? WHERE id = ?").run(now, runId);
      db.prepare('UPDATE journeys SET total_completed = total_completed + 1, updated_at = ? WHERE id = ?').run(now, journey.id);
    }

  } catch (e) {
    log.error({ err: e.message, run_id: runId, step: run.current_step }, 'journey step error');
    db.prepare("UPDATE journey_runs SET status = 'failed', completed_at = ? WHERE id = ?").run(Date.now(), runId);
  }
};

// ─── 排程旅程執行器（每 30 秒）───
export const runScheduledJourneys = async () => {
  const now = Date.now();
  const dueRuns = db.prepare(
    "SELECT id FROM journey_runs WHERE status = 'running' AND next_run_at <= ? LIMIT 50"
  ).all(now);

  for (const run of dueRuns) {
    try {
      await processJourneyRun(run.id);
    } catch (e) {
      log.error({ err: e.message, run_id: run.id }, 'runScheduledJourneys error');
    }
  }
};

// ─── Trigger Hook（供 server.js 呼叫）───
// trigger_type: 'tag_added' | 'customer_created' | 'order_paid' | 'cart_abandoned'
export const checkAndEnrollJourneyTrigger = (triggerType, triggerData = {}) => {
  const { client_id, customer_id, tag } = triggerData;
  if (!client_id || !customer_id) return;

  const activeJourneys = db.prepare(
    "SELECT * FROM journeys WHERE client_id = ? AND status = 'active' AND trigger_type = ?"
  ).all(client_id, triggerType);

  for (const journey of activeJourneys) {
    let triggerConfig = {};
    try { triggerConfig = JSON.parse(journey.trigger_config || '{}'); } catch {}

    // tag_added 觸發條件：指定 tag 符合
    if (triggerType === 'tag_added') {
      if (triggerConfig.tag && triggerConfig.tag !== tag) continue;
    }

    enrollCustomer(journey.id, customer_id);
  }
};

export default {
  ensureJourneySchema,
  enrollCustomer,
  processJourneyRun,
  runScheduledJourneys,
  checkAndEnrollJourneyTrigger,
};
