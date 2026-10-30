// 后台权限节点：菜单级节点树 + 角色绑定
// 节点用「前端路由 path」作为 action_name，便于前端直接按路由过滤菜单
import { all, get, run, now } from '../db.js';
import { MENU } from './menu.config.js';

// 菜单结构统一来自 menu.config.js（单一数据源）
// 仅本模块用于同步节点表，不需要对外暴露
const MENU_TREE = MENU.map((g) => ({
  group: g.label,
  items: g.items.map((i) => ({ name: i.title, path: i.path })),
}));

/**
 * 幂等初始化节点表：缺失的分组/菜单会补建，已存在的不动
 * @returns {number} 新增节点数
 */
export function ensureNodes() {
  let added = 0;
  let sort = 100;

  for (const g of MENU_TREE) {
    let groupNode = get('SELECT * FROM store_node WHERE type = 1 AND parent_id = 0 AND node_name = ?', g.group);
    if (!groupNode) {
      const info = run(
        'INSERT INTO store_node (node_name, controller_name, action_name, menu_icon, parent_id, type, sort) VALUES (?,?,?,?,0,1,?)',
        g.group, 'group', '', '', sort,
      );
      groupNode = { id: Number(info.lastInsertRowid) };
      added++;
    }

    let childSort = 100;
    for (const it of g.items) {
      const exist = get('SELECT id, node_name FROM store_node WHERE action_name = ?', it.path);
      // 菜单改名后把节点名一起改掉，否则「角色分配权限」里还显示旧名字
      if (exist && exist.node_name !== it.name) {
        run('UPDATE store_node SET node_name = ? WHERE id = ?', it.name, exist.id);
      }
      if (!exist) {
        run(
          'INSERT INTO store_node (node_name, controller_name, action_name, menu_icon, parent_id, type, sort) VALUES (?,?,?,?,?,1,?)',
          it.name, 'menu', it.path, '', groupNode.id, childSort,
        );
        added++;
      }
      childSort += 10;
    }
    sort += 100;
  }
  // 清理已下线菜单（例如合并后的「协议与须知」）
  const validPaths = new Set(MENU_TREE.flatMap((g) => g.items.map((i) => i.path)));
  const stale = all("SELECT id, action_name FROM store_node WHERE action_name <> ''")
    .filter((n) => !validPaths.has(n.action_name));
  for (const n of stale) {
    run('DELETE FROM store_role_node WHERE node_id = ?', n.id);
    run('DELETE FROM store_node WHERE id = ?', n.id);
    console.log(`[nodes] 清理下线节点 ${n.action_name}`);
  }

  // 清理指向已不存在角色的孤儿权限绑定：
  // 否则将来新建同 ID 角色会凭空继承历史权限
  const orphan = all(
    'SELECT DISTINCT role_id FROM store_role_node WHERE role_id NOT IN (SELECT role_id FROM store_role)',
  );
  for (const o of orphan) {
    run('DELETE FROM store_role_node WHERE role_id = ?', o.role_id);
    console.log(`[nodes] 清理孤儿角色权限 role_id=${o.role_id}`);
  }

  return added;
}

/** 节点树（管理页展示） */
export function nodeTree() {
  const groups = all('SELECT * FROM store_node WHERE type = 1 AND parent_id = 0 ORDER BY sort ASC, id ASC');
  return groups.map((g) => ({
    id: g.id,
    name: g.node_name,
    children: all('SELECT * FROM store_node WHERE parent_id = ? ORDER BY sort ASC, id ASC', g.id).map((x) => ({
      id: x.id,
      name: x.node_name,
      path: x.action_name,
    })),
  }));
}

/** 某角色已分配的节点ID */
export function roleNodeIds(roleId) {
  return all('SELECT node_id FROM store_role_node WHERE role_id = ?', Number(roleId)).map((x) => x.node_id);
}

/** 某角色可访问的路由集合（超级管理员返回 null 表示不限制） */
export function rolePaths(roleId) {
  const role = get('SELECT * FROM store_role WHERE role_id = ?', Number(roleId));
  if (!role) return [];
  // role_id = 6 为超级管理员（seed 中最后一个角色）
  if (Number(roleId) === 6) return null;

  const ids = roleNodeIds(roleId);
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return all(`SELECT action_name FROM store_node WHERE id IN (${ph}) AND action_name <> ''`, ...ids).map(
    (x) => x.action_name,
  );
}

/** 保存角色权限（覆盖式） */
export function saveRoleNodes(roleId, nodeIds) {
  run('DELETE FROM store_role_node WHERE role_id = ?', Number(roleId));
  for (const id of nodeIds || []) {
    run('INSERT OR IGNORE INTO store_role_node (role_id, node_id) VALUES (?,?)', Number(roleId), Number(id));
  }
}

/** 超级管理员角色ID（seed 约定为 6） */
export const SUPER_ROLE_ID = 6;
