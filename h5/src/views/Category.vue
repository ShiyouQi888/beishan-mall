<template>
  <div class="page page--tab cat">
    <header class="cat__header">
      <div class="cat__heading">商品分类</div>
      <div class="cat__search" @click="$router.push('/search')">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none"><circle cx="11" cy="11" r="6.5" stroke="#9aa0aa" stroke-width="1.8" /><path d="m16 16 4.5 4.5" stroke="#9aa0aa" stroke-width="1.8" stroke-linecap="round" /></svg>
        <span>搜索商品名称</span>
        <span class="cat__search-action">搜索</span>
      </div>
    </header>

    <div class="cat__body">
      <aside class="cat__side">
        <div
          v-for="c in categories"
          :key="c.category_id"
          class="cat__side-item"
          :class="{ on: c.category_id === active }"
          @click="pick(c.category_id)"
        >
          <span class="cat__side-icon" :class="`tone-${iconFor(c.name).tone}`">
            <CategoryIconDisplay :image="c.image" :name="c.name" size="19px" />
          </span>
          <span class="cat__side-label">{{ c.name }}</span>
        </div>
        <div v-if="!categories.length" class="cat__side-item on">
          <span class="cat__side-icon tone-gold" v-html="iconFor('全部').svg" />
          <span class="cat__side-label">全部商品</span>
        </div>
      </aside>

      <main class="cat__main">
        <div class="cat__intro" v-if="categories.length">
          <div>
            <div class="cat__eyebrow">CURATED COLLECTION</div>
            <div class="cat__title">{{ activeName }}</div>
            <div class="cat__subtitle">为你甄选品质好物</div>
          </div>
          <span class="cat__intro-icon" :class="`tone-${activeIcon.tone}`">
            <CategoryIconDisplay :image="activeCategory?.image" :name="activeName" size="25px" />
          </span>
        </div>
        <div class="cat__section-title" v-if="!loading && goods.length">
          <span>精选好物</span><span class="cat__count">{{ goods.length }} 件</span>
        </div>
        <div v-if="loading" class="empty">加载中…</div>
        <div v-else-if="goods.length" class="cat__grid">
          <div v-for="g in goods" :key="g.goods_id" class="cat__item" @click="$router.push(`/goods/${g.goods_id}`)">
            <div class="cat__img"><img :src="g.good_thumb" loading="lazy" /></div>
            <div class="cat__name ellipsis2">{{ g.goods_name }}</div>
            <div class="cat__foot"><div class="price cat__price"><span class="sym">¥</span>{{ Number(g.goods_min_price).toFixed(0) }}</div><span class="cat__tag">臻选</span></div>
          </div>
        </div>
        <div v-else class="empty">该分类暂无商品</div>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import CategoryIconDisplay from '../../../shared/CategoryIconDisplay.vue';

const categories = ref([]);
const active = ref(0);
const goods = ref([]);
const loading = ref(true);

const iconFor = (name = '') => {
  const n = String(name);
  let path = '<path d="M12 3.5 20 7v5c0 4.3-3.3 7.3-8 9-4.7-1.7-8-4.7-8-9V7l8-3.5Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>';
  let tone = 'gold';
  if (/翡|玉|宝石/.test(n)) { path = '<path d="m12 3 7.5 5-2 9L12 21l-5.5-4-2-9L12 3Z"/><path d="m4.5 8 7.5 5 7.5-5M12 13v8"/>'; tone = 'jade'; }
  else if (/首饰|珠宝|珍珠|饰品/.test(n)) { path = '<path d="M5 8.5a7 7 0 1 0 14 0 7 7 0 0 0-14 0Z"/><path d="M8 14.5 12 21l4-6.5M8 4.5 12 8l4-3.5"/>'; tone = 'rose'; }
  else if (/表|钟|数码|电器/.test(n)) { path = '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3.5 2M9 2.5h6M9 21.5h6"/>'; tone = 'blue'; }
  else if (/服|箱包|鞋|家居/.test(n)) { path = '<path d="M7 4h10l1.5 16h-13L7 4Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'; tone = 'lavender'; }
  else if (/全部|精选/.test(n)) { path = '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>'; }
  return { tone, svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>` };
};
const activeName = computed(() => categories.value.find(c => c.category_id === active.value)?.name || '精选商品');
const activeCategory = computed(() => categories.value.find(c => c.category_id === active.value));
const activeIcon = computed(() => iconFor(activeName.value));

async function pick(id) {
  active.value = id;
  loading.value = true;
  try {
    const r = await api.categoryGoods({ category_id: id, page: 1, limit: 30 });
    goods.value = r.data.data || [];
  } catch {
    goods.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  try {
    const r = await api.categories();
    categories.value = r.data.categoryList || [];
    if (categories.value.length) await pick(categories.value[0].category_id);
    else loading.value = false;
  } catch {
    loading.value = false;
  }
});
</script>

<style scoped>
.cat { background: #f6f7f9; display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
.cat__header { flex: none; padding: 8px 16px 14px; background: linear-gradient(180deg,#fff 72%,#fbfaf8); }
.cat__heading { font-size: 21px; font-weight: 750; letter-spacing: .5px; padding: 2px 0 11px; }
.cat__search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  margin: 0;
  border-radius: 12px;
  background: #f4f5f6;
  padding: 0 14px;
  color: #9aa0aa;
  font-size: 13px;
  flex: none;
}
.cat__search-action { margin-left: auto; padding-left: 10px; border-left: 1px solid #e5e6e8; color: var(--brand); font-weight: 600; }
.cat__body { flex: 1; min-height: 0; display: flex; overflow: hidden; }
.cat__side {
  width: 92px;
  background: #f1f2f4;
  overflow-y: auto;
  flex: none;
  padding: 10px 0 calc(var(--tabbar-h) + 16px);
}
.cat__side-item {
  min-height: 76px;
  padding: 10px 5px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
  position: relative;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
}
.cat__side-item.on {
  background: #fdfdfd;
  color: #312b25;
  font-weight: 650;
  border-radius: 0 13px 13px 0;
}
.cat__side-item.on::before {
  content: '';
  position: absolute;
  left: 0; top: 50%;
  transform: translateY(-50%);
  width: 3px; height: 22px;
  border-radius: 0 3px 3px 0;
  background: #b18a54;
}
.cat__side-icon { display:grid;place-items:center;width:34px;height:34px;border:1px solid rgba(92,74,48,.07);border-radius:10px;box-shadow:inset 0 1px 0 rgba(255,255,255,.42),0 1px 2px rgba(40,35,28,.035); }
.cat__side-icon svg { width: 20px; height: 20px; }
.cat__side-icon img { width:20px;height:20px;object-fit:contain; }
.cat__side-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cat__main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 13px 12px calc(var(--tabbar-h) + 18px);
}
.cat__intro { min-height: 91px; border-radius: 16px; padding: 14px; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; overflow: hidden; background: linear-gradient(120deg,#f2ece1,#e8ddca); position: relative; }
.cat__intro::after { content:''; position:absolute; width:145px;height:145px;border:1px solid rgba(150,116,68,.12);border-radius:50%;right:-34px;top:-65px;box-shadow:0 0 0 16px rgba(255,255,255,.13),0 0 0 34px rgba(255,255,255,.1); }
.cat__eyebrow { font-size: 8px; letter-spacing: 1.7px; color: #98794f; font-weight: 700; }
.cat__title { margin-top: 3px; font-size: 19px; font-weight: 750; color: #41372a; }
.cat__subtitle { font-size: 10px; color: #897b68; margin-top: 2px; }
.cat__intro-icon { z-index:1;width:48px;height:48px;border:1px solid rgba(92,74,48,.07);border-radius:14px;display:grid;place-items:center;background:rgba(255,255,255,.45);box-shadow:0 5px 14px rgba(72,56,35,.06); }
.cat__intro-icon svg { width:28px;height:28px; }
.cat__intro-icon img { width:30px;height:30px;object-fit:contain; }
.tone-gold { color:#a57b3e; background:#f1e5d0; }
.tone-jade { color:#568371; background:#dfede6; }
.tone-rose { color:#ad6c70; background:#f3e2e3; }
.tone-blue { color:#65819a; background:#e0eaf1; }
.tone-lavender { color:#82729b; background:#e9e3f1; }
.cat__section-title { display:flex;align-items:center;justify-content:space-between;margin:0 1px 9px;font-size:14px;font-weight:700;color:#393633; }
.cat__count { font-size:10px;color:#a5a09a;font-weight:450; }
.cat__grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
.cat__item { background:#fff; border-radius:13px; overflow:hidden; padding:6px 6px 9px; box-shadow:0 3px 12px rgba(45,38,28,.045); }
.cat__img {
  aspect-ratio: 1;
  border-radius: 9px;
  overflow: hidden;
  background: #f6f7f9;
}
.cat__img img { width: 100%; height: 100%; object-fit: cover; }
.cat__name { font-size: 12px; line-height: 1.45; margin: 8px 2px 0; min-height: 35px; color:#383530; }
.cat__foot { display:flex;align-items:center;justify-content:space-between;margin:5px 2px 0; }
.cat__price { font-size: 16px; }
.cat__tag { color:#a47b45;background:#f7f0e5;border-radius:5px;padding:2px 5px;font-size:9px; }
</style>
