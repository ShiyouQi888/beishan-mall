<template>
  <div class="page comm">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">我的佣金</div>
    </div>

    <div class="comm__card">
      <div class="c-label">可用佣金（元）</div>
      <div class="c-value">{{ me.e_card_number || '0.00' }}</div>
      <div class="c-row">
        <div class="c-item"><b>{{ profit.today || 0 }}</b><span>今日</span></div>
        <div class="c-item"><b>{{ profit.month || 0 }}</b><span>本月</span></div>
        <div class="c-item"><b>{{ profit.all || 0 }}</b><span>累计</span></div>
      </div>
    </div>

    <div class="section-pad" style="padding-top: 14px">
      <div class="sec-title"><span>佣金明细</span></div>
      <div v-if="rows.length" class="elist">
        <div class="eitem card" v-for="r in rows" :key="r.energy_id">
          <div class="e-left">
            <div class="e-name">{{ r.type_name || '佣金' }}</div>
            <div class="e-remark ellipsis">{{ r.remarks || '—' }}</div>
            <div class="e-time">{{ r.create_time }}</div>
          </div>
          <div class="e-val" :class="{ minus: Number(r.face_value) < 0 }">
            {{ Number(r.face_value) > 0 ? '+' : '' }}{{ Number(r.face_value).toFixed(2) }}
          </div>
        </div>
      </div>
      <div v-else class="empty">暂无佣金记录</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

const me = ref({});
const profit = ref({});
const rows = ref([]);

onMounted(async () => {
  try {
    const [m, p] = await Promise.allSettled([api.me(), api.personProfit()]);
    if (m.status === 'fulfilled') me.value = m.value.data || {};
    if (p.status === 'fulfilled') {
      profit.value = p.value.data || {};
      rows.value = p.value.data?.rows || [];
    }
  } catch {}
});
</script>

<style scoped>
.comm { background: var(--bg); }
.comm__card {
  margin: 14px;
  padding: 20px 18px 18px;
  border-radius: 18px;
  background: linear-gradient(150deg, var(--brand-hero-1), var(--brand-hero-2) 70%, var(--brand-hero-3));
  color: #fff;
  box-shadow: 0 10px 26px rgba(230, 60, 38, 0.24);
}
.c-label { font-size: 12px; opacity: 0.86; }
.c-value {
  font-size: 34px;
  font-weight: 700;
  letter-spacing: 0.5px;
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}
.c-row {
  display: flex;
  margin: 18px 0 16px;
  padding-top: 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.22);
}
.c-item { flex: 1; text-align: center; }
.c-item b { display: block; font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
.c-item span { font-size: 11px; opacity: 0.82; }
.c-btn {
  width: 100%;
  height: 42px;
  border: none;
  border-radius: 21px;
  background: #fff;
  color: var(--brand);
  font-size: 14.5px;
  font-weight: 700;
  font-family: var(--font);
}

.elist { display: flex; flex-direction: column; gap: 9px; }
.eitem { display: flex; align-items: center; gap: 12px; padding: 13px 14px; }
.e-left { flex: 1; min-width: 0; }
.e-name { font-size: 13.5px; font-weight: 550; }
.e-remark { font-size: 11.5px; color: var(--text-3); margin-top: 2px; }
.e-time { font-size: 11px; color: var(--text-4); margin-top: 3px; font-variant-numeric: tabular-nums; }
.e-val {
  font-size: 16px;
  font-weight: 700;
  color: #2eb872;
  font-variant-numeric: tabular-nums;
  flex: none;
}
.e-val.minus { color: var(--text-2); }
</style>
