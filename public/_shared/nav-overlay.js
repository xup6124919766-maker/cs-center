/**
 * nav-overlay.js — 把 top nav 跨頁跳轉改成 iframe overlay
 *
 * 在頂層頁載入時：攔截 top nav 內部連結點擊 → 開全螢幕 overlay 在當前頁上方
 *                 對話/業主設定/任何 context 都不會丟。
 * 在 iframe 內載入時：不攔截，讓使用者可以在 overlay 內正常導覽。
 *
 * 使用：在所有頁面 <body> 結尾前加：
 *   <script src="/_shared/nav-overlay.js"></script>
 */
(() => {
  // 在 iframe 裡 → 不做攔截，讓 iframe 內可以自由導航
  if (window.parent !== window) return;

  // ─── 注入 overlay DOM ───
  const overlay = document.createElement('div');
  overlay.id = 'cs-nav-overlay';
  overlay.innerHTML = `
    <div class="cs-nav-overlay-bg"></div>
    <div class="cs-nav-overlay-panel">
      <div class="cs-nav-overlay-head">
        <div class="cs-nav-overlay-title">載入中…</div>
        <button class="cs-nav-overlay-fullscreen" title="新分頁開啟">⤢</button>
        <button class="cs-nav-overlay-close" title="關閉 (Esc)">×</button>
      </div>
      <div class="cs-nav-overlay-loading">
        <div class="cs-nav-spinner"></div>
        <div style="margin-top:14px;font-size:13px;color:#666;">載入中…</div>
      </div>
      <iframe class="cs-nav-overlay-iframe" src="about:blank" allow="clipboard-write"></iframe>
    </div>
  `;
  const style = document.createElement('style');
  style.textContent = `
    #cs-nav-overlay { display:none; position:fixed; inset:0; z-index:9990; }
    #cs-nav-overlay.open { display:block; }
    #cs-nav-overlay .cs-nav-overlay-bg { position:absolute; inset:0; background:rgba(0,0,0,0.4); animation: csFadeIn 0.15s ease; }
    #cs-nav-overlay .cs-nav-overlay-panel {
      position:absolute; inset:24px;
      background:#fff; border-radius:12px;
      display:flex; flex-direction:column;
      box-shadow:0 20px 60px rgba(0,0,0,0.3);
      animation: csSlideUp 0.18s ease;
      overflow:hidden;
    }
    @media (max-width: 768px) { #cs-nav-overlay .cs-nav-overlay-panel { inset:0; border-radius:0; } }
    #cs-nav-overlay .cs-nav-overlay-head {
      display:flex; align-items:center; gap:8px;
      padding:10px 16px; border-bottom:1px solid #eee;
      background:#fafafa;
    }
    #cs-nav-overlay .cs-nav-overlay-title {
      flex:1; font-weight:600; font-size:14px; color:#1a1a2e;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    #cs-nav-overlay button {
      background:none; border:none; cursor:pointer;
      font-size:20px; line-height:1; color:#666;
      padding:4px 8px; border-radius:4px;
    }
    #cs-nav-overlay button:hover { background:#eee; color:#000; }
    #cs-nav-overlay .cs-nav-overlay-iframe {
      flex:1; width:100%; border:0; background:#fff;
      transition: opacity 0.18s ease;
    }
    #cs-nav-overlay .cs-nav-overlay-iframe.loading { opacity:0; }
    #cs-nav-overlay .cs-nav-overlay-loading {
      position:absolute; inset:42px 0 0 0;
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      background:#fafafa; z-index:1;
      transition: opacity 0.2s ease;
    }
    #cs-nav-overlay .cs-nav-overlay-loading.hidden { opacity:0; pointer-events:none; }
    #cs-nav-overlay .cs-nav-spinner {
      width:32px; height:32px;
      border:3px solid #e8eaf0;
      border-top-color:#5856d6;
      border-radius:50%;
      animation: csSpin 0.7s linear infinite;
    }
    @keyframes csSpin { to { transform: rotate(360deg) } }
    @keyframes csFadeIn { from { opacity:0 } to { opacity:1 } }
    @keyframes csSlideUp { from { transform:translateY(8px); opacity:0 } to { transform:translateY(0); opacity:1 } }
  `;
  document.head.appendChild(style);
  document.body.appendChild(overlay);

  const overlayEl = overlay;
  const iframeEl = overlay.querySelector('.cs-nav-overlay-iframe');
  const titleEl  = overlay.querySelector('.cs-nav-overlay-title');
  const loadingEl = overlay.querySelector('.cs-nav-overlay-loading');

  const openOverlay = (url, title) => {
    titleEl.textContent = title || url;
    // 重設 loading 狀態
    loadingEl.classList.remove('hidden');
    iframeEl.classList.add('loading');
    iframeEl.src = url;
    overlayEl.classList.add('open');
    document.body.style.overflow = 'hidden';
  };
  // iframe 載完後隱藏 loading
  iframeEl.addEventListener('load', () => {
    if (iframeEl.src && iframeEl.src !== 'about:blank') {
      loadingEl.classList.add('hidden');
      iframeEl.classList.remove('loading');
    }
  });
  const closeOverlay = () => {
    overlayEl.classList.remove('open');
    iframeEl.src = 'about:blank';
    document.body.style.overflow = '';
  };

  overlay.querySelector('.cs-nav-overlay-bg').onclick = closeOverlay;
  overlay.querySelector('.cs-nav-overlay-close').onclick = closeOverlay;
  overlay.querySelector('.cs-nav-overlay-fullscreen').onclick = () => {
    if (iframeEl.src && iframeEl.src !== 'about:blank') window.open(iframeEl.src, '_blank');
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlayEl.classList.contains('open')) closeOverlay();
  });

  // ─── 攔截 top nav 內部連結 ───
  // 規則：只攔截 same-origin、非「客服首頁」、非外連、非 #anchor、非 javascript:
  const HOME_PATHS = new Set(['/', '/index.html']);
  const isInternalNavTarget = (href) => {
    if (!href) return false;
    if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return false;
    // 同網域相對路徑
    if (href.startsWith('/') && !HOME_PATHS.has(href.split('?')[0].split('#')[0])) return true;
    if (href.startsWith(location.origin) && !HOME_PATHS.has(new URL(href).pathname)) return true;
    return false;
  };

  // 用事件委派，新加的 anchor 也吃得到
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    if (a.target === '_blank') return; // 已標明開新分頁，不攔
    if (a.dataset.noOverlay === 'true') return; // 顯式關掉
    const href = a.getAttribute('href');
    if (!isInternalNavTarget(href)) return;
    // 只攔 nav 區的連結 — 否則對話內所有 a 都會被吃
    const inNav = a.closest(
      '.topnav, #topnav, nav, .nav, [data-nav], .sidebar-nav, header, ' +
      '#topbar, #topbar-right, #topnav-area, .quick-links'
    );
    if (!inNav) return;
    e.preventDefault();
    openOverlay(href, a.textContent.trim());
  }, true); // capture phase 才能擋早

  // 暴露給其他程式用
  window.csNavOverlay = { open: openOverlay, close: closeOverlay };
})();
