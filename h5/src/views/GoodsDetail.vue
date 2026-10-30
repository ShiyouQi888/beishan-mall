<template>
  <div class="page detail">
    <div class="navbar navbar--float">
      <div class="navbar__back navbar__back--round" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
    </div>

    <div class="detail__gallery">
      <van-swipe :autoplay="5000" indicator-color="#fff" @change="idx = $event">
        <van-swipe-item v-for="(im, i) in gallery" :key="i">
          <img :src="im" class="detail__img" />
        </van-swipe-item>
      </van-swipe>
      <div class="detail__idx">{{ idx + 1 }} / {{ gallery.length }}</div>
    </div>

    <div class="detail__pricecard">
      <div class="detail__price-row">
        <div class="price big">
          <span class="sym">¥</span>{{ intPart(g.goods_min_price) }}<span class="dec">.{{ decPart(g.goods_min_price) }}</span>
        </div>
        <div class="detail__lineprice" v-if="Number(g.line_price) > 0">市场价 ¥{{ Number(g.line_price).toFixed(2) }}</div>
      </div>
      <div class="detail__name">{{ g.goods_name }}</div>
      <div class="detail__meta">
        <span v-if="g.specialarea?.title_main" class="chip">{{ g.specialarea.title_main }}</span>
        <span v-if="g.specialarea" class="chip chip--time">{{ g.specialarea.start_end_time }} - {{ g.specialarea.start_end_time1 }}</span>
        <span class="chip chip--ghost">已转拍 {{ g.turn_beat_num || 0 }} 次</span>
        <!-- 名额：一件货有几个购买名额。抢完就不再显示剩余，只留「已抢完」 -->
        <span v-if="Number(g.session_quota) > 0" class="chip chip--stock">
          本场限量 {{ g.session_quota }} 件 · 剩 {{ Math.max(0, Number(g.session_quota) - Number(g.session_sold || 0)) }} 件
        </span>
        <span v-else-if="Number(g.stock_total) > 1" class="chip chip--stock">
          共 {{ g.stock_total }} 件 · 剩 {{ Math.max(0, Number(g.stock_num) || 0) }} 件
        </span>
      </div>
      <!-- 不能买时把原因写在明面上：只把底部按钮弄灰，用户会以为按钮坏了、反复去点 -->
      <div class="detail__state" :class="{ 'is-out': soldOut }" v-if="closedTip">{{ closedTip }}</div>
    </div>

    <div class="detail__promise card">
      <div class="pi" v-for="p in promises" :key="p">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" style="flex: none">
          <path d="m5 12.5 4.2 4.2L19 6.5" stroke="#2eb872" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ p }}</span>
      </div>
    </div>

    <div class="detail__holder card" v-if="g.holder">
      <div class="h-label">现持有人</div>
      <div class="h-name">{{ g.holder }}</div>
      <div class="h-badge">平台认证</div>
    </div>

    <div class="detail__desc card">
      <div class="sec-title"><span>商品详情</span></div>
      <div class="detail__rich" v-html="safeDetail" />
    </div>

    <div class="detail__bar">
      <div class="bar-icon" @click="$router.push('/')">
        <svg viewBox="0 0 24 24" width="21" height="21" fill="none"><path d="M3.5 10.5 12 3.5l8.5 7v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-9Z" stroke="#4a4a4a" stroke-width="1.7" stroke-linejoin="round" /></svg>
        <span>首页</span>
      </div>
      <div class="bar-icon" @click="$router.push('/order')">
        <svg viewBox="0 0 24 24" width="21" height="21" fill="none"><rect x="4" y="3.5" width="16" height="17" rx="2.2" stroke="#4a4a4a" stroke-width="1.7" /><path d="M8 8h8M8 12h8M8 16h5" stroke="#4a4a4a" stroke-width="1.7" stroke-linecap="round" /></svg>
        <span>订单</span>
      </div>
      <button class="btn-main bar-btn" :disabled="!canBuy" @click="buy">
        {{ canBuy ? '立即抢购' : soldOut ? '已抢完' : buyClosed ? '当前不在抢购时间' : '不可购买' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast } from '../utils/feedback.js';
import { api } from '../api.js';
import { sanitizeHtml } from '../../../shared/sanitize.js';

const route = useRoute();
const router = useRouter();
const g = ref({});
const idx = ref(0);

// 商品详情是后台可编辑的富文本，渲染前必须净化
const safeDetail = computed(() => sanitizeHtml(g.value.detail) || '<p style="color:#9aa0aa">暂无详情</p>');
const gallery = computed(() => {
  const imgs = g.value.images?.length ? g.value.images : [g.value.good_thumb].filter(Boolean);
  return imgs.length ? imgs : [''];
});
const intPart = (v) => String(Number(v || 0).toFixed(2)).split('.')[0];
const decPart = (v) => String(Number(v || 0).toFixed(2)).split('.')[1];
const promises = computed(() => {
  const t = g.value.specialarea?.title_ordinary || '';
  const arr = t.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  return arr.length ? arr : ['正品保障', '顺丰包邮', '支持复检'];
});
// 抢购商品必须等所属场次开放；商城商品（type=2）没有场次，不受时间限制。
// 判断「是不是抢购商品」优先看 type，但 type 缺失时退化为「有没有场次」——
// 之前就是接口漏返 type，Number(undefined) === 1 恒为 false，抢购商品在非抢购时段
// 也显示「立即抢购」、按钮还能点。不再赌单个字段一定在。
const isLootGoods = computed(() => (Number(g.value.type) === 2 ? false : !!g.value.specialarea));
const buyClosed = computed(() => isLootGoods.value && Number(g.value.is_ordinary_order) !== 1);
// 已抢完：商品被买走或一批货卖光后下架。列表里留一张灰卡片，点进来就是这里 —— 不能下单。
// 优先用后端的 sold_out，字段缺失时退回 goods_status，两者都不会让售罄商品漏过
const soldOut = computed(() => (g.value.sold_out === undefined
  ? Number(g.value.goods_status ?? 10) !== 10
  : Number(g.value.sold_out) === 1));
const canBuy = computed(() => !!g.value.goods_id && !buyClosed.value && !soldOut.value);
// 不能买时给一句人话，别只把按钮弄灰 —— 按钮变灰很容易被当成「点一下试试」
const closedTip = computed(() => {
  if (!g.value.goods_id || canBuy.value) return '';
  // 本场放量抢满：货可能还有，只是这一场不放了。文案必须和「货没了」分开，
  // 否则用户以为卖光了，明天也不会再来
  if (soldOut.value && Number(g.value.session_full) === 1 && Number(g.value.goods_status) === 10) {
    return `本场 ${g.value.session_quota} 件已经抢满，下一场再来`;
  }
  if (soldOut.value) return '这件货已经被抢走了，等下一场再来';
  const a = g.value.specialarea;
  if (buyClosed.value && a) return `当前不在抢购时间（本场 ${a.start_end_time}-${a.start_end_time1}）`;
  return '该商品暂不可购买';
});

function buy() {
  if (!localStorage.getItem('TOKEN')) return router.push('/login');
  router.push(`/submit/${g.value.goods_id}`);
}

async function load(id) {
  if (!id) return;
  try {
    const r = await api.lootDetail(id);
    // 业务失败也是 HTTP 200，不判断 code 的话会拿空数据渲染出「¥0.00 可购买」的假页面
    if (r?.code !== 1 || !r.data?.goods_id) throw new Error(r?.msg || 'not found');
    g.value = r.data;
  } catch {
    try {
      const r2 = await api.shopDetail(id);
      if (r2?.code !== 1 || !r2.data?.goods_id) throw new Error('not found');
      g.value = r2.data;
    } catch {
      showToast('商品不存在');
      g.value = {};
      setTimeout(() => router.replace('/loot'), 1000);
    }
  }
}

// 组件会被复用（在详情页之间跳转时不会重新挂载），只写在 onMounted 里会导致
// 「看一眼新商品，页面还是上一件」——点抢购买的可能仍是上一件
onMounted(() => load(route.params.id));
watch(() => route.params.id, (id) => load(id));
</script>

<style scoped>
.detail { background: var(--bg); padding-bottom: 76px; position: relative; }
.navbar--float {
  position: fixed;
  top: 10px; left: max(12px, calc((100vw - 430px) / 2 + 12px));
  background: transparent;
  border: none;
  height: auto;
  padding: 0;
  z-index: 60;
}
.navbar__back--round {
  width: 34px; height: 34px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.36);
  color: #fff;
  backdrop-filter: blur(6px);
}

.detail__gallery { position: relative; background: #fff; }
.detail__img { width: 100%; aspect-ratio: 1; object-fit: cover; }
.detail__idx {
  position: absolute;
  right: 14px; bottom: 14px;
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, 0.4);
  padding: 2px 9px;
  border-radius: 10px;
  font-variant-numeric: tabular-nums;
}

.detail__pricecard { background: #fff; padding: 14px 16px 16px; }
.detail__price-row { display: flex; align-items: baseline; gap: 10px; }
.price.big { font-size: 26px; }
.detail__lineprice { font-size: 12px; color: var(--text-4); text-decoration: line-through; }
.detail__name {
  font-size: 16.5px;
  font-weight: 650;
  line-height: 1.45;
  margin-top: 8px;
  color: var(--text-1);
}
.detail__meta { display: flex; gap: 7px; margin-top: 10px; flex-wrap: wrap; }
.chip {
  font-size: 11px;
  color: var(--brand);
  background: var(--brand-soft);
  padding: 3px 9px;
  border-radius: 7px;
  font-weight: 500;
}
.chip--time { color: #3d7dff; background: #eef4ff; font-variant-numeric: tabular-nums; }
.chip--ghost { color: var(--text-3); background: #f5f6f8; }
.chip--stock { color: #c88a1e; background: #fff7e8; }
/* 不能买的原因条：比灰按钮显眼，一眼就知道是「来晚了」还是「没到点」 */
.detail__state {
  margin-top: 10px;
  padding: 8px 11px;
  border-radius: 9px;
  font-size: 12px;
  line-height: 1.45;
  color: #9a6212;
  background: #fff8e9;
  border: 1px solid #f6e3c2;
}
.detail__state.is-out { color: #6a7078; background: #f4f5f7; border-color: #e6e8ec; }

.detail__promise {
  margin: 10px 14px 0;
  padding: 12px 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px 18px;
}
.detail__promise .pi {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-2);
}

.detail__holder {
  margin: 10px 14px 0;
  padding: 13px 14px;
  display: flex;
  align-items: center;
  gap: 9px;
}
.detail__holder .h-label { font-size: 12px; color: var(--text-3); }
.detail__holder .h-name { font-size: 13.5px; font-weight: 600; }
.detail__holder .h-badge {
  margin-left: auto;
  font-size: 10.5px;
  color: #2eb872;
  background: #eefaf3;
  padding: 2px 8px;
  border-radius: 7px;
}

.detail__desc { margin: 10px 14px 0; padding: 4px 14px 16px; }
.detail__rich { font-size: 13.5px; line-height: 1.75; color: var(--text-2); }
.detail__rich :deep(img) { border-radius: 10px; margin: 8px 0; }

.detail__bar {
  position: fixed;
  left: 50%; right: auto; bottom: 0;
  width: min(100vw, 430px);
  transform: translateX(-50%);
  height: 62px;
  background: #fff;
  border-top: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 14px calc(env(safe-area-inset-bottom));
  z-index: 90;
}
.bar-icon {
  width: 50px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  font-size: 10px;
  color: var(--text-2);
}
.bar-btn {
  flex: 1;
  height: 44px;
  margin-left: 6px;
}
</style>
