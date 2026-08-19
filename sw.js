/* 株価テクニカル分析ツール — オフラインで開くためのキャッシュ
   キャッシュしてよいのは「変わらないもの」だけです。株価・空売り残高・
   ニュース・Googleの認証は必ずネットワークへ流します(古い値を返すと、
   ただ間違った分析になるため)。 */
/* 名前を変えると、activate で古いキャッシュがまとめて消えます。
   v2 には、CDNのエラー応答やWi-Fiのログインページを保存してしまった端末が
   あり得ます(そのままだとSheetJSが永久に壊れたままになるため)。 */
const CACHE = 'ta-tool-v11';
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

/* アラートの通知をタップしたとき。
   すでに開いているタブがあればそれを前に出し、無ければ開きます。
   これが無いと、iPhone では通知を押しても何も起きません。 */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const c of all) {
      /* オリジンでは足りません。GitHub Pages は user.github.io に別プロジェクトが
         同居するので、直前に見ていた無関係なページを前に出してしまいます。
         scope で見れば、このアプリのタブだけが対象になります。 */
      if (c.url.startsWith(self.registration.scope)) {
        try { await c.focus(); return; } catch (e) {}
      }
    }
    try { await self.clients.openWindow('./'); } catch (e) {}
  })());
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
        /* 成功した応答だけを残します。ここは cache-first で二度と取り直さない
           ので、404 や、ホテル・空港Wi-Fiのログインページ(全部200で返ります)を
           そのまま保存すると、SheetJS がその中身で固定され、以後ずっと
           「改ざん検知(SRI)」で失敗し続けます。サイトデータを消すまで
           空売り残高も決算予定もExcel取り込みも動かなくなります。 */
        if (res && res.ok && res.type !== 'opaque') {
          cache.put(req, res.clone()).catch(() => {});   /* 保存に失敗しても配信は続ける */
        }
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
        if (res && res.ok) {
          cache.put(req, res.clone()).catch(() => {});
          return res;
        }
        /* 404 や 502 も「応答」なので例外にはならず、そのまま表示されて
           いました。デプロイ中の一瞬の404や、プロキシの502で、完全な版が
           キャッシュにあるのに GitHub のエラーページが出ます。下の
           フォールバックへ落とします。 */
        const err = new Error('bad status ' + (res && res.status));
        err.res = res;          /* キャッシュが空なら、これを見せます */
        throw err;
      } catch (e) {
        const hit = await cache.match(req)
                 || await cache.match('./index.html')
                 || await cache.match('./');
        if (hit) return hit;
        /* まだ一度もキャッシュできていない端末では、サーバの404/502を
           そのまま見せます。ここで投げると、ステータスも本文も見えない
           ブラウザのネットワークエラー画面になってしまいます。 */
        if (e && e.res) return e.res;
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
