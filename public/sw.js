// ═══════════════════════════════════════════════════
//  梵森客服中心 — Service Worker
//  版本：cs-center-v1
// ═══════════════════════════════════════════════════

const CACHE_NAME = 'cs-center-v2';
// 更新到 v2 強制清掉所有舊 cache
const NETWORK_FIRST_PATHS = ['/app.js', '/styles.css', '/index.html', '/admin.js'];
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

  // 動態資源（HTML/JS/CSS）→ network-first，永遠拿最新版
  const isDynamic = NETWORK_FIRST_PATHS.some(p => url.pathname === p || url.pathname.endsWith(p));
  if (isDynamic) {
    e.respondWith(
      fetch(e.request).then(resp => {
        if (resp.ok && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => caches.match(e.request).then(c => c || new Response('', { status: 504 })))
    );
    return;
  }

  // 其他靜態資源（icons、字型）→ stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request)
        .then(resp => {
          if (resp.ok && resp.type === 'basic') {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => {
          if (e.request.headers.get('accept')?.includes('text/html')) {
            return caches.match('/index.html');
          }
          return new Response('', { status: 504, statusText: 'Offline' });
        });
      // 有 cache 先回，背景同步更新；沒 cache 等網路
      return cached || fetchPromise;
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
