<template>
  <div>
    <div class="page-head">
      <div>
        <h2>控制面板</h2>
        <div class="desc">今日经营概览 · {{ today }}</div>
      </div>
      <el-button size="default" @click="load">刷新数据</el-button>
    </div>

    <div class="stat-grid dash-cards">
      <div class="stat-card" v-for="c in cards" :key="c.key" @click="$router.push(c.route)">
        <div class="badge" :style="{ background: c.bg, color: c.color }" v-html="c.icon" />
        <div class="label">{{ c.label }}</div>
        <div class="value">{{ c.value }}</div>
        <div class="hint">{{ c.tip || '点击查看明细 ›' }}</div>
      </div>
    </div>

    <div class="grid2">
      <div class="panel">
        <div class="panel-head">
          <span>经营概览</span>
        </div>
        <div class="ov-grid">
          <div class="ov" v-for="o in overviewItems" :key="o.k">
            <div class="ov-k">{{ o.k }}</div>
            <div class="ov-v">{{ o.v }}</div>
            <div class="ov-h" v-if="o.h">{{ o.h }}</div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <span>近 7 日订单趋势</span>
          <span class="sub">订单量</span>
        </div>
        <div class="chart">
          <div class="bar-wrap" v-for="d in trend" :key="d.date">
            <div class="bar-col">
              <span class="bar-val" v-if="d.orders">{{ d.orders }}</span>
              <div class="bar" :style="{ height: barH(d.orders) + '%' }" />
            </div>
            <div class="bar-label">{{ d.date }}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="grid2">
      <div class="panel">
        <div class="panel-head">
          <span>最近订单</span>
          <a class="more" @click="$router.push('/orders')">全部订单 ›</a>
        </div>
        <div v-if="recentOrders.length" class="rlist">
          <div class="ritem" v-for="o in recentOrders" :key="o.order_id" @click="$router.push('/orders')">
            <div class="r-main">
              <div class="r-t">{{ o.goods_name }}</div>
              <div class="r-s">{{ o.order_no }} · {{ o.create_time }}</div>
            </div>
            <div class="r-right">
              <div class="money money-red">¥{{ o.total_price }}</div>
              <span class="tag-status" :class="o.pay_status === 10 ? 'tag-ok' : 'tag-warn'">{{ o.status_text }}</span>
            </div>
          </div>
        </div>
        <div v-else class="empty-box">暂无订单</div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <span>新注册会员</span>
          <a class="more" @click="$router.push('/member')">全部会员 ›</a>
        </div>
        <div v-if="recentMembers.length" class="rlist">
          <div class="ritem" v-for="m in recentMembers" :key="m.member_id">
            <div class="avatar">{{ (m.nick_name || 'U').slice(0, 1) }}</div>
            <div class="r-main">
              <div class="r-t">{{ m.nick_name }}</div>
              <div class="r-s">{{ m.mobile }}</div>
            </div>
            <div class="r-right">
              <div class="r-s">{{ (m.create_time || '').slice(0, 10) }}</div>
            </div>
          </div>
        </div>
        <div v-else class="empty-box">暂无会员</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { adminApi } from '../api.js';

const d = ref({});
const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

const icons = {
  wait_confirm: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="1.8"/></svg>',
  transposing: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M4 8h13l-3.2-3.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 16H7l3.2 3.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  wait_recycle: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M20 12a8 8 0 1 1-2.3-5.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M20.5 4.5V9H16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  wait_score: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M4 9h11l-3-3m3 3-3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 15H9l3 3m-3-3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  wait_cert: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><rect x="3" y="5" width="18" height="14" rx="2.2" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="11" r="2" stroke="currentColor" stroke-width="1.7"/><path d="M5.6 16.2c.4-1.5 1.7-2.4 3.4-2.4s3 .9 3.4 2.4" stroke="currentColor" stroke-width="1.7"/></svg>',
};

const styles = {
  wait_confirm: { bg: '#fff1ee', color: '#e63c26' },
  transposing: { bg: '#eef4ff', color: '#3d6fdd' },
  wait_recycle: { bg: '#fff7e8', color: '#c88a1e' },
  wait_score: { bg: '#f3f0ff', color: '#6b53d8' },
  wait_cert: { bg: '#eefaf3', color: '#1f9d5f' },
};

const cards = computed(() =>
  (d.value.cards || []).map((c) => ({ ...c, icon: icons[c.key] || '', ...(styles[c.key] || { bg: '#f4f6f9', color: '#666' }) })),
);

const yuan = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const overviewItems = computed(() => {
  const o = d.value.overview || {};
  const incomeToday = Number(o.fee_today || 0) + Number(o.listing_fee_today || 0);
  return [
    { k: '会员总数', v: o.member_total ?? 0, h: `今日新增 ${o.member_today ?? 0}` },
    { k: '在售商品', v: o.goods_online ?? 0, h: `商品总数 ${o.goods_total ?? 0} · 封顶下架 ${o.goods_capped ?? 0}` },
    { k: '订单总数', v: o.order_total ?? 0, h: `今日新增 ${o.order_today ?? 0}` },
    { k: '今日成交额', v: yuan(o.turnover_today), h: `累计 ${yuan(o.turnover_total)}` },
    { k: '今日平台收入', v: yuan(incomeToday), h: `服务费 ${yuan(o.fee_today)} · 上架 ${yuan(o.listing_fee_today)}` },
    { k: '会员余额（平台待付）', v: yuan(o.amount_total), h: `佣金账户 ${yuan(o.commission_total)}` },
  ];
});

const trend = computed(() => d.value.trend || []);
const maxOrders = computed(() => Math.max(1, ...trend.value.map((x) => x.orders)));
const barH = (v) => (v ? Math.max(8, (v / maxOrders.value) * 100) : 3);

const recentOrders = computed(() => d.value.recent_orders || []);
const recentMembers = computed(() => d.value.recent_members || []);

async function load() {
  try {
    const r = await adminApi.dashboard();
    d.value = r.data || {};
  } catch {}
}

onMounted(load);
</script>

<style scoped>
/* 五张待办卡：窄屏自动折行，别硬挤成一条 */
.dash-cards { grid-template-columns: repeat(auto-fit, minmax(198px, 1fr)); }

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 14px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 650;
  margin-bottom: 14px;
}
.panel-head .sub { font-size: 11.5px; color: #8c93a0; font-weight: 450; }
.panel-head .more { font-size: 12px; color: #8c93a0; cursor: pointer; font-weight: 450; }
.panel-head .more:hover { color: #ff513a; }

.ov-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.ov {
  background: #fafbfc;
  border-radius: 10px;
  padding: 13px 14px;
}
.ov-k { font-size: 12px; color: #8c93a0; }
.ov-v {
  font-size: 19px;
  font-weight: 700;
  margin-top: 5px;
  font-variant-numeric: tabular-nums;
}
.ov-h {
  font-size: 11px;
  color: #a8adb7;
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chart {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 172px;
  padding-top: 16px;
}
.bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 7px; height: 100%; }
.bar-col { flex: 1; width: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; }
.bar {
  width: 100%;
  max-width: 34px;
  border-radius: 6px 6px 3px 3px;
  background: linear-gradient(180deg, #ff826e, #ff513a);
  transition: height 0.3s;
}
.bar-val { font-size: 11px; color: #8c93a0; margin-bottom: 5px; font-variant-numeric: tabular-nums; }
.bar-label { font-size: 11px; color: #a8adb7; }

.rlist { display: flex; flex-direction: column; }
.ritem {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 0;
  border-bottom: 1px solid #f2f4f7;
  cursor: pointer;
}
.ritem:last-child { border-bottom: none; }
.ritem:hover .r-t { color: #ff513a; }
.r-main { flex: 1; min-width: 0; }
.r-t { font-size: 13px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r-s { font-size: 11.5px; color: #a8adb7; margin-top: 3px; }
.r-right { text-align: right; flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.avatar {
  width: 32px; height: 32px;
  border-radius: 9px;
  background: linear-gradient(135deg, #ff826e, #ff513a);
  color: #fff;
  font-size: 13px;
  font-weight: 650;
  display: flex; align-items: center; justify-content: center;
  flex: none;
}
</style>
