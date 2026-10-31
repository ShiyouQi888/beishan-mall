/**
 * H5 版号管理。
 *
 * 页面上显示的版号来自 h5/package.json 的 version（构建时由 vite define 注入），
 * 所以改版号只用改这一个文件 —— 不要直接改 App.vue 里的字符串。
 *
 * 用法：
 *   node scripts/version.mjs            # 只看当前版号
 *   node scripts/version.mjs minor      # 2.0.0 → 2.1.0（默认，页面上 V2.0 → V2.1）
 *   node scripts/version.mjs patch      # 2.0.0 → 2.0.1（页面显示不变，仅内部修订）
 *   node scripts/version.mjs major      # 2.0.0 → 3.0.0
 *
 * 为什么默认 minor：底部只展示「主.次」两位，patch 位变了页面上看不出区别，
 * 就没法用它判断线上是不是最新版本。只有确实想「不改版号」的微调才用 patch。
 *
 * 项目约定：每次 git push 前先跑一次 `npm run version:bump`（等价于 minor）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PKG = join(ROOT, 'h5', 'package.json');
const LOCK = join(ROOT, 'h5', 'package-lock.json');

const short = (v) => `V${v.split('.').slice(0, 2).join('.')}`;

const pkg = JSON.parse(readFileSync(PKG, 'utf-8'));
const current = pkg.version;

const arg = (process.argv[2] || '').replace(/^--?/, '').toLowerCase();
if (!arg) {
  console.log(`当前版号：${short(current)}（完整 ${current}）`);
  process.exit(0);
}
if (!['major', 'minor', 'patch'].includes(arg)) {
  console.error(`未知参数「${arg}」，只能是 major / minor / patch`);
  process.exit(1);
}

const [maj, min, pat] = current.split('.').map((n) => Number(n) || 0);
let next;
if (arg === 'major') next = `${maj + 1}.0.0`;
else if (arg === 'minor') next = `${maj}.${min + 1}.0`;
else next = `${maj}.${min}.${pat + 1}`;

pkg.version = next;
writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');

// package-lock 里也记着根包版本，不同步会让 npm ci 报版本不一致
if (existsSync(LOCK)) {
  const lock = JSON.parse(readFileSync(LOCK, 'utf-8'));
  let touched = false;
  if (lock.version) { lock.version = next; touched = true; }
  if (lock.packages?.['']?.version) { lock.packages[''].version = next; touched = true; }
  if (touched) writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`, 'utf-8');
}

console.log(`版号已更新：${short(current)} → ${short(next)}（完整 ${current} → ${next}）`);
console.log('记得重新构建 H5 才会生效：npm --prefix h5 run build');
