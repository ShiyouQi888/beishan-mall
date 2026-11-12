/**
 * Docker 运行阶段文件清单验收（不需要 Docker daemon）
 *
 * 背景：运行阶段是精简镜像，只 COPY 若干目录。服务端一旦 import 了清单外的
 * 文件（例如 ../../../shared/markdown.js），镜像能构建、版本号能过校验，
 * 但容器一启动就 ERR_MODULE_NOT_FOUND → 健康检查全红 → 自动回滚。
 *
 * 覆盖：
 *   1. 从 Dockerfile 解析运行阶段 COPY 清单，扫描 server/src 所有相对 import，
 *      确认没有指向清单外的仓库根目录文件
 *   2. 按清单复刻一套 /app 布局，先跑 seed 再启动 app.js，验证 /api/health 可用
 *   3. 反向验证：把 shared/ 拿掉，服务必须起不来（证明探针真能抓到这个回归）
 *
 * 用法: node scripts/probe/docker-runtime-layout.mjs
 */
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, cpSync, symlinkSync, rmSync, readdirSync,
} from 'node:fs';
import { dirname, join, resolve, relative, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const LAYOUT = join(tmpdir(), 'mall-runtime-layout-probe');
const PORT = 3493;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}

const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const copies = [...dockerfile.matchAll(/^COPY --from=build \/app\/(\S+)\s+(\S+)\s*$/gm)]
  .map((m) => ({ src: m[1], dst: m[2].replace(/^\.\//, '') }));
const topLevel = new Set(copies.map((c) => c.dst.split('/')[0]));

/** 递归列出 .js 文件 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walk(p, out);
    else if (name.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function cleanup() {
  if (existsSync(LAYOUT)) {
    try { rmSync(LAYOUT, { recursive: true, force: true }); } catch {}
  }
}

function buildLayout(withShared = true) {
  cleanup();
  mkdirSync(LAYOUT, { recursive: true });
  // 对应 Dockerfile 的 RUN mkdir -p /app/data/uploads（VOLUME 挂载点）
  mkdirSync(join(LAYOUT, 'data', 'uploads'), { recursive: true });
  for (const c of copies) {
    if (!withShared && (c.src === 'shared' || c.dst === 'shared')) continue;
    const from = join(ROOT, c.src);
    if (!existsSync(from)) continue;
    const to = join(LAYOUT, c.dst);
    mkdirSync(dirname(to), { recursive: true });
    if (c.src === 'server/node_modules') {
      // Windows 下 junction 不需要管理员权限，比复制几十 MB 快得多
      try { symlinkSync(from, to, 'junction'); } catch { cpSync(from, to, { recursive: true }); }
    } else {
      cpSync(from, to, { recursive: true });
    }
  }
}

const layoutEnv = () => ({
  ...process.env,
  MALL_DB: join(LAYOUT, 'data', 'probe.db'),
  PORT: String(PORT),
  PUBLIC_DIR: join(LAYOUT, 'public'),
  UPLOAD_DIR: join(LAYOUT, 'data', 'uploads'),
  RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0', ORDER_EXPIRE_SCAN_MS: '0',
});

const runNode = (args, env, timeout = 30000, cwd = join(LAYOUT, 'server')) => new Promise((done) => {
  const p = spawn(process.execPath, args, { cwd, env, stdio: 'pipe' });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += String(d)));
  const t = setTimeout(() => { try { p.kill(); } catch {} }, timeout);
  p.on('close', (code) => { clearTimeout(t); done({ code, out }); });
  return p;
});

async function waitHealth(timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return (await r.json()).code;
    } catch {}
    await sleep(250);
  }
  return 0;
}

let srv = null;
async function main() {
  section('[1] Dockerfile 清单 vs 服务端 import');
  ok(copies.length >= 8, '解析到运行阶段 COPY 清单', `${copies.length} 项`);
  ok(topLevel.has('shared'), '运行阶段已拷贝 shared/（修复点）', [...topLevel].join(','));
  ok(/RUN node scripts\/check-runtime-deps\.mjs/.test(dockerfile), 'Dockerfile 构建期会跑依赖自检');
  const missing = [];
  for (const file of walk(join(ROOT, 'server', 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const abs = resolve(dirname(file), m[1]);
      const rel = relative(ROOT, abs).split('\\').join('/');
      // 只关心跳出 server/ 的相对引用
      if (!rel.startsWith('..') && !rel.startsWith('shared/')) continue;
      if (rel.startsWith('..')) {
        missing.push(`${relative(ROOT, file)} -> ${m[1]} (${rel})`);
        continue;
      }
      if (!topLevel.has(rel.split('/')[0])) missing.push(`${relative(ROOT, file)} -> ${m[1]} (清单缺 ${rel.split('/')[0]})`);
    }
  }
  ok(missing.length === 0, '服务端所有跨目录 import 都在 COPY 清单内', missing.slice(0, 3).join(' | '));

  section('[2] 复刻容器布局并首次启动');
  buildLayout(true);
  ok(existsSync(join(LAYOUT, 'shared', 'markdown.js')), '布局里存在 shared/markdown.js');
  const seed = await runNode(['src/seed.js'], layoutEnv(), 60000);
  ok(seed.code === 0, 'seed 初始化成功', seed.out.slice(-300));
  const env = layoutEnv();
  srv = spawn(process.execPath, ['src/app.js'], { cwd: join(LAYOUT, 'server'), env, stdio: 'pipe' });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += String(d)));
  const health = await waitHealth();
  ok(health === 1, '容器内 /api/health 返回 code=1（对应 HEALTHCHECK 通过）', log.slice(-300));
  try { srv.kill(); } catch {}
  srv = null;
  await sleep(300);
  const checkOk = await runNode(['scripts/check-runtime-deps.mjs'], layoutEnv(), 15000, LAYOUT);
  ok(checkOk.code === 0, '完整布局下构建期自检通过', checkOk.out.slice(-200));

  section('[3] 反向验证：拿掉 shared/ 服务必须起不来');
  buildLayout(false);
  const broken = await runNode(['src/app.js'], layoutEnv(), 8000);
  ok(broken.code !== 0, '缺少 shared/ 时进程异常退出', `code=${broken.code}`);
  ok(/ERR_MODULE_NOT_FOUND|Cannot find module/.test(broken.out), '报错是找不到模块（复现线上故障）', broken.out.slice(-300));
  ok(/shared\/markdown\.js/.test(broken.out), '明确指向 shared/markdown.js', broken.out.slice(-300));
  const checkBad = await runNode(['scripts/check-runtime-deps.mjs'], layoutEnv(), 15000, LAYOUT);
  ok(checkBad.code !== 0, '构建期自检能拦住缺 shared/ 的镜像');
  ok(/shared\/markdown\.js/.test(checkBad.out), '自检输出点名缺失文件', checkBad.out.slice(-200));
}

main()
  .then(() => {
    if (srv) { try { srv.kill(); } catch {} }
    cleanup();
    console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
    if (fails.length) {
      for (const f of fails) console.log('  ✗ ' + f);
      process.exitCode = 1;
    }
  })
  .catch((e) => {
    if (srv) { try { srv.kill(); } catch {} }
    cleanup();
    console.error('\n探针异常：', e?.message || e);
    process.exitCode = 1;
  });
