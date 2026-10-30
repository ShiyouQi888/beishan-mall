<template>
  <div class="page records">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">兑换记录</div>
    </div>

    <div class="section-pad" style="padding-top: 12px">
      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!list.length" class="empty">还没有兑换过商品</div>
      <div v-else class="rlist">
        <div class="rcard" v-for="r in list" :key="r.exchange_id">
          <div class="rcard__top">
            <span class="rcard__no">{{ r.exchange_no }}</span>
            <span class="rcard__status" :class="statusClass(r.status)">{{ r.status_text }}</span>
          </div>
          <div class="rcard__body">
            <div class="rcard__thumb"><img v-if="r.item_thumb" :src="r.item_thumb" :alt="r.item_name" /></div>
            <div class="rcard__info">
              <div class="rcard__name ellipsis2">{{ r.item_name }}</div>
              <div class="rcard__meta">数量 ×{{ r.num }}</div>
              <div v-if="r.express_no" class="rcard__express">{{ r.express_company }} {{ r.express_no }}</div>
            </div>
            <div class="rcard__score">
              <div class="rcard__score-num">{{ r.total_score }}</div>
              <div class="rcard__score-t">积分</div>
            </div>
          </div>
          <div class="rcard__time">{{ r.create_time }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { showToast } from '../utils/feedback.js';
import { api } from '../api.js';

const list = ref([]);
const loading = ref(true);

const statusClass = (s) => ({ 10: 'st-wait', 20: 'st-send', 30: 'st-done', 40: 'st-off' }[Number(s)] || 'st-off');

onMounted(async () => {
  try {
    const r = await api.myScoreExchanges({ page: 1, limit: 50 });
    if (r && r.code !== 1) showToast(r.msg || '加载失败');
    list.value = r?.data?.list?.data || [];
  } catch {
    showToast('加载失败');
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.records { background: var(--bg); }
.rlist { display: flex; flex-direction: column; gap: 10px; }
.rcard { background: #fff; border-radius: 13px; padding: 12px 13px; box-shadow: var(--shadow); }
.rcard__top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.rcard__no { font-size: 11.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.rcard__status { font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 9px; }
.st-wait { color: #c2410c; background: #fff2e8; }
.st-send { color: #1d4ed8; background: #eef2ff; }
.st-done { color: #15803d; background: #ecfdf3; }
.st-off { color: #6b7280; background: #f3f4f6; }
.rcard__body { display: flex; gap: 10px; align-items: flex-start; }
.rcard__thumb { width: 62px; height: 62px; border-radius: 10px; overflow: hidden; background: #f6f7f9; flex: none; }
.rcard__thumb img { width: 100%; height: 100%; object-fit: cover; }
.rcard__info { flex: 1; min-width: 0; }
.rcard__name { font-size: 13.5px; line-height: 1.4; }
.rcard__meta { font-size: 12px; color: var(--text-3); margin-top: 5px; }
.rcard__express { font-size: 12px; color: var(--text-2); margin-top: 4px; }
.rcard__score { text-align: right; flex: none; }
.rcard__score-num { font-size: 16px; font-weight: 700; color: var(--brand); font-variant-numeric: tabular-nums; }
.rcard__score-t { font-size: 10.5px; color: var(--text-3); }
.rcard__time { font-size: 11.5px; color: var(--text-3); margin-top: 10px; text-align: right; }
</style>
