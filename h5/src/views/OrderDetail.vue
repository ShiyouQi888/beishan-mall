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

    <div class="odetail__bar" v-if="o.status === 0 || (Number(o.pay_status) === 10 && Number(o.order_type) === 1)">
      <button
        v-if="o.status === 0 && Number(o.pay_status) !== 10"
        class="btn-main"
        :disabled="paying || submitted"
        @click="pay"
      >
        {{ submitted ? '已提交，等待确认' : (paying ? '提交中…' : '申请抢单') }}
      </button>
      <button v-if="Number(o.pay_status) === 10 && Number(o.order_type) === 1" class="btn-main" @click="goToMyShop">查看我的店铺</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast } from '../utils/feedback.js';
import { api } from '../api.js';

const route = useRoute();
const router = useRouter();
const o = ref({});
const loading = ref(true);
// 支付方式这一环已整体去掉：未完成的订单只需「申请抢单」，等平台确认
const paying = ref(false);
// 已经提交过抢单申请（后端按订单日志判定）→ 按钮置灰，退出重进也不能再点
const submitted = computed(() => Number(o.value.applied) === 1);

// 订单只反映付没付，没有发货/收货环节
const statusTitle = computed(() => o.value.status_text || (Number(o.value.pay_status) === 10 ? '已确认' : '待确认'));
const statusDesc = computed(() => {
  if (Number(o.value.status) === 40) return '订单已关闭';
  if (Number(o.value.pay_status) !== 10) {
    return submitted.value ? '抢单申请已提交，等待平台确认' : '等待平台确认这笔抢单';
  }
  if (o.value.transferred && Number(o.value.order_type) === 1) return '商品已转拍给他人';
  return Number(o.value.order_type) === 1 ? '平台已确认，可前往我的店铺查看商品' : '平台已确认';
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
  } catch {
    showToast('订单加载失败');
    o.value = {};
  } finally {
    loading.value = false;
  }
}

async function pay() {
  if (paying.value) return;
  // 二次兜底：即使按钮因为旧数据没置灰，也不让同一笔订单重复提交
  if (submitted.value) {
    showToast('这笔订单已经提交过抢单申请');
    return;
  }
  paying.value = true;
  try {
    // pay_type 固定 0：只是把「已申请抢单」提交给平台，不涉及任何支付通道
    const r = await api.payOrder({ order_id: o.value.order_id, pay_type: 0 });
    showToast((r && r.msg) || '已提交抢单申请，等待平台确认');
    await load();
  } catch (error) {
    if (String(error?.msg || '').includes('订单已支付')) {
      showToast('这笔订单已经确认过了');
      await load();
    }
  } finally { paying.value = false; }
}

function goToMyShop() {
  router.push('/my-shop');
}

/* ---------------- 自动刷新 ----------------
 * 抢单是「用户提交申请 → 平台在后台点确认」，确认这一刻用户手机上没有任何感知，
 * 不轮询就会一直停在「已提交，等待确认」，得手动退出重进才更新。
 * 只在「还没确认、也没关闭」时轮询，确认/关闭后自动停，不会白耗流量。
 */
const POLL_MS = 4000;
let pollTimer = 0;

function shouldPoll() {
  const v = o.value || {};
  if (!v.order_id) return false;
  if (Number(v.status) === 40) return false;      // 已关闭，不会再有变化
  return Number(v.pay_status) !== 10;             // 已确认就停
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
}

async function pollOnce() {
  // 页面在后台、或正在提交申请时不打扰
  if (document.hidden || paying.value || !shouldPoll()) {
    if (!shouldPoll()) stopPoll();
    return;
  }
  try {
    const r = await api.orderDetail(route.params.id);
    if (!r || r.code !== 1 || !r.data?.order_id) return;
    const wasConfirmed = Number(o.value.pay_status) === 10;
    const wasClosed = Number(o.value.status) === 40;
    o.value = { ...r.data };
    if (!wasConfirmed && Number(r.data.pay_status) === 10) {
      showToast('平台已确认这笔抢单');
    } else if (!wasClosed && Number(r.data.status) === 40) {
      showToast('这笔订单已关闭');
    }
    if (!shouldPoll()) stopPoll();
  } catch {
    // 静默失败：网络抖一下不该弹错误，下一轮再试
  }
}

function startPoll() {
  stopPoll();
  if (shouldPoll()) pollTimer = setInterval(pollOnce, POLL_MS);
}

// 从后台切回前台时立刻补一次，别让用户盯着旧数据等 4 秒
function onVisible() {
  if (!document.hidden) pollOnce();
}

onMounted(async () => {
  await load();
  startPoll();
  document.addEventListener('visibilitychange', onVisible);
});

onUnmounted(() => {
  stopPoll();
  document.removeEventListener('visibilitychange', onVisible);
});
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
