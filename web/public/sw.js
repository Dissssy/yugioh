// Shows Web Push notifications while the site is closed (server/src/push.ts), and opens the duel on a click.

self.addEventListener('push', (event) => {
  const message = event.data?.json();
  if (!message) return;
  event.waitUntil(self.registration.showNotification('Yu-Gi-Oh Duels', { body: message.body, tag: message.tag, data: { url: message.url } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data.url, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
      const tab = tabs.find((t) => t.url === url) ?? tabs[0];
      return tab ? tab.focus().then((t) => t.navigate(url)) : self.clients.openWindow(url);
    }),
  );
});
