// 一体化构建：把后台与 H5 打包到 public/，由同一个 Node 进程托管
// 用法: npm run build
import { spawnSync } from 'node:child_process';
import { rmSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');

function step(name, cmd, args, opts = {}) {
  console.log(`\n▶ ${name}`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (r.status !== 0) {
    console.error(`\n✗ ${name} 失败（exit ${r.status}）`);
    process.exit(r.status || 1);
  }
}

function sizeOf(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? sizeOf(p) : st.size;
  }
  return total;
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

console.log('清理 public/ …');
rmSync(PUB, { recursive: true, force: true });

// 后台挂在 /admin/ 下，必须带 base 构建，否则资源会指向根路径与 H5 冲突
step('构建后台（base=/admin/）', 'npm', ['run', 'build'], {
  cwd: join(ROOT, 'admin'),
  env: { VITE_BASE: '/admin/' },
});
step('构建 H5（base=/）', 'npm', ['run', 'build'], { cwd: join(ROOT, 'h5') });

console.log('\n▶ 收集产物到 public/');
cpSync(join(ROOT, 'admin', 'dist'), join(PUB, 'admin'), { recursive: true });
cpSync(join(ROOT, 'h5', 'dist'), join(PUB, 'h5'), { recursive: true });

const a = sizeOf(join(PUB, 'admin'));
const h = sizeOf(join(PUB, 'h5'));
console.log(`  public/admin  ${mb(a)}`);
console.log(`  public/h5     ${mb(h)}`);
console.log(`\n✓ 构建完成。启动：npm start  然后访问 http://127.0.0.1:3300/ 与 /admin/`);
