<template>
  <div class="page odetail">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">订单详情</div>
    </div>

    <div class="empty" v-if="!o.order_id">{{ loading ? '加载中…' : '订单不存在或无权查看' }}</div>

    <div class="section-pad" style="padding-top: 12px" v-else>
      <!-- 状态 -->
      <div class="status">
        <div class="status__t">{{ statusTitle }}</div>
        <div class="status__d">{{ statusDesc }}</div>
      </div>

      <!-- 商品 -->
      <div class="card goods">
        <div class="goods__img"><img :src="o.goods_thumb" /></div>
        <div class="goods__info">
          <div class="goods__name ellipsis2">{{ o.goods_name }}</div>
          <div class="goods__row">
            <div class="price"><span class="sym">¥</span>{{ Number(o.price).toFixed(2) }}</div>
            <div class="muted">× {{ o.num }}</div>
          </div>
        </div>
      </div>

      <!-- 金额 -->
      <div class="card">
        <div class="kv"><span>商品金额</span><span>¥{{ Number(o.total_price).toFixed(2) }}</span></div>
        <div class="kv"><span>服务费</span><span>¥{{ Number(o.service_charge || 0).toFixed(2) }}</span></div>
        <div class="kv kv--sum">
          <span>实付金额</span>
          <span class="price"><span class="sym">¥</span>{{ (Number(o.total_price) + Number(o.service_charge || 0)).toFixed(2) }}</span>
        </div>
      </div>

      <!-- 地址 -->
      <div class="card" v-if="o.address">
        <div class="kv"><span>收货人</span><span>{{ o.address.name }} {{ o.address.mobile }}</span></div>
        <div class="kv"><span>地址</span><span class="right">{{ o.address.province }}{{ o.address.city }}{{ o.address.district }}{{ o.address.detail }}</span></div>
      </div>

      <!-- 订单信息 -->
      <div class="card">
        <div class="kv"><span>订单编号</span><span>{{ o.order_no }}</span></div>
        <div class="kv"><span>订单类型</span><span>{{ o.order_type_text }}</span></div>
        <div class="kv"><span>下单时间</span><span>{{ o.create_time }}</span></div>
        <div class="kv" v-if="o.pay_time"><span>支付时间</span><span>{{ o.pay_time }}</span></div>
        <div class="kv" v-if="o.pay_type_text"><span>支付方式</span><span>{{ o.pay_type_text }}</span></div>
        <div class="kv" v-if="o.seller_name"><span>卖家</span><span>{{ o.seller_name }}</span></div>
        <div class="kv" v-if="o.express_no"><span>快递</span><span>{{ o.express_company }} {{ o.express_no }}</span></div>
      </div>

      <div class="card payment" v-if="o.status === 0 && Number(o.pay_status) !== 10">
        <div class="sec-title" style="padding: 14px 0 8px"><span>选择支付方式</span></div>
        <div v-for="p in availablePayTypes" :key="p.v" class="payment__option" @click="selectedPayType = p.v">
          <span class="radio" :class="{ on: selectedPayType === p.v }" />
          <div>
            <div class="payment__title">{{ p.t }}</div>
            <div class="payment__desc">{{ p.d }}</div>
          </div>
        </div>
        <div v-if="!availablePayTypes.length" class="payment__empty">当前暂无开放的支付方式，请联系平台处理。</div>
        <div v-if="selectedPayType === 2 || selectedPayType === 3" class="payment__qr">
          <div>{{ selectedPayType === 2 ? '请使用微信扫码转账' : '请使用支付宝扫码转账' }}</div>
          <img v-if="paymentQr" :src="paymentQr" alt="收款二维码" @click="showImagePreview([paymentQr])" />
          <div v-else class="payment__empty">暂未配置收款二维码，请联系平台处理。</div>
        </div>
        <div v-if="selectedPayType && selectedPayType !== 1 && needVoucher" class="payment__voucher">
          <div class="payment__hint">完成转账后，请上传付款凭证供平台核实。</div>
          <ImageUploader :model-value="voucher" :upload="uploadVoucher" @update:model-value="voucher = $event" />
        </div>
      </div>

      <!-- 时间轴 -->
      <div class="card logs" v-if="o.logs?.length">
        <div class="sec-title" style="padding: 14px 0 10px"><span>订单动态</span></div>
        <div class="log" v-for="l in o.logs" :key="l.log_id">
          <span class="dot" />
          <div class="log__body">
            <div class="log__t">{{ l.action }}</div>
            <div class="log__d">{{ l.remark || '—' }}</div>
          </div>
          <span class="log__time">{{ l.create_time?.slice(5, 16) }}</span>
        </div>
      </div>
    </div>

    <div class="odetail__bar" v-if="o.status === 0 || o.status === 20 || (Number(o.pay_status) === 10 && Number(o.order_type) === 1)">
      <button v-if="o.status === 0 && Number(o.pay_status) !== 10" class="btn-main" :disabled="!availablePayTypes.length || paying" @click="pay">
        {{ paying ? '提交中…' : selectedPayType === 1 ? '立即支付' : (needVoucher ? '提交支付凭证' : '我已付款，提交') }}
      </button>
      <button v-if="Number(o.pay_status) === 10 && Number(o.order_type) === 1" class="btn-main" @click="goToMyShop">查看我的店铺</button>
      <button v-if="o.status === 20" class="btn-main" @click="receipt">确认收货</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showImagePreview } from 'vant';
import { showToast } from '../utils/feedback.js';
import { api } from '../api.js';
import ImageUploader from '../components/ImageUploader.vue';

const route = useRoute();
const router = useRouter();
const o = ref({});
const loading = ref(true);
const sys = ref({});
const paymentSettings = ref({});
const selectedPayType = ref(0);
const voucher = ref('');
// 后台「支付凭证必传」：默认必传。关闭后线下支付不显示上传框、不校验凭证。
const needVoucher = computed(() => String(paymentSettings.value.voucher_required ?? '1') === '1');
const paying = ref(false);
const payOptions = computed(() => {
  // 后台「支付凭证必传」关掉后，线下支付不再要求上传凭证，文案也要跟着改，
  // 否则会出现「请上传凭证」的页面却找不到上传框。
  const tail = needVoucher.value
    ? '扫码转账后上传凭证，等待平台确认'
    : '扫码转账后提交即可，等待平台确认';
  return [
    { v: 1, key: 'balance_open', t: '余额支付', d: '使用账户可用余额直接支付' },
    { v: 2, key: 'wx_open', ready: 'wx_qr_ready', t: '微信扫码', d: tail },
    { v: 3, key: 'zfb_open', ready: 'zfb_qr_ready', t: '支付宝扫码', d: tail },
    {
      v: 4,
      key: 'bank_open',
      t: needVoucher.value ? '线下转账凭证' : '线下转账',
      d: needVoucher.value ? '转账后上传凭证，等待平台确认' : '转账后提交即可，等待平台确认',
    },
  ];
});
const availablePayTypes = computed(() => payOptions.value.filter((item) =>
  String(paymentSettings.value[item.key]) === '1'
  && (!item.ready || String(paymentSettings.value[item.ready]) === '1'),
));
const paymentQr = computed(() => selectedPayType.value === 2 ? sys.value.wx_image : selectedPayType.value === 3 ? sys.value.zfb_image : '');

const statusTitle = computed(() => Number(o.value.pay_status) === 10 && Number(o.value.order_type) === 1 && Number(o.value.status) === 0
  ? '订单已支付'
  : o.value.status_text);
const statusDesc = computed(() => {
  if (Number(o.value.pay_status) === 10 && Number(o.value.order_type) === 1 && Number(o.value.status) === 0) {
    return '订单已支付，可前往我的店铺查看商品';
  }
  // 已转拍出去的单不再等待发货，避免会员一直以为还在备货
  if (o.value.transferred && Number(o.value.status) === 10) return '商品已转拍给他人，无需等待发货';
  const m = { 0: '请尽快完成支付', 10: '商家正在备货', 20: '商品运输中，请注意查收', 30: '交易已完成', 40: '订单已关闭' };
  return m[o.value.status] || '';
});

async function load() {
  loading.value = true;
  try {
    const r = await api.orderDetail(route.params.id);
    // 业务失败（订单不存在 / 无权查看）不能静默渲染空对象，否则金额会显示成 ¥NaN
    if (!r || r.code !== 1 || !r.data?.order_id) {
      showToast((r && r.msg) || '订单不存在');
      o.value = {};
      setTimeout(() => router.back(), 1200);
      return;
    }
    o.value = r.data;
    voucher.value = r.data.pay_voucher || '';
    const [s, p] = await Promise.allSettled([api.systemInfo(), api.paymentSettings()]);
    if (s.status === 'fulfilled') sys.value = s.value.data || {};
    if (p.status === 'fulfilled') paymentSettings.value = p.value.data || {};
    const original = Number(r.data.pay_type);
    selectedPayType.value = availablePayTypes.value.some((item) => item.v === original)
      ? original
      : (availablePayTypes.value[0]?.v || 0);
  } catch {
    showToast('订单加载失败');
    o.value = {};
  } finally {
    loading.value = false;
  }
}

async function pay() {
  if (!selectedPayType.value) return showToast('当前暂无开放的支付方式');
  if (needVoucher.value && selectedPayType.value !== 1 && !voucher.value) return showToast('请先上传支付凭证');
  paying.value = true;
  try {
    await api.payOrder({
      order_id: o.value.order_id,
      pay_type: selectedPayType.value,
      ...(selectedPayType.value === 1 || !voucher.value ? {} : { voucher: voucher.value }),
    });
    const isBalancePayment = selectedPayType.value === 1;
    showToast(isBalancePayment
      ? '支付成功，正在前往我的店铺'
      : '付款信息已提交；平台确认后，商品会显示在我的店铺');
    // 买家完成付款申报后直接进入店铺查看商品状态；线下转账仍需后台确认后才会入店。
    window.setTimeout(() => router.push('/my-shop'), 450);
  } catch (error) {
    // 订单可能已在其他页面或设备上完成支付，接口会拒绝重复支付。把这个状态作为成功结果处理，
    // 避免旧详情页继续显示“我已付款”并让用户无路可走。
    if (String(error?.msg || '').includes('订单已支付')) {
      window.setTimeout(() => router.push('/my-shop'), 450);
    }
  } finally { paying.value = false; }
}

function goToMyShop() {
  router.push('/my-shop');
}

async function uploadVoucher(file) {
  const result = await api.upload(file);
  voucher.value = result.data.url;
  return result.data.url;
}

async function receipt() {
  try {
    await api.receipt({ order_id: o.value.order_id });
    showToast('已确认收货');
    load();
  } catch {}
}

onMounted(load);
</script>

<style scoped>
.odetail { background: var(--bg); padding-bottom: 80px; }
.status {
  padding: 18px 18px 22px;
  background: linear-gradient(135deg, var(--brand-light), var(--brand-dark));
  border-radius: 14px;
  color: #fff;
}
.status__t { font-size: 19px; font-weight: 700; letter-spacing: 0.5px; }
.status__d { font-size: 12.5px; opacity: 0.88; margin-top: 6px; }

.goods { margin-top: 10px; display: flex; gap: 12px; padding: 13px; }
.goods__img { width: 78px; height: 78px; border-radius: 10px; overflow: hidden; background: #f6f7f9; flex: none; }
.goods__img img { width: 100%; height: 100%; object-fit: cover; }
.goods__info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.goods__name { font-size: 14px; font-weight: 550; line-height: 1.45; }
.goods__row { display: flex; align-items: flex-end; justify-content: space-between; margin-top: auto; }
.goods__row .price { font-size: 16px; }

.card {
  margin-top: 10px;
  padding: 0 14px;
  background: #fff;
  border-radius: 14px;
  box-shadow: var(--shadow);
}
.kv {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  font-size: 13px;
  color: var(--text-2);
  border-bottom: 1px solid var(--line);
}
.card .kv:last-child { border-bottom: none; }
.kv span:last-child { color: var(--text-1); font-weight: 500; text-align: right; }
.kv .right { max-width: 62%; line-height: 1.5; }
.kv--sum { font-size: 14px; }
.kv--sum .price { font-size: 18px; }

.payment { padding-bottom: 8px; }
.payment__option { display: flex; align-items: center; gap: 10px; padding: 12px 0; border-top: 1px solid var(--line); cursor: pointer; }
.payment__option:first-of-type { border-top: none; }
.payment .radio { width: 17px; height: 17px; border-radius: 50%; border: 1.6px solid #d3d7de; flex: none; position: relative; }
.payment .radio.on { border-color: var(--brand); }
.payment .radio.on::after { content: ''; position: absolute; inset: 3px; border-radius: 50%; background: var(--brand); }
.payment__title { font-size: 13.5px; font-weight: 550; }
.payment__desc, .payment__hint { color: var(--text-3); font-size: 11.5px; margin-top: 3px; }
.payment__qr { text-align: center; color: var(--text-2); font-size: 12px; padding: 12px 0; }
.payment__qr img { display: block; width: 170px; height: 170px; object-fit: contain; margin: 10px auto 0; border: 1px solid var(--line); border-radius: 10px; }
.payment__voucher { padding: 10px 0; border-top: 1px solid var(--line); }
.payment__empty { color: var(--text-3); font-size: 12px; padding: 12px 0; }

.logs { padding-bottom: 14px; }
.log {
  display: flex;
  gap: 10px;
  padding: 9px 0;
  align-items: flex-start;
}
.dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--brand);
  margin-top: 6px;
  flex: none;
  box-shadow: 0 0 0 3px var(--brand-soft);
}
.log__body { flex: 1; }
.log__t { font-size: 13px; font-weight: 550; }
.log__d { font-size: 11.5px; color: var(--text-3); margin-top: 2px; }
.log__time { font-size: 11px; color: var(--text-4); font-variant-numeric: tabular-nums; }

.odetail__bar {
  position: fixed;
  left: 50%; right: auto; bottom: 0;
  width: min(100vw, 430px);
  transform: translateX(-50%);
  padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
  background: #fff;
  border-top: 1px solid var(--line);
}

.empty {
  padding: 60px 20px;
  text-align: center;
  font-size: 13px;
  color: var(--text-3);
}
</style>
