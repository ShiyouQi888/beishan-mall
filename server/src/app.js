import express from 'express';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, get, run } from './db.js';
import { ensureNodes } from './lib/nodes.js';
import { fail } from './lib/helper.js';

import indexRouter from './routes/index.js';
import memberRouter from './routes/member.js';
import goodsRouter from './routes/goods.js';
import orderRouter from './routes/order.js';
import financeRouter from './routes/finance.js';
import uploadRouter from './routes/upload.js';
import scoreRouter from './routes/score.js';
import adminRouter from './routes/admin/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 初始化表结构
db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
// 初始化权限节点（幂等）
const addedNodes = ensureNodes();
if (addedNodes) console.log(`[nodes] 初始化 ${addedNodes} 个权限节点`);

// 协议类配置从旧键迁移到 prompt_ 前缀（幂等；旧键保留兼容）
for (const [to, from] of [
  ['prompt_register', 'register_agreement'],
  ['prompt_invite', 'invitation_notice'],
  ['prompt_shop', 'shop_agreement'],
  ['prompt_trade', 'transaction_agreement'],
]) {
  if (!get('SELECT 1 FROM setting_config WHERE `key` = ?', to)) {
    const old = get('SELECT `value` v FROM setting_config WHERE `key` = ?', from);
    if (old?.v) {
      run('INSERT INTO setting_config (`key`, `value`, `group`) VALUES (?,?,?)', to, old.v, 'prompt');
      console.log(`[migrate] ${from} → ${to}`);
    }
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use('/uploads', express.static(join(__dirname, '..', 'data', 'uploads')));

// ---- H5 / 小程序接口 ----
app.use('/api', indexRouter);
app.use('/api/member', memberRouter);
app.use('/api/goods', goodsRouter);
app.use('/api/order', orderRouter);
app.use('/api/finance', financeRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/score', scoreRouter);

// ---- 后台接口 ----
app.use('/admin/api', adminRouter);

app.get('/api/health', (req, res) => res.json({ code: 1, msg: 'ok', data: { time: Date.now() } }));

// 统一 404 / 错误
app.use((req, res) => res.status(404).json(fail(`接口不存在: ${req.path}`, 404)));
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json(fail(err.message || '服务器内部错误'));
});

const PORT = Number(process.env.PORT) || 3300;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`mall-server running at http://127.0.0.1:${PORT}`);
});
