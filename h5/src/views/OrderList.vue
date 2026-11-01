<template>
  <div class="page orders">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">我的订单</div>
      <!-- 只刷新订单数据，不动整个页面：线上是纯静态托管，整页刷新会重新走一次
           应用初始化（有的环境还会掉登录态），不值得为了看新状态付这个代价 -->
      <button
        class="navbar__refresh"
        :class="{ 'is-spinning': refreshing }"
        type="button"
        aria-label="刷新订单"
        @click="refresh"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M20 12a8 8 0 1 1-2.34-5.66" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />
          <path d="M20 4.6V9h-4.4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <div class="orders__tabs">
      <div
        v-for="t in tabs"
        :key="t.v"
        class="orders__tab"
        :class="{ on: status === t.v }"
        @click="switchTab(t.v)"
      >{{ t.label }}</div>
    </div>

    <div class="section-pad orders__list">
      <div v-if="loading" class="empty">加载中…</div>
      <template v-else-if="list.length">
        <div v-for="o in list" :key="o.order_id" class="ocard card" @click="$router.push(`/order/detail/${o.order_id}`)">
          <div class="ocard__head">
            <span class="ocard__type">{{ o.order_type_text }}</span>
            <span class="ocard__no">{{ o.order_no }}</span>
            <span class="ocard__status">{{ o.status_text }}</span>
          </div>
          <div class="ocard__body">
            <div class="ocard__img"><img :src="o.goods_thumb" /></div>
            <div class="ocard__info">
              <div class="ocard__name ellipsis2">{{ o.goods_name }}</div>
              <div class="muted" style="margin-top: 4px" v-if="o.seller_name">卖家：{{ o.seller_name }}</div>
              <div class="ocard__row">
                <div class="price"><span class="sym">¥</span>{{ Number(o.total_price).toFixed(2) }}</div>
                <div class="muted">× {{ o.num }}</div>
              </div>
              <!-- 卡片主价是成交价；带服务费/上架费的单要再露一行实付，否则会员点进去才发现金额不一样 -->
              <div class="ocard__pay" v-if="extraFeeOf(o) > 0">
                实付 ¥{{ payTotalOf(o).toFixed(2) }}
                <span class="muted">（含{{ feeText(o) }}）</span>
              </div>
            </div>
          </div>
          <div class="ocard__foot">
            <span class="muted">{{ o.create_time }}</span>
            <div class="ocard__acts" @click.stop>
              <button v-if="o.status === 0" class="mini mini--main" :disabled="Number(o.applied) === 1" @click="pay(o)">{{ Number(o.applied) === 1 ? '已提交' : '申请抢单' }}</button>
              <button v-if="o.status === 0" class="mini" @click="cancel(o)">取消</button>
              <button v-if="(o.status === 10 || o.status === 30) && !o.consignment_status && !o.transferred" class="mini mini--main" :disabled="loadingQuoteId === o.order_id" @click="openTransfer(o)">{{ loadingQuoteId === o.order_id ? '计算中…' : '转拍' }}</button>
              <button v-if="o.consignment_status" class="mini" disabled>已上架</button>
            </div>
          </div>
        </div>
      </template>
      <div v-else class="empty">暂无相关订单</div>
    </div>

    <van-popup v-model:show="showTransfer" position="bottom" round :style="{ padding: '22px 18px 26px' }">
      <div class="tr-title">转拍上架</div>
      <div class="tr-goods">
        <img :src="curOrder.goods_thumb" />
        <div>
          <div class="tr-name ellipsis">{{ curOrder.goods_name }}</div>
          <div class="muted">原成交价 ¥{{ Number(curOrder.total_price || 0).toFixed(2) }}</div>
        </div>
      </div>

      <div class="tr-price">
        <div class="tr-price__label">下一轮自动标价</div>
        <div class="tr-price__value">¥{{ Number(quote.next_price || 0).toFixed(2) }}</div>
        <div class="tr-price__up" v-if="Number(quote.increase_rate) > 0">
          较您买入价 +{{ quote.increase_rate }}%（+¥{{ Number(quote.increase_amount || 0).toFixed(2) }}）
        </div>
        <div class="tr-price__up tr-price__up--off" v-else>未开启自动涨价，按原价挂牌</div>
      </div>

      <div class="tr-fee">
        <!-- 上架费已在下单时随货款一起收过，这里不再从余额扣，只做展示 -->
        <!-- 上架费只在下单时收一次：本单付过就显示金额，没付过（历史订单）就写「不收取」，
             转拍时不再从余额扣款，所以这里不会出现负数 -->
        <div class="tr-row">
          <span>转拍上架费</span>
          <b v-if="Number(quote.listing_fee_prepaid) === 1" class="prepaid">
            ¥{{ Number(quote.listing_fee || 0).toFixed(2) }}（下单时已付）
          </b>
          <b v-else class="prepaid">本单不收取</b>
        </div>
        <div class="tr-row tr-row--sum">
          <span>下一轮成交后您可收回</span>
          <b>¥{{ Number(quote.next_price || 0).toFixed(2) }}</b>
        </div>
        <div class="tr-row">
          <span>扣除实际成本（货款 + 服务费 + 上架费）后净收益</span>
          <b :class="{ 'tr-loss': Number(quote.net_income) < 0 }">
            {{ Number(quote.net_income) >= 0 ? '+' : '' }}¥{{ Number(quote.net_income || 0).toFixed(2) }}
          </b>
        </div>
        <div class="tr-tip">
          {{ Number(quote.listing_fee_prepaid) === 1
            ? '上架费已随本单货款一起支付，本次转拍不再从余额扣款；'
            : '本单下单时未含上架费，本次转拍不收取；' }}商品转拍后即与您无关，后续涨跌由下一手持有人承担。
        </div>
      </div>

      <button class="btn-main" :disabled="submitting" @click="submitTransfer">
        {{ submitting ? '提交中…' : '确认转拍' }}
      </button>
    </van-popup>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast, showDangerConfirm } from '../utils/feedback.js';
import { api } from '../api.js';

const route = useRoute();
const router = useRouter();
const tabs = [
  { v: 'all', label: '全部' },
  { v: 0, label: '待确认' },
  { v: 10, label: '已确认' },
];
const status = ref(route.query.pay_status !== undefined
  ? (route.query.pay_status === 'all' ? 'all' : Number(route.query.pay_status))
  : 'all');
const list = ref([]);
const loading = ref(true);

/**
 * 拉订单列表。
 * @param {boolean} silent 静默刷新：不显示「加载中…」，失败也不清空已有列表
 *                        （点右上角刷新时用，避免列表整块闪一下白）
 */
async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const params = { page: 1, limit: 30 };
    if (route.query.consign_order_id) params.order_id = route.query.consign_order_id;
    if (status.value !== 'all') params.pay_status = status.value;
    const r = await api.orders(params);
    list.value = r.data.data || [];
  } catch {
    // 静默刷新失败时保留原列表，别让用户以为订单没了
    if (!silent) list.value = [];
  } finally {
    if (!silent) loading.value = false;
  }
}

// 点右上角刷新：只重新拉数据，不重载页面
const refreshing = ref(false);
async function refresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  const started = Date.now();
  await load(true);
  // 转圈至少留 420ms，否则本地很快、用户看不出点过
  const rest = 420 - (Date.now() - started);
  if (rest > 0) await new Promise((r) => setTimeout(r, rest));
  refreshing.value = false;
  showToast('订单已刷新');
}

function switchTab(v) {
  status.value = v;
  load();
}

// ---------- 实付口径：货款 + 抢单服务费 + 转拍上架费 ----------
// 卡片上先露成交价、再露实付，两个数都在，会员不会因为「点进去金额变了」而质疑
const payTotalOf = (o) => Number(o?.total_price || 0)
  + Number(o?.service_charge || 0)
  + Number(o?.listing_fee || 0);
const extraFeeOf = (o) => Number(o?.service_charge || 0) + Number(o?.listing_fee || 0);
function feeText(o) {
  const parts = [];
  if (Number(o?.service_charge) > 0) parts.push(`服务费 ¥${Number(o.service_charge).toFixed(2)}`);
  if (Number(o?.listing_fee) > 0) parts.push(`上架费 ¥${Number(o.listing_fee).toFixed(2)}`);
  return parts.join(' + ');
}

function pay(o) {
  router.push(`/order/detail/${o.order_id}`);
}

async function cancel(o) {
  // 取消是不可撤销的：名额会当场释放给其他人，想买得重新抢。
  // 所以弹窗里带上具体商品，并用危险样式（红色感叹号 + 危险色主按钮），别让人手滑点掉。
  const name = o.goods_name ? `「${o.goods_name}」` : '这笔订单';
  try {
    await showDangerConfirm({
      title: '取消这笔订单？',
      message: `${name} ¥${Number(o.total_price || 0).toFixed(2)}\n取消后名额立即释放，订单不可恢复，需要的话要重新抢购。`,
      confirmButtonText: '确认取消',
      cancelButtonText: '再想想',
    });
  } catch {
    return;
  }
  try {
    await api.cancelOrder({ order_id: o.order_id });
    showToast('已取消');
    load();
  } catch {}
}

async function consign(o) {
  openTransfer(o);
}

// ---------- 转拍（重新挂出到下一轮场次） ----------
const showTransfer = ref(false);
const curOrder = ref({});
const quote = ref({});
const submitting = ref(false);
const loadingQuoteId = ref(0);

// 标价与上架费全部由服务端按「上一手成交价 × (1+涨价率)」算出，前端只展示，不可改
async function openTransfer(o) {
  if (loadingQuoteId.value) return;
  loadingQuoteId.value = o.order_id;
  curOrder.value = o;
  quote.value = {};
  try {
    const r = await api.consignmentQuote(o.order_id);
    quote.value = r.data || {};
    if (!Number(quote.value.next_price || 0)) throw new Error('转拍报价获取失败');
    showTransfer.value = true;
  } catch (error) {
    showTransfer.value = false;
    await load();
    if (route.query.from === 'my-shop' && /已转拍|已上架/.test(error?.msg || '')) {
      router.replace('/my-shop');
    }
  } finally {
    loadingQuoteId.value = 0;
  }
}

async function submitTransfer() {
  if (!Number(quote.value.next_price || 0)) return showToast('标价获取失败，请重试');
  submitting.value = true;
  try {
    const r = await api.consignment({ order_id: curOrder.value.order_id });
    showToast(r.msg || '转拍成功');
    showTransfer.value = false;
    if (route.query.from === 'my-shop') {
      router.replace('/my-shop');
    } else {
      await load();
    }
  } catch (error) {
    await load();
    if (route.query.from === 'my-shop' && /已转拍|已上架/.test(error?.msg || '')) {
      router.replace('/my-shop');
    }
  } finally {
    submitting.value = false;
  }
}

/* ---------------- 自动刷新 ----------------
 * 后台确认抢单后，列表上的「已提交 / 待确认」也要跟着变，不然用户以为没生效。
 * 静默拉取（不动 loading、不打断弹窗），只在有未完成订单时轮询。
 */
const POLL_MS = 8000;
let pollTimer = 0;

const hasPending = () => list.value.some((x) => Number(x.status) !== 40 && Number(x.pay_status) !== 10);

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
}

async function pollOnce() {
  // 转拍弹窗打开时别刷，否则 curOrder 会被换掉、填了一半的输入框也会被冲掉
  if (document.hidden || showTransfer.value || submitting.value || !hasPending()) {
    if (!hasPending()) stopPoll();
    return;
  }
  try {
    const params = { page: 1, limit: 30 };
    if (route.query.consign_order_id) params.order_id = route.query.consign_order_id;
    if (status.value !== 'all') params.pay_status = status.value;
    const r = await api.orders(params);
    const next = r.data.data || [];
    const confirmedNow = list.value.filter(
      (x) => Number(x.pay_status) !== 10 && next.some((y) => Number(y.order_id) === Number(x.order_id) && Number(y.pay_status) === 10),
    );
    // 当前看的是「待确认」tab 时，刚确认的单会从列表里消失 —— 提醒一句，避免以为是丢了
    if (confirmedNow.length && Number(status.value) === 0) {
      showToast(`${confirmedNow.length} 笔已被平台确认，可在「已确认」里查看`);
    }
    list.value = next;
    if (!hasPending()) stopPoll();
  } catch {
    // 静默失败，下一轮再试
  }
}

function startPoll() {
  stopPoll();
  if (hasPending()) pollTimer = setInterval(pollOnce, POLL_MS);
}

function onVisible() {
  if (!document.hidden) pollOnce();
}

onMounted(async () => {
  await load();
  startPoll();
  document.addEventListener('visibilitychange', onVisible);
  const consignOrderId = Number(route.query.consign_order_id || 0);
  if (consignOrderId) {
    const order = list.value.find((item) => Number(item.order_id) === consignOrderId);
    if (order) {
      await openTransfer(order);
    } else if (route.query.from === 'my-shop') {
      router.replace('/my-shop');
    }
  }
});

onUnmounted(() => {
  stopPoll();
  document.removeEventListener('visibilitychange', onVisible);
});
</script>

<style scoped>
.prepaid { color: #1f9d5f; }

.orders { background: var(--bg); }

/* 导航栏右侧刷新：绝对定位，不占布局，标题仍保持居中对称 */
.navbar__refresh {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: #f4f6f8;
  color: var(--text-2);
  transition: background .15s ease, color .15s ease;
}
.navbar__refresh:active { background: #e9ecf1; color: var(--brand); }
.navbar__refresh svg { width: 17px; height: 17px; }
.navbar__refresh.is-spinning { pointer-events: none; color: var(--brand); }
.navbar__refresh.is-spinning svg { animation: order-refresh-spin .7s linear infinite; }
@keyframes order-refresh-spin { to { transform: rotate(360deg); } }

/* 导航栏右侧刷新：绝对定位，不占布局，标题仍保持居中对称 */
.navbar__refresh {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: #f4f6f8;
  color: var(--text-2);
  transition: background .15s ease, color .15s ease;
}
.navbar__refresh:active { background: #e9ecf1; color: var(--brand); }
.navbar__refresh svg { width: 17px; height: 17px; }
.navbar__refresh.is-spinning { pointer-events: none; color: var(--brand); }
.navbar__refresh.is-spinning svg { animation: order-refresh-spin .7s linear infinite; }
@keyframes order-refresh-spin { to { transform: rotate(360deg); } }
.orders__tabs {
  display: flex;
  background: #fff;
  padding: 0 6px;
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  z-index: 20;
}
.orders__tab {
  flex: 1;
  text-align: center;
  padding: 13px 0;
  font-size: 13.5px;
  color: var(--text-3);
  position: relative;
}
.orders__tab.on { color: var(--text-1); font-weight: 650; }
.orders__tab.on::after {
  content: '';
  position: absolute;
  left: 50%; bottom: 3px;
  transform: translateX(-50%);
  width: 20px; height: 3px;
  border-radius: 2px;
  background: var(--brand);
}

.orders__list { padding-top: 12px; }
.ocard { padding: 13px 14px; margin-bottom: 11px; }
.ocard__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-3);
  padding-bottom: 11px;
  border-bottom: 1px solid var(--line);
}
.ocard__type {
  color: var(--brand);
  background: var(--brand-soft);
  padding: 2px 7px;
  border-radius: 6px;
  font-weight: 500;
  font-size: 10.5px;
}
.ocard__no { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ocard__status { color: var(--text-1); font-weight: 600; font-size: 12px; }

.ocard__body { display: flex; gap: 11px; padding: 12px 0; }
.ocard__img {
  width: 76px; height: 76px;
  border-radius: 10px;
  overflow: hidden;
  background: #f6f7f9;
  flex: none;
}
.ocard__img img { width: 100%; height: 100%; object-fit: cover; }
.ocard__info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ocard__name { font-size: 13.5px; font-weight: 500; line-height: 1.45; }
.ocard__row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-top: auto;
}
.ocard__row .price { font-size: 16px; }
/* 实付行：成交价下面补一行，字号小、颜色浅，不抢主价格 */
.ocard__pay {
  margin-top: 5px;
  font-size: 12px;
  font-weight: 500;
  color: #8a5a3b;
}
.ocard__pay .muted { font-weight: 400; }
/* 实付行：成交价下面补一行，字号小、颜色浅，不抢主价格 */
.ocard__pay {
  margin-top: 5px;
  font-size: 12px;
  font-weight: 500;
  color: #8a5a3b;
}
.ocard__pay .muted { font-weight: 400; }

.ocard__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 11px;
  border-top: 1px solid var(--line);
}
.ocard__acts { display: flex; gap: 8px; }
.mini {
  height: 28px;
  padding: 0 13px;
  border-radius: 14px;
  border: 1px solid var(--line);
  background: #fff;
  font-size: 12px;
  color: var(--text-2);
  font-family: var(--font);
}
.mini--main {
  border-color: var(--brand);
  color: var(--brand);
  background: var(--brand-soft);
  font-weight: 600;
}

.tr-title { font-size: 17px; font-weight: 700; margin-bottom: 16px; }
.tr-goods { display: flex; align-items: center; gap: 11px; margin-bottom: 16px; }
.tr-goods img { width: 54px; height: 54px; border-radius: 9px; object-fit: cover; background: #f6f7f9; }
.tr-name { font-size: 14px; font-weight: 550; margin-bottom: 3px; }
.tr-price {
  background: #fff6f5; border: 1px solid #ffe2dd; border-radius: 12px;
  padding: 14px 16px; margin-bottom: 14px;
}
.tr-price__label { font-size: 12px; color: var(--text-3); margin-bottom: 4px; }
.tr-price__value {
  font-size: 26px; font-weight: 700; color: var(--brand);
  font-variant-numeric: tabular-nums; line-height: 1.15;
}
.tr-price__up { font-size: 12px; color: #d4380d; margin-top: 4px; }
.tr-price__up--off { color: var(--text-3); }
.tr-fee { background: #fafbfc; border-radius: 11px; padding: 12px 14px; margin-bottom: 18px; }
.tr-row { display: flex; justify-content: space-between; font-size: 13.5px; color: var(--text-2); }
.tr-row + .tr-row { margin-top: 7px; }
.tr-row b { color: var(--brand); font-size: 15px; font-variant-numeric: tabular-nums; }
.tr-row--sum { padding-top: 7px; border-top: 1px dashed #e6e8ec; }
.tr-row b.tr-loss { color: #d4380d; }
.tr-tip { font-size: 11.5px; color: var(--text-3); margin-top: 8px; line-height: 1.55; }
</style>
