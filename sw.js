// sw.js - BD Tour Background Service Worker

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// সরাসরি মেসেজ বা পুশ নোটিফিকেশন হ্যান্ডলার
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const payload = event.data.payload;
    const options = {
      body: payload.body || 'নতুন আপডেট এসেছে!',
      icon: 'https://cdn-icons-png.flaticon.com/512/3408/3408590.png',
      badge: 'https://cdn-icons-png.flaticon.com/512/3408/3408590.png',
      vibrate: [300, 100, 300, 100, 300],
      tag: 'bdtour-notification',
      renotify: true,
      data: {
        url: './'
      }
    };
    self.registration.showNotification(payload.title || 'BD Tour', options);
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('./');
      }
    })
  );
});
