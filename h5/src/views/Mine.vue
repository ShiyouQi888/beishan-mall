<template>
  <div class="page page--tab mine">
    <!-- 头部 -->
    <div class="mine__head">
      <div class="mine__head-row">
        <div class="mine__user" @click="!logged && $router.push('/login')">
          <div class="mine__avatar">
            <img v-if="me.headimg" :src="me.headimg" />
            <svg v-else viewBox="0 0 24 24" width="30" height="30" fill="none">
              <circle cx="12" cy="9" r="3.6" stroke="#fff" stroke-width="1.6" opacity=".9" />
              <path d="M4.8 20c.7-3.4 3.6-5.6 7.2-5.6s6.5 2.2 7.2 5.6" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".9" />
            </svg>
          </div>
          <div class="mine__user-info">
            <div class="nick">{{ me.nickName || '点击登录' }}</div>
            <div class="tags">
              <span class="tag tag--id" v-if="me.is_certification === 1">已实名</span>
            </div>
          </div>
        </div>
        <div class="mine__setting" @click="$router.push('/setting')">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
            <circle cx="12" cy="12" r="3" stroke="#fff" stroke-width="1.7" />
            <path d="M12 2.8v2.4M12 18.8v2.4M4.5 12H2.1M21.9 12h-2.4M6.7 6.7 5 5M19 19l-1.7-1.7M6.7 17.3 5 19M19 5l-1.7 1.7" stroke="#fff" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </div>
      </div>

      <!-- 邀请码 -->
      <div class="mine__invite" @click="copyCode">
        <span>邀请码：{{ me.invitation_code || '——' }}</span>
        <span class="copy">复制</span>
      </div>

      <!-- 三数字 -->
      <div class="mine__stats">
        <div class="stat"><b>{{ stats.orders }}</b><span>今日订单</span></div>
        <div class="stat"><b>{{ stats.team }}</b><span>粉丝人数</span></div>
        <div class="stat"><b>{{ stats.teamOrders }}</b><span>粉丝订单</span></div>
      </div>
    </div>

    <!-- 资产卡片：余额不展示（业务要求），只留佣金与积分 -->
    <div class="mine__assets card">
      <div class="asset" @click="$router.push('/commission')">
        <div class="v">{{ me.e_card_number || '0.00' }}</div>
        <div class="k">我的佣金</div>
      </div>
      <div class="asset-div" v-if="scoreOpen" />
      <div class="asset" v-if="scoreOpen" @click="$router.push('/score')">
        <div class="v">{{ me.score || 0 }}</div>
        <div class="k">积分</div>
      </div>
    </div>

    <!-- 订单入口 -->
    <div class="card mine__block">
      <div class="block-head">
        <span>我的订单</span>
        <span class="more" @click="$router.push('/order')">全部订单 ›</span>
      </div>
      <div class="order-quick">
        <div class="q" v-for="q in orderQuick" :key="q.status" @click="$router.push(`/order?status=${q.status}`)">
          <span class="q-icon" v-html="q.icon" />
          <span class="q-label">{{ q.label }}</span>
        </div>
      </div>
    </div>

    <!-- 我的店铺 -->
    <div class="card mine__block shop-entry" @click="router.push('/my-shop')">
      <div class="shop-entry__ico">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="M4 9.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19V9.5" stroke="var(--brand)" stroke-width="1.7" stroke-linecap="round"/><path d="M3 9.5 5.2 4.5h13.6L21 9.5M3 9.5h18M9 13v3M15 13v3" stroke="var(--brand)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="shop-entry__main">
        <div class="shop-entry__title">
          我的店铺
          <span v-if="shop.count" class="shop-entry__badge">{{ shop.count }} 件在售</span>
        </div>
        <div class="shop-entry__meta">
          <template v-if="shop.count">
            预计收益 <b>¥{{ Number(shop.totalNet).toFixed(2) }}</b>
            <span v-if="shop.listedCount">（{{ shop.listedCount }} 件已挂牌等抢）</span>
          </template>
          <template v-else>抢到商品即可开店，转拍后等下一轮被抢走</template>
        </div>
      </div>
      <span class="more">查看 ›</span>
    </div>

    <!-- 功能宫格 -->
    <div class="card mine__block">
      <div class="block-head"><span>常用功能</span></div>
      <div class="func-grid">
        <div class="func" v-for="f in funcs" :key="f.label" @click="go(f)">
          <span class="func-icon" :style="{ background: f.bg }" v-html="f.icon" />
          <span class="func-label">{{ f.label }}</span>
        </div>
      </div>
    </div>

    <div class="mine__logout" v-if="logged" @click="logout">退出登录</div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, inject } from 'vue';
import { useRouter } from 'vue-router';
import { showToast } from '../utils/feedback.js';
import { api } from '../api.js';

const router = useRouter();
const me = ref({});
// 积分商城总开关由后台「商城设置 → 积分商城」控制，关闭时前台不显示任何积分入口
const store = inject('storeInfo', ref({}));
const scoreOpen = computed(() => String(store.value?.score_open ?? '10') !== '20');
const logged = computed(() => !!localStorage.getItem('TOKEN'));
const stats = reactive({ orders: 0, team: 0, teamOrders: 0 });
const shop = reactive({ count: 0, listedCount: 0, totalNet: 0 });

const orderQuick = [
  { status: 0, label: '待付款', icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2.5" stroke="var(--brand)" stroke-width="1.7"/><path d="M3 10h18" stroke="var(--brand)" stroke-width="1.7"/></svg>` },
  { status: 10, label: '待发货', icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M3.5 8.5 12 4l8.5 4.5v7L12 20l-8.5-4.5v-7Z" stroke="#ff8a3d" stroke-width="1.7" stroke-linejoin="round"/><path d="M3.5 8.5 12 13l8.5-4.5M12 13v7" stroke="#ff8a3d" stroke-width="1.7"/></svg>` },
  { status: 20, label: '待收货', icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><rect x="2.5" y="7" width="12" height="10" rx="1.6" stroke="#3d9cff" stroke-width="1.7"/><path d="M14.5 10h4l3 3v4h-7v-7Z" stroke="#3d9cff" stroke-width="1.7" stroke-linejoin="round"/><circle cx="7" cy="18" r="1.8" stroke="#3d9cff" stroke-width="1.7"/><circle cx="17.5" cy="18" r="1.8" stroke="#3d9cff" stroke-width="1.7"/></svg>` },
  { status: 30, label: '已完成', icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="#2eb872" stroke-width="1.7"/><path d="m8.3 12.2 2.6 2.6 4.8-5" stroke="#2eb872" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>` },
];

const allFuncs = [
  { label: '邀请好友', to: '/invite', bg: 'var(--brand-soft)', icon: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><circle cx="9" cy="8" r="3" stroke="var(--brand)" stroke-width="1.7"/><path d="M3.8 19.5c0-2.9 2.3-5 5.2-5s5.2 2.1 5.2 5" stroke="var(--brand)" stroke-width="1.7" stroke-linecap="round"/><path d="M17 6.5v6M14 9.5h6" stroke="var(--brand)" stroke-width="1.7" stroke-linecap="round"/></svg>` },
  { label: '我的团队', to: '/team', bg: '#eef4ff', icon: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><circle cx="8.5" cy="8.5" r="2.8" stroke="#3d7dff" stroke-width="1.7"/><circle cx="16.5" cy="9.5" r="2.2" stroke="#3d7dff" stroke-width="1.7"/><path d="M3.5 19c0-2.7 2.2-4.6 5-4.6s5 1.9 5 4.6M14 19c0-2.2 1.4-3.7 3.5-3.7s3.5 1.5 3.5 3.7" stroke="#3d7dff" stroke-width="1.7" stroke-linecap="round"/></svg>` },
  { label: '提现', to: '/withdraw', bg: '#fff7e8', icon: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="M12 4v11" stroke="#e8a33d" stroke-width="1.8" stroke-linecap="round"/><path d="m7.8 11 4.2 4.2 4.2-4.2" stroke="#e8a33d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 19.5h15" stroke="#e8a33d" stroke-width="1.8" stroke-linecap="round"/></svg>` },
  { label: '实名认证', to: '/identify', bg: '#eefaf3', icon: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><rect x="3" y="5" width="18" height="14" rx="2.4" stroke="#2eb872" stroke-width="1.7"/><circle cx="9" cy="11" r="2" stroke="#2eb872" stroke-width="1.6"/><path d="M5.6 16.2c.4-1.5 1.7-2.4 3.4-2.4s3 .9 3.4 2.4M15 10h3.5M15 13.5h3.5" stroke="#2eb872" stroke-width="1.6" stroke-linecap="round"/></svg>` },
  { label: '收货地址', to: '/address', bg: '#f1efff', icon: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="M12 21s7-5.3 7-11a7 7 0 1 0-14 0c0 5.7 7 11 7 11Z" stroke="#7a5cf5" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.6" stroke="#7a5cf5" stroke-width="1.7"/></svg>` },
  { label: '积分商城', to: '/score', bg: '#fff1f5', icon: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8L12 3.5Z" stroke="#e8548a" stroke-width="1.7" stroke-linejoin="round"/></svg>` },
  { label: '佣金明细', to: '/commission', bg: 'var(--brand-soft)', icon: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2" stroke="var(--brand)" stroke-width="1.7"/><path d="M7.5 9h9M7.5 12.5h9M7.5 16h5" stroke="var(--brand)" stroke-width="1.7" stroke-linecap="round"/></svg>` },
  { label: '公告', to: '/notice', bg: '#eef7ff', icon: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="M4.5 9.5v5l11 4.5V5L4.5 9.5Z" stroke="#3d9cff" stroke-width="1.7" stroke-linejoin="round"/><path d="M18 9.5a3 3 0 0 1 0 5" stroke="#3d9cff" stroke-width="1.7" stroke-linecap="round"/></svg>` },
];

// 积分商城关闭时，常用功能里也不出现这个入口
const funcs = computed(() => allFuncs.filter((f) => f.to !== '/score' || scoreOpen.value));

function go(f) {
  router.push(f.to);
}

async function load() {
  if (!logged.value) return;
  try {
    const [m, o, t] = await Promise.allSettled([api.me(), api.orders({ page: 1, limit: 1 }), api.indirection()]);
    if (m.status === 'fulfilled') me.value = m.value.data || {};
    if (o.status === 'fulfilled') {
      const list = o.value.data?.data || [];
      stats.orders = list.filter((x) => x.create_time?.startsWith(new Date().toISOString().slice(0, 10))).length;
    }
    if (t.status === 'fulfilled') stats.team = (t.value.data || []).length;
    // 我的店铺摘要：在售件数 + 预计收益
    if (logged.value) {
      try {
        const s = await api.myShop();
        shop.count = s.data?.summary?.count || 0;
        shop.totalNet = s.data?.summary?.total_net || 0;
        shop.listedCount = s.data?.summary?.listed_count || 0;
      } catch {}
    }
  } catch {}
}

async function copyCode() {
  if (!me.value.invitation_code) return;
  try {
    await navigator.clipboard.writeText(me.value.invitation_code);
    showToast('邀请码已复制');
  } catch {
    showToast(`邀请码：${me.value.invitation_code}`);
  }
}

function logout() {
  localStorage.removeItem('TOKEN');
  showToast('已退出');
  setTimeout(() => location.reload(), 400);
}

onMounted(load);
</script>

<style scoped>
.mine { background: var(--bg); }

.mine__head {
  background: linear-gradient(165deg, var(--brand-hero-1) 0%, var(--brand-hero-2) 55%, var(--brand-hero-3) 100%);
  padding: 22px 18px 58px;
  border-radius: 0 0 26px 26px;
  position: relative;
}
.mine__head-row { display: flex; align-items: flex-start; justify-content: space-between; }
.mine__user { display: flex; align-items: center; gap: 12px; }
.mine__avatar {
  width: 54px; height: 54px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.22);
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.32);
}
.mine__avatar img { width: 100%; height: 100%; object-fit: cover; }
.mine__user-info .nick { color: #fff; font-size: 17px; font-weight: 700; letter-spacing: 0.3px; }
.mine__user-info .tags { display: flex; gap: 6px; margin-top: 6px; }
.tag {
  font-size: 10.5px;
  color: #fff;
  background: rgba(255, 255, 255, 0.2);
  padding: 2px 8px;
  border-radius: 8px;
  font-weight: 500;
}
.tag--id { background: rgba(255, 255, 255, 0.3); }
.mine__setting { opacity: 0.85; padding: 4px; }

.mine__invite {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.92);
}
.mine__invite .copy {
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 9px;
  padding: 1px 8px;
  font-size: 10.5px;
}

.mine__stats {
  display: flex;
  margin-top: 18px;
}
.mine__stats .stat { flex: 1; text-align: center; color: #fff; }
.mine__stats .stat b {
  display: block;
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.mine__stats .stat span { font-size: 11px; opacity: 0.85; }

.mine__assets {
  margin: -42px 14px 0;
  display: flex;
  align-items: center;
  padding: 16px 0;
  position: relative;
  z-index: 2;
}
.asset { flex: 1; text-align: center; }
.asset .v {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
.asset .k { font-size: 11.5px; color: var(--text-3); margin-top: 4px; }
.asset-div { width: 1px; height: 26px; background: var(--line); }

.mine__block { margin: 12px 14px 0; padding: 14px 14px 16px; }
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14.5px;
  font-weight: 650;
  margin-bottom: 12px;
}
.block-head .more { font-size: 11.5px; color: var(--text-3); font-weight: 450; }

.shop-entry { display: flex; align-items: center; gap: 12px; padding: 14px 14px; }
.shop-entry__ico {
  flex: none; width: 40px; height: 40px; border-radius: 11px;
  background: #fff2f0; display: grid; place-items: center;
}
.shop-entry__main { flex: 1; min-width: 0; }
.shop-entry__title {
  display: flex; align-items: center; gap: 7px;
  font-size: 14.5px; font-weight: 600; color: var(--text-1);
}
.shop-entry__badge {
  padding: 1px 6px; border-radius: 20px; background: #fff2f0;
  color: var(--brand); font-size: 10.5px; font-weight: 500;
}
.shop-entry__meta {
  margin-top: 3px; font-size: 11.5px; color: var(--text-3); line-height: 1.5;
}
.shop-entry__meta b { color: var(--brand); font-size: 13px; font-variant-numeric: tabular-nums; }
.shop-entry .more { flex: none; font-size: 11.5px; color: var(--text-3); }

.order-quick { display: flex; }
.order-quick .q {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.q-label { font-size: 11.5px; color: var(--text-2); }

.func-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px 4px;
}
.func { display: flex; flex-direction: column; align-items: center; gap: 7px; }
.func-icon {
  width: 42px; height: 42px;
  border-radius: 13px;
  display: flex; align-items: center; justify-content: center;
}
.func-label { font-size: 11.5px; color: var(--text-2); }

.mine__logout {
  margin: 18px 14px 8px;
  height: 46px;
  border-radius: 14px;
  background: #fff;
  color: #d14328;
  font-size: 14.5px;
  display: flex; align-items: center; justify-content: center;
  box-shadow: var(--shadow);
}
</style>
