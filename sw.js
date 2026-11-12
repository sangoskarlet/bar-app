// =====================================================================
//  SERVICE WORKER — «копия приложения внутри телефона»
//
//  При первой загрузке сохраняет все файлы приложения в кэш.
//  Дальше приложение открывается из кэша — даже без интернета.
//  Запросы к Google (Apps Script) НЕ трогает: они идут в сеть как обычно.
//
//  ВАЖНО: после любого изменения файлов приложения увеличьте VERSION —
//  иначе телефоны продолжат показывать старую версию.
// =====================================================================

const VERSION = 'v6';
const CACHE = 'bar-app-' + VERSION;
const FILES = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './manifest.webmanifest',
  './js/app.js',
  './js/api.js',
  './js/db.js',
  './js/sync.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// Установка: скачиваем и кладём в кэш все файлы
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

// Активация: удаляем кэши старых версий
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('bar-app-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Запросы: свои файлы — из кэша (быстро и офлайн), чужие — не трогаем
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google и прочее — напрямую в сеть

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cached => {
      if (cached) return cached;
      return fetch(req).catch(() => {
        // Нет сети и файла нет в кэше: для открытия страницы отдаём главную
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    }),
  );
});
