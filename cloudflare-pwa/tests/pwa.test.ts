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
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    expect(manifest.icons.some((i: { src: string; type: string }) => i.src.endsWith('.png') && i.type === 'image/png')).toBe(true);
  });

  it('ships real PNG icons for iOS apple-touch-icon (avoiding Safari SVG letter fallback)', () => {
    for (const file of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) {
      const iconPath = resolve(rootDir, 'web/public/icons', file);
      expect(existsSync(iconPath)).toBe(true);
      const buf = readFileSync(iconPath);
      // PNG magic bytes: 89 50 4E 47
      expect(buf[0]).toBe(0x89);
      expect(buf[1]).toBe(0x50);
      expect(buf[2]).toBe(0x4e);
      expect(buf[3]).toBe(0x47);
    }

    const html = readFileSync(resolve(rootDir, 'web/index.html'), 'utf8');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('/icons/apple-touch-icon.png');
  });

  it('provides a syntactically valid Service Worker that caches app shell and bypasses /api/', () => {
    const swPath = resolve(rootDir, 'web/public/sw.js');
    expect(existsSync(swPath)).toBe(true);

    const code = readFileSync(swPath, 'utf8');
    expect(() => new vm.Script(code, { filename: 'sw.js' })).not.toThrow();
    expect(code).toContain('/api/');
    expect(code).toContain('caches.open');
  });

  it('initializes all 14 D1 tables cleanly from migrations (including rent_utility)', async () => {
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
      'rent_utility_records',
      'rent_utility_settings',
      'sinking_fund_items',
      'sync_idempotency',
    ]);

    // Verify seeded confirmed history (11409 baseline + 11411~11509)
    const countRow = await db
      .prepare('SELECT COUNT(*) as cnt FROM rent_utility_records')
      .first<{ cnt: number }>();
    expect(countRow?.cnt).toBe(7);
  });

  it('includes 5th rent-utility tab in index.html', () => {
    const html = readFileSync(resolve(rootDir, 'web/index.html'), 'utf8');
    expect(html).toContain('id="tab-utility"');
    expect(html).toContain('data-tab="utility"');
  });
});
