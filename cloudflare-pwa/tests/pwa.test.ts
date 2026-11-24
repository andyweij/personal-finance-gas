import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createTestD1 } from './helpers/mockD1';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('PWA assets & D1 migration integrity', () => {
  it('provides a valid standalone PWA manifest for iOS and Android home screen install', () => {
    const manifestPath = resolve(rootDir, 'web/public/manifest.webmanifest');
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.name).toBeTruthy();
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(1);
  });

  it('provides a syntactically valid Service Worker that caches app shell and bypasses /api/', () => {
    const swPath = resolve(rootDir, 'web/public/sw.js');
    expect(existsSync(swPath)).toBe(true);

    const code = readFileSync(swPath, 'utf8');
    expect(() => new vm.Script(code, { filename: 'sw.js' })).not.toThrow();
    expect(code).toContain('/api/');
    expect(code).toContain('caches.open');
  });

  it('initializes all 12 D1 tables cleanly from 0001_initial.sql', async () => {
    const db = createTestD1();
    const res = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all<{ name: string }>();
    const names = res.results.map((r) => r.name).sort();

    expect(names).toEqual([
      'app_settings',
      'asset_items',
      'auth_challenges',
      'auth_owner',
      'auth_passkeys',
      'auth_rate_limits',
      'auth_sessions',
      'cashflow_logs',
      'networth_history',
      'recurring_items',
      'sinking_fund_items',
      'sync_idempotency',
    ]);
  });
});
