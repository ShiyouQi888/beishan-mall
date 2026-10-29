// 开发模式：同时起后端(3300) + 后台 vite(5274) + H5 vite(5273)
// 用法: npm run dev
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const procs = [
  { name: 'server', cmd: process.execPath, args: ['src/app.js'], cwd: join(ROOT, 'server'), color: 36 },
  { name: 'admin ', cmd: npm, args: ['run', 'dev'], cwd: join(ROOT, 'admin'), color: 35 },
  { name: 'h5    ', cmd: npm, args: ['run', 'dev'], cwd: join(ROOT, 'h5'), color: 32 },
];

const children = [];
for (const p of procs) {
  const child = spawn(p.cmd, p.args, { cwd: p.cwd, shell: process.platform === 'win32' });
  children.push(child);
  const tag = `\x1b[${p.color}m[${p.name}]\x1b[0m`;
  child.stdout.on('data', (d) => process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => `${tag} ${l}\n`).join('')));
  child.stderr.on('data', (d) => process.stderr.write(String(d).split('\n').filter(Boolean).map((l) => `${tag} ${l}\n`).join('')));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`${tag} 退出，code=${code}`);
  });
}

console.log('后端 http://127.0.0.1:3300 ｜ 后台 http://127.0.0.1:5274 ｜ H5 http://127.0.0.1:5273');
console.log('Ctrl+C 结束全部进程\n');

const shutdown = () => {
  for (const c of children) { try { c.kill(); } catch {} }
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
