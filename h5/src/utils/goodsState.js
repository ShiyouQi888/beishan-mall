// 商品卡片状态：首页 / 分类 / 搜索 / 抢购页共用一份判定
//
// 之前每个页面各写各的 —— 抢购页有灰卡、首页只认 sold_out、分类和搜索干脆不认，
// 同一件货在不同页面一个灰一个亮，用户点进去才发现买不了。
// 这里把「什么状态、叫什么、要不要置灰」收敛成唯一实现，页面只管调用。

/**
 * 卡片状态
 * @returns {'sold'|'ended'|'upcoming'|'limited'|'locked'|''}
 *   sold     = 已抢完（库存卖光 / 被买走）
 *   ended    = 本场已结束（时间到）
 *   upcoming = 未开始
 *   limited  = 本场每人限购额度已用完（不是售罄，但这个人今天在这买不了）
 *   locked   = 被别人锁单中
 *   ''       = 正常可买
 */
export function cardState(g = {}) {
  // 已抢完：优先用后端 sold_out，字段缺失时退回 goods_status（两者都不让售罄商品漏过）
  const sold = g.sold_out !== undefined
    ? Number(g.sold_out) === 1
    : Number(g.goods_status ?? 10) !== 10;
  if (sold) return 'sold';

  // 被别人下单锁着：还没付款，但此刻谁也抢不了（抢购是提交即锁单）
  if (Number(g.locked) === 1) return 'locked';

  // 场次状态由后端算好（服务端时间才准，客户端时钟可能差几分钟）
  switch (g.session_state) {
    case 'ended':
    case 'closed':
      return 'ended';
    case 'upcoming':
      return 'upcoming';
    default: {
      // 本场限购额度用完：货还在、别人还能抢，但这个人今天在这买不了
      const limit = Number(g.purchase_limit) || 0;
      const bought = Number(g.purchase_bought) || 0;
      if (limit > 0 && bought >= limit) return 'limited';
      return '';
    }
  }
}

/** 卡片上压的标签文字，空串表示不压 */
export const cardLabel = (state) => ({
  sold: '已抢完',
  ended: '本场已结束',
  upcoming: '未开始',
  limited: '本场已抢满',
  locked: '抢购中',
}[state] || '');

/** 是否整张卡置灰（未开始只是暂时不能买，不置灰，否则一进首页全是灰的） */
export const isGreyState = (state) => state === 'sold' || state === 'ended' || state === 'locked' || state === 'limited';
