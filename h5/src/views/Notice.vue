<template>
  <div class="page notice">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">平台公告</div>
    </div>

    <div class="section-pad" style="padding-top: 12px">
      <div v-if="list.length" class="nlist">
        <div class="ncard card" v-for="n in list" :key="n.id" @click="open(n)">
          <div class="ncard__t">{{ n.title }}</div>
          <div class="ncard__d muted">{{ n.create_time }}</div>
          <div class="ncard__c ellipsis2" v-html="strip(n.content)" />
        </div>
      </div>
      <div v-else class="empty">暂无公告</div>
    </div>

    <van-popup v-model:show="show" position="bottom" round :style="{ maxHeight: '80vh', padding: '22px 18px 28px' }">
      <div class="p-title">{{ cur.title }}</div>
      <div class="p-time muted">{{ cur.create_time }}</div>
      <div class="p-content" v-html="cur.content" />
    </van-popup>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

const list = ref([]);
const show = ref(false);
const cur = ref({});

const strip = (h) => (h || '').replace(/<[^>]+>/g, '').slice(0, 80);

function open(n) {
  cur.value = n;
  show.value = true;
}

onMounted(async () => {
  try {
    const r = await api.notices();
    list.value = r.data || [];
  } catch {}
});
</script>

<style scoped>
.notice { background: var(--bg); }
.nlist { display: flex; flex-direction: column; gap: 10px; }
.ncard { padding: 14px; }
.ncard__t { font-size: 14.5px; font-weight: 600; }
.ncard__d { margin: 4px 0 7px; }
.ncard__c { font-size: 12.5px; color: var(--text-3); line-height: 1.6; }
.p-title { font-size: 17px; font-weight: 700; }
.p-time { font-size: 11.5px; margin: 6px 0 14px; }
.p-content { font-size: 13.5px; line-height: 1.8; color: var(--text-2); }
.p-content :deep(p) { margin: 0 0 8px; }
</style>
