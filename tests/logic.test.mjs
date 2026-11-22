import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

const projectRoot = resolve(import.meta.dirname, '..');
const distDir = join(projectRoot, 'dist');

function createMockProperties() {
  const store = new Map();
  return {
    getProperty: (k) => (store.has(k) ? store.get(k) : null),
    setProperty: (k, v) => store.set(k, String(v)),
    setProperties: (obj) => {
      for (const [k, v] of Object.entries(obj)) store.set(k, String(v));
    },
    deleteProperty: (k) => store.delete(k),
  };
}

function createMockCache() {
  const store = new Map();
  return {
    get: (k) => (store.has(k) ? store.get(k) : null),
    put: (k, v) => store.set(k, String(v)),
    remove: (k) => store.delete(k),
  };
}

function loadGasContext(mocks = {}) {
  const props = createMockProperties();
  const userCache = createMockCache();

  const ctx = vm.createContext({
    console,
    Date,
    Math,
    Number,
    String,
    Set,
    Array,
    Object,
    Error,
    isNaN,
    isFinite,
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => props },
    CacheService: { getUserCache: () => userCache },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(),
      computeDigest(_alg, input) {
        return Array.from(crypto.createHash('sha256').update(String(input), 'utf8').digest());
      },
      formatDate(date, _tz, pattern) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        if (pattern === 'yyyy-MM-dd') return `${y}-${m}-${d}`;
        if (pattern === 'yyyy-MM') return `${y}-${m}`;
        if (pattern === 'yyyy-MM-dd HH:mm') return `${y}-${m}-${d} ${hh}:${mm}`;
        return `${y}-${m}-${d}`;
      },
    },
    ...mocks,
  });

  const files = ['config.js', 'utils.js', 'security.js', 'setup.js', 'automation.js', 'webapp.js'];
  for (const file of files) {
    const code = readFileSync(join(distDir, file), 'utf8');
    vm.runInContext(code, ctx, { filename: file });
  }
  return ctx;
}

test('dist/ contains all compiled GAS files, HTML, and manifest without ES module syntax', () => {
  const expectedFiles = [
    'appsscript.json',
    'index.html',
    'config.js',
    'utils.js',
    'security.js',
    'setup.js',
    'automation.js',
    'webapp.js',
  ];

  for (const file of expectedFiles) {
    const fullPath = join(distDir, file);
    assert.equal(existsSync(fullPath), true, `Missing dist/${file}`);
  }

  for (const jsFile of ['config.js', 'utils.js', 'security.js', 'setup.js', 'automation.js', 'webapp.js']) {
    const content = readFileSync(join(distDir, jsFile), 'utf8');
    assert.equal(/\bexport\s+/.test(content), false, `dist/${jsFile} should not contain ES export`);
    assert.equal(/\bimport\s+/.test(content), false, `dist/${jsFile} should not contain ES import`);
  }
});

test('GAS global entry points (Sheets + Automation + WebApp + Security) are defined', () => {
  const ctx = loadGasContext();
  const requiredFns = [
    'onOpen',
    'setupSpreadsheet',
    'setupSpreadsheetWithConfirm',
    'rebuildDashboardOnly',
    'shouldPostRecurringItem',
    'runMonthlyRecurring',
    'checkAndRunMonthEndSnapshot',
    'runMonthEndNetWorthSnapshot',
    'installTriggers',
    'removeManagedTriggers',
    'listInstalledTriggers',
    'doGet',
    'getSecurityStatus',
    'unlockWithPin',
    'lockSession',
    'configureAppPin',
    'resetAppPinMenu',
    'getAppBundle',
    'submitExpense',
    'deleteCashFlowEntry',
    'saveBudgetSettings',
    'saveRecurringItem',
    'toggleRecurringStatus',
    'deleteRecurringItem',
    'saveSinkingFundItem',
    'deleteSinkingFundItem',
    'saveAssetItem',
    'deleteAssetItem',
    'runRecurringFromUi',
    'runSnapshotFromUi',
  ];

  for (const fn of requiredFns) {
    assert.equal(typeof ctx[fn], 'function', `Expected global function ${fn}`);
  }
});

test('parseLocalDate validates calendar dates strictly', () => {
  const ctx = loadGasContext();
  const d = ctx.parseLocalDate('2026-11-22');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 10);
  assert.equal(d.getDate(), 22);

  assert.throws(() => ctx.parseLocalDate('2026-02-30'), /無效的日期/);
  assert.throws(() => ctx.parseLocalDate('2026/11/22'), /日期格式錯誤/);
});

test('buildRecurringDedupKey normalizes whitespace reliably', () => {
  const ctx = loadGasContext();
  assert.equal(
    ctx.buildRecurringDedupKey(' 訂閱扣款 ', ' Google AI Pro '),
    ctx.buildRecurringDedupKey('訂閱扣款', 'Google AI Pro')
  );
});

test('shouldPostRecurringItem supports monthly, annual, specific months, and one-time cycles', () => {
  const ctx = loadGasContext();

  assert.equal(ctx.shouldPostRecurringItem('月繳', '', 2026, 1), true);
  assert.equal(ctx.shouldPostRecurringItem('年繳', '6', 2026, 6), true);
  assert.equal(ctx.shouldPostRecurringItem('年繳', '6', 2026, 5), false);
  assert.equal(ctx.shouldPostRecurringItem('特定月份', '3,6,9,12', 2026, 9), true);
  assert.equal(ctx.shouldPostRecurringItem('特定月份', '3、6、9、12', 2026, 12), true);
  assert.equal(ctx.shouldPostRecurringItem('特定月份', '3,6,9,12', 2026, 10), false);
  assert.equal(ctx.shouldPostRecurringItem('一次性', '', 2026, 11), true);
  assert.equal(ctx.shouldPostRecurringItem('一次性', '2026-12', 2026, 12), true);
  assert.equal(ctx.shouldPostRecurringItem('一次性', '2026-12', 2026, 11), false);
  assert.equal(ctx.shouldPostRecurringItem('一次性', '11', 2026, 11), true);
});

test('App PIN security: enable, reject wrong PIN, unlock with valid token, and lockSession', () => {
  const ctx = loadGasContext();

  // 預設關閉
  assert.equal(ctx.getSecurityStatus().pinEnabled, false);
  assert.doesNotThrow(() => ctx.assertAuthorized(''));

  // 啟用 PIN 鎖
  const enabledRes = ctx.configureAppPin('', { enable: true, newPin: '2580' });
  assert.equal(enabledRes.pinEnabled, true);
  assert.ok(enabledRes.token.length > 10);

  // 未帶 token 或假 token 應拒絕
  assert.throws(() => ctx.assertAuthorized(''), /AUTH_REQUIRED/);
  assert.throws(() => ctx.assertAuthorized('fake-token'), /AUTH_REQUIRED/);

  // 帶正確 token 應放行
  assert.doesNotThrow(() => ctx.assertAuthorized(enabledRes.token));

  // 錯誤 PIN 無法解鎖
  const badUnlock = ctx.unlockWithPin('9999');
  assert.equal(badUnlock.ok, false);

  // 正確 PIN 可取得新 token
  const goodUnlock = ctx.unlockWithPin('2580');
  assert.equal(goodUnlock.ok, true);
  assert.doesNotThrow(() => ctx.assertAuthorized(goodUnlock.token));

  // 手動上鎖後 token 立即失效
  ctx.lockSession(goodUnlock.token);
  assert.throws(() => ctx.assertAuthorized(goodUnlock.token), /AUTH_REQUIRED/);
});

test('submitExpense rejects invalid amounts and unsupported types before touching sheet', () => {
  const ctx = loadGasContext();
  assert.throws(
    () =>
      ctx.submitExpense({
        date: '2026-11-22',
        type: '無效類型',
        category: '餐飲',
        itemName: '午餐',
        amount: 100,
        currency: 'TWD',
      }),
    /不支援的收支類型/
  );
  assert.throws(
    () =>
      ctx.submitExpense({
        date: '2026-11-22',
        type: '日常花費',
        category: '餐飲',
        itemName: '午餐',
        amount: -50,
        currency: 'TWD',
      }),
    /大於 0/
  );
  assert.throws(
    () =>
      ctx.submitExpense({
        date: '2026-11-22',
        type: '日常花費',
        category: '餐飲',
        itemName: '午餐',
        amount: 100,
        currency: 'JPY',
      }),
    /不支援的幣別/
  );
});
