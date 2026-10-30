// 部署配置静态检查：compose 里的环境变量必须能被 .env 覆盖
//
// 起因：compose 里写 `ADMIN_USER: "admin1"` 这种字面量时，.env 里的同名变量是**不生效**的
// （compose 以字面量为准）。这个坑已经踩过两次（PORT、ADMIN_*），所以固化成断言。
//
// 用法: node scripts/probe/deploy-config.mjs
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}

const compose = read('docker-compose.yml');
const envExample = existsSync(join(ROOT, '.env.example')) ? read('.env.example') : '';
const gitignore = read('.gitignore');
const pkg = JSON.parse(read('package.json'));

// 容器内固定路径：由 volumes 挂载决定，不该被 .env 覆盖
const FIXED_KEYS = new Set(['HOST', 'MALL_DB', 'UPLOAD_DIR', 'PUBLIC_DIR']);

section('[1] compose 基本结构');
ok(/^name:\s*\S+/m.test(compose), 'compose 显式指定了项目名（中文目录名会导致推导失败）');
ok(/^services:/m.test(compose) && /\s+mall:/m.test(compose), '有 mall 服务');
ok(/restart:\s*unless-stopped/.test(compose), '配置了重启策略');
ok(/healthcheck:/.test(compose) && /\/api\/health/.test(compose), '健康检查指向 /api/health');

section('[2] 端口不能写死');
ok(!/-\s*["']\d+:\d+["']/.test(compose), 'ports 里没有「宿主机:容器」的写死映射');
ok(/\$\{APP_PORT:-\}/.test(compose), '宿主机端口留空即自动分配（${APP_PORT:-}）');
ok(/PORT:\s*\$\{PORT:-/.test(compose), '容器内 PORT 可被 .env 覆盖');

section('[3] 环境变量必须可被 .env 覆盖');
const envLines = compose.split('\n').filter((l) => /^\s{6}[A-Z_][A-Z0-9_]*:/.test(l));
ok(envLines.length >= 8, '采集到环境变量条目', `${envLines.length} 条`);
const literals = [];
for (const line of envLines) {
  const key = line.trim().split(':')[0];
  if (FIXED_KEYS.has(key)) continue;
  if (!line.includes('${')) literals.push(key);
}
ok(literals.length === 0, '可配置项都写成 ${VAR:-默认值}', literals.length ? `字面量：${literals.join('、')}` : '');
for (const key of ['ADMIN_USER', 'ADMIN_PASSWORD', 'ADMIN_PASSWORD_RESET', 'JWT_SECRET', 'PUBLIC_BASE_URL', 'TZ']) {
  ok(new RegExp(`${key}:\\s*\\$\\{`).test(compose), `${key} 走插值`);
}

section('[4] 文档与忽略规则');
for (const key of ['ADMIN_USER', 'ADMIN_PASSWORD', 'APP_PORT', 'PORT', 'JWT_SECRET']) {
  ok(envExample.includes(`${key}=`), `.env.example 收录了 ${key}`);
}
ok(/^\/data\/$/m.test(gitignore), '.gitignore 忽略了 compose 挂载目录 /data/');
ok(!!pkg.scripts['docker:url'], 'package.json 有 docker:url（自动端口下用来查实际地址）');

console.log(`\n${'─'.repeat(52)}`);
if (fails.length) {
  console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✓ 全部通过：${pass} 项断言`);
}
