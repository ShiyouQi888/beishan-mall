// 商品 ↔ 场次 关联（多对多）
//
// 设计变更：商品表不再承载「场次」这个属性。
//   · 一件商品属于哪些场次，只由 specialarea_goods 这张关联表决定
//   · 后台「商品管理」里没有场次字段，关联入口统一在场次页
//   · 同一件商品可以同时挂在多个场次下（运营按需分配）
//   · goods.specialarea_id 降级成「首个关联场次」的镜像列，只给历史代码兜底，
//     任何「能不能买、属于哪一场」的判断都必须走本模块，不能读镜像列
import { all, get, run, tx, now } from '../db.js';
import { sessionWindow } from './sessionWindow.js';

/** 某件商品关联的场次（按关联排序） */
export function areasOfGoods(goodsId) {
  return all(
    `SELECT s.* FROM specialarea_goods sg
     JOIN specialarea s ON s.specialarea_id = sg.specialarea_id
     WHERE sg.goods_id = ?
     ORDER BY sg.sort ASC, s.specialarea_id ASC`,
    Number(goodsId) || 0,
  );
}

/**
 * 批量取关联场次，避免列表逐条查库（N+1）
 * @param {number[]} goodsIds
 * @returns {Map<number, Array<{specialarea_id:number,title_main:string,name:string}>>}
 */
export function areaMapOfGoods(goodsIds) {
  const ids = [...new Set((goodsIds || []).map(Number).filter((n) => n > 0))];
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const rows = all(
    `SELECT sg.goods_id, s.specialarea_id, s.title_main, s.name, s.start_time, s.end_time, s.open_days
     FROM specialarea_goods sg
     JOIN specialarea s ON s.specialarea_id = sg.specialarea_id
     WHERE sg.goods_id IN (${ids.map(() => '?').join(',')})
     ORDER BY sg.sort ASC, s.specialarea_id ASC`,
    ...ids,
  );
  for (const r of rows) map.get(Number(r.goods_id))?.push(r);
  return map;
}

/** 取「此刻正在开放」的场次（多场同时开放时取排序最靠前的那个） */
/**
 * 找出此刻正在开放的场次。
 *
 * `leadSeconds` 是「提前抢购」的提前量：只有带这个资格的会员才会传 > 0 的值。
 * 语义很克制 —— 只把「还没开始」的场次往前放，**不延长结束时间**：
 * 提前会员在 07:57 就能买 08:00 那场，但 12:00 之后照样买不了。
 *
 * 实现上把参照时间往后挪 leadSeconds 再判一次，而不是直接改 sessionWindow ——
 * 场次本身的开放/结束口径必须只有一份，别为了提前抢购把它改出第二套。
 */
export function openAreaOf(areas, at = new Date(), leadSeconds = 0) {
  const lead = Math.max(0, Number(leadSeconds) || 0);
  const shifted = lead > 0 ? new Date(at.getTime() + lead * 1000) : at;
  for (const a of areas || []) {
    // 停用的场次不参与交易：后台「启用状态」关掉之后，这场里的商品不能再被买
    if (Number(a.is_open ?? 10) !== 10) continue;
    const w = sessionWindow(a, at);
    if (w.open) return { area: a, win: w };
    if (!lead || w.state !== 'upcoming') continue; // 已结束/今天不开放，提前也没用
    const w2 = sessionWindow(a, shifted);
    if (w2.open) {
      // 还差多少秒才真正开抢，前端拿它显示「提前抢购中，还有 42 秒」
      const left = Math.max(0, w.startsAt - Math.floor(at.getTime() / 1000));
      return { area: a, win: w2, advanced: true, lead_left: left };
    }
  }
  return null;
}

/** 这个会员的提前量（秒）：没开通资格一律 0，开了也得填了分钟数才算 */
export function advanceLeadOf(member) {
  if (!member || Number(member.is_advance) !== 10) return 0;
  const sec = Number(member.advance_seconds) || 0;
  return sec > 0 ? Math.min(sec, 3600) : 0; // 最多提前 1 小时，防止填错把场次穿透
}

/**
 * 展示用场次：开放中 → 即将开始 → 已结束（取最晚结束的那场）→ 第一场
 * 详情页/列表要告诉用户「这件货在等哪一场」，所以必须有个明确的代表场次。
 */
export function displayAreaOf(areas, at = new Date()) {
  const list = (areas || []).map((a) => ({ a, w: sessionWindow(a, at) }));
  if (!list.length) return null;
  return list.find((x) => x.w.open)
    || list.find((x) => x.w.state === 'upcoming')
    || list.filter((x) => x.w.state === 'ended').pop()
    || list[0];
}

/** 把镜像列同步成「首个关联场次」（不参与业务判断，只为老代码与后台展示兜底） */
function syncAreaMirror(goodsId) {
  const first = get(
    'SELECT specialarea_id FROM specialarea_goods WHERE goods_id = ? ORDER BY sort ASC, area_goods_id ASC LIMIT 1',
    Number(goodsId),
  );
  run('UPDATE goods SET specialarea_id = ? WHERE goods_id = ?', Number(first?.specialarea_id) || 0, Number(goodsId));
}

/** 覆盖式设置：把商品关联到指定场次集合（用于转拍换场等场景） */
export function setGoodsAreas(goodsId, areaIds) {
  const id = Number(goodsId);
  const ids = [...new Set((areaIds || []).map(Number).filter((n) => n > 0))];
  tx(() => {
    run('DELETE FROM specialarea_goods WHERE goods_id = ?', id);
    ids.forEach((areaId, i) => {
      run(
        'INSERT INTO specialarea_goods (specialarea_id, goods_id, sort, create_time) VALUES (?,?,?,?)',
        areaId, id, 100 + i, now(),
      );
    });
    syncAreaMirror(id);
  });
  return ids;
}

/** 场次下批量添加商品（已存在的跳过） */
export function addGoodsToArea(areaId, goodsIds) {
  const area = Number(areaId);
  const ids = [...new Set((goodsIds || []).map(Number).filter((n) => n > 0))];
  if (!area || !ids.length) return { added: 0, skipped: 0 };
  let added = 0;
  let skipped = 0;
  tx(() => {
    for (const id of ids) {
      if (!get('SELECT 1 FROM goods WHERE goods_id = ?', id)) { skipped++; continue; }
      const dup = get('SELECT 1 FROM specialarea_goods WHERE specialarea_id = ? AND goods_id = ?', area, id);
      if (dup) { skipped++; continue; }
      run(
        'INSERT INTO specialarea_goods (specialarea_id, goods_id, sort, create_time) VALUES (?,?,?,?)',
        area, id, 100, now(),
      );
      syncAreaMirror(id);
      added++;
    }
  });
  return { added, skipped };
}

/** 从场次移除商品 */
export function removeGoodsFromArea(areaId, goodsIds) {
  const area = Number(areaId);
  const ids = [...new Set((goodsIds || []).map(Number).filter((n) => n > 0))];
  if (!area || !ids.length) return 0;
  let removed = 0;
  tx(() => {
    for (const id of ids) {
      const r = run('DELETE FROM specialarea_goods WHERE specialarea_id = ? AND goods_id = ?', area, id);
      if (Number(r.changes)) removed++;
      syncAreaMirror(id);
    }
  });
  return removed;
}

/** 场次被删除时清掉它的关联 */
export function clearAreaLinks(areaId) {
  const ids = all('SELECT goods_id FROM specialarea_goods WHERE specialarea_id = ?', Number(areaId)).map((r) => Number(r.goods_id));
  run('DELETE FROM specialarea_goods WHERE specialarea_id = ?', Number(areaId));
  ids.forEach((id) => syncAreaMirror(id));
  return ids.length;
}
