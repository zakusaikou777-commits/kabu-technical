/* 組み込みの自己テスト(index.html#selftest)を、ブラウザを画面なしで動かして実行します。
   GitHub Actions(.github/workflows/selftest.yml)から呼ばれますが、手元でも動きます:

     npm install --no-save playwright && npx playwright install chromium
     node tests/selftest.js

   外部への通信はすべて止めます(株価・JPX・CDN など)。自己テストは通信なしで
   通るように作ってあり、通信の有無で結果が変わらないようにするためです。
   あわせて、sw.js の版番号が本体と同じかも確かめます(違うと、開きっぱなしの
   端末に「新しい版があります」が出ません)。 */
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const SW = path.join(ROOT, 'sw.js');

const RUNS = [
  { label: 'パソコン幅 1280×900', ctx: { viewport: { width: 1280, height: 900 } } },
  { label: 'スマホ幅 (Pixel 7)', ctx: { ...devices['Pixel 7'] } },
];

const lines = [];
const out = s => { console.log(s); lines.push(s); };

function checkVersions() {
  const html = fs.readFileSync(HTML, 'utf8');
  const sw = fs.readFileSync(SW, 'utf8');
  const a = /const APP_VER = '(v\d+)'/.exec(html);
  const b = /const APP_VER = '(v\d+)'/.exec(sw);
  if (!a) return 'index.html に APP_VER が見つかりません';
  if (!b) return 'sw.js に APP_VER が見つかりません';
  if (a[1] !== b[1]) return `版番号が違います: index.html ${a[1]} / sw.js ${b[1]}(sw.js も上げてください)`;
  return null;
}

async function runOnce(browser, run) {
  const ctx = await browser.newContext(run.ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')));
  await page.route(/^https?:/, r => r.abort());
  await page.goto('file://' + HTML + '#selftest');
  await page.waitForFunction(() => {
    const el = document.querySelector('#selfSummary');
    return el && /件が合格/.test(el.textContent || '');
  }, null, { timeout: 180000 });
  const res = await page.evaluate(() => ({
    total: T.list.length,
    failed: T.list.filter(t => !t.ok).map(t => ({ group: t.group, name: t.name, detail: t.detail })),
  }));
  await ctx.close();
  return { ...res, errors };
}

(async () => {
  let bad = false;
  const v = checkVersions();
  if (v) { out(`✗ ${v}`); bad = true; } else out('✓ sw.js の版番号が本体と同じ');

  const browser = await chromium.launch();
  try {
    for (const run of RUNS) {
      let r;
      try { r = await runOnce(browser, run); }
      catch (e) { out(`✗ ${run.label}: 自己テストが終わりませんでした (${e.message.split('\n')[0]})`); bad = true; continue; }
      const pass = r.total - r.failed.length;
      if (!r.total) { out(`✗ ${run.label}: テストが1件も走りませんでした`); bad = true; continue; }
      out(`${r.failed.length ? '✗' : '✓'} ${run.label}: ${pass}/${r.total} 件が合格`);
      for (const f of r.failed) out(`    ✗ [${f.group}] ${f.name}${f.detail ? ' — ' + String(f.detail).slice(0, 300) : ''}`);
      if (r.errors.length) out(`    ページのエラー: ${r.errors.slice(0, 5).join(' / ')}`);
      if (r.failed.length || r.errors.length) bad = true;
    }
  } finally {
    await browser.close();
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '### 自己テスト\n\n```\n' + lines.join('\n') + '\n```\n');
  }
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
