// Service worker: shows Buy Alert notifications pushed by the server and opens the app when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Hood Investing', {
    body: d.body || '', icon: '/icon-180.png?v=2', badge: '/icon-180.png?v=2', tag: d.tag || 'hood', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close(); const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ('focus' in w) { if (w.navigate) w.navigate(url); return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
