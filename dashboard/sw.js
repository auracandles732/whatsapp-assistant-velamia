self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('fetch', (event) => {
  // Solo las peticiones al propio servidor pasan por aquí; las librerías y fotos externas las carga el navegador directamente.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request));
});
