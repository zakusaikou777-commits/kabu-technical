/* 株価テクニカル分析ツール — オフラインで開くためのキャッシュ
   キャッシュしてよいのは「変わらないもの」だけです。株価・空売り残高・
   ニュース・Googleの認証は必ずネットワークへ流します(古い値を返すと、
   ただ間違った分析になるため)。 */
const CACHE = 'ta-tool-v1';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

/* SheetJS など、内容が固定でSRI検証もかかるもの */
const CDN = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* addAll は1つ失敗すると全部入らないので、1件ずつ入れて失敗だけ記録する */
    const failed = [];
    await Promise.all(SHELL.map(async url => {
      try { await cache.add(new Request(url, {cache: 'reload'})); }
      catch (e) { failed.push(url); }
    }));
    if (failed.length) console.warn('[sw] キャッシュできなかったファイル:', failed);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  /* Google の認証と Drive API。キャッシュすると同期が壊れる */
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('google.com')) return;

  if (CDN.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        cache.put(req, res.clone()).catch(() => {});   /* 保存に失敗しても配信は続ける */
        return res;
      } catch (e) {
        return new Response('', {status: 504, statusText: 'offline'});
      }
    })());
    return;
  }

  /* 株価・空売り・信用・ニュース・中継サーバ … 触らない */
  if (url.origin !== self.location.origin) return;

  /* 自分のファイルは、まずキャッシュを返して裏で更新する。
     次に開いたときには新しい版になる */
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(res => {
      if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
