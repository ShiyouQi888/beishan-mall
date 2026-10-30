// 开发模式：同时起后端(3300) + 后台 vite(5274) + H5 vite(5273)
// 用法: npm run dev
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

// shell 只给 npm 用：npm 在 Windows 上是 .cmd，必须走 shell 才能执行。
// 后端直接起 node，绝不能开 shell —— 一旦开，execPath 里的空格
// （C:\Program Files\nodejs\node.exe）会被 cmd 当成命令边界，报 "'C:\Program' 不是内部或外部命令"。
const procs = [
  { name: 'server', cmd: process.execPath, args: ['src/app.js'], cwd: join(ROOT, 'server'), color: 36, shell: false },
  { name: 'admin ', cmd: npm, args: ['run', 'dev'], cwd: join(ROOT, 'admin'), color: 35, shell: isWin },
  { name: 'h5    ', cmd: npm, args: ['run', 'dev'], cwd: join(ROOT, 'h5'), color: 32, shell: isWin },
];

const children = [];
for (const p of procs) {
  const child = spawn(p.cmd, p.args, { cwd: p.cwd, shell: p.shell });
  children.push(child);
  const tag = `\x1b[${p.color}m[${p.name}]\x1b[0m`;
  const pipe = (stream, out) =>
    stream.on('data', (d) =>
      out.write(String(d).split('\n').filter(Boolean).map((l) => `${tag} ${l}\n`).join('')),
    );
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`${tag} 退出，code=${code}`);
      if (p.name === 'server') {
        console.error(`${tag} 后端没起来，H5 与后台的 /api、/admin/api 请求都会 502（ECONNREFUSED）。`);
        console.error(`${tag} 常见原因：3300 端口被旧进程占用、或 node 路径/依赖异常。`);
      }
    }
  });
}

console.log('后端 http://127.0.0.1:3300 ｜ 后台 http://127.0.0.1:5274 ｜ H5 http://127.0.0.1:5273');
console.log('Ctrl+C 结束全部进程\n');

/**
 * Windows 上 npm 是经 cmd.exe 起的，只 kill 父进程会留下孤儿 vite 占着端口。
 * 用 taskkill /T 连子进程树一起结束，避免下次启动端口冲突。
 */
function killTree(child) {
  if (!child.pid) return;
  if (isWin) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {}
  }
  try {
    child.kill();
  } catch {}
}

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) killTree(c);
  setTimeout(() => process.exit(0), 400);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { for (const c of children) killTree(c); });
