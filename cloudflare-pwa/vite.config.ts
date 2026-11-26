import { defineConfig, type Plugin } from 'vite';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/**
 * M12 (v1.8.14): after the build, inject into dist/web/sw.js
 *  - `self.__PRECACHE_MANIFEST__`: the app shell ('/') plus every emitted file (hashed JS / CSS) and public asset;
 *  - `__BUILD_HASH__`: a hash of all those files' contents, which becomes the cache name.
 * Any change to any shipped file therefore produces a new Service Worker and a new cache — no manual
 * CACHE_VERSION bumps.
 */
function swPrecachePlugin(): Plugin {
  const EXCLUDE = new Set(['sw.js', '_headers', 'index.html']);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = resolve(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  return {
    name: 'sw-precache',
    apply: 'build',
    closeBundle() {
      const outDir = resolve(__dirname, 'dist/web');
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split('\\').join('/'))
        .filter((f) => !EXCLUDE.has(f) && !f.endsWith('.map'))
        .sort();
      const hash = createHash('sha256');
      for (const f of [...files, 'index.html']) {
        hash.update(f);
        hash.update(readFileSync(resolve(outDir, f)));
      }
      const buildHash = hash.digest('hex').slice(0, 16);
      const manifest = ['/', ...files.map((f) => `/${f}`)];
      const swPath = resolve(outDir, 'sw.js');
      const source = readFileSync(swPath, 'utf8');
      if (!source.includes("'__BUILD_HASH__'")) throw new Error('sw.js: __BUILD_HASH__ placeholder not found');
      const built =
        `self.__PRECACHE_MANIFEST__ = ${JSON.stringify(manifest)};\n` +
        source.replace("'__BUILD_HASH__'", JSON.stringify(buildHash));
      writeFileSync(swPath, built);
    },
  };
}

function readAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version || '1.4.0';
  } catch {
    return '1.4.0';
  }
}

function readGitShortHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'local';
  }
}

function formatBuildTime(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export default defineConfig({
  root: resolve(__dirname, 'web'),
  publicDir: resolve(__dirname, 'web/public'),
  define: {
    __APP_VERSION__: JSON.stringify(readAppVersion()),
    __BUILD_COMMIT__: JSON.stringify(readGitShortHash()),
    __BUILD_TIME__: JSON.stringify(formatBuildTime()),
  },
  plugins: [swPrecachePlugin()],
  build: {
    outDir: resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
