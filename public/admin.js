// admin.js — 業主設定後台

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ─── CSRF helper ───
const getCsrfToken = () => {
  const match = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('cs_csrf='));
  return match ? match.slice(8) : '';
};

// ─── API ───
const api = async (method, path, body) => {
  const opts = { method, headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('未登入'); }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return r.json();
};

// ─── Toast ───
let toastTimer;
const toast = (msg, type = '') => {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
};

// ─── 複製 ───
const copyText = (text, btn) => {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = '已複製!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
    toast('已複製到剪貼簿', 'success');
  }).catch(() => toast('複製失敗，請手動複製', 'error'));
};

// ─── Tag Input ───
const makeTagInput = (containerId, initialTags = []) => {
  const wrap = document.getElementById(containerId);
  if (!wrap) return { getTags: () => [] };
  const tags = [...initialTags];

  const render = () => {
    // 清掉舊 chip
    wrap.querySelectorAll('.tag-chip').forEach(c => c.remove());
    const inp = wrap.querySelector('input');
    tags.forEach((t, i) => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip';
      chip.innerHTML = `<span>${esc(t)}</span><button type="button" data-idx="${i}">x</button>`;
      chip.querySelector('button').onclick = () => {
        tags.splice(i, 1);
        render();
      };
      wrap.insertBefore(chip, inp);
    });
  };

  const inp = wrap.querySelector('input');
  if (inp) {
    inp.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ',') && inp.value.trim()) {
        e.preventDefault();
        const val = inp.value.trim().replace(/,/g, '');
        if (val && !tags.includes(val)) { tags.push(val); render(); }
        inp.value = '';
      }
      if (e.key === 'Backspace' && !inp.value && tags.length) {
        tags.pop();
        render();
      }
    });
    wrap.addEventListener('click', () => inp.focus());
  }
  render();
  return { getTags: () => [...tags] };
};

// ─── Escape HTML ───
const esc = (s) => {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

// ─── 取得主機 ───
const getHost = () => location.origin;

// ─── Token 狀態顯示 ───
const tokenStatusHtml = (isSet, label) => {
  const cls = isSet ? 'set' : 'unset';
  const dot = isSet ? 'green' : 'red';
  const txt = isSet ? '已設定' : '未設定';
  return `<div class="token-status ${cls}"><span class="dot ${dot}"></span>${label}：${txt}</div>`;
};

// ─── 渲染業主卡片 ───
let tagInputInstances = {};

const renderClientCard = (client) => {
  const host = getHost();
  const lineUrl = `${host}/webhook/line/${client.id}`;
  const fbUrl   = `${host}/webhook/fb/${client.id}`;
  const igUrl   = `${host}/webhook/ig/${client.id}`;

  // 解析 brand_dna
  const dna = (typeof client.brand_dna === 'object' ? client.brand_dna : {}) || {};

  // Token 整體狀態燈號（含 IG）
  const hasAll = client.has_line_token && client.has_line_secret && client.has_fb_token && client.has_ig_token;
  const hasAny = client.has_line_token || client.has_line_secret || client.has_fb_token || client.has_ig_token;
  const pillCls = hasAll ? 'green' : hasAny ? 'yellow' : 'red';
  const pillTxt = hasAll ? '全部已設定' : hasAny ? '部分已設定' : '未設定';

  const cardId = `card-${client.id}`;
  const bodyId = `body-${client.id}`;

  const div = document.createElement('div');
  div.className = 'client-card';
  div.id = cardId;

  // forbidden_words / required_phrases / product_lines 轉 array
  const parseArr = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return v ? [v] : []; }
    }
    return [];
  };
  const forbiddenTags = parseArr(dna.forbidden_words);
  const requiredTags  = parseArr(dna.required_phrases);
  const productTags   = parseArr(dna.product_lines);

  // tone_examples JSON
  const toneExamplesStr = JSON.stringify(Array.isArray(dna.tone_examples) ? dna.tone_examples : [], null, 2);

  div.innerHTML = `
    <div class="client-card-header" onclick="toggleCard('${bodyId}', this)">
      <div class="client-card-title">${esc(client.display_name)} <small style="color:var(--muted);font-weight:400;">(${esc(client.name)})</small></div>
      <div class="client-card-meta">
        <span class="token-pill ${pillCls}">${pillTxt}</span>
        <span class="collapse-icon" id="icon-${bodyId}">▼</span>
      </div>
    </div>
    <div class="client-card-body" id="${bodyId}">

      <!-- LINE 設定 -->
      <div class="section-label">LINE 設定</div>
      <div class="form-row">
        <div class="form-group">
          <label>Channel ID（明文）</label>
          <input type="text" id="${client.id}-line-channel-id" placeholder="1234567890" value="${esc(client.line_channel_id || '')}" />
        </div>
        <div class="form-group">
          <label>Channel Secret（送出後加密存儲）</label>
          <input type="password" id="${client.id}-line-channel-secret" placeholder="留空 = 不更新" autocomplete="new-password" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Access Token（送出後加密存儲）</label>
          <input type="password" id="${client.id}-line-access-token" placeholder="留空 = 不更新" autocomplete="new-password" />
        </div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
        ${tokenStatusHtml(client.has_line_token, 'LINE Token')}
        ${tokenStatusHtml(client.has_line_secret, 'LINE Secret')}
      </div>

      <!-- Webhook URL - LINE -->
      <div class="webhook-block">
        <div class="webhook-label">LINE Webhook URL（貼到 LINE Developers 後台）</div>
        <div class="webhook-url-row">
          <span class="webhook-url" id="line-url-${client.id}">${esc(lineUrl)}</span>
          <button class="copy-btn" onclick="copyText('${lineUrl}', this)">複製</button>
        </div>
      </div>

      <!-- FB 設定 -->
      <div class="section-label">Facebook 設定</div>
      <div class="form-row">
        <div class="form-group">
          <label>Page ID</label>
          <input type="text" id="${client.id}-fb-page-id" placeholder="123456789012345" value="${esc(client.fb_page_id || '')}" />
        </div>
        <div class="form-group">
          <label>Verify Token（Webhook 驗證用，自訂字串）</label>
          <input type="text" id="${client.id}-fb-verify-token" placeholder="my-secret-verify-token" value="${esc(client.fb_verify_token || '')}" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Page Access Token（送出後加密存儲）</label>
          <input type="password" id="${client.id}-fb-page-token" placeholder="留空 = 不更新" autocomplete="new-password" />
        </div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
        ${tokenStatusHtml(client.has_fb_token, 'FB Page Token')}
        ${tokenStatusHtml(client.has_fb_verify_token, 'FB Verify Token')}
      </div>

      <!-- Webhook URL - FB -->
      <div class="webhook-block">
        <div class="webhook-label">FB Webhook URL（GET + POST，Callback URL 填此）</div>
        <div class="webhook-url-row">
          <span class="webhook-url" id="fb-url-${client.id}">${esc(fbUrl)}</span>
          <button class="copy-btn" onclick="copyText('${fbUrl}', this)">複製</button>
        </div>
        <div style="font-size:11px; color:var(--muted); margin-top:6px;">Verify Token 欄位填入你在上方設定的自訂字串</div>
      </div>

      <!-- Instagram DM 設定 -->
      <div class="section-label">Instagram DM 設定</div>
      <div class="form-row">
        <div class="form-group">
          <label>IG Business Account ID（17 位數字）</label>
          <input type="text" id="${client.id}-ig-business-id" placeholder="17xxxxxxxxxxxxxxxxx" value="${esc(client.ig_business_account_id || '')}" />
        </div>
        <div class="form-group">
          <label>Verify Token（Webhook 驗證用，自訂字串）</label>
          <input type="text" id="${client.id}-ig-verify-token" placeholder="my-ig-verify-token" value="${esc(client.ig_verify_token || '')}" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>IG Access Token（送出後加密存儲）</label>
          <input type="password" id="${client.id}-ig-access-token" placeholder="留空 = 不更新" autocomplete="new-password" />
        </div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
        ${tokenStatusHtml(client.has_ig_token, 'IG Access Token')}
      </div>

      <!-- Webhook URL - IG -->
      <div class="webhook-block">
        <div class="webhook-label">IG Webhook URL（複製貼到 Meta for Developers → Webhooks）</div>
        <div class="webhook-url-row">
          <span class="webhook-url" id="ig-url-${client.id}">${esc(igUrl)}</span>
          <button class="copy-btn" onclick="copyText('${igUrl}', this)">複製</button>
        </div>
        <div style="font-size:11px; color:var(--muted); margin-top:6px;">
          必要權限：instagram_basic、instagram_manage_messages、pages_messaging<br/>
          IG Business Account 必須先連結到 FB Page 才能收發 DM
        </div>
      </div>
      <div class="card-actions" style="margin-top:0; margin-bottom:8px;">
        <button class="btn btn-secondary" style="font-size:12px;" onclick="saveIgTokens(${client.id})">儲存 IG 設定</button>
        <span id="ig-save-status-${client.id}" style="font-size:12px; color:var(--muted);"></span>
      </div>

      <!-- 測試連線 -->
      <div class="card-actions" style="margin-top:12px; margin-bottom:4px;">
        <button class="btn btn-secondary" onclick="testConnection(${client.id})" ${!hasAny ? 'disabled title="請先設定 token"' : ''}>測試連線</button>
        <span id="test-result-${client.id}" style="font-size:12px; color:var(--muted);"></span>
      </div>

      <!-- 品牌 DNA -->
      <div class="section-label">品牌 DNA</div>
      <div class="form-row">
        <div class="form-group" style="min-width:100%;">
          <label>品牌語調（tone）</label>
          <textarea id="${client.id}-dna-tone" placeholder="例：親切、專業、帶有溫度，適度加入 emoji">${esc(dna.tone || '')}</textarea>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>署名（signature）</label>
          <input type="text" id="${client.id}-dna-signature" placeholder="例：梵森客服小組" value="${esc(dna.signature || '')}" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group" style="min-width:100%;">
          <label>禁止用詞（Enter 新增標籤）</label>
          <div class="tag-input-wrap" id="wrap-forbidden-${client.id}">
            <input type="text" placeholder="輸入後按 Enter" />
          </div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group" style="min-width:100%;">
          <label>必用語句（Enter 新增標籤）</label>
          <div class="tag-input-wrap" id="wrap-required-${client.id}">
            <input type="text" placeholder="輸入後按 Enter" />
          </div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group" style="min-width:100%;">
          <label>產品線（Enter 新增標籤）</label>
          <div class="tag-input-wrap" id="wrap-product-${client.id}">
            <input type="text" placeholder="例：精華液、防曬乳" />
          </div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group" style="min-width:100%;">
          <label>語調範例（JSON 陣列，格式：[{"scenario":"...","example":"..."}]）</label>
          <textarea id="${client.id}-dna-tone-examples" style="min-height:100px; font-family:monospace; font-size:12px;">${esc(toneExamplesStr)}</textarea>
        </div>
      </div>

      <!-- P8：BV SHOP 整合 -->
      <div class="section-label">BV SHOP 整合</div>
      <div class="form-row">
        <div class="form-group">
          <label>BV API Host（預設 https://bvshop-manage.bvshop.tw 可空）</label>
          <input type="text" id="${client.id}-bv-shop-url" placeholder="https://bvshop-manage.bvshop.tw" value="${esc(client.bv_shop_url || '')}" />
        </div>
        <div class="form-group">
          <label>BV API Token（格式 id|hash，加密存儲）</label>
          <input type="password" id="${client.id}-bv-api-key" placeholder="留空 = 不更新" autocomplete="new-password" />
        </div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; align-items:center;">
        ${client.has_bv_api_key ? '<span style="padding:2px 8px;border-radius:10px;background:#d1f7e0;color:#1b7c3e;font-size:11px;">BV Key 已設定</span>' : '<span style="padding:2px 8px;border-radius:10px;background:#f5f5f5;color:#888;font-size:11px;">BV Key 未設定</span>'}
        ${client.bv_last_sync_at ? `<span style="font-size:11px;color:var(--muted);">上次同步：${new Date(client.bv_last_sync_at).toLocaleString('zh-TW')}</span>` : '<span style="font-size:11px;color:var(--muted);">尚未同步</span>'}
        ${client.bv_order_count ? `<span style="font-size:11px;color:var(--muted);">共 ${client.bv_order_count} 筆訂單</span>` : ''}
      </div>
      <div class="card-actions" style="margin-top:0;margin-bottom:8px;">
        <button class="btn btn-secondary" style="font-size:12px;" onclick="bvTestToken(${client.id})">測試 Token</button>
        <button class="btn btn-secondary" style="font-size:12px;" onclick="saveBvShop(${client.id})">儲存 BV 設定</button>
        <button class="btn btn-secondary" style="font-size:12px;" onclick="bvSyncNow(${client.id})" ${!client.has_bv_api_key ? 'disabled title="請先設定 BV API Key"' : ''}>立即同步</button>
        <span id="bv-status-${client.id}" style="font-size:12px;color:var(--muted);"></span>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.6;">
        💡 <b>Webhook URL（給 BV 後台設定）</b>：<code style="background:#f5f5f5;padding:2px 4px;border-radius:3px;">${location.origin}/api/webhooks/bvshop/${client.id}</code><br>
        BV 訂單建立/付款/出貨時自動 push，免 token，立刻有資料。
      </div>

      <!-- AI 預算（A4）-->
      <div class="section-label">AI 預算</div>
      <div id="ai-budget-${client.id}">
        <div style="color:var(--muted);font-size:13px;">載入中…</div>
      </div>
      <div class="form-row" style="margin-top:12px;">
        <div class="form-group">
          <label>月度預算（USD，0 = 無上限）</label>
          <input type="number" id="${client.id}-budget-usd" placeholder="0" min="0" step="1" />
        </div>
        <div class="form-group">
          <label>預算週期</label>
          <select id="${client.id}-budget-cycle" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;font-size:13px;font-family:inherit;background:var(--bg);outline:none;">
            <option value="monthly">每月</option>
            <option value="weekly">每週</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>
            <input type="checkbox" id="${client.id}-pii-masking" style="margin-right:6px;" />
            PII 遮蔽（傳給 AI 前自動遮蔽電話/Email/姓名）
          </label>
        </div>
      </div>
      <div class="card-actions" style="margin-top:0;margin-bottom:8px;">
        <button class="btn btn-secondary" style="font-size:12px;" onclick="saveBudget(${client.id})">儲存 AI 預算</button>
        <span id="budget-status-${client.id}" style="font-size:12px;color:var(--muted);"></span>
      </div>

      <!-- 結帳連結設定 -->
      <div class="section-label" style="margin-top:20px;">結帳連結設定</div>
      <div class="form-row">
        <div class="form-group">
          <label>Cart URL 模板（{sku} 或 {items} 占位符）</label>
          <input type="text" id="${client.id}-cart-url-template"
            placeholder="https://www.faisem.tw/products/{sku}"
            value="${esc(client.cart_url_template || '')}"
            style="font-family:monospace;font-size:12px;" />
          <div style="font-size:11px;color:var(--muted);margin-top:4px;">
            單商品用 {sku}，多商品購物車用 {items}（格式：sku1:qty1,sku2:qty2）
          </div>
        </div>
      </div>
      <div class="card-actions" style="margin-top:0;margin-bottom:8px;">
        <button class="btn btn-secondary" style="font-size:12px;" onclick="saveCartTemplate(${client.id})">儲存 URL 模板</button>
        <span id="cart-status-${client.id}" style="font-size:12px;color:var(--muted);"></span>
      </div>

      <div class="section-label" style="margin-top:12px;">商品目錄</div>
      <div id="product-catalog-list-${client.id}" style="margin-bottom:8px;font-size:13px;color:var(--muted);">載入中…</div>
      <div class="form-row">
        <div class="form-group">
          <label>新增商品</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <input type="text" id="${client.id}-new-sku" placeholder="SKU" style="width:120px;" />
            <input type="text" id="${client.id}-new-name" placeholder="商品名稱" style="flex:1;min-width:140px;" />
            <input type="number" id="${client.id}-new-price" placeholder="價格" style="width:90px;" />
            <button class="btn btn-secondary" style="font-size:12px;" onclick="addProduct(${client.id})">+ 新增</button>
          </div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>匯入 CSV（格式：sku,名稱,價格,圖片URL,說明）</label>
          <textarea id="${client.id}-catalog-csv" rows="3" placeholder="the_twilight,晨光 The Twilight,1280,,清新安心型" style="font-family:monospace;font-size:12px;resize:vertical;"></textarea>
        </div>
      </div>
      <div class="card-actions" style="margin-top:0;margin-bottom:8px;">
        <button class="btn btn-secondary" style="font-size:12px;" onclick="importCatalogCsv(${client.id})">匯入 CSV</button>
        <a href="/admin/quiz.html" target="_blank" class="btn btn-secondary" style="font-size:12px;text-decoration:none;">Quiz 統計</a>
        <span id="catalog-status-${client.id}" style="font-size:12px;color:var(--muted);"></span>
      </div>

      <!-- 儲存按鈕 -->
      <div class="section-label" style="margin-top:16px;">其他操作</div>
      <div class="card-actions">
        <button class="btn btn-primary" onclick="saveClient(${client.id})">儲存設定</button>
        <span id="save-status-${client.id}" style="font-size:12px; color:var(--muted);"></span>
      </div>
    </div>
  `;

  // 建立 tag input instances（等 DOM append 後才能找到元素）
  setTimeout(() => {
    tagInputInstances[`forbidden-${client.id}`] = makeTagInput(`wrap-forbidden-${client.id}`, forbiddenTags);
    tagInputInstances[`required-${client.id}`]  = makeTagInput(`wrap-required-${client.id}`,  requiredTags);
    tagInputInstances[`product-${client.id}`]   = makeTagInput(`wrap-product-${client.id}`,   productTags);
    // A4: 載入 AI 預算資料
    loadBudget(client.id);
    // 結帳：載入商品目錄
    loadProductCatalog(client.id);
  }, 0);

  return div;
};

// ─── 結帳：儲存 Cart URL Template ───
window.saveCartTemplate = async (clientId) => {
  const statusEl = document.getElementById(`cart-status-${clientId}`);
  const template = document.getElementById(`${clientId}-cart-url-template`)?.value?.trim();
  if (!template) { if (statusEl) statusEl.textContent = '請輸入模板'; return; }
  if (!template.includes('{sku}') && !template.includes('{items}')) {
    if (statusEl) statusEl.textContent = '需包含 {sku} 或 {items}';
    toast('模板需包含 {sku} 或 {items}', 'error');
    return;
  }
  if (statusEl) statusEl.textContent = '儲存中…';
  try {
    await api('PUT', '/api/checkout/template', { client_id: clientId, template });
    if (statusEl) statusEl.textContent = '已儲存';
    toast('Cart URL 模板已儲存', 'success');
  } catch (e) {
    if (statusEl) statusEl.textContent = `錯誤：${e.message}`;
    toast(`儲存失敗：${e.message}`, 'error');
  }
};

// ─── 結帳：載入商品目錄 ───
const loadProductCatalog = async (clientId) => {
  const el = document.getElementById(`product-catalog-list-${clientId}`);
  if (!el) return;
  try {
    const data = await api('GET', `/api/products?client_id=${clientId}`);
    const products = data.products || [];
    if (!products.length) { el.innerHTML = '<span style="color:var(--muted)">尚無商品</span>'; return; }
    el.innerHTML = `
      <table style="width:100%;font-size:12px;border-collapse:collapse;">
        <thead><tr style="color:var(--muted)"><th style="text-align:left;padding:4px 8px;">SKU</th><th style="text-align:left;">名稱</th><th style="text-align:right;">價格</th></tr></thead>
        <tbody>
          ${products.map(p => `
            <tr style="border-top:1px solid var(--border);">
              <td style="padding:4px 8px;font-family:monospace;">${esc(p.sku)}</td>
              <td style="padding:4px 8px;">${esc(p.name)}</td>
              <td style="padding:4px 8px;text-align:right;">${p.price ? 'NT$ ' + Number(p.price).toLocaleString() : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    if (el) el.textContent = '載入失敗：' + e.message;
  }
};

// ─── 結帳：新增單一商品 ───
window.addProduct = async (clientId) => {
  const sku = document.getElementById(`${clientId}-new-sku`)?.value?.trim();
  const name = document.getElementById(`${clientId}-new-name`)?.value?.trim();
  const priceVal = document.getElementById(`${clientId}-new-price`)?.value?.trim();
  const statusEl = document.getElementById(`catalog-status-${clientId}`);

  if (!sku || !name) { toast('SKU 和名稱為必填', 'error'); return; }

  // 先拿現有商品
  try {
    const data = await api('GET', `/api/products?client_id=${clientId}`);
    const products = data.products || [];
    const existing = products.findIndex(p => p.sku === sku);
    const newProduct = { sku, name, price: priceVal ? parseFloat(priceVal) : null, image_url: null, description: null };
    if (existing >= 0) products[existing] = newProduct;
    else products.push(newProduct);
    await api('PUT', '/api/checkout/catalog', { client_id: clientId, products });
    toast(`商品 ${name} 已新增/更新`, 'success');
    if (statusEl) statusEl.textContent = '已更新';
    // 清空欄位
    ['new-sku','new-name','new-price'].forEach(id => {
      const el = document.getElementById(`${clientId}-${id}`);
      if (el) el.value = '';
    });
    loadProductCatalog(clientId);
  } catch (e) {
    toast(`新增失敗：${e.message}`, 'error');
  }
};

// ─── 結帳：匯入 CSV ───
window.importCatalogCsv = async (clientId) => {
  const csv = document.getElementById(`${clientId}-catalog-csv`)?.value?.trim();
  const statusEl = document.getElementById(`catalog-status-${clientId}`);
  if (!csv) { toast('請貼入 CSV 內容', 'error'); return; }
  if (statusEl) statusEl.textContent = '匯入中…';
  try {
    const result = await api('POST', '/api/checkout/catalog/import-csv', { client_id: clientId, csv });
    toast(`匯入完成，共 ${result.imported} 筆`, 'success');
    if (statusEl) statusEl.textContent = `已匯入 ${result.imported} 筆`;
    if (result.errors?.length) console.warn('CSV 匯入警告：', result.errors);
    loadProductCatalog(clientId);
  } catch (e) {
    if (statusEl) statusEl.textContent = `錯誤：${e.message}`;
    toast(`匯入失敗：${e.message}`, 'error');
  }
};

// ─── 展開/收合 ───
window.toggleCard = (bodyId, header) => {
  const body = document.getElementById(bodyId);
  const icon = document.getElementById(`icon-${bodyId}`);
  if (!body) return;
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  if (icon) icon.classList.toggle('open', !isOpen);
};

// ─── 儲存 IG 設定 ───
window.saveIgTokens = async (clientId) => {
  const statusEl = document.getElementById(`ig-save-status-${clientId}`);
  if (statusEl) statusEl.textContent = '儲存中…';

  const get = (id) => document.getElementById(id)?.value ?? '';
  const igBusinessId = get(`${clientId}-ig-business-id`);
  const igVerifyToken = get(`${clientId}-ig-verify-token`);
  const igAccessToken = get(`${clientId}-ig-access-token`);

  const body = {};
  if (igBusinessId)   body.ig_business_account_id = igBusinessId;
  if (igVerifyToken)  body.ig_verify_token = igVerifyToken;
  if (igAccessToken)  body.ig_access_token = igAccessToken;

  if (!Object.keys(body).length) {
    if (statusEl) statusEl.textContent = '沒有變更';
    return;
  }

  try {
    await api('PUT', `/api/clients/${clientId}`, body);
    if (statusEl) statusEl.textContent = '已儲存';
    toast('IG 設定已儲存', 'success');
    setTimeout(() => loadClients(), 800);
  } catch (e) {
    if (statusEl) statusEl.textContent = `錯誤：${e.message}`;
    toast(`IG 設定儲存失敗：${e.message}`, 'error');
  }
};

// ─── P8：儲存 BV SHOP 設定 ───
window.saveBvShop = async (clientId) => {
  const statusEl = document.getElementById(`bv-status-${clientId}`);
  if (statusEl) statusEl.textContent = '儲存中…';
  const get = (id) => document.getElementById(id)?.value ?? '';
  const bvShopUrl = get(`${clientId}-bv-shop-url`);
  const bvApiKey  = get(`${clientId}-bv-api-key`);
  const body = {};
  if (bvShopUrl !== undefined) body.bv_shop_url = bvShopUrl;
  if (bvApiKey)  body.bv_api_key = bvApiKey;
  if (!bvShopUrl && !bvApiKey) {
    if (statusEl) statusEl.textContent = '沒有變更';
    return;
  }
  try {
    await api('PUT', `/api/clients/${clientId}`, body);
    if (statusEl) statusEl.textContent = '已儲存';
    toast('BV SHOP 設定已儲存', 'success');
    setTimeout(() => loadClients(), 800);
  } catch (e) {
    if (statusEl) statusEl.textContent = `錯誤：${e.message}`;
    toast(`BV SHOP 設定儲存失敗：${e.message}`, 'error');
  }
};

// ─── BV token 即時驗證 ───
window.bvTestToken = async (clientId) => {
  const get = (id) => document.getElementById(id)?.value?.trim() ?? '';
  const token = get(`${clientId}-bv-api-key`);
  const baseUrl = get(`${clientId}-bv-shop-url`) || 'https://bvshop-manage.bvshop.tw';
  if (!token) {
    toast('請先在 BV API Token 欄位貼上 token', 'warning');
    return;
  }
  const statusEl = document.getElementById(`bv-status-${clientId}`);
  if (statusEl) statusEl.textContent = '驗證中…';
  try {
    const r = await api('POST', `/api/clients/${clientId}/bv-test-token`, { token, base_url: baseUrl });
    if (statusEl) statusEl.textContent = r.message || (r.ok ? '✅ 通過' : '❌ 失敗');
    toast(r.message || (r.ok ? 'Token 有效' : 'Token 無效'), r.ok ? 'success' : 'error');
  } catch (e) {
    if (statusEl) statusEl.textContent = `驗證失敗：${e.message}`;
    toast(`驗證失敗：${e.message}`, 'error');
  }
};

// ─── P8：BV 立即同步 ───
window.bvSyncNow = async (clientId) => {
  const statusEl = document.getElementById(`bv-status-${clientId}`);
  if (statusEl) statusEl.textContent = '同步中…';
  try {
    const result = await api('POST', `/api/clients/${clientId}/bv-sync-now`);
    const msg = result.note ? `（${result.note}）` : `已同步 ${result.synced ?? 0} 筆`;
    if (statusEl) statusEl.textContent = msg;
    toast(`BV 同步完成 ${msg}`, 'success');
    setTimeout(() => loadClients(), 1000);
  } catch (e) {
    if (statusEl) statusEl.textContent = `同步失敗：${e.message}`;
    toast(`BV 同步失敗：${e.message}`, 'error');
  }
};

// ─── 儲存業主設定 ───
window.saveClient = async (clientId) => {
  const statusEl = $(`#save-status-${clientId}`);
  if (statusEl) statusEl.textContent = '儲存中…';

  const get = (id) => document.getElementById(id)?.value ?? '';

  // token 欄位：空白不送
  const body = {};
  const lineChannelId = get(`${clientId}-line-channel-id`);
  const lineSecret    = get(`${clientId}-line-channel-secret`);
  const lineToken     = get(`${clientId}-line-access-token`);
  const fbPageId      = get(`${clientId}-fb-page-id`);
  const fbVerify      = get(`${clientId}-fb-verify-token`);
  const fbToken       = get(`${clientId}-fb-page-token`);

  if (lineChannelId) body.line_channel_id = lineChannelId;
  if (lineSecret)    body.line_channel_secret = lineSecret;
  if (lineToken)     body.line_access_token = lineToken;
  if (fbPageId)      body.fb_page_id = fbPageId;
  if (fbVerify)      body.fb_verify_token = fbVerify;
  if (fbToken)       body.fb_page_token = fbToken;

  // brand_dna
  const tone      = get(`${clientId}-dna-tone`);
  const signature = get(`${clientId}-dna-signature`);
  const toneExamplesRaw = get(`${clientId}-dna-tone-examples`);

  let tone_examples = [];
  try { tone_examples = JSON.parse(toneExamplesRaw); } catch {}

  const forbidden_words  = tagInputInstances[`forbidden-${clientId}`]?.getTags() ?? [];
  const required_phrases = tagInputInstances[`required-${clientId}`]?.getTags()  ?? [];
  const product_lines    = tagInputInstances[`product-${clientId}`]?.getTags()   ?? [];

  body.brand_dna = { tone, signature, forbidden_words, required_phrases, product_lines, tone_examples };

  try {
    await api('PUT', `/api/clients/${clientId}`, body);
    if (statusEl) statusEl.textContent = '已儲存';
    toast('設定已儲存', 'success');
    // 重新載入顯示最新狀態
    setTimeout(() => loadClients(), 800);
  } catch (e) {
    if (statusEl) statusEl.textContent = `錯誤：${e.message}`;
    toast(`儲存失敗：${e.message}`, 'error');
  }
};

// ─── 測試連線 ───
window.testConnection = async (clientId) => {
  const resultEl = $(`#test-result-${clientId}`);
  if (resultEl) resultEl.textContent = '測試中…';
  try {
    const data = await api('POST', `/api/clients/${clientId}/test`, {});
    if (resultEl) resultEl.textContent = data.note || (data.ok ? '連線正常' : '測試失敗');
    toast(data.note || '待 LINE/FB API 整合後啟用', '');
  } catch (e) {
    if (resultEl) resultEl.textContent = `錯誤：${e.message}`;
    toast(`測試失敗：${e.message}`, 'error');
  }
};

// ─── 載入業主列表 ───
let allClients = [];
let activeClientId = null;

const loadClients = async () => {
  try {
    const data = await api('GET', '/api/clients');
    allClients = data.clients || [];
    renderClientSelector();
    renderVisibleClients();
  } catch (e) {
    toast(`載入失敗：${e.message}`, 'error');
  }
};

const renderClientSelector = () => {
  const sel = $('#client-selector');
  sel.innerHTML = '';
  // 「全部」按鈕
  const allBtn = document.createElement('div');
  allBtn.className = 'client-tab' + (activeClientId === null ? ' active' : '');
  allBtn.textContent = '全部';
  allBtn.onclick = () => { activeClientId = null; renderClientSelector(); renderVisibleClients(); };
  sel.appendChild(allBtn);

  allClients.forEach(c => {
    const btn = document.createElement('div');
    btn.className = 'client-tab' + (activeClientId === c.id ? ' active' : '');
    btn.textContent = c.display_name;
    btn.onclick = () => { activeClientId = c.id; renderClientSelector(); renderVisibleClients(); };
    sel.appendChild(btn);
  });
};

const renderVisibleClients = () => {
  const container = $('#clients-container');
  container.innerHTML = '';
  tagInputInstances = {};

  const visible = activeClientId === null ? allClients : allClients.filter(c => c.id === activeClientId);
  if (!visible.length) {
    container.innerHTML = '<div class="text-muted text-sm">沒有業主資料</div>';
    return;
  }
  visible.forEach(c => {
    const card = renderClientCard(c);
    container.appendChild(card);
    // 第一張預設展開
    if (visible.length === 1) {
      const bodyId = `body-${c.id}`;
      const body = document.getElementById(bodyId);
      const icon = document.getElementById(`icon-${bodyId}`);
      if (body) { body.classList.add('open'); if (icon) icon.classList.add('open'); }
    }
  });
};

// ─── Init ───
const init = async () => {
  try {
    const me = await api('GET', '/api/me');
    $('#user-info').textContent = `${me.username} (${me.role})`;

    if (me.role !== 'admin') {
      // agent 只看自己 client，直接跳轉
      location.href = '/';
      return;
    }
  } catch {
    location.href = '/login.html';
    return;
  }

  await loadClients();

  $('#logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login.html';
  });
};

// ─── A4. AI 預算 ───
const loadBudget = async (clientId) => {
  const container = document.getElementById(`ai-budget-${clientId}`);
  if (!container) return;
  try {
    const data = await api('GET', `/api/clients/${clientId}/ai-budget`);

    // 填入表單
    const budgetInput = document.getElementById(`${clientId}-budget-usd`);
    const cycleSelect = document.getElementById(`${clientId}-budget-cycle`);
    const piiCheck    = document.getElementById(`${clientId}-pii-masking`);
    if (budgetInput) budgetInput.value = data.monthly_budget_usd || 0;
    if (cycleSelect) cycleSelect.value = data.budget_cycle || 'monthly';
    if (piiCheck) piiCheck.checked = !!data.pii_masking_enabled;

    const usedUsd = (data.used_usd || 0).toFixed(4);
    const budgetUsd = data.monthly_budget_usd || 0;
    const pct = data.used_pct || 0;
    const barColor = pct >= 90 ? '#e53935' : pct >= 70 ? '#f57c00' : '#43a047';

    container.innerHTML = `
      <div style="font-size:13px;margin-bottom:8px;">
        本月用量：<strong>$${usedUsd}</strong>${budgetUsd > 0 ? ` / $${budgetUsd} (${pct}%)` : ' (無上限)'}
      </div>
      ${budgetUsd > 0 ? `
      <div style="background:#f0f0f0;border-radius:4px;height:8px;overflow:hidden;margin-bottom:4px;">
        <div style="height:100%;background:${barColor};width:${Math.min(100, pct)}%;border-radius:4px;transition:width 0.3s;"></div>
      </div>` : ''}
      <div style="font-size:12px;color:var(--muted);">輸入 ${data.input_tokens || 0} tokens / 輸出 ${data.output_tokens || 0} tokens</div>
    `;
  } catch (e) {
    if (container) container.innerHTML = `<div style="font-size:12px;color:var(--muted);">無法載入 AI 用量（${e.message}）</div>`;
  }
};

window.saveBudget = async (clientId) => {
  const statusEl = document.getElementById(`budget-status-${clientId}`);
  if (statusEl) statusEl.textContent = '儲存中…';
  const monthly_budget_usd = parseFloat(document.getElementById(`${clientId}-budget-usd`)?.value || '0');
  const budget_cycle = document.getElementById(`${clientId}-budget-cycle`)?.value || 'monthly';
  const pii_masking_enabled = document.getElementById(`${clientId}-pii-masking`)?.checked || false;
  try {
    await api('PUT', `/api/clients/${clientId}/ai-budget`, { monthly_budget_usd, budget_cycle, pii_masking_enabled });
    if (statusEl) statusEl.textContent = '已儲存';
    toast('AI 預算已儲存', 'success');
    loadBudget(clientId);
  } catch (e) {
    if (statusEl) statusEl.textContent = `錯誤：${e.message}`;
    toast(`儲存失敗：${e.message}`, 'error');
  }
};

// ─── 暴露給 onclick 的函式已用 window. 前綴，copyText 也要暴露 ───
window.copyText = copyText;

init();
