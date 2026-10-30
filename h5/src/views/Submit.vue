<template>
  <div class="page submit">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">确认订单</div>
    </div>

    <div class="empty" v-if="closedReason">{{ closedReason }}，正在返回抢购页…</div>
    <div class="empty" v-else-if="!g.goods_id">商品不存在或已下架，正在返回抢购页…</div>

    <div class="section-pad" style="padding-top: 12px" v-else>
      <!-- 地址 -->
      <div class="card addr" @click="$router.push('/address?select=1')">
        <template v-if="addr">
          <div class="addr__main">
            <div class="addr__line1">
              <b>{{ addr.name }}</b>
              <span class="muted">{{ addr.mobile }}</span>
            </div>
            <div class="addr__line2">{{ addr.province }}{{ addr.city }}{{ addr.district }} {{ addr.detail }}</div>
          </div>
        </template>
        <template v-else>
          <div class="addr__empty">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="M12 21s7-5.3 7-11a7 7 0 1 0-14 0c0 5.7 7 11 7 11Z" stroke="#a8adb7" stroke-width="1.7" /><circle cx="12" cy="10" r="2.5" stroke="#a8adb7" stroke-width="1.7" /></svg>
            <span>请选择收货地址</span>
          </div>
        </template>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="m9 5 7 7-7 7" stroke="#c4c8d0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>

      <!-- 商品 -->
      <div class="card goods">
        <div class="goods__img"><img :src="g.good_thumb" /></div>
        <div class="goods__info">
          <div class="goods__name ellipsis2">{{ g.goods_name }}</div>
          <div class="goods__meta">
            <span v-if="g.specialarea?.title_main" class="chip">{{ g.specialarea.title_main }}</span>
          </div>
          <div class="goods__row">
            <div class="price"><span class="sym">¥</span>{{ Number(g.goods_min_price || 0).toFixed(2) }}</div>
            <div class="goods__num">× {{ num }}</div>
          </div>
        </div>
      </div>

      <!-- 支付方式 -->
      <div class="card paysel">
        <div class="sec-title" style="padding: 14px 14px 6px"><span>支付方式</span></div>
        <div
          v-for="p in payTypes"
          :key="p.v"
          class="payitem"
          :class="{ on: payType === p.v }"
          @click="payType = p.v"
        >
          <span class="radio" :class="{ on: payType === p.v }" />
          <div class="payitem__body">
            <div class="payitem__t">{{ p.t }}</div>
            <div class="payitem__d">{{ p.d }}</div>
          </div>
        </div>
        <div v-if="!payTypes.length" class="payitem__empty">当前暂无开放的支付方式，请稍后再试。</div>
      </div>

      <!-- 备注 -->
      <div class="card remark">
        <div class="remark__label">订单备注</div>
        <input v-model="remark" placeholder="选填，可填写特殊要求" />
      </div>

      <!-- 费用 -->
      <div class="card fee">
        <div class="fee__row"><span>商品金额</span><span>¥{{ total.toFixed(2) }}</span></div>
        <div class="fee__row"><span>服务费（{{ feeRate }}%）</span><span>¥{{ fee.toFixed(2) }}</span></div>
        <div class="fee__row fee__row--sum">
          <span>应付合计</span>
          <span class="price"><span class="sym">¥</span>{{ payTotal.toFixed(2) }}</span>
        </div>
      </div>

      <div class="submit__tip">
        <p>· 抢购成功后请在 30 分钟内完成支付，超时订单自动关闭。</p>
        <p>· 商品支持复检，非质量问题不予退换。</p>
      </div>
    </div>

    <div class="submit__bar" v-if="g.goods_id && !closedReason">
      <div class="submit__bar-price">
        合计 <span class="price"><span class="sym">¥</span>{{ payTotal.toFixed(2) }}</span>
      </div>
      <button class="btn-main submit__bar-btn" :disabled="loading || !g.goods_id || !payTypes.length || !!closedReason" @click="doSubmit">
        {{ loading ? '提交中…' : '提交订单' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast } from '../utils/feedback.js';
import { api } from '../api.js';

const route = useRoute();
const router = useRouter();
const g = ref({});
const addr = ref(null);
const num = ref(1);
const payType = ref(1);
const remark = ref('');
const loading = ref(false);
const feeRate = ref(0);
// 商品已抢完 / 不在抢购时间时，这个页面不该让人继续往下走
const closedReason = ref('');

const paymentSettings = ref({});
// 后台「支付凭证必传」：默认必传；关闭后线下支付无需上传凭证
const needVoucher = computed(() => String(paymentSettings.value.voucher_required ?? '1') === '1');
const allPayTypes = computed(() => {
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
const payTypes = computed(() => allPayTypes.value.filter((item) =>
  String(paymentSettings.value[item.key]) === '1'
  && (!item.ready || String(paymentSettings.value[item.ready]) === '1'),
));

const total = computed(() => Number(g.value.goods_min_price || 0) * num.value);
const fee = computed(() => Math.round(total.value * feeRate.value) / 100);
const payTotal = computed(() => Math.round((total.value + fee.value) * 100) / 100);

onMounted(async () => {
  try {
    const p = await api.paymentSettings();
    paymentSettings.value = p.data || {};
    payType.value = payTypes.value[0]?.v || 0;
  } catch {
    paymentSettings.value = {};
  }
  try {
    const r = await api.lootDetail(route.params.id);
    // 业务失败（商品不存在/已下架）不能静默留空，否则会渲染出 ¥0.00 的空订单页
    if (!r || r.code !== 1 || !r.data?.goods_id) {
      showToast((r && r.msg) || '商品不存在');
      g.value = {};
      // back() 在直接打开链接、无历史记录时是空操作，这里显式回退到抢购页
      setTimeout(() => router.replace('/loot'), 1200);
      return;
    }
    g.value = r.data;
    feeRate.value = Number(g.value.service_charge_rate || 0);

    // 详情页已经拦过一次，但这里是独立路由，链接可以被直接打开 / 从历史记录回来，
    // 所以必须再拦一次。否则「已抢完」的商品照样能渲染出完整下单页，
    // 用户填完地址点提交才被后端驳回 —— 体验上就是「明明显示抢完还能抢」。
    const gone = g.value.sold_out !== undefined
      ? Number(g.value.sold_out) === 1
      : Number(g.value.goods_status ?? 10) !== 10;
    const notOpen = Number(g.value.type) === 1
      && !!g.value.specialarea
      && Number(g.value.is_ordinary_order) !== 1;
    if (gone || notOpen) {
      closedReason.value = gone ? '该商品已抢完' : '当前不在该场次抢购时间';
      showToast(closedReason.value);
      g.value = {};
      setTimeout(() => router.replace('/loot'), 1500);
      return;
    }
  } catch {
    showToast('商品不存在');
    g.value = {};
  }
  try {
    const a = await api.addressList();
    const list = a.data || [];
    addr.value = list.find((x) => x.is_default) || list[0] || null;
  } catch {}
});

async function doSubmit() {
  if (!g.value.goods_id) return showToast('商品信息未加载');
  if (!payTypes.value.some((item) => item.v === payType.value)) return showToast('当前暂无开放的支付方式');
  loading.value = true;
  try {
    const r = await api.addOrder({
      goods_id: Number(route.params.id),
      num: num.value,
      address_id: addr.value?.address_id || 0,
      remark: remark.value,
      pay_type: payType.value,
    });
    const orderId = r.data.order_id;
    if (payType.value === 1) {
      try {
        await api.payOrder({ order_id: orderId, pay_type: 1 });
        showToast('支付成功');
      } catch {
        router.replace(`/order/detail/${orderId}`);
        return;
      }
    } else {
      showToast(needVoucher.value ? '订单已创建，请完成转账并上传凭证' : '订单已创建，请完成转账后提交');
    }
    setTimeout(() => router.replace(`/order/detail/${orderId}`), 500);
  } catch {
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.submit { background: var(--bg); padding-bottom: 82px; }
.addr {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 15px 14px;
}
.addr__main { flex: 1; min-width: 0; }
.addr__line1 { display: flex; align-items: center; gap: 10px; font-size: 14.5px; }
.addr__line2 { font-size: 12.5px; color: var(--text-3); margin-top: 5px; line-height: 1.45; }
.addr__empty {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-3);
  font-size: 13.5px;
}

.goods {
  margin-top: 10px;
  display: flex;
  gap: 12px;
  padding: 13px;
}
.goods__img {
  width: 84px; height: 84px;
  border-radius: 10px;
  overflow: hidden;
  background: #f6f7f9;
  flex: none;
}
.goods__img img { width: 100%; height: 100%; object-fit: cover; }
.goods__info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.goods__name { font-size: 14px; font-weight: 550; line-height: 1.4; }
.goods__meta { margin-top: 5px; }
.chip {
  font-size: 10.5px;
  color: var(--brand);
  background: var(--brand-soft);
  padding: 2px 8px;
  border-radius: 6px;
}
.goods__row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-top: auto;
}
.goods__row .price { font-size: 16.5px; }
.goods__num { font-size: 12.5px; color: var(--text-3); }

.paysel { margin-top: 10px; padding-bottom: 6px; }
.payitem {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 14px;
  border-top: 1px solid var(--line);
}
.payitem:first-of-type { border-top: none; }
.radio {
  width: 17px; height: 17px;
  border-radius: 50%;
  border: 1.6px solid #d3d7de;
  flex: none;
  margin-top: 2px;
  position: relative;
}
.radio.on { border-color: var(--brand); }
.radio.on::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--brand);
}
.payitem__t { font-size: 14px; font-weight: 500; }
.payitem__d { font-size: 11.5px; color: var(--text-3); margin-top: 3px; }
.payitem__empty { padding: 14px; color: var(--text-3); font-size: 12.5px; border-top: 1px solid var(--line); }

.remark {
  margin-top: 10px;
  display: flex;
  align-items: center;
  padding: 0 14px;
  gap: 12px;
}
.remark__label { font-size: 13.5px; color: var(--text-2); flex: none; }
.remark input {
  flex: 1;
  border: none;
  outline: none;
  font-family: var(--font);
  font-size: 13.5px;
  padding: 15px 0;
  background: transparent;
}

.fee { margin-top: 10px; padding: 14px; }
.fee__row {
  display: flex;
  justify-content: space-between;
  font-size: 13.5px;
  color: var(--text-2);
  padding: 6px 0;
}
.fee__row--sum {
  border-top: 1px solid var(--line);
  margin-top: 6px;
  padding-top: 12px;
  font-size: 14px;
  color: var(--text-1);
  font-weight: 600;
}
.fee__row--sum .price { font-size: 18px; }

.submit__tip {
  font-size: 11.5px;
  color: var(--text-4);
  line-height: 1.7;
  margin: 12px 4px 0;
}
.submit__tip p { margin: 0 0 3px; }

.submit__bar {
  position: fixed;
  left: 50%; right: auto; bottom: 0;
  width: min(100vw, 430px);
  transform: translateX(-50%);
  height: 64px;
  background: #fff;
  border-top: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px calc(env(safe-area-inset-bottom));
  z-index: 90;
}
.submit__bar-price { font-size: 12.5px; color: var(--text-3); flex: none; }
.submit__bar-price .price { font-size: 18px; margin-left: 3px; }
.submit__bar-btn { flex: 1; height: 44px; }

.empty {
  padding: 60px 20px;
  text-align: center;
  font-size: 13px;
  color: var(--text-3);
}
</style>
