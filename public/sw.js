// ═══════════════════════════════════════════════════
//  梵森客服中心 — Service Worker
//  版本：cs-center-v1
// ═══════════════════════════════════════════════════

const CACHE_NAME = 'cs-center-v1';
const STATIC_CACHE = [
  '/index.html',
  '/login.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
];

// ─── 安裝：預快取靜態檔 ───
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(STATIC_CACHE))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] 預快取失敗（可能部分檔案不存在）:', err))
  );
});

// ─── 啟動：清除舊 cache，接管所有 client ───
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => {
            console.log('[SW] 刪除舊 cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch：Cache-First for 靜態，Network-Only for API/socket ───
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API 與 socket.io 走網路，不快取
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/webhook/')
  ) {
    return; // 讓瀏覽器處理，不攔截
  }

  // 只快取 GET
  if (e.request.method !== 'GET') return;

  // 跨來源不快取
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;

      return fetch(e.request)
        .then(resp => {
          // 只快取成功的同源回應
          if (resp.ok && resp.type === 'basic') {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => {
          // 離線 fallback：HTML 頁面回傳 index.html（讓 app 顯示離線提示）
          if (e.request.headers.get('accept')?.includes('text/html')) {
            return caches.match('/index.html');
          }
          // 其他資源回傳 504
          return new Response('', { status: 504, statusText: 'Offline' });
        });
    })
  );
});

// ─── Push 通知 ───
self.addEventListener('push', (e) => {
  let data = { title: '梵森客服', body: '您有新訊息' };
  try {
    if (e.data) data = { ...data, ...e.data.json() };
  } catch {
    if (e.data) data.body = e.data.text();
  }

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      tag: data.tag || 'cs-msg',
      data: { url: data.url || '/index.html' },
      vibrate: [200, 100, 200],
      requireInteraction: false,
    })
  );
});

// ─── 通知點擊：聚焦已開啟的視窗，或開新頁面 ───
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || '/index.html';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // 找已開啟的視窗
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.postMessage({ type: 'notification_click', url: targetUrl });
          return client.focus();
        }
      }
      // 沒有的話開新視窗
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ─── 接受 skip waiting 訊息（新版 SW 就緒後，app 可呼叫此訊息立刻生效）───
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
