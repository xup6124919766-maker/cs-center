#!/usr/bin/env node
/**
 * backfill-line-profiles.js — 對所有 LINE 通道顧客重新抓 profile
 *
 * 用途：早期 webhook stub 時期建立的 customer 沒有大頭貼跟正式 displayName。
 * 跑這個 script 對所有 LINE customer_channels 呼叫 getUserProfile，更新
 * channel_display_name + channel_avatar_url + customers.name。
 *
 * 執行：node --experimental-sqlite scripts/backfill-line-profiles.js
 */

import 'dotenv/config';
import { db } from '../lib/db.js';
import { decrypt } from '../lib/crypto.js';
import { getUserProfile } from '../lib/line.js';

const main = async () => {
  const clients = db.prepare('SELECT * FROM clients WHERE line_access_token_enc IS NOT NULL').all();
  if (!clients.length) {
    console.error('沒有設定 LINE token 的業主，跳過');
    return;
  }

  for (const client of clients) {
    const accessToken = decrypt(client.line_access_token_enc);
    console.log(`\n=== Backfilling client ${client.id} (${client.display_name}) ===`);

    const channels = db.prepare(`
      SELECT cc.*, c.name AS customer_name
      FROM customer_channels cc
      JOIN customers c ON c.id = cc.customer_id
      WHERE cc.channel = 'line' AND c.client_id = ?
    `).all(client.id);

    console.log(`  共 ${channels.length} 個 LINE customer 要處理`);

    for (const ch of channels) {
      try {
        const profile = await getUserProfile(accessToken, ch.channel_user_id);
        const displayName = profile.displayName || ch.channel_display_name || ch.customer_name;
        const pictureUrl = profile.pictureUrl || null;

        // 更新 customer_channels
        db.prepare(`
          UPDATE customer_channels SET channel_display_name = ?, channel_avatar_url = ?
          WHERE id = ?
        `).run(displayName, pictureUrl, ch.id);

        // 同步更新 customers.name（如果之前是預設值）
        if (ch.customer_name === 'LINE 顧客' || ch.customer_name === '未知顧客') {
          db.prepare('UPDATE customers SET name = ?, updated_at = ? WHERE id = ?')
            .run(displayName, Date.now(), ch.customer_id);
        }

        console.log(`  ✅ ${ch.channel_user_id.slice(0, 8)}... → ${displayName} ${pictureUrl ? '+ avatar' : '(no avatar)'}`);

        // 防 rate limit（LINE API 有限制）
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.warn(`  ❌ ${ch.channel_user_id.slice(0, 8)}... 失敗: ${e.message}`);
      }
    }
  }

  console.log('\n完成。');
  process.exit(0);
};

main().catch(e => {
  console.error('Backfill 失敗:', e);
  process.exit(1);
});
