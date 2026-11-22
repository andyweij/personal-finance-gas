import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const distDir = join(projectRoot, 'dist');
const webDir = join(projectRoot, 'web');
const manifestPath = join(projectRoot, 'appsscript.json');

console.log('🧹 Cleaning dist/ ...');
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

console.log('🔨 Compiling TypeScript (src/*.ts -> dist/*.js) ...');
const tscBin = join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
);

if (!existsSync(tscBin)) {
  console.error('❌ 找不到 TypeScript 編譯器，請先執行 npm install');
  process.exit(1);
}

execFileSync(tscBin, ['--project', join(projectRoot, 'tsconfig.json')], {
  cwd: projectRoot,
  stdio: 'inherit',
});

console.log('📄 Copying appsscript.json -> dist/ ...');
cpSync(manifestPath, join(distDir, 'appsscript.json'));

if (existsSync(webDir)) {
  console.log('🌐 Copying web/*.html -> dist/ ...');
  for (const file of readdirSync(webDir)) {
    if (file.endsWith('.html')) {
      cpSync(join(webDir, file), join(distDir, file));
    }
  }
}

console.log('✅ Build complete! Ready for `clasp push`.');
