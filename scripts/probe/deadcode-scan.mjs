// 死代码扫描：未被引用的配置键 / 导出函数 / 前端文件
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/');
const SKIP = new Set(['node_modules', 'dist', '.git', '_probe', '_npmcache', 'uploads']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT).filter((f) => ['.js', '.mjs', '.vue', '.sql', '.json'].includes(extname(f)));
const code = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');

// ---------- 1. setting 键是否被读取 ----------
const seedSrc = code.get(join(ROOT, 'server/src/seed.js')) || '';
const seedKeys = [...seedSrc.matchAll(/\[\s*'([a-z0-9_]+)'\s*,\s*'[^']*'\s*,\s*'([a-z]+)'\s*\]/g)]
  .map((m) => ({ key: m[1], group: m[2] }));

const nonSeed = files.filter((f) => !rel(f).endsWith('server/src/seed.js'));
const nonSeedCode = nonSeed.map((f) => code.get(f)).join('\n');

const unusedKeys = seedKeys.filter(({ key }) => {
  const re = new RegExp(`['"\`]${key}['"\`]`);
  return !re.test(nonSeedCode);
});

console.log('=== 1. seed 里定义但代码里没人读的配置键 ===');
if (!unusedKeys.length) console.log('无');
for (const u of unusedKeys) console.log(`  ${u.group.padEnd(8)} ${u.key}`);

// ---------- 2. server/lib 导出函数是否被引用 ----------
console.log('\n=== 2. server/src/lib 里导出但没被引用的函数 ===');
const libFiles = files.filter((f) => rel(f).startsWith('server/src/lib/') && rel(f).endsWith('.js'));
let anyUnusedFn = false;
for (const f of libFiles) {
  const src = code.get(f);
  const names = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const self = rel(f);
  const others = files.filter((x) => rel(x) !== self && !rel(x).includes('/test/')).map((x) => code.get(x)).join('\n');
  for (const n of names) {
    const re = new RegExp(`\\b${n}\\b`);
    if (!re.test(others)) {
      console.log(`  ${self} → ${n}`);
      anyUnusedFn = true;
    }
  }
}
if (!anyUnusedFn) console.log('无');

// ---------- 3. 前端 .vue 是否被引用 ----------
console.log('\n=== 3. .vue 文件没有任何地方引用 ===');
const vues = files.filter((f) => extname(f) === '.vue');
const allText = files.filter((f) => !extname(f).match(/\.vue$/)).map((f) => code.get(f)).join('\n') + '\n' +
  vues.map((f) => code.get(f)).join('\n');
let anyVue = false;
for (const v of vues) {
  const name = v.split(/[\\/]/).pop().replace('.vue', '');
  // 引用方式：import ... from '.../Name.vue' 或 <Name /> 标签
  const imported = new RegExp(`[/']${name}\\.vue['"]`).test(allText);
  const usedAsTag = new RegExp(`<${name}[\\s/>]`).test(allText);
  if (!imported && !usedAsTag) {
    console.log(`  ${rel(v)}`);
    anyVue = true;
  }
}
if (!anyVue) console.log('无');

// ---------- 4. 空目录 / 疑似残留 ----------
console.log('\n=== 4. 顶层目录体积 ===');
for (const d of readdirSync(ROOT)) {
  const p = join(ROOT, d);
  if (!statSync(p).isDirectory()) continue;
  console.log(`  ${d}`);
}
void existsSync;
