// Service Worker da Central de BI — Espelho SMA, Espelho SMC e BI Embalagens.
// Permite instalar o app e abrir offline. Para publicar uma atualização, basta subir os arquivos novos
// e aumentar VERSION: o navegador detecta o novo sw.js, refaz o cache e remove os antigos.
const VERSION = 'v9';
const SHELL_CACHE = 'bi-shell-' + VERSION;
const RUNTIME_CACHE = 'bi-runtime-' + VERSION;
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './firebase-db.js',
  './Menu.html',
  './Espelho_SMC.html',
  './BI_Embalagens.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];
// Bibliotecas/fontes de CDN: guardadas após o 1º uso para o app abrir offline.
// (O BI Embalagens é 100% autocontido e não usa CDN.)
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com'];

const CDN_PRE = [
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-datalabels/2.2.0/chartjs-plugin-datalabels.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap',
  // Espelho SMC usa também o peso 700 da fonte condensada:
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => caches.open(RUNTIME_CACHE))
      .then((rc) => Promise.all(CDN_PRE.map((u) => fetch(new Request(u, { mode: 'no-cors' })).then((res) => rc.put(u, res)).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Permite que uma página peça a ativação imediata de uma versão nova (navigator.serviceWorker.controller / registration.waiting).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || (event.data && event.data.type === 'SKIP_WAITING')) self.skipWaiting();
});

// Resposta offline de uma página: a própria página em cache; senão o menu; senão o início.
function offlinePage(key) {
  return caches.match(key, { ignoreSearch: true })
    .then((r) => r || caches.match('./Menu.html'))
    .then((r) => r || caches.match('./index.html'))
    .then((r) => r || caches.match('./'))
    .then((r) => r || Response.error());
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Dados do Firebase (Firestore/Auth) nunca passam pelo cache.
  if (/(^|\.)googleapis\.com$/.test(url.hostname) && !/^fonts\./.test(url.hostname)) return;
  if (url.hostname.endsWith('firebaseio.com') || url.hostname.endsWith('firebaseapp.com')) return;

  // Páginas (Menu, Espelhos, BI Embalagens): rede primeiro (pega a versão publicada mais nova), cache se offline.
  if (req.mode === 'navigate') {
    const isHome = /\/(index\.html)?$/.test(url.pathname);
    const key = isHome ? './index.html' : req;
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put(key, copy)); }
          return res;
        })
        .catch(() => offlinePage(key))
    );
    return;
  }

  // Arquivos do próprio app: rede primeiro, cache como reserva.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || Response.error()))
    );
    return;
  }

  // CDN (Chart.js, SheetJS, fontes, SDK Firebase): cache primeiro, atualiza em segundo plano.
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const net = fetch(req)
            .then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; })
            .catch(() => cached || Response.error());
          return cached || net;
        })
      )
    );
  }
});
