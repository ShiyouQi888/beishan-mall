<template>
  <div class="page page--tab loot">
    <div class="loot__head">
      <div class="loot__title">限时抢购</div>
      <div class="loot__sub">每日三场 · 好物限量</div>
    </div>

    <!-- 场次切换 -->
    <div class="loot__tabs">
      <div
        v-for="(a, i) in areas"
        :key="a.specialarea_id"
        class="loot__tab"
        :class="{ on: i === activeIdx }"
        @click="activeIdx = i"
      >
        <div class="t">{{ a.title?.ordinary_title_main || a.name }}</div>
        <div class="time">{{ a.time.start_end_time }} - {{ a.time.start_end_time1 }}</div>
        <span class="badge" v-if="a.is_ordinary_order">进行中</span>
      </div>
    </div>

    <!-- 当前场次 -->
    <div v-if="current" class="loot__panel">
      <div class="loot__panel-bg">
        <img :src="current.images?.ordinary_images" v-if="current.images?.ordinary_images" />
        <div class="mask" />
        <div class="loot__panel-info">
          <div class="name">{{ current.title?.ordinary_title_main }}</div>
          <div class="countdown" v-if="current.is_ordinary_order">
            距结束 <b>{{ countdown }}</b>
          </div>
          <div class="countdown" v-else>
            {{ started ? '本场已结束' : '距开始 ' + toStart }}
          </div>
        </div>
      </div>

      <div class="loot__goods">
        <div v-if="current.goods_list?.length" class="loot__grid">
          <div
            v-for="g in current.goods_list"
            :key="g.goods_id"
            class="loot-card"
            @click="$router.push(`/goods/${g.goods_id}`)"
          >
            <div class="loot-card__img"><img :src="g.good_thumb" /></div>
            <div class="loot-card__name ellipsis">{{ g.goods_name }}</div>
            <div class="loot-card__row">
              <div class="price"><span class="sym">¥</span>{{ Number(g.goods_min_price).toFixed(0) }}</div>
              <div class="loot-card__btn" :class="{ done: !current.is_ordinary_order }">
                {{ current.is_ordinary_order ? '去抢购' : '未开始' }}
              </div>
            </div>
          </div>
        </div>
        <div v-else class="empty">本场次暂未上架商品</div>
      </div>
    </div>

    <div v-else-if="!loading" class="empty">暂无抢购场次</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';

const areas = ref([]);
const activeIdx = ref(0);
const loading = ref(true);
const nowSec = ref(Math.floor(Date.now() / 1000));
let timer;

const current = computed(() => areas.value[activeIdx.value]);
const started = computed(() => current.value && nowSec.value > current.value.time.end_time);

const fmt = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((x) => String(Math.max(0, x)).padStart(2, '0')).join(':');
};

const countdown = computed(() => fmt((current.value?.time.end_time || 0) - nowSec.value));
const toStart = computed(() => fmt((current.value?.time.start_time || 0) - nowSec.value));

onMounted(async () => {
  try {
    const r = await api.lootList();
    areas.value = r.data.list || [];
    const idx = areas.value.findIndex((a) => a.is_ordinary_order);
    activeIdx.value = idx >= 0 ? idx : 0;
  } finally {
    loading.value = false;
  }
  timer = setInterval(() => (nowSec.value = Math.floor(Date.now() / 1000)), 1000);
});

onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.loot { background: var(--bg); }

.loot__head {
  padding: 16px 16px 12px;
  background: #fff;
}
.loot__title { font-size: 20px; font-weight: 700; letter-spacing: 1px; }
.loot__sub { font-size: 12px; color: var(--text-3); margin-top: 3px; }

.loot__tabs {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  background: #fff;
  overflow-x: auto;
  scrollbar-width: none;
}
.loot__tabs::-webkit-scrollbar { display: none; }
.loot__tab {
  position: relative;
  flex: none;
  min-width: 104px;
  padding: 10px 12px;
  border-radius: 12px;
  background: #f6f7f9;
  border: 1px solid transparent;
  transition: all 0.18s;
}
.loot__tab.on {
  background: var(--brand-soft);
  border-color: rgba(var(--brand-rgb), 0.3);
}
.loot__tab .t { font-size: 13px; font-weight: 600; color: var(--text-2); }
.loot__tab.on .t { color: var(--brand); }
.loot__tab .time {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 3px;
  font-variant-numeric: tabular-nums;
}
.loot__tab .badge {
  position: absolute;
  top: -6px;
  right: -4px;
  font-size: 9px;
  color: #fff;
  background: var(--brand);
  padding: 1px 5px;
  border-radius: 6px;
  font-weight: 600;
}

.loot__panel { padding: 0 14px; }
.loot__panel-bg {
  position: relative;
  margin-top: 12px;
  width: 100%;
  aspect-ratio: 3 / 1;
  min-height: 112px;
  max-height: 144px;
  border-radius: 14px;
  overflow: hidden;
  background: linear-gradient(135deg, #8d1f2a, #3d0d13);
}
.loot__panel-bg img { width: 100%; height: 100%; object-fit: cover; }
.loot__panel-bg .mask {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.1));
}
.loot__panel-info {
  position: absolute;
  left: 16px;
  bottom: 16px;
  color: #fff;
}
.loot__panel-info .name { font-size: 17px; font-weight: 700; letter-spacing: 0.5px; }
.loot__panel-info .countdown { font-size: 12px; margin-top: 5px; opacity: 0.9; }
.loot__panel-info .countdown b {
  font-variant-numeric: tabular-nums;
  background: rgba(0, 0, 0, 0.35);
  padding: 1px 6px;
  border-radius: 5px;
  margin-left: 3px;
}

.loot__goods { margin-top: 14px; }
.loot__grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
.loot-card {
  background: #fff;
  border-radius: 12px;
  padding: 8px;
  box-shadow: var(--shadow);
}
.loot-card__img {
  aspect-ratio: 1;
  border-radius: 9px;
  overflow: hidden;
  background: #f6f7f9;
}
.loot-card__img img { width: 100%; height: 100%; object-fit: cover; }
.loot-card__name { font-size: 13px; margin: 8px 2px 0; color: #22252b; }
.loot-card__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 7px 2px 2px;
}
.loot-card__row .price { font-size: 16px; }
.loot-card__btn {
  font-size: 11px;
  color: #fff;
  background: var(--brand);
  padding: 4px 10px;
  border-radius: 11px;
  font-weight: 600;
}
.loot-card__btn.done { background: #d8dbe0; }
</style>
