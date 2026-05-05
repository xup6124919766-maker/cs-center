// ═══════════════════════════════════════════════════
//  梵森客服中心 — Service Worker 完全 No-Op 版
//  目的：讓 SW 自我卸載，但**絕不**觸發 navigate / reload
//  使用者按一次 F5 後就會脫離 SW 控制
// ═══════════════════════════════════════════════════

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))),
      self.clients.claim(),
    ])
      .then(() => self.registration.unregister())
      .catch(() => {})
  );
});

// 完全不攔截 fetch — 所有請求走原生網路
