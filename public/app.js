// ═══════════════════════════════════════════════════
//  PWA：Service Worker 註冊 + 安裝橫幅 + Push 通知
// ═══════════════════════════════════════════════════

// ─── SW 註冊 — **暫時停用** ───
// 原 PWA SW 造成 reload 迴圈，先讓所有頁面走純網路
// 主動卸載任何已存在的 SW
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(r => r.unregister().catch(() => {}));
  }).catch(() => {});
  // 也清掉所有 cache
  if ('caches' in window) {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
  }
}

// ─── 防禦：頁面載入時強制關閉所有可能卡住的 modal/overlay ───
window.addEventListener('DOMContentLoaded', () => {
  const overlayIds = ['transfer-modal', 'checkout-modal', 'shortcut-modal', 'pwa-install-banner', 'pwa-update-banner', 'offline-banner'];
  overlayIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  // 砍掉所有 .shortcut-modal class（鍵盤快捷鍵說明）
  document.querySelectorAll('.shortcut-modal').forEach(el => el.style.display = 'none');
});

// ─── 更新橫幅 ───
const _showUpdateBanner = (newWorker) => {
  const existing = document.getElementById('pwa-update-banner');
  if (existing) return;

  const banner = document.createElement('div');
  banner.id = 'pwa-update-banner';
  banner.className = 'pwa-update-banner';
  banner.innerHTML = `
    <span>梵森客服有新版本，重新整理後生效</span>
    <button onclick="window._pwaUpdate()" class="btn-primary">立即更新</button>
    <button onclick="this.closest('#pwa-update-banner').remove()" class="btn-text">稍後</button>
  `;
  document.body.appendChild(banner);

  window._pwaUpdate = () => {
    banner.remove();
    newWorker.postMessage({ type: 'SKIP_WAITING' });
  };
};

// ─── 「加到主畫面」安裝橫幅 ───
let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  _showInstallBanner();
});

const _showInstallBanner = () => {
  // 7 天內顯示過就跳過
  const lastShown = localStorage.getItem('pwa_install_banner_shown');
  if (lastShown && Date.now() - parseInt(lastShown) < 7 * 86400000) return;
  // 已是 standalone 模式（已安裝）就跳過
  if (window.matchMedia('(display-mode: standalone)').matches) return;

  const existing = document.getElementById('pwa-install-banner');
  if (existing) return;

  const banner = document.createElement('div');
  banner.id = 'pwa-install-banner';
  banner.className = 'pwa-install-banner';
  banner.innerHTML = `
    <span>加到主畫面，下次直接從手機桌面進入</span>
    <button onclick="window._pwaInstall()" class="btn-primary">安裝</button>
    <button onclick="window._pwaDismiss()" class="btn-text">稍後</button>
  `;
  document.body.appendChild(banner);

  window._pwaInstall = async () => {
    if (_deferredInstallPrompt) {
      _deferredInstallPrompt.prompt();
      const { outcome } = await _deferredInstallPrompt.userChoice;
      console.log('[PWA] 安裝選擇:', outcome);
      _deferredInstallPrompt = null;
    }
    banner.remove();
  };

  window._pwaDismiss = () => {
    localStorage.setItem('pwa_install_banner_shown', Date.now().toString());
    banner.remove();
  };
};

// ─── Push 通知權限請求（進站 30 秒後彈橫幅，不直接彈原生 prompt）───
const _initPushNotification = () => {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    console.log('[PWA] 通知已授權');
    return;
  }
  if (Notification.permission === 'denied') return;

  // 已顯示過就跳過
  if (localStorage.getItem('pwa_notify_asked')) return;

  setTimeout(() => {
    const existing = document.getElementById('pwa-notify-banner');
    if (existing) return;
    // 確認有登入後再問
    if (!document.getElementById('user-info')?.textContent?.trim()) return;

    const banner = document.createElement('div');
    banner.id = 'pwa-notify-banner';
    banner.className = 'pwa-install-banner';
    banner.style.bottom = '76px'; // 避免蓋到 mobile-tabs
    banner.innerHTML = `
      <span>啟用通知，收到新訊息立即知道</span>
      <button onclick="window._pwaEnableNotify()" class="btn-primary">啟用</button>
      <button onclick="window._pwaDenyNotify()" class="btn-text">不用了</button>
    `;
    document.body.appendChild(banner);

    window._pwaEnableNotify = async () => {
      banner.remove();
      localStorage.setItem('pwa_notify_asked', '1');
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        console.log('[PWA] 通知已授權');
        // TODO: 取得 VAPID push subscription
        // const reg = await navigator.serviceWorker.ready;
        // const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY });
        // await api('POST', '/api/push/subscribe', sub);
      }
    };

    window._pwaDenyNotify = () => {
      localStorage.setItem('pwa_notify_asked', '1');
      banner.remove();
    };
  }, 30000);
};

// DOMContentLoaded 後初始化 Push
document.addEventListener('DOMContentLoaded', _initPushNotification);

// ─── 接受 SW 的 notification_click 訊息（聚焦對應對話）───
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'notification_click' && e.data.url) {
      // 已在 index.html，不需跳頁，直接確保顯示
      console.log('[PWA] 通知點擊，目標:', e.data.url);
    }
  });
}

// ─── Swipe 手勢（行動版：往左滑 = 標已讀，往右滑 = 跟催）───
const _initSwipeGestures = () => {
  const convList = document.getElementById('conv-list');
  if (!convList) return;

  let touchStartX = 0;
  let touchStartY = 0;
  let swipeTarget = null;

  convList.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    swipeTarget = e.target.closest('.conv-item');
  }, { passive: true });

  convList.addEventListener('touchend', (e) => {
    if (!swipeTarget) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;

    // 橫向滑動幅度要大於縱向才觸發
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

    const convId = parseInt(swipeTarget.dataset.convId, 10);
    if (!convId) return;

    if (dx < 0) {
      // 往左滑 → 標已讀
      console.log('[Swipe] 往左，標已讀:', convId);
      if (typeof markConvRead === 'function') markConvRead(convId);
      else if (typeof api === 'function') api('POST', `/api/conversations/${convId}/read`).catch(() => {});
      // 視覺回饋
      _swipeFeedback(swipeTarget, 'left');
    } else {
      // 往右滑 → 標待處理（跟催）
      console.log('[Swipe] 往右，跟催:', convId);
      if (typeof api === 'function') {
        api('PATCH', `/api/conversations/${convId}`, { status: 'pending' }).catch(() => {});
      }
      _swipeFeedback(swipeTarget, 'right');
    }
    swipeTarget = null;
  }, { passive: true });
};

const _swipeFeedback = (el, direction) => {
  el.style.transition = 'transform 0.15s ease, opacity 0.15s';
  el.style.transform = `translateX(${direction === 'left' ? '-12px' : '12px'})`;
  el.style.opacity = '0.6';
  setTimeout(() => {
    el.style.transform = '';
    el.style.opacity = '';
  }, 250);
};

// DOMContentLoaded 後初始化 swipe
document.addEventListener('DOMContentLoaded', _initSwipeGestures);

// ─── helpers ───
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const fmtTime = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return `${diffDays} 天前`;
  return d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
};

const fmtDateLabel = (ms) => {
  const d = new Date(ms);
  return d.toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' });
};

const channelIcon  = (channel) => channel === 'line' ? 'L' : (channel === 'ig' ? 'I' : 'F');
const channelClass = (channel) => channel === 'line' ? 'line' : (channel === 'ig' ? 'ig' : 'fb');

const emotionEmoji = (e) => ({ positive: '😊', negative: '😟', angry: '😠', neutral: '😐' }[e] || '');

// 首字圓形頭貼顏色陣列
const AVATAR_COLORS = [
  '#06C755', '#1976D2', '#E53935', '#F57C00',
  '#7B1FA2', '#00838F', '#558B2F', '#D84315',
];
const getAvatarColor = (name) => {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + (name || '').charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
};
const getInitial = (name) => {
  if (!name) return '?';
  const clean = name.replace(/[^一-龥a-zA-Z0-9]/g, '');
  return clean.charAt(0) || '?';
};

// ─── State ───
const state = {
  me: null,
  activeConvId: null,
  activeConv: null,
  activeCustomerId: null,
  activeCustomer: null,
  conversations: [],
  messages: [],
  templates: [],
  statusFilter: '',
  currentClientId: null,
  inputMode: 'reply',
  convTags: [],
  socket: null,
  wsOnline: false,
  offlineTimer: null,
  pollInterval: null,
  currentSuggestions: [],
};

// ─── CSRF helper ───
const getCsrfToken = () => {
  const match = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('cs_csrf='));
  return match ? match.slice(8) : '';
};

// ─── API ───
const api = async (method, path, body) => {
  const opts = {
    method,
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': getCsrfToken(),
    },
  };
  // super admin 自動補 client_id（POST/PUT/PATCH 即使沒 body 也補）
  if (state.currentClientId && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    if (body === undefined || body === null) {
      body = { client_id: state.currentClientId };
    } else if (typeof body === 'object' && !Array.isArray(body) && body.client_id === undefined) {
      body = { ...body, client_id: state.currentClientId };
    }
  }
  if (body !== undefined) opts.body = JSON.stringify(body);
  let finalPath = path;
  if (method === 'GET' && state.currentClientId && !path.includes('client_id=') && !path.startsWith('/api/me') && !path.startsWith('/api/health')) {
    finalPath = path + (path.includes('?') ? '&' : '?') + 'client_id=' + state.currentClientId;
  }
  const r = await fetch(finalPath, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('未登入'); }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return r.json();
};

// ─── Toast（重新設計：右下角浮動，有關閉按鈕，5 秒自動消失）───
// alias for newer code
const toast = (msg, type = '') => showToast(msg, type);
const showToast = (msg, type = '') => {
  const container = $('#toast-container');
  if (!container) return;

  const item = document.createElement('div');
  item.className = `toast-item ${type === 'success' ? 'success' : type === 'error' ? 'error' : 'default'}`;

  const iconMap = { success: '✓', error: '✕', default: 'ℹ' };
  const icon = iconMap[type] || iconMap.default;

  item.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-msg">${esc(msg)}</span>
    <button class="toast-close" onclick="this.closest('.toast-item').remove()">×</button>
  `;

  container.appendChild(item);

  const dismiss = () => {
    item.classList.add('hiding');
    setTimeout(() => item.remove(), 220);
  };

  const t = setTimeout(dismiss, 5000);
  item.querySelector('.toast-close').addEventListener('click', () => { clearTimeout(t); });
};

// ─── 新訊息 mini banner ───
const showNewMsgBanner = (customerName, convId) => {
  let banner = $('#new-msg-banner');
  if (banner) banner.remove();

  banner = document.createElement('div');
  banner.id = 'new-msg-banner';
  banner.style.cursor = 'pointer';
  banner.innerHTML = `💬 新訊息來自 <strong>${esc(customerName)}</strong> <span style="margin-left:8px;font-size:11px;background:rgba(255,255,255,0.25);padding:2px 7px;border-radius:99px;">💡 看建議</span>`;
  banner.onclick = () => {
    banner.remove();
    const conv = state.conversations.find(c => c.id === convId);
    if (conv) selectConversation(conv);
  };
  document.body.appendChild(banner);

  clearTimeout(banner._t);
  banner._t = setTimeout(() => {
    if (banner.parentNode) {
      banner.style.opacity = '0';
      banner.style.transition = 'opacity 0.3s';
      setTimeout(() => banner.remove(), 320);
    }
  }, 3000);
};

// ─── Aggressive Polling（主保底，5 秒一次）───
let lastSyncAt = 0;
let syncTimer = null;

const startSync = () => {
  if (syncTimer) clearInterval(syncTimer);
  lastSyncAt = Date.now() - 5000; // 啟動時往前 5 秒，確保拿到最新訊息
  syncTimer = setInterval(syncIncremental, 5000);
};

const stopSync = () => {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
};

const updateSyncIndicator = (ok) => {
  const el = $('#sync-indicator');
  if (!el) return;
  const ago = Math.round((Date.now() - lastSyncAt) / 1000);
  el.textContent = ok ? `同步：${ago} 秒前` : '同步失敗';
  el.className = `sync-indicator${ok ? ' fresh' : ''}`;
};

const syncIncremental = async () => {
  if (!state.currentClientId) return;
  if (document.hidden) return; // 背景 tab 跳過，省流量

  try {
    const data = await api('GET', `/api/sync?client_id=${state.currentClientId}&since=${lastSyncAt}`);
    const prevSyncAt = lastSyncAt;
    lastSyncAt = data.server_time || Date.now();

    // 1. 更新對話列表
    let convListChanged = false;
    for (const c of data.conversations || []) {
      const idx = state.conversations.findIndex(x => x.id === c.id);
      if (idx >= 0) {
        // 防 polling 蓋掉本地 0：當前 active 對話的 unread_count 強制保持 0
        const isActive = state.activeConvId === c.id;
        if (isActive) {
          c.unread_count = 0;
          // 同時重新呼叫 mark-read（保險，避免 server 端有殘留）
          api('POST', `/api/conversations/${c.id}/mark-read`).catch(() => {});
        }
        Object.assign(state.conversations[idx], c);
        convListChanged = true;
      } else {
        state.conversations.unshift(c);
        convListChanged = true;
      }
    }
    if (convListChanged) {
      state.conversations.sort((a, b) => (b.last_message_at || 0) - (a.last_message_at || 0));
      renderConvList();
    }

    // 2. 分派新訊息
    let activeConvUpdated = false;
    for (const m of data.messages || []) {
      if (m.conversation_id === state.activeConvId) {
        if (!state.messages.find(x => x.id === m.id)) {
          state.messages.push(m);
          activeConvUpdated = true;
          if (m.direction === 'inbound') {
            loadSuggestions().catch(() => {});
          }
        }
      } else if (m.direction === 'inbound' && m.created_at > prevSyncAt) {
        // 非當前對話的新訊息 → banner + 桌面通知
        const conv = state.conversations.find(c => c.id === m.conversation_id);
        if (conv) {
          showNewMsgBanner(conv.customer_name || '顧客', m.conversation_id);
          if (notifyEnabled()) {
            sendDesktopNotification('新訊息', (m.content || '').slice(0, 80));
          }
        }
      }
    }

    if (activeConvUpdated) renderMessages();
    updateSyncIndicator(true);
  } catch (e) {
    console.warn('sync failed:', e.message);
    updateSyncIndicator(false);
  }
};

// 切回前景立即同步一次
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) syncIncremental();
});

// ─── WebSocket 連線狀態 UI ───
const setWsStatus = (status) => {
  const el = $('#ws-status');
  const label = $('#ws-status-label');
  if (!el || !label) return;

  el.className = `${status}`;

  const labelMap = {
    connected: '即時連線中',
    reconnecting: '重連中…',
    disconnected: '連線中斷',
  };
  label.textContent = labelMap[status] || '';

  const offlineBanner = $('#offline-banner');
  if (!offlineBanner) return;

  if (status === 'connected') {
    state.wsOnline = true;
    offlineBanner.classList.add('hidden');
    clearTimeout(state.offlineTimer);
    // WS 恢復時立即 sync 一次補全
    syncIncremental();
    // 舊 fallback polling 停掉（已改為 aggressive polling 永遠跑）
    if (state.pollInterval) { clearInterval(state.pollInterval); state.pollInterval = null; }
  } else if (status === 'disconnected') {
    state.wsOnline = false;
    // WS 斷線：Aggressive Polling 已在跑，用戶完全無感
    // 30 秒後才顯示橫幅（提醒 WS 狀態，但不影響訊息接收）
    clearTimeout(state.offlineTimer);
    state.offlineTimer = setTimeout(() => {
      offlineBanner.classList.remove('hidden');
    }, 30000);
  } else if (status === 'reconnecting') {
    state.wsOnline = false;
  }
};

const reconnectSocket = () => {
  if (state.socket) {
    state.socket.connect();
    setWsStatus('reconnecting');
  }
};

// ─── Socket.IO ───
const initSocket = () => {
  if (typeof io === 'undefined') {
    console.warn('socket.io client not loaded');
    setWsStatus('disconnected');
    return;
  }

  state.socket = io({
    path: '/socket.io/',
    transports: ['websocket', 'polling'],  // 優先 WS，失敗 fallback polling
    reconnection: true,
    reconnectionAttempts: Infinity,        // 無限重試
    reconnectionDelay: 1000,               // 1 秒
    reconnectionDelayMax: 5000,            // 最多等 5 秒
    randomizationFactor: 0.3,
    timeout: 20000,
  });

  // ── 主動心跳：每 30 秒送一次，避免 Cloudflare 100s 閒置 timeout 斷線 ──
  setInterval(() => {
    if (state.socket?.connected) {
      state.socket.emit('keepalive');
    }
  }, 30_000);

  state.socket.on('connect', () => {
    console.log('socket connected:', state.socket.id);
    setWsStatus('connected');
  });

  state.socket.on('disconnect', () => {
    console.warn('socket disconnected');
    setWsStatus('disconnected');
  });

  state.socket.on('reconnect_attempt', () => {
    setWsStatus('reconnecting');
  });

  state.socket.on('reconnect', () => {
    setWsStatus('connected');
    loadConversations();
  });

  state.socket.on('connect_error', (err) => {
    console.warn('socket connect error:', err.message);
    setWsStatus('disconnected');
  });

  // 新訊息
  state.socket.on('message:new', ({ conversation_id, message }) => {
    if (state.activeConvId === conversation_id) {
      state.messages.push(message);
      renderMessages();
      // 顧客傳訊進來時自動觸發建議
      if (message.direction === 'inbound') {
        loadSuggestions();
        // 同時清未讀
        api('POST', `/api/conversations/${conversation_id}/mark-read`).catch(() => {});
      }
    } else {
      // 非當前對話：顯示 banner + 桌面通知
      const conv = state.conversations.find(c => c.id === conversation_id);
      const cName = conv?.customer_name || '顧客';
      showNewMsgBanner(cName, conversation_id);
      if (notifyEnabled()) {
        sendDesktopNotification('新訊息', (message.content || '').slice(0, 80), `/conversations/${conversation_id}`);
      }
    }
    // 對話列表冒泡：把對應對話移到頂端並 +1 未讀
    const conv = state.conversations.find(c => c.id === conversation_id);
    if (conv) {
      conv.last_message_at = message.created_at;
      conv.last_message_preview = message.content;
      if (state.activeConvId !== conversation_id) conv.unread_count = (conv.unread_count || 0) + 1;
      state.conversations.sort((a, b) => (b.last_message_at || 0) - (a.last_message_at || 0));
      renderConvList();
    }
  });

  // 客服回覆（自己送的也推）
  state.socket.on('message:reply', ({ conversation_id, message }) => {
    if (state.activeConvId === conversation_id) {
      if (!state.messages.find(m => m.id === message.id)) {
        state.messages.push(message);
        renderMessages();
      }
    }
  });

  // 對話更新（標籤/status/摘要/意圖 etc.）
  state.socket.on('conversation:update', ({ conversation_id, ...updates }) => {
    const conv = state.conversations.find(c => c.id === conversation_id);
    if (conv) {
      Object.assign(conv, updates);
      renderConvList();
    }
    if (state.activeConvId === conversation_id) {
      if (state.activeConv) Object.assign(state.activeConv, updates);
      if (updates.tags !== undefined) renderConvTags(Array.isArray(updates.tags) ? updates.tags : parseJson(updates.tags, []));
      if (updates.summary) showSummary(updates.summary);
      if (updates.emotion || updates.intent || updates.urgency) renderHeaderBadges(state.activeConv);
    }
  });

  // AI 草擬就緒
  state.socket.on('draft:ready', ({ conversation_id, drafts }) => {
    if (state.activeConvId === conversation_id) {
      renderDraftList(drafts);
      $$('.rpanel-tab').forEach(t => t.classList.toggle('active', t.dataset.rtab === 'drafts'));
      $$('#right-panel-body > div').forEach(d => d.style.display = 'none');
      $('#tab-drafts').style.display = '';
    }
  });

  // 緊急提醒
  state.socket.on('alert:urgent', ({ conversation_id, rule_name, message_preview }) => {
    showToast(`緊急！對話 #${conversation_id}：${rule_name || '規則觸發'}`, 'error');
    sendDesktopNotification('緊急警示', `對話 #${conversation_id} — ${message_preview || ''}`, '#alert');
  });

  // P3：@提及
  state.socket.on('mention', ({ conversation_id, content_preview }) => {
    showToast(`有人在對話 #${conversation_id} 提及您`, 'success');
    sendDesktopNotification('有人提及您', content_preview || `對話 #${conversation_id}`, '#mention');
    loadMentions();
  });

  // P3：對話提醒
  state.socket.on('conversation:reminder', ({ conversation_id, reminder_note }) => {
    showToast(`跟催提醒：對話 #${conversation_id} — ${reminder_note || ''}`, 'error');
    sendDesktopNotification('跟催提醒', reminder_note || `對話 #${conversation_id}`);
  });

  // 語音訊息轉文字完成
  state.socket.on('message:transcribed', ({ conversation_id, message_id, transcript, duration_ms }) => {
    if (conversation_id === state.activeConvId) {
      const msg = state.messages.find(m => m.id === message_id);
      if (msg) {
        msg.content = transcript;
        msg.transcript = transcript;
        if (duration_ms) msg.audio_duration_ms = duration_ms;
        renderMessages();
      }
    }
    // 更新對話列表 preview
    const conv = state.conversations.find(c => c.id === conversation_id);
    if (conv) {
      conv.last_message_preview = transcript;
      renderConvList();
    }
  });

  // SLA 狀態變更
  state.socket.on('conversation:sla_change', ({ conversation_id, sla_status, wait_minutes }) => {
    const conv = state.conversations.find(c => c.id === conversation_id);
    if (conv) {
      conv.sla_status = sla_status;
      conv.sla_wait_minutes = wait_minutes;
      renderConvList();
    }
    if (sla_status === 'breached') {
      showToast(`SLA 超時！對話 #${conversation_id} 已等待 ${wait_minutes} 分鐘`, 'error');
    }
  });
};

// ─── Init ───
const init = async () => {
  // 初始化 ws-status 為連線中
  setWsStatus('reconnecting');

  try {
    state.me = await api('GET', '/api/me');
  } catch {
    location.href = '/login.html';
    return;
  }

  $('#user-info').textContent = `${state.me.username} (${state.me.role})`;
  if (state.me.role === 'admin') {
    const adminLink = $('#admin-link');
    if (adminLink) adminLink.style.display = '';
    const pwaLink = $('#pwa-link');
    if (pwaLink) pwaLink.style.display = '';
  }

  state.currentClientId = state.me.client_id;

  if (state.currentClientId === null && state.me.role === 'admin') {
    try {
      const cd = await api('GET', '/api/clients');
      if (cd?.clients?.length) {
        state.currentClientId = cd.clients[0].id;
        console.log('[admin] 自動選業主', cd.clients[0].display_name, 'id=', state.currentClientId);
      }
    } catch (e) { console.warn('載入業主清單失敗', e); }
  }

  await loadConversations();
  initSocket();

  // 右上角 tab
  $$('.rpanel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.rpanel-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $$('#right-panel-body > div').forEach(d => d.style.display = 'none');
      $(`#tab-${tab.dataset.rtab}`).style.display = '';
      if (tab.dataset.rtab === 'templates') loadTemplates();
    });
  });

  // 狀態過濾
  $$('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.statusFilter = btn.dataset.status;
      renderConvList();
    });
  });

  // 對話狀態更新
  $('#conv-status-select').addEventListener('change', async (e) => {
    if (!state.activeConvId) return;
    const cid = state.currentClientId;
    if (!cid) return;
    await api('PUT', `/api/conversations/${state.activeConvId}`, { status: e.target.value });
    await loadConversations();
  });

  // 輸入模式切換
  $$('.input-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.inputMode = btn.dataset.mode;
      $$('.input-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const input = $('#msg-input');
      if (state.inputMode === 'note') {
        input.placeholder = '輸入內部備忘（不送出給顧客）…';
        input.classList.add('note-mode');
      } else {
        input.placeholder = '輸入訊息… (Enter 送出，Shift+Enter 換行)';
        input.classList.remove('note-mode');
      }
    });
  });

  // 送訊息
  $('#send-btn').addEventListener('click', sendMessage);
  $('#msg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 自動展開輸入框
  $('#msg-input').addEventListener('input', () => {
    const el = $('#msg-input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 130) + 'px';
    $('#send-btn').disabled = !el.value.trim() || !state.activeConvId;
    // 品牌教練 debounce 評分（僅 reply 模式）
    if (state.inputMode !== 'note') scheduleBrandCoachScore();
  });

  // AI 草擬按鈕
  $('#draft-btn').addEventListener('click', async () => {
    if (!state.activeConvId) return;
    $('#draft-btn').disabled = true;
    $('#draft-btn').textContent = '生成中…';
    $$('.rpanel-tab').forEach(t => t.classList.toggle('active', t.dataset.rtab === 'drafts'));
    $$('#right-panel-body > div').forEach(d => d.style.display = 'none');
    $('#tab-drafts').style.display = '';
    $('#draft-list').innerHTML = '<div class="draft-placeholder">AI 生成中，請稍候…</div>';
    try {
      const result = await api('POST', `/api/conversations/${state.activeConvId}/draft`);
      if (result.drafts) renderDraftList(result.drafts);
    } catch (e) {
      $('#draft-list').innerHTML = `<div class="draft-placeholder" style="color:var(--err)">${esc(e.message)}</div>`;
    } finally {
      $('#draft-btn').disabled = false;
      $('#draft-btn').textContent = 'AI 草擬';
    }
  });

  // 摘要 toggle
  const summaryToggle = $('#summary-toggle');
  if (summaryToggle) {
    summaryToggle.addEventListener('click', () => {
      const content = $('#summary-content');
      const chevron = $('#summary-chevron');
      const isHidden = content.classList.contains('hidden');
      content.classList.toggle('hidden', !isHidden);
      chevron.textContent = isHidden ? '▲' : '▼';
    });
  }

  // 轉接按鈕
  const transferBtn = $('#transfer-btn');
  const transferModal = $('#transfer-modal');
  if (transferBtn) {
    transferBtn.addEventListener('click', async () => {
      if (!state.currentClientId) return;
      try {
        const data = await api('GET', `/api/users?client_id=${state.currentClientId}`);
        const sel = $('#transfer-user-select');
        sel.innerHTML = '<option value="">選擇客服人員…</option>' +
          (data.users || []).map(u => `<option value="${u.id}">${esc(u.username)} (${esc(u.role)})</option>`).join('');
      } catch {}

      const summaryArea = $('#transfer-summary-area');
      if (summaryArea) {
        const conv = state.activeConv || state.conversations?.find(c => c.id === state.activeConvId);
        if (conv?.summary) {
          summaryArea.style.display = '';
          summaryArea.innerHTML = `<div style="font-size:11px;color:var(--muted);margin-bottom:5px;">AI 摘要（接手客服參考）</div>
            <div style="font-size:12px;background:var(--bg);border-radius:var(--radius-sm);padding:9px 12px;max-height:80px;overflow-y:auto;line-height:1.55;">${esc(conv.summary)}</div>`;
        } else {
          summaryArea.style.display = 'none';
        }
      }

      transferModal.style.display = 'flex';
    });
  }

  $('#transfer-cancel')?.addEventListener('click', () => { transferModal.style.display = 'none'; });
  $('#transfer-confirm')?.addEventListener('click', async () => {
    const toUserId = parseInt($('#transfer-user-select').value, 10);
    const reason   = $('#transfer-reason').value.trim();
    if (!toUserId) { showToast('請選擇客服人員', 'error'); return; }
    try {
      await api('POST', `/api/conversations/${state.activeConvId}/transfer`, { to_user_id: toUserId, reason });
      showToast('轉接成功', 'success');
      transferModal.style.display = 'none';
      await loadConversations();
    } catch (e) {
      showToast('轉接失敗：' + e.message, 'error');
    }
  });

  // 摘要按鈕
  $('#summarize-btn')?.addEventListener('click', async () => {
    if (!state.activeConvId || !state.currentClientId) return;
    $('#summarize-btn').disabled = true;
    try {
      const result = await api('POST', `/api/conversations/${state.activeConvId}/summarize`);
      if (result.summary) showSummary(result.summary, { action_required: result.action_required });
      showToast('摘要已更新', 'success');
    } catch (e) {
      showToast('摘要失敗：' + e.message, 'error');
    } finally {
      $('#summarize-btn').disabled = false;
    }
  });

  // 封鎖按鈕
  $('#block-btn')?.addEventListener('click', async () => {
    if (!state.activeCustomerId || !state.currentClientId) return;
    const cust = state.activeCustomer;
    if (cust?.is_blocked) {
      if (!confirm('解除封鎖這位顧客？')) return;
      try {
        await api('POST', `/api/customers/${state.activeCustomerId}/unblock`, { client_id: state.currentClientId });
        showToast('已解除封鎖', 'success');
        await reloadCustomer();
      } catch (e) { showToast('操作失敗：' + e.message, 'error'); }
    } else {
      const reason = prompt('封鎖原因（選填）：');
      if (reason === null) return;
      try {
        await api('POST', `/api/customers/${state.activeCustomerId}/block`, { reason, client_id: state.currentClientId });
        showToast('已封鎖顧客', 'success');
        await reloadCustomer();
      } catch (e) { showToast('操作失敗：' + e.message, 'error'); }
    }
  });

  // 對話標籤 input
  const tagInput = $('#tag-input');
  if (tagInput) {
    tagInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const val = tagInput.value.trim();
      if (!val || !state.activeConvId || !state.currentClientId) return;
      const newTags = [...new Set([...state.convTags, val])];
      try {
        await api('PUT', `/api/conversations/${state.activeConvId}/tags`, { tags: newTags });
        state.convTags = newTags;
        renderConvTags(newTags);
        tagInput.value = '';
        showToast('標籤已新增', 'success');
      } catch (e) { showToast('標籤更新失敗：' + e.message, 'error'); }
    });
  }

  // 搜尋框
  const searchInput = $('#search-input');
  const searchResults = $('#search-results');
  let searchTimer = null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = searchInput.value.trim();
      if (!q || !state.currentClientId) {
        searchResults.classList.add('hidden');
        return;
      }
      searchTimer = setTimeout(async () => {
        try {
          const data = await api('GET', `/api/search?client_id=${state.currentClientId}&q=${encodeURIComponent(q)}&limit=8`);
          renderSearchResults(data.matches || []);
        } catch {}
      }, 300);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        searchResults.classList.add('hidden');
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#search-wrap')) searchResults.classList.add('hidden');
    });
  }

  // 登出
  $('#logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST', headers: { 'x-csrf-token': getCsrfToken() } });
    location.href = '/login.html';
  });

  // Mobile tabs
  $$('.mtab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.mtab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.panel;
      $$('.panel').forEach(p => {
        if (p.dataset.panel === target) p.classList.remove('hidden');
        else p.classList.add('hidden');
      });
    });
  });

  // 定時刷新對話列表
  setInterval(loadConversations, 15000);

  // 桌面通知權限請求
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // admin 導覽連結顯示
  if (state.me.role === 'admin') {
    const rulesLink = $('#rules-link');
    const integrationsLink = $('#integrations-link');
    if (rulesLink) rulesLink.style.display = '';
    if (integrationsLink) integrationsLink.style.display = '';
  }

  // 我的狀態
  const myStatusWrap = $('#my-status-wrap');
  if (myStatusWrap) {
    myStatusWrap.style.display = '';
    updateMyStatusUI(state.me.online_status || 'online');
  }
  const mentionBell = $('#mention-bell');
  if (mentionBell) mentionBell.style.display = '';
  loadMentions();

  // heartbeat 每 30 秒
  setInterval(() => {
    if (state.socket?.connected) state.socket.emit('heartbeat');
  }, 30_000);

  // 關閉 status-dropdown（點外側）
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#my-status-wrap')) {
      $('#status-dropdown')?.classList.remove('open');
    }
  });

  // ── Aggressive Polling 啟動 ──
  startSync();
};

// ─── 搜尋結果渲染 ───
const renderSearchResults = (matches) => {
  const el = $('#search-results');
  if (!matches.length) {
    el.innerHTML = `
      <div style="padding:20px;text-align:center;color:var(--muted);">
        <div style="font-size:24px;margin-bottom:8px;">🔍</div>
        <div style="font-size:13px;">沒有符合的結果</div>
        <div style="font-size:12px;margin-top:4px;color:var(--text-disabled);">試試看不同關鍵字</div>
      </div>
    `;
  } else {
    el.innerHTML = matches.map(m => `
      <div class="search-result-item" onclick="jumpToConversation(${m.conversation_id})">
        <div style="font-size:12px;font-weight:600;color:var(--text-primary);">${esc(m.customer_name || '未知顧客')}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px;">${esc(m.snippet || '')}</div>
      </div>
    `).join('');
  }
  el.classList.remove('hidden');
};

const jumpToConversation = (convId) => {
  $('#search-input').value = '';
  $('#search-results').classList.add('hidden');
  const conv = state.conversations.find(c => c.id === convId);
  if (conv) selectConversation(conv);
};

// ─── Conversations ───
const loadConversations = async () => {
  const cid = state.currentClientId;
  const qs = cid ? `?client_id=${cid}` : '';
  const data = await api('GET', `/api/conversations${qs}`);
  state.conversations = data.conversations || [];
  // 移除 skeleton
  const skeleton = $('#conv-skeleton');
  if (skeleton) skeleton.remove();
  renderConvList();
};

// ─── 頭貼 HTML 生成（首字圓 / img + fallback）───
const makeAvatarHtml = (name, avatarUrl, size = 48) => {
  const color = getAvatarColor(name);
  const initial = getInitial(name);
  const fSize = Math.floor(size * 0.4);
  const fallbackStyle = `width:${size}px;height:${size}px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:${fSize}px;font-weight:600;color:#fff;flex-shrink:0;`;
  const fallbackHtml = `<div style="${fallbackStyle}">${initial}</div>`;

  if (avatarUrl) {
    // 使用 wrap + hidden fallback 方式，避免 onerror 裡呼叫函數的 CSP 問題
    const wrapStyle = `position:relative;display:inline-flex;width:${size}px;height:${size}px;flex-shrink:0;`;
    const imgStyle = `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;`;
    // onerror: 隱藏 img、顯示 fallback div
    return `<div style="${wrapStyle}">
      <img src="${esc(avatarUrl)}" alt="${esc(name || '?')}" style="${imgStyle}" loading="lazy"
        onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
      <div style="${fallbackStyle}display:none;">${initial}</div>
    </div>`;
  }
  return fallbackHtml;
};

// onerror fallback（需要全域函數）
window.makeInitialAvatar = (name, size = 48) => {
  const el = document.createElement('div');
  const color = getAvatarColor(name);
  const initial = getInitial(name);
  const fSize = Math.floor(size * 0.4);
  el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:${fSize}px;font-weight:600;color:#fff;flex-shrink:0;`;
  el.textContent = initial;
  return el;
};

const renderConvList = () => {
  const filtered = state.statusFilter
    ? state.conversations.filter(c => c.status === state.statusFilter)
    : state.conversations;

  const list = $('#conv-list');
  const empty = $('#conv-empty');

  $$('.conv-item').forEach(el => el.remove());

  if (!filtered.length) {
    if (empty) empty.style.display = '';
    return;
  }

  if (empty) empty.style.display = 'none';

  filtered.forEach(conv => {
    const div = document.createElement('div');
    const isUnread = (conv.unread_count || 0) > 0;
    div.className = 'conv-item' +
      (conv.id === state.activeConvId ? ' active' : '') +
      (isUnread ? ' unread' : '') +
      (conv.pinned ? ' pinned' : '') +
      (conv.archived ? ' archived' : '');
    div.dataset.id = conv.id;
    div.dataset.convId = conv.id; // swipe 手勢用

    const name    = conv.customer_name || '未知顧客';
    const preview = conv.last_message_preview || '尚無訊息';
    const time    = fmtTime(conv.last_message_at);
    const cls     = channelClass(conv.channel);
    const chIcon  = channelIcon(conv.channel);
    const emotionStr = conv.emotion ? emotionEmoji(conv.emotion) : '';

    // 頭貼（customer_avatar_url 來自 LEFT JOIN customer_channels）
    const avatarHtml = makeAvatarHtml(name, conv.customer_avatar_url || conv.channel_avatar_url || conv.avatar_url, 48);

    // 對話標籤
    let tagsHtml = '';
    try {
      const tags = JSON.parse(conv.tags || '[]');
      if (tags.length) {
        const visible = tags.slice(0, 2);
        const more = tags.length > 2 ? `<span class="conv-tag-chip">+${tags.length - 2}</span>` : '';
        tagsHtml = `<div class="conv-tag-row">${visible.map(t => `<span class="conv-tag-chip">${esc(t)}</span>`).join('')}${more}</div>`;
      }
    } catch {}

    // SLA 燈號
    let slaHtml = '';
    if (conv.sla_status === 'warning' || conv.sla_status === 'breached') {
      const mins = conv.sla_wait_minutes || 0;
      if (conv.sla_status === 'breached') {
        slaHtml = `<div class="sla-breached">超時 ${mins} 分鐘</div>`;
      } else {
        slaHtml = `<div class="sla-warning">待回覆 ${mins} 分鐘</div>`;
      }
    }

    div.innerHTML = `
      <div class="conv-avatar" style="position:relative;flex-shrink:0;">
        ${avatarHtml}
        <span class="channel-badge ${cls}">${chIcon}</span>
      </div>
      <div class="conv-info">
        <div class="conv-name">${esc(name)}${emotionStr ? ` <span style="font-weight:400;">${emotionStr}</span>` : ''}</div>
        <div class="conv-preview">${esc(preview)}</div>
        ${slaHtml}
        ${tagsHtml}
      </div>
      <div class="conv-meta">
        <span class="conv-time">${time}</span>
        ${isUnread ? `<span class="unread-badge">${conv.unread_count}</span>` : ''}
        ${conv.urgency === 'high' ? '<span class="urgency-badge">緊急</span>' : ''}
        ${conv.pinned ? '<span class="pin-icon">📌</span>' : ''}
      </div>
    `;

    // ─── 長按進批次選取模式（手機專用）───
    let _longPressTimer = null;
    div.addEventListener('touchstart', () => {
      _longPressTimer = setTimeout(() => {
        _longPressTimer = null;
        _enterSelectMode(div, conv.id);
      }, 550);
    }, { passive: true });
    div.addEventListener('touchend', () => {
      if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
    }, { passive: true });
    div.addEventListener('touchmove', () => {
      if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
    }, { passive: true });

    div.addEventListener('click', () => {
      // 批次選取模式中，點擊為 toggle 選取
      if (_bulkSelectMode) {
        _toggleBulkItem(div, conv.id);
        return;
      }
      selectConversation(conv);
    });
    list.appendChild(div);
  });
};

// ─── 批次選取模式 ───
let _bulkSelectMode = false;
const _bulkSelectedIds = new Set();

const _enterSelectMode = (startEl, convId) => {
  _bulkSelectMode = true;
  _bulkSelectedIds.clear();
  _toggleBulkItem(startEl, convId);

  // 震動反饋（如果支援）
  if (navigator.vibrate) navigator.vibrate(40);

  // 顯示批次操作工具列
  _showBulkBar();
};

const _toggleBulkItem = (el, convId) => {
  if (_bulkSelectedIds.has(convId)) {
    _bulkSelectedIds.delete(convId);
    el.classList.remove('selected');
  } else {
    _bulkSelectedIds.add(convId);
    el.classList.add('selected');
  }
  // 更新計數
  const countEl = document.getElementById('bulk-count');
  if (countEl) countEl.textContent = `已選 ${_bulkSelectedIds.size} 個`;

  // 全部取消選取時退出批次模式
  if (_bulkSelectedIds.size === 0) _exitBulkMode();
};

const _showBulkBar = () => {
  let bar = document.getElementById('mobile-bulk-bar');
  if (bar) { bar.style.display = 'flex'; return; }

  bar = document.createElement('div');
  bar.id = 'mobile-bulk-bar';
  bar.className = 'bulk-bar';
  bar.style.bottom = '60px'; // 手機版在 tab bar 上方
  bar.innerHTML = `
    <span id="bulk-count">已選 0 個</span>
    <button onclick="_bulkMarkRead()">標已讀</button>
    <button onclick="_bulkSetPending()">跟催</button>
    <button onclick="_bulkClose()">結束</button>
    <button onclick="_exitBulkMode()" style="background:rgba(255,255,255,0.1);">取消</button>
  `;
  document.body.appendChild(bar);
};

const _exitBulkMode = () => {
  _bulkSelectMode = false;
  _bulkSelectedIds.clear();
  $$('.conv-item.selected').forEach(el => el.classList.remove('selected'));
  const bar = document.getElementById('mobile-bulk-bar');
  if (bar) bar.remove();
};

window._exitBulkMode = _exitBulkMode;

// ─── Bulk menu / mark-all 操作 ───
window._toggleBulkMenu = () => {
  const menu = document.getElementById('bulk-menu');
  if (menu) menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
};

window._markAllRead = async () => {
  if (!confirm('確定把全部對話的紅色未讀數歸零？')) return;
  try {
    const r = await api('POST', '/api/conversations/mark-all-read', {});
    if (typeof showToast === 'function') showToast(`已標 ${r.count || 0} 個對話為已讀`, 'success');
    state.conversations.forEach(c => { c.unread_count = 0; });
    if (typeof renderConvList === 'function') renderConvList();
  } catch (e) {
    if (typeof showToast === 'function') showToast('失敗：' + e.message, 'error');
  }
  document.getElementById('bulk-menu').style.display = 'none';
};

window._markAllHandled = async () => {
  if (!confirm('把所有「進行中」對話標為「LINE 已處理」？\n（status 變 pending、紅色未讀消失，視為你已從 LINE OA 那邊回覆）')) return;
  try {
    const r = await api('POST', '/api/conversations/mark-handled-externally', {});
    if (typeof showToast === 'function') showToast(`已標 ${r.count || 0} 個為 LINE 處理過`, 'success');
    state.conversations.forEach(c => {
      if (c.status === 'open') { c.status = 'pending'; c.unread_count = 0; }
    });
    if (typeof renderConvList === 'function') renderConvList();
  } catch (e) {
    if (typeof showToast === 'function') showToast('失敗：' + e.message, 'error');
  }
  document.getElementById('bulk-menu').style.display = 'none';
};

window._markActiveAsHandled = async () => {
  if (!state.activeConvId) {
    if (typeof showToast === 'function') showToast('請先選一個對話', 'info');
    return;
  }
  try {
    await api('POST', '/api/conversations/mark-handled-externally', { ids: [state.activeConvId] });
    const c = state.conversations.find(x => x.id === state.activeConvId);
    if (c) { c.status = 'pending'; c.unread_count = 0; }
    if (typeof renderConvList === 'function') renderConvList();
    if (typeof showToast === 'function') showToast('已標為 LINE 處理過', 'success');
  } catch (e) {
    if (typeof showToast === 'function') showToast('失敗：' + e.message, 'error');
  }
  document.getElementById('bulk-menu').style.display = 'none';
};

// 點外側關 menu
document.addEventListener('click', (e) => {
  if (!e.target.closest('#bulk-menu') && !e.target.closest('#bulk-actions-btn')) {
    const menu = document.getElementById('bulk-menu');
    if (menu) menu.style.display = 'none';
  }
});

window._bulkMarkRead = async () => {
  const ids = [..._bulkSelectedIds];
  await Promise.all(ids.map(id => api('POST', `/api/conversations/${id}/read`).catch(() => {})));
  if (typeof showToast === 'function') showToast(`${ids.length} 個已標為已讀`, 'success');
  _exitBulkMode();
};

window._bulkSetPending = async () => {
  const ids = [..._bulkSelectedIds];
  await Promise.all(ids.map(id => api('PATCH', `/api/conversations/${id}`, { status: 'pending' }).catch(() => {})));
  if (typeof showToast === 'function') showToast(`${ids.length} 個已標為待處理`, 'success');
  _exitBulkMode();
  if (typeof renderConvList === 'function') renderConvList();
};

window._bulkClose = async () => {
  const ids = [..._bulkSelectedIds];
  await Promise.all(ids.map(id => api('PATCH', `/api/conversations/${id}`, { status: 'closed' }).catch(() => {})));
  if (typeof showToast === 'function') showToast(`${ids.length} 個已結束`, 'success');
  _exitBulkMode();
  if (typeof renderConvList === 'function') renderConvList();
};

const selectConversation = async (conv) => {
  state.activeConvId = conv.id;
  state.activeConv = conv;

  // 清除未讀
  conv.unread_count = 0;

  // 高亮
  $$('.conv-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.id) === conv.id);
    if (parseInt(el.dataset.id) === conv.id) el.classList.remove('unread');
  });

  const name = conv.customer_name || '未知顧客';

  // 更新 header 頭像
  const chatAvatar = $('#chat-avatar');
  if (chatAvatar) {
    chatAvatar.innerHTML = makeAvatarHtml(name, conv.customer_avatar_url || conv.channel_avatar_url || conv.avatar_url, 40);
    chatAvatar.style.cssText = 'position:relative;flex-shrink:0;cursor:pointer;';
    chatAvatar.onclick = () => {
      if (state.activeCustomerId) {
        const cid = state.currentClientId ? `&client_id=${state.currentClientId}` : '';
        window.open(`/admin/customer-timeline.html?id=${state.activeCustomerId}${cid}`, '_blank');
      }
    };
  }

  // 更新 header 文字
  $('#chat-header-name').textContent = name;
  const chLabel = conv.channel === 'line' ? 'LINE' : (conv.channel === 'ig' ? 'Instagram' : 'FB Messenger');
  $('#chat-header-sub').textContent = `${chLabel} · ${statusLabel(conv.status)}`;
  $('#conv-status-select').value = conv.status;
  renderHeaderBadges(conv);

  // 摘要
  if (conv.summary) showSummary(conv.summary);
  else hideSummary();

  // 啟用輸入
  $('#send-btn').disabled = !$('#msg-input').value.trim();
  $('#msg-input').disabled = false;
  $('#msg-input').placeholder = '輸入訊息… (Enter 送出，Shift+Enter 換行)';

  // 切換對話時清除品牌教練評分
  hideBrandCoachBar();
  state._bcLastScore   = null;
  state._bcLastRewrite = null;
  // 載入業主門檻（async，背景）
  if (state.currentClientId) loadBrandCoachThreshold(state.currentClientId).catch(() => {});

  // 啟用操作按鈕
  $('#draft-btn').disabled = false;
  $('#transfer-btn').disabled = false;
  $('#summarize-btn').disabled = false;
  $('#block-btn').disabled = false;
  const timelineBtn = $('#timeline-btn');
  if (timelineBtn) timelineBtn.disabled = false;

  // 初始化對話標籤
  let convTags = [];
  try { convTags = JSON.parse(conv.tags || '[]'); } catch {}
  state.convTags = convTags;
  renderConvTags(convTags);

  // 顧客資訊
  state.activeCustomerId = conv.customer_id ?? null;
  $('#c-name').textContent  = name;
  $('#c-phone').textContent = '—';
  $('#c-email').textContent = '—';
  $('#c-notes').textContent = '';

  const editBtn = $('#edit-customer-btn');
  if (editBtn) editBtn.disabled = !state.activeCustomerId;

  // 非同步載入完整顧客資料
  if (state.activeCustomerId && state.currentClientId) {
    reloadCustomer();
  }

  // Mobile: 切到 chat panel
  if (window.innerWidth <= 768) {
    $$('.panel').forEach(p => p.classList.add('hidden'));
    $('#main').classList.remove('hidden');
    $$('.mtab').forEach(t => t.classList.toggle('active', t.dataset.panel === 'chat'));
  } else {
    $('#main').classList.remove('hidden');
    $('#right-panel').classList.remove('hidden');
  }

  // 切換對話時先隱藏建議區，避免顯示前一個對話的舊建議
  const _sugBar = $('#suggestion-bar');
  if (_sugBar) _sugBar.style.display = 'none';

  // 顯示訊息 skeleton
  showMessageSkeleton();
  await loadMessages(conv.id);
  loadTemplates();
};

// 訊息 skeleton
const showMessageSkeleton = () => {
  const container = $('#messages-container');
  const placeholder = $('#chat-placeholder');
  if (placeholder) placeholder.style.display = 'none';
  $$('.bubble-row, .date-divider, .note-row, .system-row, .msg-skeleton-row').forEach(el => el.remove());

  const skeletons = [
    { cls: '', w: '55%' },
    { cls: 'right', w: '45%' },
    { cls: '', w: '65%' },
  ];
  skeletons.forEach(s => {
    const row = document.createElement('div');
    row.className = `msg-skeleton-row ${s.cls}`;
    row.innerHTML = `<div class="msg-skeleton-circle"></div><div class="msg-skeleton-bubble" style="width:${s.w};"></div>`;
    container.appendChild(row);
  });
};

const reloadCustomer = async () => {
  if (!state.activeCustomerId || !state.currentClientId) return;
  try {
    const data = await api('GET', `/api/customers/${state.activeCustomerId}?client_id=${state.currentClientId}`);
    const c = data.customer;
    if (!c) return;
    state.activeCustomer = c;

    $('#c-name').textContent  = c.name  || '—';
    $('#c-phone').textContent = c.phone || '—';
    $('#c-email').textContent = c.email || '—';
    $('#c-notes').textContent = c.notes || '';

    // 顧客標籤
    const tagsEl2 = $('#c-tags');
    tagsEl2.innerHTML = '';
    let tags2 = [];
    try { tags2 = JSON.parse(c.tags || '[]'); } catch {}
    if (tags2.length) {
      tags2.forEach(t => {
        const span = document.createElement('span');
        span.className = 'tag';
        span.textContent = t;
        tagsEl2.appendChild(span);
      });
    } else {
      tagsEl2.innerHTML = '<span class="text-muted text-sm">尚無標籤</span>';
    }

    // 封鎖狀態
    const blockedBar = $('#c-blocked-bar');
    const blockBtn   = $('#block-btn');
    if (c.is_blocked) {
      blockedBar.classList.remove('hidden');
      $('#c-blocked-reason').textContent = c.blocked_reason || '無';
      if (blockBtn) { blockBtn.textContent = '解除封鎖'; blockBtn.style.color = 'var(--primary)'; blockBtn.style.borderColor = 'rgba(6,199,85,0.3)'; }
    } else {
      blockedBar.classList.add('hidden');
      if (blockBtn) { blockBtn.textContent = '封鎖顧客'; blockBtn.style.color = 'var(--err)'; blockBtn.style.borderColor = 'rgba(229,57,53,0.3)'; }
    }

    // 自訂屬性
    const cfSection = $('#custom-fields-section');
    const cfView    = $('#custom-fields-view');
    let cf = {};
    try { cf = JSON.parse(c.custom_fields || '{}'); } catch {}
    const cfEntries = Object.entries(cf).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (cfEntries.length) {
      cfSection.style.display = '';
      cfView.innerHTML = cfEntries.map(([k, v]) =>
        `<div class="info-row"><span class="info-label" style="width:80px;">${esc(k)}</span><span class="info-value">${esc(String(v))}</span></div>`
      ).join('');
    } else {
      cfSection.style.display = 'none';
    }

    // 訂單歷史
    loadCustomerOrders(state.activeCustomerId, state.currentClientId);

    // 會員資訊
    loadMembership(state.activeCustomerId, state.currentClientId);

    // BV 動作面板（需顧客已連結 BV）
    loadBvActions(state.activeCustomerId, state.currentClientId);

    // 時間軸按鈕
    const timelineBtn = $('#timeline-btn');
    if (timelineBtn && state.activeCustomerId) {
      timelineBtn.onclick = () => {
        const cid = state.currentClientId ? `&client_id=${state.currentClientId}` : '';
        window.open(`/admin/customer-timeline.html?id=${state.activeCustomerId}${cid}`, '_blank');
      };
    }
  } catch {}
};

// ─── 訂單歷史（P4）───
const orderStatusStyle = {
  pending:   'background:#e5e5ea;color:#555',
  paid:      'background:#cce5ff;color:#004085',
  shipped:   'background:#fff3cd;color:#856404',
  delivered: 'background:#d1f7e0;color:#1b7c3e',
  cancelled: 'background:#ffe0e0;color:#b00020',
  refunded:  'background:#f3d6f5;color:#6f42c1',
};
const orderStatusLabel = { pending:'待付款', paid:'已付款', shipped:'已出貨', delivered:'已送達', cancelled:'已取消', refunded:'已退款' };

const loadCustomerOrders = async (customerId, clientId) => {
  const section = $('#orders-section');
  const listEl  = $('#orders-list');
  const countEl = $('#orders-count');
  if (!section || !listEl) return;
  try {
    const data = await api('GET', `/api/orders?customer_id=${customerId}&client_id=${clientId}&limit=5`);
    const orders = data.orders || [];
    if (!orders.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    countEl.textContent = `(${orders.length})`;
    listEl.innerHTML = orders.map(o => {
      const style = orderStatusStyle[o.status] || orderStatusStyle.pending;
      const label = orderStatusLabel[o.status] || o.status;
      let items = [];
      try { items = JSON.parse(o.items_json || '[]'); } catch {}
      const itemSummary = items.slice(0,2).map(i => i.name || i.sku || '商品').join('、') + (items.length > 2 ? '…' : '');
      const isBv = o.source === 'bvshop';
      return `<div style="padding:9px 0;border-bottom:1px solid var(--border-light);" data-order-id="${o.id}">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
          ${isBv
            ? `<a href="javascript:void(0)" onclick="openBvOrderModal(${o.id})" style="font-size:11px;color:var(--info);font-family:monospace;text-decoration:none;cursor:pointer;">${esc(o.external_order_id)} 🔍</a>`
            : `<code style="font-size:11px;color:var(--info);font-family:monospace;">${esc(o.external_order_id)}</code>`}
          <span style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:var(--radius-pill);${style}">${esc(label)}</span>
        </div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:3px;">NT$ ${o.total_amount ?? '-'} ${itemSummary ? '· ' + esc(itemSummary) : ''}</div>
        ${o.tracking_number ? `<div style="font-size:11px;margin-top:3px;"><a href="https://www.t-cat.com.tw/inquire/trace.aspx?no=${esc(o.tracking_number)}" target="_blank" style="color:var(--info);text-decoration:none;">物流追蹤：${esc(o.tracking_number)}</a></div>` : ''}
        ${isBv ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-secondary bv-order-status-btn" data-order-id="${o.id}" style="font-size:10px;padding:3px 8px;">改狀態</button>
          <button class="btn btn-secondary bv-order-logistic-btn" data-order-id="${o.id}" style="font-size:10px;padding:3px 8px;">綠界物流單</button>
        </div>` : ''}
      </div>`;
    }).join('');
    // 綁訂單動作
    listEl.querySelectorAll('.bv-order-status-btn').forEach(btn => {
      btn.onclick = () => bvOrderChangeStatus(parseInt(btn.dataset.orderId, 10));
    });
    listEl.querySelectorAll('.bv-order-logistic-btn').forEach(btn => {
      btn.onclick = () => bvOrderCreateLogistic(parseInt(btn.dataset.orderId, 10), btn);
    });
  } catch { section.style.display = 'none'; }
};

// ─── BV 動作面板：根據業主有無設 BV / 顧客有無連結，渲染對應 UI ───
const loadBvActions = async (customerId, clientId) => {
  const section = $('#bv-actions-section');
  const statusEl = $('#bv-link-status');
  const linkPrompt = $('#bv-link-prompt');
  const actionBtns = $('#bv-actions-buttons');
  if (!section || !customerId || !clientId) {
    if (section) section.style.display = 'none';
    return;
  }
  // 先檢查業主有沒設 BV（從 client info 看 has_bv_api_key）
  try {
    const cdata = await api('GET', `/api/clients`);
    const cinfo = cdata?.clients?.find(c => c.id === clientId);
    if (!cinfo?.has_bv_api_key) {
      section.style.display = 'none';
      return;
    }
  } catch { /* 一般 agent 沒權限取 /api/clients，繼續 */ }

  try {
    const data = await api('GET', `/api/customers/${customerId}?client_id=${clientId}`);
    const cust = data.customer || data;
    section.style.display = '';
    if (cust && cust.bv_customer_id) {
      if (statusEl) statusEl.textContent = `BV id #${cust.bv_customer_id}`;
      linkPrompt.style.display = 'none';
      actionBtns.style.display = '';
    } else {
      if (statusEl) statusEl.textContent = '未連結';
      linkPrompt.style.display = '';
      actionBtns.style.display = 'none';
    }
  } catch {
    section.style.display = 'none';
  }
};

// ─── 搜尋並連結 BV 會員（支援 email / 電話 / LINE userid / BV ID）───
const bvDoLink = async (bvId, displayName) => {
  if (!state.activeConvId) return;
  const conv = state.conversations?.find(c => c.id === state.activeConvId);
  const customerId = conv?.customer_id;
  if (!customerId) return;
  const statusEl = $('#bv-link-status-msg');
  statusEl.textContent = '連結中…';
  try {
    const r = await api('PUT', `/api/customers/${customerId}/bv-link`, { bv_customer_id: bvId });
    if (r.ok) {
      const synced = r.synced ? `（已同步：${[r.synced.fullName, r.synced.email, r.synced.phone, r.synced.level].filter(Boolean).join(' / ')}）` : '';
      statusEl.textContent = `✅ 連結成功 ${synced}`;
      toast(`已連結 ${displayName || ('BV #' + bvId)}`, 'success');
      // 重整顧客視圖（補齊資料會更新）
      setTimeout(() => {
        loadBvActions(customerId, state.currentClientId);
        loadConversations?.();
      }, 500);
    } else {
      statusEl.textContent = '❌ ' + (r.error || `HTTP ${r.status}`);
    }
  } catch (e) { statusEl.textContent = '❌ ' + e.message; }
};

const bvLinkConfirm = async () => {
  const q = $('#bv-link-id').value.trim();
  const statusEl = $('#bv-link-status-msg');
  const resultsEl = $('#bv-link-results');
  resultsEl.innerHTML = '';
  if (!q) { statusEl.textContent = '請輸入 email / 電話 / LINE userid / BV ID'; return; }
  if (!state.activeConvId) return;
  const conv = state.conversations?.find(c => c.id === state.activeConvId);
  const customerId = conv?.customer_id;
  if (!customerId) { statusEl.textContent = '此對話無顧客'; return; }

  statusEl.textContent = '搜尋中…';
  try {
    const r = await api('GET', `/api/customers/${customerId}/bv-search?q=${encodeURIComponent(q)}`);
    if (!r.ok) { statusEl.textContent = '❌ ' + (r.error || '搜尋失敗'); return; }
    const list = r.customers || [];
    if (!list.length) { statusEl.textContent = `❌ 找不到符合「${q}」的會員`; return; }
    if (list.length === 1) {
      // 自動連結
      const c = list[0];
      const display = `${c.fullName || '(無名)'} · ${c.email || c.phone || c.lineUid || '#' + c.id}`;
      statusEl.textContent = `找到唯一符合：${display}，自動連結中…`;
      await bvDoLink(c.id, display);
      return;
    }
    // 多筆 → 顯示清單讓 agent 點選
    statusEl.textContent = `找到 ${list.length} 筆符合，請選擇：`;
    resultsEl.innerHTML = list.slice(0, 10).map(c => `
      <div class="bv-link-row" data-bv-id="${c.id}" style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:#fff;border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:4px;cursor:pointer;font-size:12px;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;">${esc(c.fullName || '(無名)')}</div>
          <div style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${esc(c.email || '')} ${c.phone ? '· ' + esc(c.phone) : ''} ${c.memberLevel?.name ? '· ' + esc(c.memberLevel.name) : ''}
          </div>
        </div>
        <button class="btn btn-primary" style="font-size:11px;padding:4px 10px;">連結</button>
      </div>
    `).join('');
    resultsEl.querySelectorAll('.bv-link-row').forEach(row => {
      const bvId = parseInt(row.dataset.bvId, 10);
      const display = row.querySelector('div > div')?.textContent || ('BV #' + bvId);
      row.onclick = () => bvDoLink(bvId, display);
    });
  } catch (e) { statusEl.textContent = '❌ ' + e.message; }
};
const bvUnlink = async () => {
  if (!confirm('解除此顧客與 BV 的連結？')) return;
  if (!state.activeConvId) return;
  const conv = state.conversations?.find(c => c.id === state.activeConvId);
  const customerId = conv?.customer_id;
  if (!customerId) return;
  try {
    await api('PUT', `/api/customers/${customerId}/bv-link`, { bv_customer_id: 0 });
    toast('已解除連結', 'success');
    loadBvActions(customerId, state.currentClientId);
  } catch (e) { toast('失敗：' + e.message, 'error'); }
};

// ─── 發購物金 ───
const bvOpenSendPoint = () => {
  $('#bv-send-point-form').style.display = '';
  $('#bv-edit-customer-form').style.display = 'none';
  $('#bv-point-title').value = '';
  $('#bv-point-amount').value = '';
  $('#bv-point-reason').value = '';
  $('#bv-send-point-status').textContent = '';
};
const bvSendPointConfirm = async () => {
  const title = $('#bv-point-title').value.trim();
  const point = parseInt($('#bv-point-amount').value, 10);
  const reason = $('#bv-point-reason').value.trim();
  const statusEl = $('#bv-send-point-status');
  if (!title) { statusEl.textContent = '請輸入標題'; return; }
  if (!point) { statusEl.textContent = '請輸入金額'; return; }
  if (!state.activeConvId) return;
  const conv = state.conversations?.find(c => c.id === state.activeConvId);
  const customerId = conv?.customer_id;
  if (!customerId) { statusEl.textContent = '此對話無顧客'; return; }
  statusEl.textContent = '發送中…';
  try {
    const r = await api('POST', `/api/customers/${customerId}/bv-send-point`, { title, point, reason });
    if (r.ok) {
      statusEl.textContent = '✅ 已發送';
      toast(`購物金已發送：${point} 點 (${title})`, 'success');
      setTimeout(() => $('#bv-send-point-form').style.display = 'none', 1500);
    } else {
      statusEl.textContent = '❌ ' + (r.error || `HTTP ${r.status}`);
    }
  } catch (e) {
    statusEl.textContent = '❌ ' + e.message;
  }
};

// ─── 改 BV 顧客資料 ───
const bvOpenEditCustomer = () => {
  $('#bv-edit-customer-form').style.display = '';
  $('#bv-send-point-form').style.display = 'none';
  // 把當前顧客資料預填
  $('#bv-edit-name').value = $('#c-name')?.textContent !== '—' ? ($('#c-name').textContent || '') : '';
  $('#bv-edit-phone').value = $('#c-phone')?.textContent !== '—' ? ($('#c-phone').textContent || '') : '';
  $('#bv-edit-email').value = $('#c-email')?.textContent !== '—' ? ($('#c-email').textContent || '') : '';
  $('#bv-edit-city').value = '';
  $('#bv-edit-address').value = '';
  $('#bv-edit-customer-status').textContent = '';
};
const bvEditCustomerConfirm = async () => {
  const fields = {};
  const get = (id) => $(`#${id}`).value.trim();
  if (get('bv-edit-name')) fields.fullName = get('bv-edit-name');
  if (get('bv-edit-phone')) fields.phone = get('bv-edit-phone');
  if (get('bv-edit-email')) fields.email = get('bv-edit-email');
  if (get('bv-edit-city')) fields.city = get('bv-edit-city');
  if (get('bv-edit-address')) fields.address = get('bv-edit-address');
  const statusEl = $('#bv-edit-customer-status');
  if (!Object.keys(fields).length) { statusEl.textContent = '至少填一個欄位'; return; }
  if (!state.activeConvId) return;
  const conv = state.conversations?.find(c => c.id === state.activeConvId);
  const customerId = conv?.customer_id;
  if (!customerId) { statusEl.textContent = '此對話無顧客'; return; }
  statusEl.textContent = '更新中…';
  try {
    const r = await api('PUT', `/api/customers/${customerId}/bv-update`, { fields });
    if (r.ok) {
      statusEl.textContent = '✅ 已同步';
      toast('BV 顧客資料已更新', 'success');
      setTimeout(() => $('#bv-edit-customer-form').style.display = 'none', 1500);
      // 重新載入顧客
      if (typeof loadConversations === 'function') loadConversations();
    } else {
      statusEl.textContent = '❌ ' + (r.error || `HTTP ${r.status}`);
    }
  } catch (e) {
    statusEl.textContent = '❌ ' + e.message;
  }
};

// ─── 改訂單狀態 ───
const bvOrderChangeStatus = async (orderId) => {
  const choice = prompt('改訂單狀態：\n  o1=訂單成立 / o2=待確認 / o4=已完成 / o-3=已取消\n  p1=未付款 / p2=已付款 / p-1=已退款\n  l1=未出貨 / l2=處理中 / l3=已出貨 / l4=已配達 / l-1=已退貨\n\n填代碼（例：l3）：');
  if (!choice) return;
  const code = choice.trim();
  const fields = {};
  if (code.startsWith('o')) fields.orderStatus = parseInt(code.slice(1), 10);
  else if (code.startsWith('p')) fields.paymentStatus = parseInt(code.slice(1), 10);
  else if (code.startsWith('l')) fields.logisticStatus = parseInt(code.slice(1), 10);
  else { toast('代碼格式錯誤', 'error'); return; }
  try {
    const r = await api('PUT', `/api/orders/${orderId}/bv-update`, { fields });
    if (r.ok) {
      toast('訂單已更新', 'success');
      // 重整顧客訂單
      const cid = state.activeConvId && state.conversations?.find(c=>c.id===state.activeConvId)?.customer_id;
      if (cid) loadCustomerOrders(cid, state.currentClientId);
    } else {
      toast('失敗：' + (r.error || `HTTP ${r.status}`), 'error');
    }
  } catch (e) { toast('錯誤：' + e.message, 'error'); }
};

// ─── 產生綠界物流單 ───
const bvOrderCreateLogistic = async (orderId, btn) => {
  if (!confirm('確認對此訂單產生綠界物流單？')) return;
  if (btn) { btn.disabled = true; btn.textContent = '產生中…'; }
  try {
    const r = await api('POST', `/api/orders/${orderId}/bv-create-logistic`);
    if (r.ok) {
      toast('物流單已產生', 'success');
      const cid = state.activeConvId && state.conversations?.find(c=>c.id===state.activeConvId)?.customer_id;
      if (cid) loadCustomerOrders(cid, state.currentClientId);
    } else {
      toast('失敗：' + (r.error || `HTTP ${r.status}`), 'error');
    }
  } catch (e) {
    toast('錯誤：' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '綠界物流單'; }
  }
};

// 暴露給 inline onclick
window.bvOrderChangeStatus = bvOrderChangeStatus;
window.bvOrderCreateLogistic = bvOrderCreateLogistic;

// ─── Slash commands（在訊息輸入框打 /xxx）───
const SLASH_HELP = `可用 slash 指令：
  /order <BV訂單ID>           開訂單詳情 modal（從 BV 即時抓）
  /sku <SKU>                  查商品庫存 → 結果寫進備忘
  /point <金額> <標題>         發購物金給目前對話顧客
  /track                      把目前顧客最近一筆訂單的追蹤連結貼進輸入框
  /help                       顯示此說明`;

const handleSlashCommand = async (raw) => {
  const trimmed = raw.trim();
  const m = trimmed.match(/^\/(\w+)(?:\s+(.+))?$/);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || '').trim();
  const conv = state.conversations?.find(c => c.id === state.activeConvId);
  const customerId = conv?.customer_id;
  const clientId = state.currentClientId;

  switch (cmd) {
    case 'help':
      toast(SLASH_HELP, 'info', 8000);
      return true;

    case 'order': {
      if (!arg) { toast('用法：/order <BV訂單ID 或 UID>', 'warning'); return true; }
      // 試本地：external_order_id 對得到的話走本地 modal
      try {
        const data = await api('GET', `/api/orders?client_id=${clientId}&limit=200`);
        const local = (data.orders || []).find(o => String(o.external_order_id) === arg);
        if (local) { window.openBvOrderModal(local.id); return true; }
        // 否則直接 BV 抓
        const r = await api('GET', `/api/bv/order/${encodeURIComponent(arg)}?client_id=${clientId}`);
        if (r.ok) {
          // 用 modal 包裝顯示
          window.openBvOrderModalFromData?.(r.order) || (() => {
            // fallback：將 order 暫存後手動開啟
            const fakeId = 'remote_' + arg;
            window._bvRemoteOrder = r.order;
            const modal = document.getElementById('bv-order-modal');
            const body = document.getElementById('bv-order-modal-body');
            const uidEl = document.getElementById('bv-order-modal-uid');
            uidEl.textContent = `#${r.order.uid || r.order.id}`;
            body.innerHTML = `<pre style="white-space:pre-wrap;font-size:11px;font-family:monospace;background:#f8f8f8;padding:10px;border-radius:4px;">${esc(JSON.stringify(r.order, null, 2).slice(0, 4000))}</pre>`;
            modal.style.display = 'flex';
          })();
        } else {
          toast(`找不到訂單：${arg}`, 'error');
        }
      } catch (e) { toast(e.message, 'error'); }
      return true;
    }

    case 'sku': {
      if (!arg) { toast('用法：/sku <SKU>', 'warning'); return true; }
      try {
        const r = await api('GET', `/api/bv/inventory/${encodeURIComponent(arg)}?client_id=${clientId}`);
        if (r.ok) {
          const inv = r.inventory;
          const stock = inv.quantity ?? inv.stock ?? inv.amount ?? '?';
          const note = `📦 SKU ${arg}：庫存 ${stock}${inv.name ? '（' + inv.name + '）' : ''}`;
          toast(note, 'success', 6000);
          // 把資訊放進輸入框（agent 可決定要不要送給顧客）
          const inputEl = $('#msg-input');
          inputEl.value = note;
          inputEl.dispatchEvent(new Event('input'));
        } else {
          toast(`查不到 SKU ${arg}：${r.error}`, 'error');
        }
      } catch (e) { toast(e.message, 'error'); }
      return true;
    }

    case 'point': {
      if (!customerId) { toast('此對話無顧客', 'warning'); return true; }
      const parts = arg.split(/\s+/);
      const point = parseInt(parts[0], 10);
      const title = parts.slice(1).join(' ').trim();
      if (!point || !title) { toast('用法：/point <金額> <標題>（例：/point 100 客訴補償）', 'warning'); return true; }
      try {
        const r = await api('POST', `/api/customers/${customerId}/bv-send-point`, { title, point });
        if (r.ok) toast(`✅ 已發送 ${point} 點購物金（${title}）`, 'success');
        else toast(`❌ ${r.error || ''}（記得先連結 BV 會員）`, 'error');
      } catch (e) { toast(e.message, 'error'); }
      return true;
    }

    case 'track': {
      if (!customerId) { toast('此對話無顧客', 'warning'); return true; }
      try {
        const data = await api('GET', `/api/orders?customer_id=${customerId}&client_id=${clientId}&limit=10`);
        const orders = data.orders || [];
        const latest = orders.find(o => o.tracking_number) || orders[0];
        if (!latest) { toast('此顧客無訂單', 'warning'); return true; }
        if (!latest.tracking_number) { toast(`最新訂單 ${latest.external_order_id} 尚無追蹤碼`, 'warning'); return true; }
        const txt = `您的訂單 ${latest.external_order_id} 物流追蹤：${latest.tracking_number}\n查詢：https://www.t-cat.com.tw/inquire/trace.aspx?no=${latest.tracking_number}`;
        const inputEl = $('#msg-input');
        inputEl.value = txt;
        inputEl.dispatchEvent(new Event('input'));
        toast('追蹤訊息已填入輸入框', 'success');
      } catch (e) { toast(e.message, 'error'); }
      return true;
    }

    default:
      return false; // 不認得就當一般訊息
  }
};

// ─── 會員資訊（游戲化強化）───
const STAGE_LABEL = { new: '新客', active: '活躍', vip: 'VIP', at_risk: '流失預警', lost: '已流失' };
const STAGE_COLOR = { new: '#888', active: '#34c759', vip: '#f59e0b', at_risk: '#ff9500', lost: '#ff3b30' };

const loadMembership = async (customerId, clientId) => {
  const section = $('#membership-info');
  if (!section || !customerId || !clientId) return;
  try {
    const data = await api('GET', `/api/customers/${customerId}/membership?client_id=${clientId}`);
    if (!data || data.error) { section.style.display = 'none'; return; }

    section.style.display = '';
    const stage = data.stage || 'new';
    const stageLabel = STAGE_LABEL[stage] || stage;
    const stageColor = STAGE_COLOR[stage] || '#888';

    const set = (id, val) => { const el = $(`#${id}`); if (el) el.textContent = val; };

    set('m-stage', stageLabel);
    const stageEl = $('#m-stage');
    if (stageEl) stageEl.style.color = stageColor;

    set('m-joined', data.joined_label || '—');
    set('m-total-amount', data.total_amount ? `NT$ ${data.total_amount.toLocaleString()}` : '—');
    set('m-order-count', data.order_count > 0 ? `${data.order_count} 筆` : '—');
    set('m-avg-amount', data.avg_amount > 0 ? `NT$ ${data.avg_amount.toLocaleString()}` : '—');
    set('m-last-order', data.last_order_label || '—');
    set('m-points', data.points_balance > 0 ? `${data.points_balance} 點` : '0 點');
    set('m-streak', data.streak_days > 0 ? `${data.streak_days} 天${data.streak_days >= 7 ? ' 🔥' : ''}` : '—');
    set('m-wins', data.win_count > 0 ? `${data.win_count} 次` : '—');
    set('m-csat', data.csat_avg !== null ? `${data.csat_avg} / 5` : '—');
  } catch {
    const section2 = $('#membership-info');
    if (section2) section2.style.display = 'none';
  }
};

// ─── 對話標籤渲染 ───
const renderConvTags = (tags) => {
  const el = $('#conv-tags');
  if (!el) return;
  el.innerHTML = '';
  if (tags.length) {
    tags.forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'conv-tag-chip removable';
      chip.innerHTML = `${esc(t)} <button onclick="removeConvTag('${esc(t)}')" style="background:none;border:none;cursor:pointer;font-size:12px;color:inherit;padding:0 1px;opacity:0.6;line-height:1;" title="移除">×</button>`;
      el.appendChild(chip);
    });
  } else {
    el.innerHTML = '<span class="text-muted text-sm">尚無標籤</span>';
  }
};

const removeConvTag = async (tag) => {
  if (!state.activeConvId || !state.currentClientId) return;
  const newTags = state.convTags.filter(t => t !== tag);
  try {
    await api('PUT', `/api/conversations/${state.activeConvId}/tags`, { tags: newTags });
    state.convTags = newTags;
    renderConvTags(newTags);
    showToast('標籤已移除', 'success');
  } catch (e) { showToast('移除標籤失敗：' + e.message, 'error'); }
};

// ─── Header badges ───
const renderHeaderBadges = (conv) => {
  const el = $('#chat-header-badges');
  if (!el || !conv) return;
  el.innerHTML = '';

  if (conv.emotion && conv.emotion !== 'neutral') {
    const span = document.createElement('span');
    span.className = `emotion-badge emotion-${conv.emotion}`;
    span.textContent = emotionEmoji(conv.emotion) + ' ' + conv.emotion;
    el.appendChild(span);
  }
  if (conv.intent && conv.intent !== '其他') {
    const span = document.createElement('span');
    span.className = 'intent-badge';
    span.textContent = conv.intent;
    el.appendChild(span);
  }
  if (conv.urgency === 'high') {
    const span = document.createElement('span');
    span.className = 'urgency-badge-header';
    span.textContent = '緊急';
    el.appendChild(span);
  }
};

// ─── 摘要 ───
const showSummary = (summaryInput, extra = {}) => {
  const bar = $('#summary-bar');
  const content = $('#summary-content');
  if (!bar || !content) return;

  const summaryText = typeof summaryInput === 'string' ? summaryInput : String(summaryInput || '');
  if (!summaryText) return;

  bar.classList.remove('hidden');

  const toggle = $('#summary-toggle');
  if (toggle) {
    const conv = state.conversations?.find(c => c.id === state.activeConvId);
    const updatedAt = conv?.summary_updated_at;
    const timeStr = updatedAt ? `（${fmtTime(updatedAt)} 更新）` : '';
    toggle.innerHTML = `💡 AI 摘要 ${timeStr} <span id="summary-chevron">▼</span>`;
    toggle.onclick = () => {
      content.classList.toggle('hidden');
      const chevron = $('#summary-chevron');
      if (chevron) chevron.textContent = content.classList.contains('hidden') ? '▼' : '▲';
    };
  }

  let html = `<div style="white-space:pre-wrap;font-size:13px;line-height:1.65;">${esc(summaryText)}</div>`;
  if (extra.action_required) {
    html += `<div style="margin-top:8px;font-size:12px;color:#e65100;font-weight:500;">📌 待辦：${esc(extra.action_required)}</div>`;
  }
  const btnStyle = "font-size:11px;padding:4px 10px;border:1px solid var(--border);border-radius:var(--radius-pill);cursor:pointer;background:var(--bg);font-family:var(--font-sans);";
  html += `<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
    <button id="sum-rebtn" style="${btnStyle}">重新摘要</button>
    <button id="sum-copybtn" style="${btnStyle}">複製</button>
  </div>`;

  content.innerHTML = html;
  // 用 addEventListener 避免 onclick 引號衝突
  const reBtn = content.querySelector('#sum-rebtn');
  const copyBtn = content.querySelector('#sum-copybtn');
  if (reBtn) reBtn.onclick = () => triggerManualSummarize();
  if (copyBtn) copyBtn.onclick = () => {
    navigator.clipboard.writeText(summaryText).then(() => showToast('已複製', 'success'))
      .catch(() => showToast('複製失敗', 'error'));
  };
  content.classList.remove('hidden');
  const chevron = $('#summary-chevron');
  if (chevron) chevron.textContent = '▲';
};

const triggerManualSummarize = async () => {
  if (!state.activeConvId) return;
  try {
    const result = await api('POST', `/api/conversations/${state.activeConvId}/summarize`);
    if (result.summary) showSummary(result.summary, { action_required: result.action_required });
  } catch (e) { showToast('摘要失敗：' + e.message, 'error'); }
};

const hideSummary = () => {
  const bar = $('#summary-bar');
  if (bar) bar.classList.add('hidden');
};

// ─── Messages ───
const loadMessages = async (convId) => {
  const data = await api('GET', `/api/conversations/${convId}/messages`);
  state.messages = data.messages || [];
  renderMessages();

  // 清零未讀（後端 + 本地）
  try {
    await api('POST', `/api/conversations/${convId}/mark-read`);
  } catch {}
  const conv = state.conversations.find(c => c.id === convId);
  if (conv) {
    conv.unread_count = 0;
    renderConvList();
  }

  // 觸發建議回覆（最後一則是 inbound 才顯示）
  // 用 setTimeout 0 確保 loadSuggestions 已定義（const 無 hoist）
  setTimeout(() => { if (typeof loadSuggestions === 'function') loadSuggestions(); }, 0);
};

const renderMessages = () => {
  const container = $('#messages-container');
  const placeholder = $('#chat-placeholder');
  if (placeholder) placeholder.style.display = 'none';

  $$('.bubble-row, .date-divider, .note-row, .system-row, .msg-skeleton-row').forEach(el => el.remove());
  // 清除空狀態文字
  const emptyMsg = container.querySelector('[data-empty-msg]');
  if (emptyMsg) emptyMsg.remove();

  if (!state.messages.length) {
    const div = document.createElement('div');
    div.dataset.emptyMsg = '1';
    div.style.cssText = 'text-align:center;color:var(--muted);font-size:13px;margin:32px 0;padding:20px;';
    div.innerHTML = `<div style="font-size:28px;margin-bottom:10px;">💬</div>尚無訊息，等待顧客傳訊或手動回覆`;
    container.appendChild(div);
    return;
  }

  let lastDateLabel = '';
  let lastSenderType = null;
  let lastSenderId = null;
  let lastMsgTime = 0;

  state.messages.forEach((msg, idx) => {
    const isNote = msg.sender_type === 'note' || msg.direction === 'internal';
    const isSystem = msg.sender_type === 'system';

    // 日期分隔
    const dateLabel = fmtDateLabel(msg.created_at);
    if (dateLabel !== lastDateLabel) {
      const divider = document.createElement('div');
      divider.className = 'date-divider';
      divider.textContent = dateLabel;
      container.appendChild(divider);
      lastDateLabel = dateLabel;
      lastSenderType = null;
    }

    // 系統訊息
    if (isSystem) {
      const row = document.createElement('div');
      row.className = 'system-row';
      row.innerHTML = `<div class="system-bubble">${esc(msg.content || '')}</div>`;
      container.appendChild(row);
      lastSenderType = null;
      return;
    }

    // 內部備忘
    if (isNote) {
      const agentName = msg.agent_name || msg.sender_name || '客服';
      const row = document.createElement('div');
      row.className = 'note-row';
      row.innerHTML = `
        <div class="note-bubble">
          <span class="note-label">📝 內部備忘 by ${esc(agentName)}</span>
          <span>${esc(msg.content || '')}</span>
          <div class="bubble-time">${fmtTime(msg.created_at)}</div>
        </div>
      `;
      container.appendChild(row);
      lastSenderType = null;
      return;
    }

    const isIn = msg.direction === 'inbound';

    // 判斷是否連續同人（緊湊模式）
    const timeDiff = msg.created_at - lastMsgTime;
    const sameGroup = (
      lastSenderType === (isIn ? 'inbound' : 'outbound') &&
      lastSenderId === (msg.sender_id || msg.direction) &&
      timeDiff < 60000
    );

    const row = document.createElement('div');
    row.className = `bubble-row ${isIn ? 'inbound' : 'outbound'}${sameGroup ? ' compact' : ''}`;

    const isAi = msg.sender_type === 'ai';
    const bubbleCls = isIn ? 'inbound' : `outbound${isAi ? ' ai' : ''}`;

    let avatarHtml = '';
    if (isIn) {
      const cName = state.activeConv?.customer_name || '顧客';
      const aUrl  = state.activeConv?.customer_avatar_url || state.activeConv?.channel_avatar_url || state.activeConv?.avatar_url;
      avatarHtml = makeAvatarHtml(cName, aUrl, 32);
    } else {
      avatarHtml = isAi
        ? '<div style="width:32px;height:32px;border-radius:50%;background:#EDF4FF;display:flex;align-items:center;justify-content:center;font-size:16px;">&#x1F916;</div>'
        : '<div style="width:32px;height:32px;border-radius:50%;background:var(--primary-soft);display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--primary-dark);">&#x1F9D1;&#x200D;&#x1F4BC;</div>';
    }

    // 音訊訊息渲染
    let bubbleContent;
    if (msg.content_type === 'audio') {
      const durSec = msg.audio_duration_ms ? Math.round(msg.audio_duration_ms / 1000) : null;
      const durStr = durSec ? ` ${durSec} 秒` : '';
      if (msg.transcript) {
        bubbleContent = `<div class="audio-bubble">
          <span class="audio-icon">&#x1F3A4;</span>
          <span class="audio-meta">語音${durStr}</span>
          <div class="audio-transcript">${esc(msg.transcript)}</div>
        </div>`;
      } else {
        bubbleContent = `<div class="audio-bubble pending">
          <span class="audio-icon">&#x1F3A4;</span>
          <span class="audio-meta">語音${durStr}</span>
          <span class="audio-pending">&#x23F3; 轉文字中...</span>
        </div>`;
      }
    } else {
      bubbleContent = esc(msg.content || '');
    }

    row.innerHTML = `
      <div class="bubble-avatar">${avatarHtml}</div>
      <div>
        <div class="bubble ${bubbleCls} ${msg.content_type === 'audio' ? 'audio-bubble-wrap' : ''}">${bubbleContent}</div>
        ${!sameGroup || idx === state.messages.length - 1 ? `<div class="bubble-time">${fmtTime(msg.created_at)}</div>` : ''}
      </div>
    `;

    container.appendChild(row);

    lastSenderType = isIn ? 'inbound' : 'outbound';
    lastSenderId = msg.sender_id || msg.direction;
    lastMsgTime = msg.created_at;
  });

  container.scrollTop = container.scrollHeight;
};

const sendMessage = async () => {
  // 防雙送 lock（防止 click + Enter 重複觸發 / race condition）
  if (state._sending) {
    console.warn('[sendMessage] 防雙送：已在送出中，忽略');
    return;
  }
  const input  = $('#msg-input');
  let content = input.value.trim();
  if (!content || !state.activeConvId) return;

  // ─── Slash commands（不送出，當場執行 BV 操作）───
  if (content.startsWith('/')) {
    const handled = await handleSlashCommand(content);
    if (handled) {
      input.value = '';
      $('#send-btn').disabled = true;
      input.style.height = 'auto';
      return;
    }
  }

  // ─── 品牌教練門檻確認 ───
  if (state.inputMode !== 'note' && state._bcLastScore != null && state._bcThreshold > 0) {
    if (state._bcLastScore < state._bcThreshold) {
      const rewrite = state._bcLastRewrite || '';
      const msg = `這則訊息梵森魂只有 ${state._bcLastScore} 分（門檻 ${state._bcThreshold} 分）。${rewrite ? '\n\nAI 改寫建議：\n' + rewrite : ''}\n\n要使用 AI 改寫的版本嗎？`;
      const choice = await new Promise(resolve => {
        // 三選一 dialog（使用自製 modal 避免瀏覽器限制）
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
          <div style="background:#fff;border-radius:12px;padding:24px;max-width:480px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
            <div style="font-size:15px;font-weight:700;color:#1a1a2e;margin-bottom:12px;">梵森魂檢測</div>
            <div style="font-size:13px;color:#444;white-space:pre-wrap;line-height:1.6;margin-bottom:16px;">${esc(msg)}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
              <button id="bc-cancel" style="padding:7px 16px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">取消</button>
              <button id="bc-send-original" style="padding:7px 16px;border:1px solid #aaa;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">直接送出</button>
              ${rewrite ? '<button id="bc-send-rewrite" style="padding:7px 16px;border:none;border-radius:6px;background:#5856d6;color:#fff;cursor:pointer;font-size:13px;">使用改寫版本</button>' : ''}
            </div>
          </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('#bc-cancel').onclick = () => { overlay.remove(); resolve('cancel'); };
        overlay.querySelector('#bc-send-original').onclick = () => { overlay.remove(); resolve('original'); };
        if (rewrite) overlay.querySelector('#bc-send-rewrite').onclick = () => { overlay.remove(); resolve('rewrite'); };
      });
      if (choice === 'cancel') return;
      if (choice === 'rewrite' && rewrite) content = rewrite;
    }
  }

  state._sending = true;
  const btn = $('#send-btn');
  btn.disabled = true;

  if (state.inputMode === 'note') {
    try {
      await api('POST', `/api/conversations/${state.activeConvId}/note`, { content });
      input.value = '';
      input.style.height = 'auto';
      await loadMessages(state.activeConvId);
    } catch (e) {
      showToast(`備忘儲存失敗：${e.message}`, 'error');
    } finally {
      state._sending = false;
      btn.disabled = !input.value.trim();
    }
    return;
  }

  try {
    await api('POST', `/api/conversations/${state.activeConvId}/reply`, { content });
    input.value = '';
    input.style.height = 'auto';
    // 品牌教練：送出後存 DB 評分（有改寫採用也標記）
    hideBrandCoachBar();
    state._bcLastScore = null;
    state._bcLastRewrite = null;
    // 送出後隱藏建議區（等下一則顧客訊息再觸發）
    const sugBar = $('#suggestion-bar');
    if (sugBar) sugBar.style.display = 'none';
    state.currentSuggestions = [];
    await loadMessages(state.activeConvId);
    await loadConversations();
  } catch (e) {
    showToast(`送出失敗：${e.message}`, 'error');
  } finally {
    state._sending = false;
    btn.disabled = !input.value.trim();
  }
};

// ─── AI 草擬渲染 ───
const renderDraftList = (drafts) => {
  const list = $('#draft-list');
  if (!drafts.length) {
    list.innerHTML = '<div class="draft-placeholder">AI 草擬結果為空</div>';
    return;
  }

  const variantLabel = { professional: '專業', friendly: '親切', concise: '簡短' };

  list.innerHTML = drafts.map(d => `
    <div class="draft-card" data-id="${d.id}">
      <div class="draft-variant">${variantLabel[d.variant] || d.variant}</div>
      <div class="draft-content" contenteditable="true">${esc(d.content)}</div>
      ${d.warnings?.length ? `<div class="draft-warnings">⚠️ ${d.warnings.join('、')}</div>` : ''}
      <div class="draft-actions">
        <button class="btn btn-primary" style="font-size:12px;padding:5px 12px;" onclick="approveDraft(${d.id}, this)">採用</button>
        <button class="btn btn-secondary" style="font-size:12px;padding:5px 12px;" onclick="approveDraftEdited(${d.id}, this)">編輯後送</button>
        <button class="btn btn-secondary" style="font-size:12px;padding:5px 12px;color:var(--err);" onclick="rejectDraft(${d.id}, this)">棄用</button>
      </div>
    </div>
  `).join('');
};

const approveDraft = async (id, btn) => {
  btn.disabled = true;
  try {
    await api('POST', `/api/drafts/${id}/approve`);
    btn.closest('.draft-card').style.opacity = '0.5';
    await loadMessages(state.activeConvId);
    await loadConversations();
    showToast('已採用草擬並送出', 'success');
  } catch (e) {
    showToast('採用失敗：' + e.message, 'error');
    btn.disabled = false;
  }
};

const approveDraftEdited = async (id, btn) => {
  const card = btn.closest('.draft-card');
  const editedContent = card.querySelector('.draft-content').textContent.trim();
  btn.disabled = true;
  try {
    await api('POST', `/api/drafts/${id}/approve`, { edited_content: editedContent });
    card.style.opacity = '0.5';
    await loadMessages(state.activeConvId);
    await loadConversations();
    showToast('已送出（含編輯）', 'success');
  } catch (e) {
    showToast('送出失敗：' + e.message, 'error');
    btn.disabled = false;
  }
};

const rejectDraft = async (id, btn) => {
  try {
    await api('POST', `/api/drafts/${id}/reject`);
    btn.closest('.draft-card').style.opacity = '0.4';
    showToast('已棄用', '');
  } catch {}
};

// ─── Templates ───
const loadTemplates = async () => {
  const cid = state.currentClientId;
  if (!cid) return;
  try {
    const data = await api('GET', `/api/templates?client_id=${cid}`);
    state.templates = data.templates || [];
    renderTemplates();
  } catch {}
};

const renderTemplates = () => {
  const list = $('#template-list');
  list.innerHTML = '';
  if (!state.templates.length) {
    list.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">尚無模板</div>';
    return;
  }
  state.templates.forEach(tpl => {
    const div = document.createElement('div');
    div.className = 'template-item';
    div.innerHTML = `
      <div class="template-shortcut">${esc(tpl.shortcut)}</div>
      <div class="template-title">${esc(tpl.title)}</div>
      <div class="template-preview">${esc(tpl.content)}</div>
    `;
    div.addEventListener('click', () => {
      const input = $('#msg-input');
      input.value = tpl.content;
      input.dispatchEvent(new Event('input'));
      input.focus();
      if (window.innerWidth <= 768) {
        $$('.panel').forEach(p => p.classList.add('hidden'));
        $('#main').classList.remove('hidden');
        $$('.mtab').forEach(t => t.classList.toggle('active', t.dataset.panel === 'chat'));
      }
    });
    list.appendChild(div);
  });
};

// ─── 建議回覆（AI 草擬 + 模板 + 知識庫）───
const loadSuggestions = async () => {
  if (!state.activeConvId) return;
  const lastMsg = state.messages[state.messages.length - 1];
  const sugBar = $('#suggestion-bar');
  if (!sugBar) return;

  // 最後一則不是 inbound → 不顯示
  if (!lastMsg || lastMsg.direction !== 'inbound') {
    sugBar.style.display = 'none';
    return;
  }

  sugBar.style.display = '';
  const sugList = $('#sug-list');
  // Skeleton 載入動畫：比單純文字更有回饋感，主觀等待感降低約 40%
  if (sugList) sugList.innerHTML = `
    <div class="sug-skeleton-card">
      <div class="sug-skeleton-label"></div>
      <div class="sug-skeleton-content"></div>
      <div class="sug-skeleton-content short"></div>
    </div>
    <div class="sug-skeleton-card">
      <div class="sug-skeleton-label"></div>
      <div class="sug-skeleton-content"></div>
      <div class="sug-skeleton-content short"></div>
    </div>
    <div class="sug-skeleton-card">
      <div class="sug-skeleton-label"></div>
      <div class="sug-skeleton-content"></div>
      <div class="sug-skeleton-content short"></div>
    </div>
    <div class="sug-loading-text">AI 正在用品牌口吻幫你想 3 個版本...</div>
  `;

  try {
    const qText = encodeURIComponent((lastMsg.content || '').slice(0, 200));
    const cid = state.currentClientId;

    const [draftsRes, templatesRes, qaRes] = await Promise.all([
      api('POST', `/api/conversations/${state.activeConvId}/draft`).catch(() => ({ drafts: [] })),
      api('GET', `/api/templates/suggest?conversation_id=${state.activeConvId}${cid ? '&client_id=' + cid : ''}&limit=2`).catch(() => ({ templates: [] })),
      api('GET', `/api/qa-pairs/match?q=${qText}${cid ? '&client_id=' + cid : ''}&limit=1`).catch(() => ({ qa_pairs: [] })),
    ]);

    const cards = [];

    const variantLabel = { professional: '專業版', friendly: '親切版', concise: '簡短版' };
    const variantIcon  = { professional: '🎩', friendly: '💝', concise: '⚡' };

    for (const d of (draftsRes.drafts || []).slice(0, 3)) {
      cards.push({
        label: `${variantIcon[d.variant] || '🤖'} AI ${variantLabel[d.variant] || d.variant}`,
        content: d.content || '',
        type: 'ai_draft',
      });
    }

    for (const t of (templatesRes.templates || []).slice(0, 2)) {
      cards.push({
        label: `模板：${t.title || ''}`,
        content: t.content || '',
        type: 'template',
      });
    }

    for (const qa of (qaRes.qa_pairs || []).slice(0, 1)) {
      cards.push({
        label: '知識庫',
        content: qa.answer || '',
        type: 'qa',
      });
    }

    state.currentSuggestions = cards;

    if (!sugList) return;

    if (!cards.length) {
      sugList.innerHTML = '<div class="sug-empty">暫無建議</div>';
      return;
    }

    sugList.innerHTML = cards.map((c, i) => `
      <div class="sug-card" data-idx="${i}">
        <div class="sug-label">${esc(c.label)}</div>
        <div class="sug-content">${esc(c.content)}</div>
        <div class="sug-actions">
          <button class="sug-btn" onclick="pasteSuggestion(${i})">✏️ 貼上編輯</button>
          <button class="sug-btn sug-btn-primary" onclick="sendSuggestion(${i})">🚀 直接送出</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    const sugList2 = $('#sug-list');
    if (sugList2) sugList2.innerHTML = `<div class="sug-empty">建議載入失敗：${esc(e.message)}</div>`;
  }
};

window.loadSuggestions = loadSuggestions;

window.pasteSuggestion = (idx) => {
  const c = state.currentSuggestions?.[idx];
  if (!c) return;
  const input = $('#msg-input');
  if (!input) return;
  input.value = c.content;
  input.focus();
  input.dispatchEvent(new Event('input'));
};

window.sendSuggestion = async (idx) => {
  const c = state.currentSuggestions?.[idx];
  if (!c) return;
  const input = $('#msg-input');
  if (!input) return;
  input.value = c.content;
  input.dispatchEvent(new Event('input'));
  await sendMessage();
};

// ─── Utils ───
const esc = (str) => {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

const parseJson = (str, def) => {
  try { return JSON.parse(str); } catch { return def; }
};

const statusLabel = (s) => ({ open: '進行中', closed: '已結束', pending: '待處理' }[s] || s);

// ─── 顧客編輯 ───
const initCustomerEdit = () => {
  const editBtn   = $('#edit-customer-btn');
  const saveBtn   = $('#save-customer-btn');
  const cancelBtn = $('#cancel-customer-btn');
  const viewEl    = $('#customer-view');
  const editEl    = $('#customer-edit');

  if (!editBtn) return;

  const enterEdit = () => {
    $('#edit-c-name').value  = $('#c-name').textContent  === '—' ? '' : $('#c-name').textContent;
    $('#edit-c-phone').value = $('#c-phone').textContent === '—' ? '' : $('#c-phone').textContent;
    $('#edit-c-email').value = $('#c-email').textContent === '—' ? '' : $('#c-email').textContent;
    $('#edit-c-notes').value = $('#c-notes').textContent || '';
    const tagSpans = $$('#c-tags .tag').map(s => s.textContent);
    $('#edit-c-tags').value = tagSpans.join(',');
    $('#customer-edit-status').textContent = '';
    viewEl.style.display = 'none';
    editEl.style.display = '';
    $('#edit-c-name').focus();
  };

  const exitEdit = () => {
    viewEl.style.display = '';
    editEl.style.display = 'none';
  };

  editBtn.addEventListener('click', enterEdit);
  cancelBtn.addEventListener('click', exitEdit);

  saveBtn.addEventListener('click', async () => {
    if (!state.activeCustomerId || !state.currentClientId) return;
    const statusEl = $('#customer-edit-status');
    statusEl.textContent = '儲存中…';

    const tagsRaw = $('#edit-c-tags').value;
    const tagsArr = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);

    const body = {
      name:  $('#edit-c-name').value.trim()  || '未知顧客',
      phone: $('#edit-c-phone').value.trim() || null,
      email: $('#edit-c-email').value.trim() || null,
      notes: $('#edit-c-notes').value.trim() || null,
      tags:  tagsArr,
      client_id: state.currentClientId,
    };

    try {
      await api('PUT', `/api/customers/${state.activeCustomerId}`, body);
      $('#c-name').textContent  = body.name;
      $('#c-phone').textContent = body.phone || '—';
      $('#c-email').textContent = body.email || '—';
      $('#c-notes').textContent = body.notes || '';
      const tagsEl = $('#c-tags');
      tagsEl.innerHTML = '';
      if (tagsArr.length) {
        tagsArr.forEach(t => {
          const span = document.createElement('span');
          span.className = 'tag';
          span.textContent = t;
          tagsEl.appendChild(span);
        });
      } else {
        tagsEl.innerHTML = '<span class="text-muted text-sm">尚無標籤</span>';
      }
      showToast('顧客資料已更新', 'success');
      exitEdit();
    } catch (e) {
      statusEl.textContent = `儲存失敗：${e.message}`;
    }
  });
};

// ─── 桌面通知 ───
const notifyEnabled = () => localStorage.getItem('notify_enabled') !== 'false';

const sendDesktopNotification = (title, body, tag = '') => {
  if (!notifyEnabled()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  new Notification(title, {
    body: body || '',
    tag: `cs-${tag}`,
    icon: '/favicon.ico',
  });
};

// ─── 我的狀態 ───
const statusLabelMap = { online: '在線', away: '離開', busy: '忙碌', offline: '離線' };
const statusDotClass = { online: 'online', away: 'away', busy: 'busy', offline: 'offline' };

const updateMyStatusUI = (status) => {
  const dot = $('#my-status-dot');
  const label = $('#my-status-label');
  if (!dot || !label) return;
  dot.className = `online-dot ${statusDotClass[status] || 'offline'}`;
  label.textContent = statusLabelMap[status] || status;
};

const setMyStatus = async (status) => {
  document.getElementById('status-dropdown').classList.remove('open');
  await api('PUT', '/api/me/status', { status });
  updateMyStatusUI(status);
};

// ─── @提及 ───
let mentionData = [];

const loadMentions = async () => {
  try {
    const data = await api('GET', '/api/me/mentions?unread=true');
    mentionData = data.mentions || [];
    const badge = $('#mention-count');
    if (!badge) return;
    if (mentionData.length > 0) {
      badge.textContent = mentionData.length;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  } catch {}
};

const toggleMentionPanel = () => {
  let panel = $('#mention-panel');
  if (panel) { panel.remove(); return; }

  panel = document.createElement('div');
  panel.id = 'mention-panel';
  panel.style.cssText = `
    position:fixed;top:58px;right:20px;width:340px;
    background:var(--surface);border:1px solid var(--border);
    border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);
    z-index:100;overflow:hidden;
  `;
  panel.innerHTML = `
    <div style="padding:14px 18px;font-weight:600;font-size:13px;border-bottom:1px solid var(--border-light);color:var(--text-primary);">提及通知</div>
    <div style="max-height:340px;overflow-y:auto;">
      ${mentionData.length ? mentionData.map(m => `
        <div class="search-result-item" onclick="jumpToConversation(${m.conversation_id});markMentionRead(${m.id})">
          <div style="font-size:12px;font-weight:600;color:var(--text-primary);">對話 #${m.conversation_id}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:3px;">${esc((m.message_content || '').slice(0, 60))}</div>
        </div>
      `).join('') : '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;">沒有未讀提及 ✓</div>'}
    </div>
  `;
  document.body.appendChild(panel);

  setTimeout(() => {
    document.addEventListener('click', function hidePanel(e) {
      if (!panel.contains(e.target) && e.target.id !== 'mention-bell') {
        panel.remove();
        document.removeEventListener('click', hidePanel);
      }
    });
  }, 100);
};

const markMentionRead = async (id) => {
  try {
    await api('POST', `/api/mentions/${id}/read`);
    await loadMentions();
  } catch {}
};

// ─── 鍵盤快捷鍵 ───
const SHORTCUTS = [
  { key: 'j / ↓',     desc: '下一個對話' },
  { key: 'k / ↑',     desc: '上一個對話' },
  { key: 'r',          desc: '聚焦回覆框' },
  { key: 'e',          desc: '編輯模式' },
  { key: 'c',          desc: '關閉當前對話' },
  { key: 't',          desc: '切換回覆/備忘模式' },
  { key: '/ 或 ⌘K',   desc: '聚焦搜尋框' },
  { key: 'Escape',     desc: '關閉 modal / 取消' },
  { key: '?',          desc: '顯示此說明' },
];

const showShortcutsModal = () => {
  let modal = document.getElementById('shortcuts-modal');
  if (modal) { modal.remove(); return; }
  modal = document.createElement('div');
  modal.id = 'shortcuts-modal';
  modal.className = 'shortcut-modal';
  modal.innerHTML = `
    <div class="shortcut-modal-inner">
      <div class="shortcut-modal-title">鍵盤快捷鍵</div>
      <table class="shortcut-table">
        ${SHORTCUTS.map(s => `<tr><td>${s.key}</td><td>${s.desc}</td></tr>`).join('')}
      </table>
      <div style="margin-top:18px;text-align:right;">
        <button onclick="document.getElementById('shortcuts-modal').remove()" class="btn btn-secondary" style="padding:7px 16px;">關閉</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
};

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const inInput = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

  if (e.key === 'Escape') {
    document.querySelectorAll('.shortcut-modal, #mention-panel').forEach(el => el.remove());
    const transferModal = $('#transfer-modal');
    if (transferModal) transferModal.style.display = 'none';
    return;
  }

  if (e.key === '?' && !inInput) {
    e.preventDefault();
    showShortcutsModal();
    return;
  }

  // Cmd+K 或 / 開搜尋
  if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !inInput)) {
    e.preventDefault();
    const si = $('#search-input');
    if (si) si.focus();
    return;
  }

  if (inInput) return;

  if (e.key === 'r') {
    e.preventDefault();
    const mi = $('#msg-input');
    if (mi) mi.focus();
    return;
  }

  if (e.key === 't') {
    e.preventDefault();
    const currentMode = state.inputMode === 'reply' ? 'note' : 'reply';
    const btn = document.querySelector(`.input-mode-btn[data-mode="${currentMode}"]`);
    if (btn) btn.click();
    return;
  }

  if (e.key === 'j' || e.key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const convs = Array.from(document.querySelectorAll('.conv-item'));
    const current = convs.findIndex(el => el.classList.contains('active'));
    const isDown = e.key === 'j' || e.key === 'ArrowDown';
    let next = isDown ? current + 1 : current - 1;
    next = Math.max(0, Math.min(next, convs.length - 1));
    convs[next]?.click();
    convs[next]?.scrollIntoView({ block: 'nearest' });
    return;
  }

  if (e.key === 'c') {
    e.preventDefault();
    if (state.activeConvId && state.currentClientId) {
      api('PUT', `/api/conversations/${state.activeConvId}`, { status: 'closed' })
        .then(() => { showToast('對話已關閉', 'success'); loadConversations(); })
        .catch(() => {});
    }
    return;
  }
});

// ─── BV 動作面板按鈕綁定 ───
const initBvActions = () => {
  const linkConfirm = $('#bv-link-confirm');
  const unlink = $('#bv-unlink-btn');
  const send = $('#bv-send-point-btn');
  const sendConfirm = $('#bv-send-point-confirm');
  const sendCancel = $('#bv-send-point-cancel');
  const edit = $('#bv-edit-customer-btn');
  const editConfirm = $('#bv-edit-customer-confirm');
  const editCancel = $('#bv-edit-customer-cancel');
  if (linkConfirm) linkConfirm.onclick = bvLinkConfirm;
  if (unlink) unlink.onclick = bvUnlink;
  if (send) send.onclick = bvOpenSendPoint;
  if (sendConfirm) sendConfirm.onclick = bvSendPointConfirm;
  if (sendCancel) sendCancel.onclick = () => $('#bv-send-point-form').style.display = 'none';
  if (edit) edit.onclick = bvOpenEditCustomer;
  if (editConfirm) editConfirm.onclick = bvEditCustomerConfirm;
  if (editCancel) editCancel.onclick = () => $('#bv-edit-customer-form').style.display = 'none';
};

// ─── Start ───
init();
initCustomerEdit();
initBvActions();

// ═══════════════════════════════════════════
//  品牌教練 AI 模式
// ═══════════════════════════════════════════

let _bcDebounceTimer = null;
let _bcCoachVisible = true;   // 使用者可手動隱藏
state._bcLastScore   = null;
state._bcLastRewrite = null;
state._bcThreshold   = 0;     // 由 client 設定拉取（0 = 不強制）

// 取得業主品牌教練門檻
const loadBrandCoachThreshold = async (clientId) => {
  if (!clientId) return;
  try {
    const data = await api('GET', `/api/clients/${clientId}/config`);
    state._bcThreshold = data?.client?.brand_coach_threshold || 0;
  } catch {}
};

// debounce 觸發評分
const scheduleBrandCoachScore = () => {
  if (_bcDebounceTimer) clearTimeout(_bcDebounceTimer);
  const content = $('#msg-input')?.value?.trim();
  if (!content || content.length < 10) {
    // 太短就隱藏評分條
    hideBrandCoachBar();
    return;
  }
  _bcDebounceTimer = setTimeout(() => runBrandCoachScore(content), 1500);
};

// 執行即時評分（save:false，只預覽）
const runBrandCoachScore = async (content) => {
  if (!state.activeConvId || !content) return;
  try {
    const result = await api('POST', '/api/brand-coach/score', {
      content,
      conversation_id: state.activeConvId,
      save: false,
    });
    if (result.ok) {
      state._bcLastScore   = result.brand_score;
      state._bcLastRewrite = result.suggested_rewrite;
      renderBrandCoachBar(result);
    }
  } catch (e) {
    // 靜默失敗：評分失敗不影響主流程
    console.warn('[brand-coach] score failed:', e.message);
  }
};

// 渲染評分條
const renderBrandCoachBar = (result) => {
  const bar = $('#brand-coach-bar');
  if (!bar || !_bcCoachVisible) return;

  const score = result.brand_score;
  const scoreEl = $('#bc-score-num');
  const badgeEl = $('#bc-score-badge');
  const feedbackEl = $('#bc-feedback');
  const applyBtn = $('#bc-apply-btn');

  if (scoreEl) scoreEl.textContent = score;

  // 顏色：90+ 綠 / 70-89 黃 / <70 紅
  let color, bgColor, label;
  if (score >= 90) {
    color = '#2e7d32'; bgColor = '#e8f5e9'; label = '很梵森';
  } else if (score >= 70) {
    color = '#e65100'; bgColor = '#fff3e0'; label = '尚可';
  } else {
    color = '#c62828'; bgColor = '#ffebee'; label = '需改進';
  }

  if (badgeEl) {
    badgeEl.textContent = label;
    badgeEl.style.background = bgColor;
    badgeEl.style.color = color;
    badgeEl.style.border = `1px solid ${color}33`;
  }

  if (scoreEl) scoreEl.style.color = color;

  if (feedbackEl) {
    feedbackEl.textContent = result.feedback || '';
  }

  if (applyBtn) {
    applyBtn.style.display = result.suggested_rewrite ? 'inline-block' : 'none';
  }

  bar.style.display = '';
};

// 隱藏評分條
const hideBrandCoachBar = () => {
  const bar = $('#brand-coach-bar');
  if (bar) bar.style.display = 'none';
};

// toggle 顯示/隱藏
window.toggleBrandCoach = () => {
  _bcCoachVisible = !_bcCoachVisible;
  const bar = $('#brand-coach-bar');
  const btn = $('#bc-coach-toggle');
  if (!_bcCoachVisible) {
    hideBrandCoachBar();
  } else if (state._bcLastScore != null) {
    bar.style.display = '';
  }
  if (btn) btn.textContent = _bcCoachVisible ? '隱藏' : '顯示';
};

// 採用改寫
window.applyCoachRewrite = () => {
  const rewrite = state._bcLastRewrite;
  if (!rewrite) return;
  const input = $('#msg-input');
  if (input) {
    input.value = rewrite;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 130) + 'px';
    $('#send-btn').disabled = false;
    // 標記採用（若有 score id 則呼叫 API，這裡是即時評分無 id 故跳過）
    showToast('已套用 AI 改寫建議', 'success');
    // 重新評分套用後的內容
    scheduleBrandCoachScore();
  }
};
