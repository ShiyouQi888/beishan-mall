<template>
  <div class="page wallet">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">我的钱包</div>
    </div>

    <div class="section-pad" style="padding-top: 12px">
      <div class="wall__card">
        <div class="wall__label">账户余额（元）</div>
        <div class="wall__value">{{ info.amount?.member_amount || me.amount || '0.00' }}</div>
        <div class="wall__row">
          <div class="w-item"><b>{{ info.amount?.today_money || '0.00' }}</b><span>今日收益</span></div>
          <div class="w-item"><b>{{ info.amount?.month_money || '0.00' }}</b><span>本月收益</span></div>
          <div class="w-item"><b>{{ info.amount?.e_card_number || '0.00' }}</b><span>佣金</span></div>
        </div>
        <div class="wall__btns">
          <button @click="$router.push('/withdraw')">申请提现</button>
          <button class="ghost" @click="$router.push('/commission')">佣金明细</button>
        </div>
      </div>

      <div class="sec-title"><span>资金流水</span></div>
      <div v-if="flows.length" class="flist">
        <div class="fitem card" v-for="f in flows" :key="f.energy_id">
          <div class="f-left">
            <div class="f-name">{{ f.type_name || typeName(f.type) }}</div>
            <div class="f-remark ellipsis">{{ f.remarks || '—' }}</div>
            <div class="f-time">{{ f.create_time }}</div>
          </div>
          <div class="f-val" :class="{ minus: Number(f.face_value) < 0 }">
            {{ Number(f.face_value) > 0 ? '+' : '' }}{{ Number(f.face_value).toFixed(2) }}
          </div>
        </div>
      </div>
      <div v-else class="empty">暂无流水记录</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

const info = ref({});
const me = ref({});
const flows = ref([]);
const typeName = (t) => ({ 1: '佣金', 2: '余额', 3: '积分', 4: '礼券' }[t] || '变更');

onMounted(async () => {
  try {
    const [a, m] = await Promise.allSettled([api.amountInfo(), api.me()]);
    if (a.status === 'fulfilled') {
      info.value = a.value.data || {};
      flows.value = a.value.data?.balance_list || [];
    }
    if (m.status === 'fulfilled') me.value = m.value.data || {};
  } catch {}
});
</script>

<style scoped>
.wallet { background: var(--bg); }
.wall__card {
  padding: 20px 18px;
  border-radius: 18px;
  background: linear-gradient(150deg, var(--brand-hero-1), var(--brand-hero-2) 70%, var(--brand-hero-3));
  color: #fff;
  box-shadow: 0 10px 26px rgba(230, 60, 38, 0.22);
}
.wall__label { font-size: 12px; opacity: 0.86; }
.wall__value { font-size: 34px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
.wall__row { display: flex; margin: 16px 0 14px; padding-top: 13px; border-top: 1px solid rgba(255, 255, 255, 0.22); }
.w-item { flex: 1; text-align: center; }
.w-item b { display: block; font-size: 14.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
.w-item span { font-size: 11px; opacity: 0.82; }
.wall__btns { display: flex; gap: 10px; }
.wall__btns button {
  flex: 1;
  height: 40px;
  border: none;
  border-radius: 20px;
  background: #fff;
  color: var(--brand);
  font-size: 14px;
  font-weight: 700;
  font-family: var(--font);
}
.wall__btns button.ghost { background: rgba(255, 255, 255, 0.18); color: #fff; }

.flist { display: flex; flex-direction: column; gap: 9px; }
.fitem { display: flex; align-items: center; gap: 12px; padding: 13px 14px; }
.f-left { flex: 1; min-width: 0; }
.f-name { font-size: 13.5px; font-weight: 550; }
.f-remark { font-size: 11.5px; color: var(--text-3); margin-top: 2px; }
.f-time { font-size: 11px; color: var(--text-4); margin-top: 3px; }
.f-val { font-size: 16px; font-weight: 700; color: #2eb872; font-variant-numeric: tabular-nums; }
.f-val.minus { color: var(--text-2); }
</style>
