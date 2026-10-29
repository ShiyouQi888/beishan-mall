<template>
  <div class="page score">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">积分商城</div>
    </div>

    <div class="score__head">
      <div class="s-label">我的积分</div>
      <div class="s-value">{{ score }}</div>
      <div class="s-desc">积分可通过充值、活动获得，用于兑换精选好物</div>
    </div>

    <div class="section-pad" style="padding-top: 14px">
      <div v-if="list.length" class="sgrid">
        <div class="scard" v-for="g in list" :key="g.goods_id">
          <div class="scard__img"><img :src="g.good_thumb" /></div>
          <div class="scard__body">
            <div class="scard__name ellipsis2">{{ g.goods_name }}</div>
            <div class="scard__row">
              <div class="scard__score">{{ g.score_price }} <span>积分</span></div>
              <button class="scard__btn" :disabled="score < g.score_price" @click="exchange(g)">兑换</button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty">暂无积分商品</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { showToast, showConfirmDialog } from 'vant';
import { api } from '../api.js';

const list = ref([]);
const score = ref(0);

async function load() {
  try {
    const [a, b] = await Promise.allSettled([api.scoreShop({ page: 1, limit: 30 }), api.me()]);
    if (a.status === 'fulfilled') list.value = a.value.data?.list?.data || [];
    if (b.status === 'fulfilled') score.value = b.value.data?.score || 0;
  } catch {}
}

async function exchange(g) {
  try {
    await showConfirmDialog({ title: '确认兑换', message: `使用 ${g.score_price} 积分兑换「${g.goods_name}」？` });
  } catch {
    return;
  }
  try {
    const http = (await import('../api.js')).default;
    const r = await http.post('/finance/recharge/exchange', { goods_id: g.goods_id });
    showToast('兑换成功');
    load();
  } catch {}
}

onMounted(load);
</script>

<style scoped>
.score { background: var(--bg); }
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
</style>
