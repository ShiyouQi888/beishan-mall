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
        <div class="status__t">{{ o.status_text }}</div>
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

    <div class="odetail__bar" v-if="o.status === 0 || o.status === 20">
      <button v-if="o.status === 0" class="btn-main" @click="pay">立即支付</button>
      <button v-if="o.status === 20" class="btn-main" @click="receipt">确认收货</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast } from 'vant';
import { api } from '../api.js';

const route = useRoute();
const router = useRouter();
const o = ref({});
const loading = ref(true);

const statusDesc = computed(() => {
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
  } catch {
    showToast('订单加载失败');
    o.value = {};
  } finally {
    loading.value = false;
  }
}

async function pay() {
  try {
    await api.payOrder({ order_id: o.value.order_id, pay_type: 1 });
    showToast('支付成功');
    load();
  } catch {}
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
  background: linear-gradient(135deg, #ff6a4d, #e63c26);
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
