<template>
  <div class="page team">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">我的团队</div>
    </div>

    <div class="section-pad" style="padding-top: 12px">
      <div class="team__hero">
        <div class="h-item"><b>{{ list.length }}</b><span>直推好友</span></div>
        <div class="h-div" />
        <div class="h-item"><b>{{ teamTotal }}</b><span>团队总人数</span></div>
        <div class="h-div" />
        <div class="h-item"><b>{{ me.distribution_amount || '0.00' }}</b><span>累计收益</span></div>
      </div>

      <div class="sec-title"><span>直推成员</span></div>
      <div v-if="list.length" class="mlist">
        <div class="mitem card" v-for="m in list" :key="m.member_id">
          <div class="mavatar">
            <img v-if="m.avatarUrl" :src="m.avatarUrl" />
            <span v-else>{{ (m.nickName || 'U').slice(0, 1) }}</span>
          </div>
          <div class="minfo">
            <div class="mname">{{ m.nickName }}</div>
            <div class="mphone">{{ maskPhone(m.mobile) }}</div>
          </div>
          <div class="mtime">{{ (m.create_time || '').slice(0, 10) }}</div>
        </div>
      </div>
      <div v-else class="empty">还没有直推好友，去邀请吧</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';

const list = ref([]);
const me = ref({});
const teamTotal = computed(() => list.value.length);

const maskPhone = (p) => (p ? p.slice(0, 3) + '****' + p.slice(-4) : '');

onMounted(async () => {
  try {
    const [a, b] = await Promise.allSettled([api.indirection(), api.me()]);
    if (a.status === 'fulfilled') list.value = a.value.data || [];
    if (b.status === 'fulfilled') me.value = b.value.data || {};
  } catch {}
});
</script>

<style scoped>
.team { background: var(--bg); }
.team__hero {
  display: flex;
  align-items: center;
  background: linear-gradient(135deg, #ff6a4d, #e63c26);
  border-radius: 16px;
  padding: 20px 0;
  color: #fff;
}
.h-item { flex: 1; text-align: center; }
.h-item b { display: block; font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.h-item span { font-size: 11.5px; opacity: 0.86; }
.h-div { width: 1px; height: 26px; background: rgba(255, 255, 255, 0.26); }

.mlist { display: flex; flex-direction: column; gap: 9px; }
.mitem { display: flex; align-items: center; gap: 11px; padding: 12px 14px; }
.mavatar {
  width: 40px; height: 40px;
  border-radius: 13px;
  background: var(--brand-soft);
  color: var(--brand);
  font-weight: 700;
  font-size: 16px;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
  flex: none;
}
.mavatar img { width: 100%; height: 100%; object-fit: cover; }
.minfo { flex: 1; min-width: 0; }
.mname { font-size: 14px; font-weight: 550; }
.mphone { font-size: 11.5px; color: var(--text-3); margin-top: 2px; font-variant-numeric: tabular-nums; }
.mtime { font-size: 11px; color: var(--text-4); }
</style>
