<template>
  <div>
    <div class="page-head">
      <div>
        <h2>控制面板</h2>
        <div class="desc">今日经营概览 · {{ today }}</div>
      </div>
      <el-button size="default" @click="load">刷新数据</el-button>
    </div>

    <div class="stat-grid">
      <div class="stat-card" v-for="c in cards" :key="c.key" @click="$router.push(c.route)">
        <div class="badge" :style="{ background: c.bg, color: c.color }" v-html="c.icon" />
        <div class="label">{{ c.label }}</div>
        <div class="value">{{ c.value }}</div>
        <div class="hint">点击查看明细 ›</div>
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
              <span class="tag-status tag-off">{{ o.status_text }}</span>
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
  wait_send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M3.5 8.5 12 4l8.5 4.5v7L12 20l-8.5-4.5v-7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  wait_receive: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><rect x="2.5" y="7" width="12" height="10" rx="1.6" stroke="currentColor" stroke-width="1.8"/><path d="M14.5 10h4l3 3v4h-7v-7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  wait_withdraw: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M12 4v11M7.8 11l4.2 4.2 4.2-4.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 19.5h15" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  wait_cert: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><rect x="3" y="5" width="18" height="14" rx="2.2" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="11" r="2" stroke="currentColor" stroke-width="1.7"/><path d="M5.6 16.2c.4-1.5 1.7-2.4 3.4-2.4s3 .9 3.4 2.4" stroke="currentColor" stroke-width="1.7"/></svg>',
};

const styles = {
  wait_send: { bg: '#fff1ee', color: '#e63c26' },
  wait_receive: { bg: '#eef4ff', color: '#3d6fdd' },
  wait_withdraw: { bg: '#fff7e8', color: '#c88a1e' },
  wait_cert: { bg: '#eefaf3', color: '#1f9d5f' },
};

const cards = computed(() =>
  (d.value.cards || []).map((c) => ({ ...c, icon: icons[c.key] || '', ...(styles[c.key] || { bg: '#f4f6f9', color: '#666' }) })),
);

const overviewItems = computed(() => {
  const o = d.value.overview || {};
  return [
    { k: '会员总数', v: o.member_total ?? 0, h: `今日新增 ${o.member_today ?? 0}` },
    { k: '在售商品', v: o.goods_online ?? 0, h: `商品总数 ${o.goods_total ?? 0}` },
    { k: '订单总数', v: o.order_total ?? 0, h: `今日新增 ${o.order_today ?? 0}` },
    { k: '累计成交额', v: `¥${(o.turnover_total ?? 0).toLocaleString()}`, h: `今日 ¥${(o.turnover_today ?? 0).toLocaleString()}` },
    { k: '会员余额总额', v: `¥${(o.amount_total ?? 0).toLocaleString()}`, h: '含全部会员' },
    { k: '佣金累计发放', v: `¥${(o.commission_total ?? 0).toLocaleString()}`, h: '三级分销' },
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
.ov-h { font-size: 11px; color: #a8adb7; margin-top: 3px; }

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
