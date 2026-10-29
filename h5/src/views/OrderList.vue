<template>
  <div class="page orders">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">我的订单</div>
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
            </div>
          </div>
          <div class="ocard__foot">
            <span class="muted">{{ o.create_time }}</span>
            <div class="ocard__acts" @click.stop>
              <button v-if="o.status === 0" class="mini mini--main" @click="pay(o)">去支付</button>
              <button v-if="o.status === 0" class="mini" @click="cancel(o)">取消</button>
              <button v-if="o.status === 20" class="mini mini--main" @click="receipt(o)">确认收货</button>
              <button v-if="(o.status === 10 || o.status === 30) && !o.consignment_status" class="mini mini--main" @click="openTransfer(o)">转拍</button>
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

      <div class="tr-field">
        <label>寄卖标价（元）</label>
        <input v-model="transferPrice" type="number" placeholder="请输入寄卖价格" />
      </div>

      <div class="tr-fee">
        <div class="tr-row"><span>上架费（{{ listingRate }}%）</span><b>¥{{ transferFee.toFixed(2) }}</b></div>
        <div class="tr-tip">上架费按原成交价计算，从账户余额中扣除</div>
      </div>

      <button class="btn-main" :disabled="submitting" @click="submitTransfer">
        {{ submitting ? '提交中…' : '确认转拍' }}
      </button>
    </van-popup>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { showToast, showConfirmDialog, showDialog } from 'vant';
import { api } from '../api.js';

const route = useRoute();
const tabs = [
  { v: 'all', label: '全部' },
  { v: 0, label: '待付款' },
  { v: 10, label: '待发货' },
  { v: 20, label: '待收货' },
  { v: 30, label: '已完成' },
];
const status = ref(route.query.status !== undefined ? (route.query.status === 'all' ? 'all' : Number(route.query.status)) : 'all');
const list = ref([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    const params = { page: 1, limit: 30 };
    if (status.value !== 'all') params.status = status.value;
    const r = await api.orders(params);
    list.value = r.data.data || [];
  } catch {
    list.value = [];
  } finally {
    loading.value = false;
  }
}

function switchTab(v) {
  status.value = v;
  load();
}

async function pay(o) {
  try {
    await api.payOrder({ order_id: o.order_id, pay_type: 1 });
    showToast('支付成功');
    load();
  } catch {}
}

async function cancel(o) {
  try {
    await showConfirmDialog({ title: '取消订单', message: '确定取消该订单吗？' });
  } catch {
    return;
  }
  try {
    await api.cancelOrder({ order_id: o.order_id });
    showToast('已取消');
    load();
  } catch {}
}

async function receipt(o) {
  try {
    await showConfirmDialog({ title: '确认收货', message: '确认已收到商品？' });
  } catch {
    return;
  }
  try {
    await api.receipt({ order_id: o.order_id });
    showToast('已确认收货');
    load();
  } catch {}
}

async function consign(o) {
  openTransfer(o);
}

// ---------- 转拍（寄卖上架） ----------
const showTransfer = ref(false);
const curOrder = ref({});
const transferPrice = ref('');
const listingRate = ref(2.8);
const submitting = ref(false);

const transferFee = computed(() => {
  const base = Number(curOrder.value.total_price || 0);
  return Math.round(base * listingRate.value) / 100;
});

function openTransfer(o) {
  curOrder.value = o;
  transferPrice.value = String(Number(o.total_price).toFixed(0));
  showTransfer.value = true;
}

async function submitTransfer() {
  const p = Number(transferPrice.value);
  if (!p || p <= 0) return showToast('请输入寄卖标价');
  submitting.value = true;
  try {
    const r = await api.consignment({ order_id: curOrder.value.order_id, price: p });
    showToast(r.msg || '转拍成功');
    showTransfer.value = false;
    load();
  } catch {
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  try {
    const r = await api.tradeConfig();
    if (r.data?.listing_fee_rate) listingRate.value = Number(r.data.listing_fee_rate);
  } catch {}
  load();
});
</script>

<style scoped>
.orders { background: var(--bg); }
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
.tr-field { margin-bottom: 14px; }
.tr-field label { display: block; font-size: 12px; color: var(--text-3); margin-bottom: 6px; }
.tr-field input {
  width: 100%; height: 46px; border: 1px solid #ebedf1; background: #fafbfc;
  border-radius: 12px; padding: 0 14px; font-size: 16px; font-family: var(--font);
  font-weight: 600; outline: none;
}
.tr-fee { background: #fafbfc; border-radius: 11px; padding: 12px 14px; margin-bottom: 18px; }
.tr-row { display: flex; justify-content: space-between; font-size: 13.5px; color: var(--text-2); }
.tr-row b { color: var(--brand); font-size: 15px; font-variant-numeric: tabular-nums; }
.tr-tip { font-size: 11.5px; color: var(--text-3); margin-top: 6px; }
</style>
