/**
 * 运行期依赖自检：确认 server/src 里所有相对 import 指向的文件都在这个镜像/目录里。
 *
 * 背景：Dockerfile 运行阶段是精简镜像，只 COPY 若干目录。曾经出现「构建阶段有 shared/、
 * 运行阶段漏拷」，镜像能构建、版本号能校验通过，但容器一启动就 ERR_MODULE_NOT_FOUND，
 * 健康检查全红后自动回滚。把这个检查放进 docker build，坏镜像就产不出来。
 *
 * 既能在容器内跑（node /app/scripts/check-runtime-deps.mjs），
 * 也能在仓库本地跑（node scripts/check-runtime-deps.mjs）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'server', 'src');

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const missing = [];
let checked = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  // 静态 import / export from / 动态 import()，只收相对路径
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    const spec = m[1];
    const target = resolve(dirname(file), spec);
    checked += 1;
    if (
      !existsSync(target)
      && !existsSync(`${target}.js`)
      && !existsSync(join(target, 'index.js'))
    ) {
      missing.push(`${relative(ROOT, file)} -> ${spec}（期望 ${relative(ROOT, target)}）`);
    }
  }
}

if (!files.length) {
  console.error('[runtime-deps] ✗ 没找到 server/src 源码，镜像可能不完整');
  process.exit(1);
}
if (missing.length) {
  console.error(`[runtime-deps] ✗ ${missing.length} 个运行期依赖缺失：`);
  for (const m of missing) console.error('  - ' + m);
  process.exit(1);
}
console.log(`[runtime-deps] ✓ ${files.length} 个源码文件，${checked} 个相对依赖齐全`);
