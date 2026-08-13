/* 株価テクニカル分析ツール — オフラインで開くためのキャッシュ
   キャッシュしてよいのは「変わらないもの」だけです。株価・空売り残高・
   ニュース・Googleの認証は必ずネットワークへ流します(古い値を返すと、
   ただ間違った分析になるため)。 */
const CACHE = 'ta-tool-v2';
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

  /* アプリ本体(HTML)だけは「まずネットワーク」。

     以前はここも“キャッシュを返して裏で更新”でした。つまり更新しても、
     開いた回は前の版が表示され、**もう一度開いて初めて**新しくなります。
     直したはずのものが直っていない、直る時と直らない時がある、という
     見え方の原因になります。本体は3秒だけ待って、駄目ならキャッシュへ。
     画像や manifest は内容が変わらないので今までどおりで構いません。 */
  const isDoc = req.mode === 'navigate' || req.destination === 'document'
             || /(^\/|\/|\/index\.html)$/.test(url.pathname);
  if (isDoc) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        /* no-store でブラウザ自身のHTTPキャッシュも飛び越える。
           GitHub Pages は10分間キャッシュを許すので、これがないと
           「ネットワークから取った古い版」を掴みます */
        const fresh = new Request(url.href, {cache: 'no-store', credentials: 'same-origin'});
        const res = await Promise.race([
          fetch(fresh),
          new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 3000))
        ]);
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch (e) {
        const hit = await cache.match(req)
                 || await cache.match('./index.html')
                 || await cache.match('./');
        if (hit) return hit;
        throw e;
      }
    })());
    return;
  }

  /* 残り(アイコン・manifest)は、まずキャッシュを返して裏で更新する */
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(res => {
      if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
