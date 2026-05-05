// ═══════════════════════════════════════════════════
//  梵森客服中心 — Service Worker 自毀版
//  目的：清除所有舊 SW + cache，讓使用者拿到乾淨環境
//  下次部署再恢復正常 SW
// ═══════════════════════════════════════════════════

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      // 清掉所有 cache
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))),
      // 接管所有 client
      self.clients.claim(),
    ])
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => clients.forEach(c => c.navigate(c.url)))
      .catch(() => {})
  );
});

// 不攔截 fetch — 全部走原生網路（讓使用者直接拿到最新版）
