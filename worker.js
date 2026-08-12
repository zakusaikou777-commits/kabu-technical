/* ============================================================
   自分専用の中継サーバー (Cloudflare Workers)
   株価テクニカル分析ツール用

   ブラウザから Yahoo Finance などへ直接アクセスすることはできません
   (CORS)。無料の公開中継サーバーでも動きますが、混雑して時間切れに
   なりますし、「どの銘柄を見たか」がその運営者に渡ります。
   これを自分のアカウントに置くと、その両方が解決します。

   ------------------------------------------------------------
   置きかた(5分・無料枠で十分です)
   ------------------------------------------------------------
   1. https://dash.cloudflare.com/ にログイン
   2. 左メニュー「Workers & Pages」→「Create」→「Start with Hello World!」
      →「Deploy」(名前は何でも構いません。例: ta-relay)
   3. デプロイ後「Edit code」を開き、中身を全部消してこのファイルを貼り付け
   4. 「Deploy」
   5. 表示された URL(例 https://ta-relay.あなた.workers.dev)をコピーし、
      ツールの「通信」欄に貼り付けて「保存」

   ------------------------------------------------------------
   このコードがしていること
   ------------------------------------------------------------
   ・取りにいける先を下の ALLOW だけに限定しています。誰かにURLを
     知られても、他人がこれを使って任意のサイトへ中継することはできません
     (＝「オープンプロキシ」になりません)
   ・ALLOW_ORIGIN を自分の公開URLに書き換えると、そのページからしか
     使えなくなります。空のままでも上の制限は効きますが、書いたほうが安全です
   ・Cookie と認証ヘッダは転送しません
   ============================================================ */

/* ここを自分の公開URLにすると、そのページ専用になります。
   例: const ALLOW_ORIGIN = 'https://xxxx.github.io';
   空文字のままなら、どこからでも使えます(取得先の制限は残ります)。 */
const ALLOW_ORIGIN = '';

/* 中継してよい相手。ツールが使う先だけです。
   ここに載っていないホストは 403 で断ります。 */
const ALLOW = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'stooq.com',
  'news.google.com',
  'www.jpx.co.jp',
  'jpx.co.jp',
  'www.taisyaku.jp'
];

const MAX_BYTES = 25 * 1024 * 1024;

function allowed(host) {
  host = String(host || '').toLowerCase();
  return ALLOW.some(h => host === h || host.endsWith('.' + h));
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN || origin || '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function deny(msg, status, origin) {
  return new Response(msg, {status: status, headers: cors(origin)});
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: cors(origin)});
    }
    if (request.method !== 'GET') {
      return deny('GET only', 405, origin);
    }
    /* 自分のページ専用にしている場合 */
    if (ALLOW_ORIGIN && origin && origin !== ALLOW_ORIGIN) {
      return deny('origin not allowed', 403, origin);
    }

    const here = new URL(request.url);

    /* ブラウザで直接開いたときの動作確認用 */
    if (!here.searchParams.has('url')) {
      return new Response(
        '中継サーバーは動いています。\n\n' +
        'このURLをツールの「通信」欄に貼り付けてください。\n' +
        '中継できる取得先: ' + ALLOW.join(', ') + '\n',
        {status: 200, headers: Object.assign({'Content-Type': 'text/plain; charset=utf-8'}, cors(origin))}
      );
    }

    let target;
    try {
      target = new URL(here.searchParams.get('url'));
    } catch (e) {
      return deny('bad url', 400, origin);
    }
    if (target.protocol !== 'https:') return deny('https only', 400, origin);
    if (!allowed(target.hostname)) return deny('host not allowed: ' + target.hostname, 403, origin);

    let upstream;
    try {
      upstream = await fetch(target.href, {
        method: 'GET',
        headers: {
          /* 素のfetchだと弾く相手がいるので、ふつうのブラウザとして名乗ります */
          'User-Agent': 'Mozilla/5.0 (compatible; ta-relay/1.0)',
          'Accept': request.headers.get('Accept') || '*/*',
          'Accept-Language': 'ja,en;q=0.8'
        },
        redirect: 'follow',
        cf: {cacheTtl: 20, cacheEverything: false}
      });
    } catch (e) {
      return deny('upstream error', 502, origin);
    }

    const len = Number(upstream.headers.get('content-length') || 0);
    if (len > MAX_BYTES) return deny('too large', 413, origin);

    const headers = new Headers(cors(origin));
    const ct = upstream.headers.get('content-type');
    if (ct) headers.set('Content-Type', ct);
    headers.set('Cache-Control', 'no-store');

    return new Response(upstream.body, {status: upstream.status, headers: headers});
  }
};
