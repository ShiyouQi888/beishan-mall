// 校验：后台菜单路径 == 前端路由（避免出现点开即 404 的菜单）
// 路由有两种写法：`path: '/x'` 与 list 助手的 `list('/x', ...)`
import { readFileSync } from 'node:fs';
import { MENU } from '../../server/src/lib/menu.config.js';

const src = readFileSync(new URL('../../admin/src/router.js', import.meta.url), 'utf8');
const routes = new Set([
  ...[...src.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]),
  ...[...src.matchAll(/\blist\(\s*'([^']+)'/g)].map((m) => m[1]),
]);
const menuPaths = MENU.flatMap((g) => g.items.map((i) => i.path));

// 动态段：/setting/:group 覆盖所有 /setting/*，/specialarea/:id 覆盖专区配置
const matches = (p) => routes.has(p) || [...routes].some((r) => r.includes(':') && new RegExp('^' + r.replace(/:[^/]+/g, '[^/]+') + '$').test(p));

const missing = menuPaths.filter((p) => !matches(p));
const extra = [...routes].filter(
  (p) => p.startsWith('/') && !p.includes(':') && !menuPaths.includes(p) && !['/login', '/forbidden', '/404', '/:pathMatch(.*)*'].includes(p),
);

// 重复路由定义（同路径或同名出现多次 → Vue Router 会告警/后者覆盖前者）
const dupPath = [...src.matchAll(/\blist\(\s*'([^']+)'/g)].map((m) => m[1]);
const pathDupes = dupPath.filter((p, i) => dupPath.indexOf(p) !== i);
const names = [...src.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
const nameDupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];

console.log('路由总数', routes.size, '| 菜单总数', menuPaths.length);
console.log('菜单中无对应路由（点开即 404）:', missing.length ? missing : '无');
console.log('有路由但不在菜单里:', extra.length ? extra : '无');
console.log('重复路由路径:', pathDupes.length ? pathDupes : '无');
console.log('重复路由名称:', nameDupes.length ? nameDupes : '无');

// 通用列表页的 module 必须在后台模块注册表里存在，否则列表接口报「模块不存在」
const adminSrc = readFileSync(new URL('../../server/src/routes/admin/index.js', import.meta.url), 'utf8');
const regBlock = adminSrc.slice(adminSrc.indexOf('const M = {'), adminSrc.indexOf('};', adminSrc.indexOf('const M = {')));
const regKeys = new Set([...regBlock.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]));
const mods = [...src.matchAll(/\blist\(\s*'[^']+'\s*,\s*'[^']+'\s*,\s*'([^']+)'/g)].map((m) => m[1]);
const badMods = [...new Set(mods)].filter((x) => !regKeys.has(x));
console.log('模块注册表', regKeys.size, '个 | 列表页引用', [...new Set(mods)].length, '个 | 未定义的:', badMods.length ? badMods : '无');
if (badMods.length) process.exit(1);

if (missing.length || pathDupes.length || nameDupes.length) process.exit(1);
