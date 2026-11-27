// v2.2.1 smoke test: both 介面版本 (經典版 / 簡潔版) — every tab and every entry is opened once, and any page error
// fails the run. 「更多」rows are generated from web/src/ui/featureEntries.ts; each row's data-expect says where it
// must lead, so a new 「更多」 entry is covered automatically.
// Usage: npm run build:web && node tests/e2e/ui-variants.e2e.mjs   (uses the pre-installed Playwright Chromium)
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/web');
if (!existsSync(resolve(root, 'index.html'))) throw new Error('run `npm run build:web` first');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end('{"error":"offline test"}');
  }
  let file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = resolve(root, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;

const failures = [];
const checked = [];
function check(name, ok, detail = '') {
  checked.push(name);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function openApp(browser, variant) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript((v) => localStorage.setItem('finance_ui_variant', v), variant);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  // no backend in this test: hide the sign-in / lock overlays and use the app on its local data
  await page.addStyleTag({ content: '#authScreen,#lockScreen,.loading-bar{display:none!important}' });
  await page.waitForTimeout(300);
  return { context, page, errors };
}

const activeTab = (page) => page.evaluate(() => document.querySelector('.tab-view.active')?.id || '');
const isOpen = (page, id) => page.evaluate((i) => document.getElementById(i)?.classList.contains('open') === true, id);
const isVisible = (page, id) =>
  page.evaluate((i) => {
    const n = document.getElementById(i);
    if (!n) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden';
  }, id);

async function closeOverlays(page) {
  if (await isOpen(page, 'calcBackdrop')) await page.click('#calcCloseBtn');
  if (await isOpen(page, 'modalBackdrop')) await page.click('#closeModalBtn');
  if (await isOpen(page, 'quickAddBackdrop')) await page.click('#quickAddCloseBtn');
  await page.waitForTimeout(100);
}

const browser = await chromium.launch();
try {
  // ---------- 經典版 ----------
  {
    const { context, page, errors } = await openApp(browser, 'classic');
    check('classic: data-ui', (await page.evaluate(() => document.documentElement.dataset.ui)) === 'classic');
    check('classic: bottom nav visible', await isVisible(page, 'bottomNav'));
    check('classic: simple nav hidden', !(await isVisible(page, 'simpleNav')));
    const tabs = await page.$$eval('#bottomNav .nav-btn', (bs) => bs.map((b) => b.dataset.tab));
    for (const tab of tabs) {
      await page.click(`#bottomNav .nav-btn[data-tab="${tab}"]`);
      await page.waitForTimeout(150);
      check(`classic: tab ${tab}`, (await activeTab(page)) === `tab-${tab}`, await activeTab(page));
    }
    await page.click('#bottomNav .nav-btn[data-tab="tools"]');
    const subs = await page.$$eval('#toolsSubtabBar [data-tools-sub]', (bs) =>
      bs.filter((b) => b.style.display !== 'none').map((b) => b.dataset.toolsSub)
    );
    for (const sub of subs) {
      await page.click(`#toolsSubtabBar [data-tools-sub="${sub}"]`);
      await page.waitForTimeout(100);
      check(`classic: tools/${sub}`, await isVisible(page, `subtab-${sub}`));
    }
    await page.click('#bottomNav .nav-btn[data-tab="log"]');
    check('classic: entry form in log tab', (await page.evaluate(() => document.getElementById('expenseForm')?.closest('.tab-view')?.id)) === 'tab-log');
    await page.click('#calcFabBtn');
    await page.waitForTimeout(150);
    check('classic: floating calculator opens', await isOpen(page, 'calcBackdrop'));
    await closeOverlays(page);
    await page.click('#securityBtn');
    await page.waitForTimeout(200);
    check('classic: settings has 介面版本', (await page.textContent('#modalBody'))?.includes('介面版本') === true);
    await closeOverlays(page);
    check('classic: no page errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // ---------- 簡潔版 ----------
  {
    const { context, page, errors } = await openApp(browser, 'simple');
    check('simple: data-ui', (await page.evaluate(() => document.documentElement.dataset.ui)) === 'simple');
    check('simple: starts on 首頁', (await activeTab(page)) === 'tab-home', await activeTab(page));
    check('simple: classic nav hidden', !(await isVisible(page, 'bottomNav')));
    check('simple: floating calculator hidden', !(await isVisible(page, 'calcFabBtn')));

    const tabs = await page.$$eval('#simpleNav [data-simple-tab]', (bs) => bs.map((b) => b.dataset.simpleTab));
    for (const tab of tabs) {
      await page.click(`#simpleNav [data-simple-tab="${tab}"]`);
      await page.waitForTimeout(150);
      check(`simple: tab ${tab}`, (await activeTab(page)) === `tab-${tab}`, await activeTab(page));
    }
    check('simple: 明細 shows the ledger', await page.evaluate(() => {
      document.querySelector('#simpleNav [data-simple-tab="log"]').click();
      return getComputedStyle(document.getElementById('ledgerPanel')).display !== 'none';
    }));

    // ＋記一筆
    await page.click('#simpleAddBtn');
    await page.waitForTimeout(200);
    check('simple: quick-add sheet opens', await isOpen(page, 'quickAddBackdrop'));
    check('simple: entry form is in the sheet', (await page.evaluate(() => document.getElementById('expenseForm')?.parentElement?.id)) === 'quickAddBody');
    check('simple: note hidden until 更多選項', !(await isVisible(page, 'noteInput')));
    await page.click('#qaMoreToggle');
    check('simple: 更多選項 reveals note', await isVisible(page, 'noteInput'));
    await page.click('#amountCalcBtn');
    await page.waitForTimeout(150);
    check('simple: amount calculator opens', await isOpen(page, 'calcBackdrop'));
    check('simple: calculator targets the amount', (await page.textContent('#calcTargetBadge'))?.startsWith('目標') === true);
    await closeOverlays(page);
    check('simple: quick-add closes', !(await isOpen(page, 'quickAddBackdrop')));

    // links into the secondary tabs, and back
    const links = [
      ['home', '#homeOverviewLink', 'overview'],
      ['assets', '#simpleStocksRow', 'stocks'],
    ];
    for (const [from, selector, to] of links) {
      await page.click(`#simpleNav [data-simple-tab="${from}"]`);
      await page.click(selector);
      await page.waitForTimeout(150);
      check(`simple: ${from} → ${to}`, (await activeTab(page)) === `tab-${to}`, await activeTab(page));
      await page.click(`#tab-${to} [data-simple-back]`);
      await page.waitForTimeout(150);
      check(`simple: back from ${to} → ${from}`, (await activeTab(page)) === `tab-${from}`, await activeTab(page));
    }

    // every visible 「更多」 row leads where featureEntries.ts says
    await page.click('#simpleNav [data-simple-tab="more"]');
    const rows = await page.$$eval('#moreEntries [data-more-action]', (rs) =>
      rs.filter((r) => r.style.display !== 'none').map((r) => ({ id: r.dataset.moreAction, expect: JSON.parse(r.dataset.expect || '{}') }))
    );
    check('simple: 更多 has entries', rows.length >= 5, String(rows.length));
    for (const row of rows) {
      await page.click('#simpleNav [data-simple-tab="more"]');
      await page.waitForTimeout(100);
      await page.click(`#moreEntries [data-more-action="${row.id}"]`);
      await page.waitForTimeout(250);
      const exp = row.expect;
      if (exp.kind === 'tab') {
        check(`simple: 更多/${row.id} → ${exp.tab}`, (await activeTab(page)) === `tab-${exp.tab}`, await activeTab(page));
        if (exp.elementId) check(`simple: 更多/${row.id} shows #${exp.elementId}`, await isVisible(page, exp.elementId));
      } else if (exp.kind === 'modal') {
        check(`simple: 更多/${row.id} opens a dialog`, await isOpen(page, 'modalBackdrop'));
      } else if (exp.kind === 'calculator') {
        check(`simple: 更多/${row.id} opens the calculator`, await isOpen(page, 'calcBackdrop'));
      } else {
        check(`simple: 更多/${row.id} has a known outcome`, false, JSON.stringify(exp));
      }
      await closeOverlays(page);
    }

    // switch back to 經典版 from 更多
    await page.click('#simpleNav [data-simple-tab="more"]');
    await page.click('#moreUiVariantSeg [data-ui-variant="classic"]');
    await page.waitForTimeout(200);
    check('switch: data-ui classic', (await page.evaluate(() => document.documentElement.dataset.ui)) === 'classic');
    check('switch: classic nav visible', await isVisible(page, 'bottomNav'));
    check('switch: entry form back in log tab', (await page.evaluate(() => document.getElementById('expenseForm')?.closest('.tab-view')?.id)) === 'tab-log');
    check('switch: remembered', (await page.evaluate(() => localStorage.getItem('finance_ui_variant'))) === 'classic');
    check('simple: no page errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`${checked.length} checks`);
if (failures.length) {
  console.error('UI variants e2e FAILED:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('UI variants e2e OK');
