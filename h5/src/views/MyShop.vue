<template>
  <div class="page shop">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">我的店铺</div>
    </div>

    <div class="section-pad" style="padding-top: 12px">
      <!-- 汇总 -->
      <div class="sum">
        <div class="sum__row">
          <div class="sum__item">
            <div class="sum__v">{{ summary.count }}</div>
            <div class="sum__k">在售商品</div>
          </div>
          <div class="sum__item">
            <div class="sum__v">{{ summary.listed_count }}</div>
            <div class="sum__k">已挂牌等抢</div>
          </div>
          <div class="sum__item">
            <div class="sum__v brand">{{ money(summary.total_net) }}</div>
            <div class="sum__k">预计收益</div>
          </div>
        </div>
        <div class="sum__tip">
          预计收益 = 下一轮标价 − 我的买入价 − 上架费（涨价率 {{ summary.increase_rate }}%）。
          商品被下一轮买走后会从这里消失，收益随即到账。
        </div>
      </div>

      <!-- 列表 -->
      <div class="card item" v-for="g in list" :key="g.goods_id">
        <div class="item__head">
          <img :src="g.good_thumb" class="item__img" />
          <div class="item__info">
            <div class="item__name ellipsis2">{{ g.goods_name }}</div>
            <div class="item__tags">
              <span class="tag" :class="g.listed ? 'tag--on' : 'tag--off'">
                {{ g.listed ? '已挂牌 · 等下一轮被抢' : '待转拍上架' }}
              </span>
              <span class="tag tag--ghost" v-if="g.turn_beat_num">已流转 {{ g.turn_beat_num }} 次</span>
            </div>
          </div>
        </div>

        <div class="item__rows">
          <div class="kv"><span>我的买入价</span><span>{{ Number(g.my_price) > 0 ? money(g.my_price) : '—' }}</span></div>
          <div class="kv"><span>下一轮标价</span><span class="brand">{{ money(g.next_price) }}</span></div>
          <div class="kv"><span>上架费</span><span>-{{ money(g.listing_fee) }}</span></div>
          <div class="kv kv--sum">
            <span>{{ g.listed ? '成交后可收回' : '转拍后预计收益' }}</span>
            <span class="brand strong">
              {{ g.est_net === null ? '—' : money(g.listed ? g.next_price : g.est_net) }}
            </span>
          </div>
          <div class="kv kv--net" v-if="g.est_net !== null">
            <span>扣除买入价与上架费后净赚</span>
            <span :class="Number(g.est_net) >= 0 ? 'brand' : 'loss'">
              {{ Number(g.est_net) >= 0 ? '+' : '' }}{{ money(g.est_net) }}
            </span>
          </div>
        </div>

        <div class="item__actions">
          <button v-if="!g.listed" class="mini mini--main" @click="$router.push('/order')">去转拍</button>
          <span v-else class="item__wait">等着被抢走即可，无需操作</span>
        </div>
      </div>

      <div v-if="!loading && !list.length" class="empty">
        还没有在售商品<br />
        <span class="empty__sub">在抢购区抢到商品后，这里就是你的店铺</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { api } from '../api.js';

const list = ref([]);
const loading = ref(true);
const summary = reactive({
  count: 0, listed_count: 0, unlisted_count: 0, total_net: 0, increase_rate: 0,
});

const money = (n) => `¥${Number(n || 0).toFixed(2)}`;

async function load() {
  loading.value = true;
  try {
    const r = await api.myShop();
    list.value = r.data?.list || [];
    Object.assign(summary, r.data?.summary || {});
  } catch {
    list.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.shop { background: var(--bg); min-height: 100vh; }

.sum {
  background: linear-gradient(135deg, #fff 0%, var(--brand-soft) 100%);
  border: 1px solid #ffe6e0; border-radius: 14px; padding: 16px 14px 13px;
  margin-bottom: 12px;
}
.sum__row { display: flex; }
.sum__item { flex: 1; text-align: center; }
.sum__item + .sum__item { border-left: 1px solid #ffeae5; }
.sum__v { font-size: 19px; font-weight: 700; color: var(--text-1); font-variant-numeric: tabular-nums; }
.sum__v.brand { color: var(--brand); }
.sum__k { font-size: 11px; color: var(--text-3); margin-top: 3px; }
.sum__tip { margin-top: 11px; font-size: 11px; color: var(--text-3); line-height: 1.6; }

.item { padding: 13px 14px; margin-bottom: 10px; }
.item__head { display: flex; gap: 11px; }
.item__img { width: 62px; height: 62px; border-radius: 9px; object-fit: cover; background: #f6f7f9; flex: none; }
.item__info { flex: 1; min-width: 0; }
.item__name { font-size: 14px; font-weight: 550; line-height: 1.35; }
.item__tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.tag { font-size: 10.5px; padding: 2px 7px; border-radius: 20px; }
.tag--on { background: #eaf7ef; color: #1a9c56; }
.tag--off { background: #fff4e8; color: #c47a16; }
.tag--ghost { background: #f4f6f9; color: var(--text-3); }

.item__rows { margin-top: 11px; padding-top: 10px; border-top: 1px dashed #eef0f3; }
.kv { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--text-2); }
.kv + .kv { margin-top: 6px; }
.kv span:last-child { font-variant-numeric: tabular-nums; }
.kv .brand { color: var(--brand); }
.kv .loss { color: #d4380d; }
.kv--sum { padding-top: 6px; border-top: 1px dashed #eef0f3; }
.kv--sum .strong { font-size: 15px; font-weight: 600; }
.kv--net { color: var(--text-3); font-size: 11.5px; }

.item__actions { margin-top: 11px; display: flex; align-items: center; }
.mini {
  height: 30px; padding: 0 16px; border-radius: 16px; border: 1px solid var(--line);
  background: #fff; font-size: 12.5px; color: var(--text-2); font-family: var(--font);
}
.mini--main { background: var(--brand); border-color: var(--brand); color: #fff; font-weight: 500; }
.item__wait { font-size: 11.5px; color: var(--text-3); }

.empty { padding: 64px 20px; text-align: center; font-size: 13px; color: var(--text-2); line-height: 1.8; }
.empty__sub { font-size: 11.5px; color: var(--text-3); }
</style>
