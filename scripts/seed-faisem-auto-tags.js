#!/usr/bin/env node
/**
 * seed-faisem-auto-tags.js
 *
 * 給梵森補上完整自動標籤規則（按關鍵字觸發）
 *
 * 執行：
 *   CS_URL=https://cs.sandian.work node scripts/seed-faisem-auto-tags.js
 */

import 'dotenv/config';
import http from 'http';
import https from 'https';
import { URL } from 'url';

const CS_URL = process.env.CS_URL || 'https://cs.sandian.work';
const ADMIN = process.env.CS_ADMIN_USER || 'admin';
const PASS  = process.env.CS_ADMIN_PASS || 'cs-vansen-5e7c26cf';

let cookie = '';
let csrf = '';

const apiCall = (method, path, body) => new Promise((resolve, reject) => {
  const url = new URL(path, CS_URL);
  const lib = url.protocol === 'https:' ? https : http;
  const headers = {
    'content-type': 'application/json',
    ...(cookie ? { cookie } : {}),
    ...(csrf ? { 'x-csrf-token': csrf } : {}),
  };
  const req = lib.request({
    hostname: url.hostname, port: url.port || 443,
    path: url.pathname + url.search, method, headers,
  }, (res) => {
    const sc = res.headers['set-cookie'];
    if (sc) {
      const cs = Array.isArray(sc) ? sc : [sc];
      cs.forEach(c => {
        const [n, v] = c.split(';')[0].split('=');
        if (n.trim() === 'cs_sid') cookie = cs.map(x => x.split(';')[0]).join('; ');
        if (n.trim() === 'cs_csrf') csrf = v.trim();
      });
    }
    let raw = '';
    res.on('data', c => raw += c);
    res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
      catch { resolve({ status: res.statusCode, body: raw }); }
    });
  });
  req.on('error', reject);
  if (body) req.write(JSON.stringify(body));
  req.end();
});

// ─── 梵森自動標籤規則（按關鍵字 → 自動貼客戶標籤）───
const RULES = [
  // 詢價類
  { name: '詢價自動標籤', rule_type: 'auto_tag',
    trigger: { keywords: ['多少錢', '售價', '價格', '怎麼賣', '一支多少'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['詢價'] } },
    priority: 5,
  },
  // 退換貨
  { name: '退換貨自動標籤', rule_type: 'auto_tag',
    trigger: { keywords: ['退貨', '換貨', '退費', '不要了', '不想要', '退錢'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['退換貨'] } },
    priority: 8,
  },
  // 物流
  { name: '物流追蹤自動標籤', rule_type: 'auto_tag',
    trigger: { keywords: ['到貨', '物流', '追蹤', '沒收到', '什麼時候到', '出貨了嗎'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['物流'] } },
    priority: 5,
  },
  // 過敏 / 敏感
  { name: '敏感肌警示', rule_type: 'auto_tag',
    trigger: { keywords: ['過敏', '敏感肌', '皮膚癢', '紅腫', '不適', '起疹'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['敏感肌', '需特別關注'] } },
    priority: 9,
  },
  { name: '敏感肌警示 alert', rule_type: 'alert',
    trigger: { keywords: ['過敏', '皮膚癢', '紅腫', '起疹'], match_type: 'any' },
    action: { type: 'alert', payload: { level: 'urgent' } },
    priority: 9,
  },
  // 送禮
  { name: '送禮自動標籤', rule_type: 'auto_tag',
    trigger: { keywords: ['送禮', '禮物', '包裝', '送朋友', '送男友', '送女友', '禮盒'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['送禮族'] } },
    priority: 5,
  },
  // 商品意圖（5 個商品 → 各自貼標）
  { name: 'The Echo 詢問', rule_type: 'auto_tag',
    trigger: { keywords: ['The Echo', '回聲', 'Echo'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['對_The_Echo_有興趣'] } },
    priority: 4,
  },
  { name: 'The Twilight 詢問', rule_type: 'auto_tag',
    trigger: { keywords: ['Twilight', '晨光'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['對_晨光_有興趣'] } },
    priority: 4,
  },
  { name: 'The Original Sin 詢問', rule_type: 'auto_tag',
    trigger: { keywords: ['Original Sin', '原罪'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['對_原罪_有興趣'] } },
    priority: 4,
  },
  { name: '口噴香詢問', rule_type: 'auto_tag',
    trigger: { keywords: ['口噴', '口噴香', '白桃', '青柚'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['對_口噴香_有興趣'] } },
    priority: 4,
  },
  // 緊急 / 急單
  { name: '急單標籤', rule_type: 'auto_tag',
    trigger: { keywords: ['急', '緊急', '今天到', '明天要', '馬上'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['急件'] } },
    priority: 8,
  },
  // 信心 / 自信（梵森核心）
  { name: '自信議題', rule_type: 'auto_tag',
    trigger: { keywords: ['沒自信', '不自信', '自卑', '焦慮', '在意別人', '怕被'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['自信議題', '深度諮詢'] } },
    priority: 6,
  },
  // 約會 / 社交場合
  { name: '約會場合', rule_type: 'auto_tag',
    trigger: { keywords: ['約會', '聯誼', '相親', '初次見面', '男友', '女友'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['約會用'] } },
    priority: 5,
  },
  // 上班 / 通勤
  { name: '上班場合', rule_type: 'auto_tag',
    trigger: { keywords: ['上班', '上課', '通勤', '辦公室', '日常'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['日常用'] } },
    priority: 4,
  },
  // 比價
  { name: '比價標籤', rule_type: 'auto_tag',
    trigger: { keywords: ['Jo Malone', 'Diptyque', 'BYREDO', '其他牌', '比較'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['比價中'] } },
    priority: 6,
  },
  // 推薦 / 不知道選
  { name: '需要推薦', rule_type: 'auto_tag',
    trigger: { keywords: ['推薦', '不知道選', '幫我選', '哪一支', '哪個比較'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['需要推薦'] } },
    priority: 5,
  },
  // 會員 / 集點
  { name: '會員詢問', rule_type: 'auto_tag',
    trigger: { keywords: ['會員', '集點', '點數', '購物金', '優惠碼', '折扣'], match_type: 'any' },
    action: { type: 'auto_tag', payload: { tags: ['會員相關'] } },
    priority: 5,
  },
];

const main = async () => {
  console.log(`\n[seed-faisem-auto-tags] → ${CS_URL}\n`);

  console.log('Step 1: 登入...');
  const login = await apiCall('POST', '/api/login', { username: ADMIN, password: PASS });
  if (login.status !== 200) { console.error('登入失敗:', login.body); process.exit(1); }
  console.log('  登入成功\n');

  // 抓現有規則去重
  console.log('Step 2: 抓現有規則...');
  const existing = await apiCall('GET', '/api/rules?client_id=1');
  const exNames = new Set((existing.body?.rules || []).map(r => r.name));
  console.log(`  現有 ${exNames.size} 條\n`);

  console.log('Step 3: 寫入新規則...');
  let inserted = 0, skipped = 0;
  for (const rule of RULES) {
    if (exNames.has(rule.name)) { skipped++; continue; }
    const r = await apiCall('POST', '/api/rules', { client_id: 1, ...rule });
    if (r.status === 200 || r.status === 201) {
      inserted++;
      console.log(`  ✅ ${rule.name}`);
    } else {
      console.warn(`  ❌ ${rule.name} → ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
    }
  }

  console.log('\n─────────────────────────────────────────');
  console.log(`  ✅ 完成！新增 ${inserted} 條，跳過重複 ${skipped} 條`);
  console.log(`  總自動化規則：${exNames.size + inserted} 條`);
  console.log('─────────────────────────────────────────\n');
};

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
