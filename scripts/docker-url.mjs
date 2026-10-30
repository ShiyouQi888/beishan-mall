// 打印容器的实际访问地址
// 宿主机端口默认由 Docker 自动分配，每次重建都可能变，所以别猜，直接问 Docker
// 用法: npm run docker:url
import { execFileSync } from 'node:child_process';

const SERVICE = 'mall';

function composePort(containerPort) {
  try {
    const out = execFileSync('docker', ['compose', 'port', SERVICE, String(containerPort)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // 输出形如 0.0.0.0:62496 或 [::]:62496
    const line = out.split('\n').filter(Boolean).pop() || '';
    return line.includes(':') ? line.split(':').pop() : '';
  } catch {
    return '';
  }
}

const ports = [process.env.PORT, '3300', '4000'].filter(Boolean);
let hostPort = '';
for (const p of ports) {
  hostPort = composePort(p);
  if (hostPort) break;
}

if (!hostPort) {
  console.error('没拿到端口：容器可能没在运行。先执行 npm run docker:up');
  process.exit(1);
}

console.log(`容器已映射到宿主机端口 ${hostPort}\n`);
console.log(`  H5 商城    http://127.0.0.1:${hostPort}/`);
console.log(`  管理后台   http://127.0.0.1:${hostPort}/admin/`);
console.log(`  健康检查   http://127.0.0.1:${hostPort}/api/health`);
console.log('\n想固定端口：在 .env 里写 APP_PORT=3300 再 npm run docker:up');
