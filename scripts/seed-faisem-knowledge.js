/**
 * seed-faisem-knowledge.js
 *
 * 將梵森 Faisem 品牌知識寫進客服中心知識庫。
 * 使用方式：
 *   CS_URL=https://cs.sandian.work node scripts/seed-faisem-knowledge.js
 *
 * 設計原則（idempotent）：
 *   - PUT /api/clients/1 → 更新 brand_dna（每次都覆蓋，安全）
 *   - POST /api/qa-pairs/import → 伺服器端以 question 去重（不重複寫入）
 *
 * 環境變數：
 *   CS_URL        客服中心網址（預設 https://cs.sandian.work）
 *   ADMIN_USER    管理員帳號（預設 admin）
 *   ADMIN_PASS    管理員密碼（預設 cs-vansen-5e7c26cf）
 *   CLIENT_ID     業主 ID（預設 1）
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

// ─── 設定 ─────────────────────────────────────────────
const CS_URL     = process.env.CS_URL    || 'https://cs.sandian.work';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'cs-vansen-5e7c26cf';
const CLIENT_ID  = parseInt(process.env.CLIENT_ID || '1', 10);

// ─── 品牌 DNA ─────────────────────────────────────────
const brandDna = {
  tone: '親切有質感，帶療癒感。對女性顧客使用「妳」，對所有顧客使用「您」稱謂。語氣溫暖不冷冰，專業不失親切。',
  signature: 'Faisem 梵森客服',
  greeting: '您好！感謝您聯繫梵森 Faisem。',
  farewell: '如有任何問題，歡迎隨時再來訊，Faisem 梵森客服敬上 ✨',
  brand_name: '梵森 Faisem',
  slogan: '提升自信，成為更好的你',
  brand_story: '梵森相信香氣能改變一個人的氣場與第一印象。品牌以希臘女神為靈感，調製出屬於不同個性女性的香氣，讓每一位使用者找到屬於自己的香氛密碼，成為讓世界記住的那個她。',
  contact_email: 'faisem.tw@gmail.com',
  line_oa: '@faisem',
  social_instagram: 'https://www.instagram.com/faisem.tw/',
  social_facebook: 'https://www.facebook.com/Faisem.tw/',
  social_threads: 'https://www.threads.com/@faisem.tw',
  business_hours: '待確認（請補充）',
  shipping_info: '滿 NT$2,000 免運（待確認）；物流方式、出貨天數待確認。',
  return_policy: '依台灣消費者保護法，商品收到後 7 天鑑賞期。香卡鋁袋一經拆封視為使用，退貨需保持商品完整。退貨請先聯繫客服確認資格後再寄回。',
  payment_methods: '待確認（信用卡、銀行轉帳等）',
  product_lines: ['靈性香水吊卡（香卡）', '口噴香', '香氛組合商品'],
  forbidden_words: [
    '療效', '根治', '完全治癒', '治療', '醫療用途',
    '最強', '第一名', '絕對有效', '100% 保證',
  ],
  required_phrases: [],
  key_vocabulary: [
    '氣場', '氣味密碼', '香氛記憶',
    '提升自信', '成為更好的妳',
    '命定的香遇', '讓世界記住妳的味道',
    '靈性', '女神',
  ],
};

// ─── FAQ 知識庫 ───────────────────────────────────────
const faqs = [

  // ── 品牌基本資訊 ──
  {
    question: '梵森是什麼品牌？',
    answer: '梵森（Faisem）是台灣本土香氛品牌，由凱展國際有限公司經營。品牌相信香氣能改變一個人的氣場與第一印象，以希臘女神為靈感調製出不同個性的香氣，幫助每位女性找到屬於自己的香氛密碼，提升自信，成為更好的自己。',
    category: '品牌資訊',
  },
  {
    question: '梵森的官網是什麼？',
    answer: '梵森官方網站：https://www.faisem.tw',
    category: '品牌資訊',
  },
  {
    question: '梵森的 Instagram 是什麼？',
    answer: '梵森 Instagram：@faisem.tw，連結：https://www.instagram.com/faisem.tw/',
    category: '品牌資訊',
  },
  {
    question: '梵森有 Facebook 嗎？',
    answer: '有的！梵森 Facebook 粉絲頁：https://www.facebook.com/Faisem.tw/\n梵森靈性香卡官方社團：https://www.facebook.com/groups/faisem/',
    category: '品牌資訊',
  },
  {
    question: '梵森有 Threads 嗎？',
    answer: '有！梵森 Threads 帳號：@faisem.tw，歡迎追蹤，我們會分享香氣生活感、自信心法等內容。',
    category: '品牌資訊',
  },
  {
    question: '梵森客服 email 是什麼？',
    answer: '梵森客服信箱：faisem.tw@gmail.com\n也歡迎透過 LINE 官方帳號 @faisem 聯繫我們，通常回覆更快速。',
    category: '客服資訊',
  },
  {
    question: '梵森有實體店面嗎？',
    answer: '目前梵森以線上販售為主，如有實體展售資訊會透過官方帳號公告。請以官網 faisem.tw 為主要購買管道。（實際情況請以品牌最新公告為準）',
    category: '品牌資訊',
  },

  // ── 商品介紹 ──
  {
    question: '梵森有哪些商品？',
    answer: '梵森目前主要有以下商品系列：\n\n【香卡系列（靈性香水吊卡）】\n• The Echo 回聲 — 水生花香調，溫柔安心感\n• The Twilight 晨光 — 木質花香調，乾淨清新氣場\n• The Original Sin 原罪之慾 — 木質調，性感魅惑\n\n【口噴香系列】\n• 口噴香 白桃烏龍\n• 口噴香 青柚\n\n【組合商品】\n• 香水試香組合包\n• 女神香氛組（晨光+白桃烏龍）\n• 約會必勝組（原罪之慾+青柚）\n• 口噴香組合優惠方案\n\n詳細商品與最新定價請至官網查看：https://www.faisem.tw/category',
    category: '商品介紹',
  },
  {
    question: '香卡是什麼？',
    answer: '香卡是梵森的核心商品，是一種固態香氛吊卡。可掛在隨身包包、車內後照鏡、衣櫃、書包等地方，讓香氣隨時陪伴妳、為妳打造獨特的氣場氛圍。\n\n使用說明：\n• 香卡為消耗型產品\n• 未使用前請勿拆開鋁袋包裝，以免影響持香效果\n• 拆封後放置於通風位置即可持續散香',
    category: '商品介紹',
  },
  {
    question: '口噴香是什麼？',
    answer: '口噴香是梵森推出的口腔噴霧香氛，讓您隨時保持清新口氣，增添自信。目前有白桃烏龍和青柚兩種香調可選擇，也有組合優惠方案。',
    category: '商品介紹',
  },
  {
    question: 'The Echo 回聲是什麼香調？',
    answer: '回聲（The Echo）以希臘神話中的回音女神 Echo 為靈感設計。香調屬水生花香調，帶有花香、琥珀的溫柔安心感，適合含蓄、情感豐富、等待愛的妳。\n\n（詳細香調成分以官網商品頁為準）',
    category: '商品介紹',
  },
  {
    question: 'The Twilight 晨光是什麼香調？',
    answer: '晨光（The Twilight）主打乾淨的氣場，香調屬溫暖木質調，結合木質調與花香，散發希望與自愛的氛圍，適合想展現清新、溫柔氣場的妳。\n\n（詳細香調成分以官網商品頁為準）',
    category: '商品介紹',
  },
  {
    question: 'The Original Sin 原罪之慾是什麼香調？',
    answer: '原罪之慾（The Original Sin）是梵森最性感魅惑的一款，屬中性木質調，結合檀香、皮革的幽靜與性感，讓世界看到妳獨特的魅力，適合自信、想展現女人味的場合。\n\n（詳細香調成分以官網商品頁為準）',
    category: '商品介紹',
  },
  {
    question: '哪款香水適合上班？',
    answer: '日常上班推薦晨光（The Twilight）系列，木質花香調清新不張揚，打造專業乾淨的氣場。如果辦公室允許稍微甜美的香氣，回聲（The Echo）的水生花香調也很適合。\n\n原罪之慾系列較為濃郁性感，更推薦在重要社交場合、約會或夜間使用。',
    category: '商品介紹',
  },
  {
    question: '哪款香水適合約會？',
    answer: '約會首選推薦「約會必勝組」—— 原罪之慾（The Original Sin）搭配口噴香青柚，讓妳全身散發性感魅惑的氣場，讓他無法忘記妳！\n\n如果偏好清新甜美路線，晨光（The Twilight）搭配白桃烏龍口噴香的「女神香氛組」也是絕佳選擇。',
    category: '商品介紹',
  },
  {
    question: '不確定選哪款，有試香服務嗎？',
    answer: '有的！梵森提供「香水試香組合包」，可以一次體驗多款香調，找到最適合妳的香氛密碼。建議先購買試香組合，確認喜歡的香調後再購入完整版本。',
    category: '商品介紹',
  },

  // ── 價格與優惠 ──
  {
    question: '梵森的商品價格是多少？',
    answer: '商品價格請至官網查看最新定價：https://www.faisem.tw/category\n\n如有任何優惠活動，也會在官網及社群帳號公告。',
    category: '商品介紹',
  },
  {
    question: '有沒有優惠活動？',
    answer: '梵森不定期舉辦優惠活動，建議追蹤我們的社群帳號以掌握最新資訊：\n• Instagram：@faisem.tw\n• Facebook：fb.com/Faisem.tw\n• Threads：@faisem.tw\n\n也可直接詢問客服是否有當期優惠。',
    category: '行銷活動',
  },

  // ── 訂單與配送 ──
  {
    question: '運費多少？有免運嗎？',
    answer: '梵森提供免運門檻優惠，詳細運費規定請至官網查看，或直接詢問客服為您確認最新資訊。',
    category: '配送資訊',
  },
  {
    question: '下單後多久出貨？',
    answer: '一般訂單確認付款後於工作天內安排出貨，詳細出貨時間請以官網公告或客服確認為主。如有特殊假日可能順延，屆時會提前公告。',
    category: '配送資訊',
  },
  {
    question: '配送方式有哪些？',
    answer: '梵森目前主要透過宅配方式配送，詳細物流廠商及配送選項請以官網資訊為準，或聯繫客服確認。',
    category: '配送資訊',
  },
  {
    question: '可以超商取貨嗎？',
    answer: '關於超商取貨服務，請直接聯繫客服確認目前是否提供此配送選項。（待官方確認後補充）',
    category: '配送資訊',
  },
  {
    question: '可以國際配送嗎？',
    answer: '關於國際配送，請直接聯繫客服詢問是否提供海外配送服務及相關費用。（待官方確認後補充）',
    category: '配送資訊',
  },

  // ── 退換貨 ──
  {
    question: '如何退貨？退貨流程是什麼？',
    answer: '梵森依台灣消費者保護法提供七天鑑賞期服務。退貨流程如下：\n\n1. 收到商品後 7 天內，聯繫客服（LINE @faisem 或 faisem.tw@gmail.com）\n2. 說明退貨原因與訂單編號\n3. 客服確認退貨資格\n4. 將商品以原包裝完整寄回指定地址\n5. 收到商品確認後，退款 3-7 個工作天到帳\n\n注意：香卡鋁袋一經拆封視為已使用，如有品質問題請拍照告知客服。',
    category: '退換貨',
  },
  {
    question: '可以換貨嗎？',
    answer: '如商品有品質瑕疵或出貨錯誤，梵森提供換貨服務。請先拍下商品狀況，聯繫客服說明情況，客服將為您安排換貨處理。若為消費者個人因素（選錯款式、不喜歡等），請在七天鑑賞期內申請退貨。',
    category: '退換貨',
  },
  {
    question: '七天鑑賞期是怎麼計算的？',
    answer: '七天鑑賞期從消費者收到商品當天開始計算（含當天），共 7 個日曆天。例如：週一收到商品，最遲需在當週週日聯繫客服申請退貨。建議盡早提出，以免錯過時限。',
    category: '退換貨',
  },
  {
    question: '退貨運費由誰負擔？',
    answer: '退貨運費規定請以官網服務條款為準。如為商品品質問題或出貨錯誤，運費由梵森負擔；如為消費者個人因素（不喜歡、選錯款等），退貨運費原則上由消費者自行承擔。詳情請聯繫客服確認。',
    category: '退換貨',
  },

  // ── 付款 ──
  {
    question: '可以用什麼方式付款？',
    answer: '梵森支援多種付款方式，詳細選項請至官網結帳頁面查看，或聯繫客服確認目前支援的付款方式。',
    category: '付款方式',
  },

  // ── 商品保存 ──
  {
    question: '香卡要怎麼保存？',
    answer: '未使用的香卡請保存在鋁袋密封狀態，存放於陰涼乾燥處，避免高溫、潮濕和直射陽光，以維持最佳香氣品質。',
    category: '商品使用',
  },
  {
    question: '香卡拆封後要怎麼使用？',
    answer: '拆封後將香卡掛置於包包、車內、衣櫃等通風位置即可。香卡為消耗型商品，香氣會隨時間逐漸散發，請適時更換新的香卡。',
    category: '商品使用',
  },
  {
    question: '口噴香如何使用？',
    answer: '口噴香直接對準口腔噴 1-2 下即可，清新口氣立即感受到。建議用餐後或需要口氣清新時使用，隨身攜帶方便。',
    category: '商品使用',
  },

  // ── 香氛知識 ──
  {
    question: '香水/香卡適合敏感肌嗎？',
    answer: '梵森香卡為外用香氛吊卡，不直接接觸肌膚，一般情況下不會引起皮膚過敏。如對特定香料成分有顧慮，建議先確認商品成分說明，或聯繫客服詢問更詳細的成分資訊。',
    category: '商品介紹',
  },
  {
    question: '香氛對心情有什麼幫助？',
    answer: '梵森相信「香氣不能治療，但可以陪伴」。嗅覺直接連結大腦的情緒中樞（杏仁核）和記憶中心（海馬迴），特定香氣能喚起正向情緒、帶來安慰感、幫助放鬆或提振精神。梵森的每款香卡都有其情感主題，陪伴妳在不同生活場景中找到自信與從容。',
    category: '品牌資訊',
  },
];

// ─── HTTP 工具函式 ─────────────────────────────────────

let sessionCookie = '';
let csrfToken     = '';

function request(method, pathname, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const base = new URL(CS_URL);
    const isHttps = base.protocol === 'https:';
    const lib = isHttps ? https : http;
    const port = base.port || (isHttps ? 443 : 80);

    const headers = {
      'Content-Type': 'application/json',
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      ...(csrfToken     ? { 'x-csrf-token': csrfToken } : {}),
      ...extraHeaders,
    };

    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const options = {
      hostname: base.hostname,
      port,
      path: pathname,
      method,
      headers,
    };

    const req = lib.request(options, (res) => {
      // 擷取 Set-Cookie
      const setCookieHdr = res.headers['set-cookie'];
      if (setCookieHdr) {
        const cookies = Array.isArray(setCookieHdr) ? setCookieHdr : [setCookieHdr];
        // 解析並更新 session_id 和 csrf_token
        for (const c of cookies) {
          const [nameVal] = c.split(';');
          const [name, val] = nameVal.split('=');
          if (name.trim() === 'cs_sid') {
            sessionCookie = cookies.map(ck => ck.split(';')[0]).join('; ');
          }
          if (name.trim() === 'cs_csrf') {
            csrfToken = val.trim();
          }
        }
      }

      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── 主流程 ───────────────────────────────────────────

async function main() {
  console.log(`\n[seed-faisem] 開始執行 → ${CS_URL}\n`);

  // Step 1：登入
  console.log('Step 1: 登入...');
  const loginRes = await request('POST', '/api/login', {
    username: ADMIN_USER,
    password: ADMIN_PASS,
  });

  if (loginRes.status !== 200 || !loginRes.body.ok) {
    console.error('[ERROR] 登入失敗：', loginRes.body);
    process.exit(1);
  }
  console.log(`  登入成功，role=${loginRes.body.role}`);

  // Step 2：更新 brand_dna
  console.log(`\nStep 2: 更新 clients(id=${CLIENT_ID}) brand_dna...`);
  const putRes = await request('PUT', `/api/clients/${CLIENT_ID}`, {
    brand_dna: brandDna,
  });

  if (putRes.status !== 200) {
    console.error('[ERROR] 更新 brand_dna 失敗：', putRes.body);
    process.exit(1);
  }
  console.log('  brand_dna 更新成功。');

  // Step 3：批次寫入 FAQ（使用 /api/qa-pairs/import）
  console.log(`\nStep 3: 寫入 ${faqs.length} 筆 FAQ...`);

  // 先查詢現有的 qa_pairs，用 question 去重
  const existingRes = await request('GET', `/api/qa-pairs?client_id=${CLIENT_ID}&limit=200`);
  const existingSet = new Set(
    (existingRes.body.qa_pairs || []).map(q => q.question.trim())
  );
  console.log(`  現有 QA: ${existingSet.size} 筆`);

  // 過濾出還沒有的 FAQ
  const newFaqs = faqs.filter(f => !existingSet.has(f.question.trim()));
  console.log(`  待新增: ${newFaqs.length} 筆，跳過重複: ${faqs.length - newFaqs.length} 筆`);

  if (newFaqs.length > 0) {
    const importRes = await request('POST', '/api/qa-pairs/import', {
      client_id: CLIENT_ID,
      items: newFaqs,
    });

    if (importRes.status !== 200) {
      console.error('[ERROR] QA import 失敗：', importRes.body);
      process.exit(1);
    }

    console.log(`  成功寫入: ${importRes.body.inserted} 筆`);
    if (importRes.body.errors && importRes.body.errors.length > 0) {
      console.warn('  部分錯誤：', importRes.body.errors);
    }
  }

  // 最終確認
  const finalRes = await request('GET', `/api/qa-pairs?client_id=${CLIENT_ID}&limit=200`);
  const totalQa = finalRes.body.qa_pairs?.length || 0;

  console.log(`
─────────────────────────────────────────
  [seed-faisem] 完成！
  ✓ brand_dna 欄位：${Object.keys(brandDna).length} 個
  ✓ 知識庫 QA 總筆數：${totalQa} 筆
  ✓ 本次新增：${newFaqs.length} 筆
─────────────────────────────────────────
`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
