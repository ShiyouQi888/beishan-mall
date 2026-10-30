<template>
  <div class="page search">
    <div class="search__bar">
      <div class="search__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="search__input">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none"><circle cx="11" cy="11" r="6.5" stroke="#9aa0aa" stroke-width="1.8" /><path d="m16 16 4.5 4.5" stroke="#9aa0aa" stroke-width="1.8" stroke-linecap="round" /></svg>
        <input v-model="kw" placeholder="搜索商品名称" autofocus @keyup.enter="doSearch" />
      </div>
      <div class="search__go" @click="doSearch">搜索</div>
    </div>

    <div class="section-pad" v-if="history.length && !searched">
      <div class="sec-title" style="padding: 16px 0 10px">
        <span>搜索历史</span>
        <span class="more" @click="clearHistory">清空</span>
      </div>
      <div class="tags">
        <span class="tagc" v-for="h in history" :key="h" @click="quick(h)">{{ h }}</span>
      </div>
    </div>

    <div class="section-pad search__result">
      <div v-if="loading" class="empty">搜索中…</div>
      <template v-else-if="list.length">
        <div class="sec-title" style="padding: 12px 0 10px"><span>找到 {{ total }} 件商品</span></div>
        <div class="slist">
          <div
            v-for="g in list"
            :key="g.goods_id"
            class="sitem"
            :class="{ 'sitem--out': isGreyState(cardState(g)) }"
            @click="$router.push(`/goods/${g.goods_id}`)"
          >
            <div class="sitem__img">
              <img :src="g.good_thumb" />
              <span v-if="cardLabel(cardState(g))" class="sitem__flag">{{ cardLabel(cardState(g)) }}</span>
            </div>
            <div class="sitem__info">
              <div class="sitem__name ellipsis2">{{ g.goods_name }}</div>
              <div class="muted" style="margin-top: 4px">{{ g.goods_no }}</div>
              <div class="sitem__row">
                <div class="price"><span class="sym">¥</span>{{ Number(g.goods_min_price).toFixed(2) }}</div>
                <div class="muted">{{ cardLabel(cardState(g)) || `${g.sales_actual || 0}人付款` }}</div>
              </div>
            </div>
          </div>
        </div>
      </template>
      <div v-else-if="searched" class="empty">没有找到相关商品</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { showToast } from '../utils/feedback.js';
import { api } from '../api.js';
import { cardState, cardLabel, isGreyState } from '../utils/goodsState.js';

const kw = ref('');
const list = ref([]);
const total = ref(0);
const loading = ref(false);
const searched = ref(false);
const history = ref(JSON.parse(localStorage.getItem('SEARCH_HISTORY') || '[]'));

async function doSearch() {
  const k = kw.value.trim();
  if (!k) return showToast('请输入搜索内容');
  loading.value = true;
  searched.value = true;
  try {
    const r = await api.searchShop({ keywords: k, page: 1, limit: 30 });
    list.value = r.data.data || [];
    total.value = r.data.total || 0;
    const h = [k, ...history.value.filter((x) => x !== k)].slice(0, 10);
    history.value = h;
    localStorage.setItem('SEARCH_HISTORY', JSON.stringify(h));
  } catch {
    list.value = [];
  } finally {
    loading.value = false;
  }
}

function quick(v) {
  kw.value = v;
  doSearch();
}

function clearHistory() {
  history.value = [];
  localStorage.removeItem('SEARCH_HISTORY');
}

onMounted(() => {});
</script>

<style scoped>
.search { background: var(--bg); }
.search__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  background: #fff;
  position: sticky;
  top: 0;
  z-index: 30;
}
.search__back { color: var(--text-1); padding: 2px; }
.search__input {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  border-radius: 18px;
  background: #f4f5f7;
  padding: 0 13px;
}
.search__input input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13.5px;
  font-family: var(--font);
}
.search__go { font-size: 13.5px; color: var(--brand); font-weight: 600; padding: 0 2px; }

.tags { display: flex; flex-wrap: wrap; gap: 9px; }
.tagc {
  font-size: 12.5px;
  color: var(--text-2);
  background: #fff;
  padding: 6px 13px;
  border-radius: 15px;
  box-shadow: var(--shadow);
}

.search__result { padding-top: 4px; }
.slist { display: flex; flex-direction: column; gap: 10px; }
.sitem {
  display: flex;
  gap: 12px;
  background: #fff;
  border-radius: 13px;
  padding: 11px;
  box-shadow: var(--shadow);
}
.sitem__img {
  position: relative;
  width: 86px; height: 86px;
  border-radius: 10px;
  overflow: hidden;
  background: #f6f7f9;
  flex: none;
}
.sitem__img img { width: 100%; height: 100%; object-fit: cover; }
/* 搜索结果同样要看得出来已经买不了，否则用户搜到一件、点进去才发现抢完 */
.sitem--out .sitem__img img { filter: grayscale(1); opacity: 0.42; }
.sitem--out .sitem__name { color: #a8adb7; }
.sitem--out .sitem__row .price { color: #a8adb7; }
.sitem__flag {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 2px 8px;
  border-radius: 9px;
  background: rgba(38, 41, 47, 0.72);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}
.sitem__info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.sitem__name { font-size: 13.5px; font-weight: 500; line-height: 1.45; }
.sitem__row { display: flex; align-items: flex-end; justify-content: space-between; margin-top: auto; }
.sitem__row .price { font-size: 16px; }
</style>
