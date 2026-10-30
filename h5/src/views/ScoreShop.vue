<template>
  <div class="page score">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">积分商城</div>
      <div class="navbar__right" @click="$router.push('/score/records')">兑换记录</div>
    </div>

    <div class="score__head" v-if="open">
      <div class="s-label">我的积分</div>
      <div class="s-value">{{ score }}</div>
      <div class="s-desc">积分可通过平台活动与成交奖励获得，用于兑换精选好物</div>
    </div>

    <div class="section-pad" style="padding-top: 14px">
      <div v-if="!open" class="empty">积分商城暂未开放</div>
      <div v-else-if="list.length" class="sgrid">
        <div class="scard" v-for="g in list" :key="g.item_id">
          <div class="scard__img">
            <img v-if="g.thumb" :src="g.thumb" :alt="g.name" />
          </div>
          <div class="scard__body">
            <div class="scard__name ellipsis2">{{ g.name }}</div>
            <div class="scard__stock">剩余 {{ g.stock }} 件</div>
            <div class="scard__row">
              <div class="scard__score">{{ g.score_price }} <span>积分</span></div>
              <button
                class="scard__btn"
                :disabled="score < g.score_price || g.stock <= 0"
                @click="openExchange(g)"
              >{{ g.stock <= 0 ? '已兑完' : '兑换' }}</button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty">暂无积分商品</div>
    </div>

    <!-- 兑换确认 -->
    <van-popup v-model:show="dlg" position="bottom" round :style="{ padding: '22px 16px 26px' }">
      <div class="ex__title">确认兑换</div>
      <div class="ex__goods" v-if="cur">
        <div class="ex__thumb"><img v-if="cur.thumb" :src="cur.thumb" /></div>
        <div class="ex__info">
          <div class="ex__name ellipsis2">{{ cur.name }}</div>
          <div class="ex__price">{{ cur.score_price }} 积分 / 件</div>
        </div>
      </div>

      <div class="ex__row">
        <span>兑换数量</span>
        <van-stepper v-model="num" :min="1" :max="maxNum" integer />
      </div>

      <div class="ex__addr" @click="addrPick = !addrPick">
        <template v-if="addr">
          <div class="ex__addr-main">
            <div class="ex__addr-line1">{{ addr.name }} {{ addr.mobile }}</div>
            <div class="ex__addr-line2">{{ addr.province }}{{ addr.city }}{{ addr.district }} {{ addr.detail }}</div>
          </div>
          <span class="ex__addr-act">{{ addrPick ? '收起' : '更换' }}</span>
        </template>
        <template v-else>
          <div class="ex__addr-main"><div class="ex__addr-line1">请选择收货地址</div></div>
          <span class="ex__addr-act">选择</span>
        </template>
      </div>

      <div v-if="addrPick" class="ex__addr-list">
        <div
          v-for="a in addrList"
          :key="a.address_id"
          class="ex__addr-item"
          :class="{ on: addr && addr.address_id === a.address_id }"
          @click="pickAddr(a)"
        >
          <div class="ex__addr-line1">{{ a.name }} {{ a.mobile }}</div>
          <div class="ex__addr-line2">{{ a.province }}{{ a.city }}{{ a.district }} {{ a.detail }}</div>
        </div>
        <div v-if="!addrList.length" class="ex__addr-empty">
          还没有收货地址，先去<em @click="$router.push('/address')">添加地址</em>
        </div>
      </div>

      <div class="ex__total">
        合计 <b>{{ totalScore }}</b> 积分
        <span v-if="totalScore > score" class="ex__lack">（积分不足）</span>
      </div>

      <button class="btn-main" :disabled="submitting || !canSubmit" @click="doExchange">
        {{ submitting ? '兑换中…' : '确认兑换' }}
      </button>
    </van-popup>
  </div>
</template>

<script setup>
import { ref, computed, inject, watch, onMounted } from 'vue';
import { showToast } from '../utils/feedback.js';
import { api } from '../api.js';

const list = ref([]);
const score = ref(0);
// 总开关来自后台「商城设置 → 积分商城」，关闭时整页显示未开放，也不去请求接口
const store = inject('storeInfo', ref({}));
const open = computed(() => String(store.value?.score_open ?? '10') !== '20');

const dlg = ref(false);
const cur = ref(null);
const num = ref(1);
const submitting = ref(false);
const addrList = ref([]);
const addr = ref(null);
const addrPick = ref(false);

const maxNum = computed(() => {
  if (!cur.value) return 1;
  return Math.max(1, Math.min(99, Number(cur.value.stock) || 1));
});
const totalScore = computed(() => (Number(cur.value?.score_price) || 0) * (Number(num.value) || 0));
const canSubmit = computed(() => !!addr.value && !!cur.value && totalScore.value <= score.value);

async function load() {
  try {
    const [a, b] = await Promise.allSettled([api.scoreShop({ page: 1, limit: 30 }), api.me()]);
    if (a.status === 'fulfilled') list.value = a.value.data?.list?.data || [];
    if (b.status === 'fulfilled') score.value = Number(b.value.data?.score || 0);
  } catch {}
}

async function loadAddr() {
  try {
    const r = await api.addressList();
    addrList.value = r.data || [];
    if (!addr.value) addr.value = addrList.value.find((x) => Number(x.is_default) === 1) || addrList.value[0] || null;
  } catch {}
}

function pickAddr(a) {
  addr.value = a;
  addrPick.value = false;
}

async function openExchange(g) {
  cur.value = g;
  num.value = 1;
  addrPick.value = false;
  dlg.value = true;
  if (!addrList.value.length) await loadAddr();
}

async function doExchange() {
  if (!cur.value) return;
  if (!addr.value) return showToast('请先选择收货地址');
  if (totalScore.value > score.value) return showToast('积分不足');
  submitting.value = true;
  try {
    const r = await api.scoreExchange({
      item_id: cur.value.item_id,
      num: Number(num.value),
      address_id: addr.value.address_id,
    });
    if (r && r.code !== 1) {
      showToast(r.msg || '兑换失败');
      return;
    }
    showToast('兑换成功，等待平台发货');
    dlg.value = false;
    load();
  } catch (e) {
    showToast(e?.message || '兑换失败');
  } finally {
    submitting.value = false;
  }
}

// 等后台配置到位再决定要不要请求：配置说关闭就整页显示未开放，一次接口都不打
const ready = computed(() => store.value?.score_open !== undefined);
let started = false;
function start(force = false) {
  if (started) return;
  if (!ready.value && !force) return; // 配置还没到，先等
  started = true;
  if (open.value) load();
}
watch(() => store.value?.score_open, () => start());

onMounted(() => {
  start();
  // 兜底：配置接口异常时不能让页面一直空着，1.5s 后强制按默认开放去请求，
  // 真正的开关状态仍由服务端接口兜底拦截
  setTimeout(() => start(true), 1500);
});
</script>

<style scoped>
.score { background: var(--bg); }
/* 导航栏右侧入口：绝对定位，避免把居中的标题挤偏 */
.navbar__right {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 13px;
  color: var(--text-2);
}
.score__head {
  margin: 0 14px;
  padding: 20px 18px;
  border-radius: 16px;
  background: linear-gradient(135deg, #ff8f5a, #f0502f);
  color: #fff;
  margin-top: 12px;
}
.s-label { font-size: 12px; opacity: 0.86; }
.s-value { font-size: 32px; font-weight: 700; margin-top: 3px; font-variant-numeric: tabular-nums; }
.s-desc { font-size: 11px; opacity: 0.82; margin-top: 8px; }

.sgrid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 11px; }
.scard { background: #fff; border-radius: 13px; overflow: hidden; box-shadow: var(--shadow); }
.scard__img { aspect-ratio: 1; background: #f6f7f9; }
.scard__img img { width: 100%; height: 100%; object-fit: cover; }
.scard__body { padding: 9px 10px 11px; }
.scard__name { font-size: 13px; line-height: 1.4; min-height: 34px; }
.scard__stock { font-size: 11px; color: var(--text-3); margin-top: 3px; }
.scard__row { display: flex; align-items: center; justify-content: space-between; margin-top: 7px; }
.scard__score { font-size: 15px; font-weight: 700; color: var(--brand); font-variant-numeric: tabular-nums; }
.scard__score span { font-size: 10.5px; font-weight: 450; }
.scard__btn {
  height: 26px;
  padding: 0 12px;
  border: none;
  border-radius: 13px;
  background: var(--brand);
  color: #fff;
  font-size: 11.5px;
  font-weight: 600;
  font-family: var(--font);
}
.scard__btn[disabled] { background: #d8dbe0; }

/* 兑换弹层 */
.ex__title { font-size: 16px; font-weight: 650; text-align: center; margin-bottom: 14px; }
.ex__goods { display: flex; gap: 10px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
.ex__thumb { width: 64px; height: 64px; border-radius: 10px; overflow: hidden; background: #f6f7f9; flex: none; }
.ex__thumb img { width: 100%; height: 100%; object-fit: cover; }
.ex__info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 6px; }
.ex__name { font-size: 14px; line-height: 1.35; }
.ex__price { font-size: 12.5px; color: var(--brand); font-weight: 600; }
.ex__row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 0; border-bottom: 1px solid var(--line); font-size: 13.5px;
}
.ex__addr {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 0; border-bottom: 1px solid var(--line);
}
.ex__addr-main { flex: 1; min-width: 0; }
.ex__addr-line1 { font-size: 13.5px; }
.ex__addr-line2 { font-size: 12px; color: var(--text-3); margin-top: 4px; line-height: 1.45; }
.ex__addr-act { font-size: 12.5px; color: var(--brand); flex: none; }
.ex__addr-list { max-height: 34vh; overflow-y: auto; border-bottom: 1px solid var(--line); }
.ex__addr-item { padding: 11px 10px; border-radius: 10px; margin: 8px 0; background: #f7f8fa; }
.ex__addr-item.on { background: var(--brand-soft, #fff1ee); box-shadow: inset 0 0 0 1px var(--brand); }
.ex__addr-empty { padding: 14px 2px; font-size: 12.5px; color: var(--text-3); }
.ex__addr-empty em { color: var(--brand); font-style: normal; }
.ex__total { text-align: right; font-size: 13px; padding: 14px 0 16px; }
.ex__total b { color: var(--brand); font-size: 18px; font-variant-numeric: tabular-nums; }
.ex__lack { color: #e34d59; font-size: 12px; }
</style>
