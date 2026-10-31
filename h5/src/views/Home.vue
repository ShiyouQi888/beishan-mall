<template>
  <div class="page page--tab home">
    <!-- 搜索栏 -->
    <div class="home__searchbar">
      <div class="home__search" @click="$router.push('/search')">
        <svg viewBox="0 0 24 24" fill="none" width="18" height="18">
          <circle cx="11" cy="11" r="6.5" stroke="#9aa0aa" stroke-width="1.8" />
          <path d="m16 16 4.5 4.5" stroke="#9aa0aa" stroke-width="1.8" stroke-linecap="round" />
        </svg>
        <span>请输入您当前要搜索的产品</span>
      </div>
    </div>

    <!-- 轮播 -->
    <!-- 轮播图：后台配了才显示。没配就空着，不再拿一张假横幅顶替 ——
         那张占位图会和运营自己传的图混在一起，看起来像「换了也换不掉」 -->
    <div class="home__banner" v-if="banners.length">
      <van-swipe :autoplay="4000" indicator-color="#fff" lazy-render>
        <van-swipe-item v-for="b in banners" :key="b.banner_id">
          <img :src="b.file_path" class="home__banner-img" />
        </van-swipe-item>
      </van-swipe>
    </div>

    <!-- 服务承诺 -->
    <div class="home__promise" v-if="promiseText.length">
      <div class="home__promise-item" v-for="(p, i) in promiseText" :key="i">
        <span class="home__promise-icon" :class="`promise-tone-${promiseIcon(p).tone}`" v-html="promiseIcon(p).svg" />
        <span class="home__promise-copy">{{ p }}</span>
      </div>
    </div>

    <!-- 分类 tab：后台可整体关闭，或把分类都设为「首页隐藏」；没有分类时不显示这条 -->
    <div class="home__tabs" v-if="categoryOpen && categories.length">
      <div class="home__tabs-inner">
        <div
          v-for="c in categories"
          :key="c.category_id"
          class="home__tab"
          :class="{ on: c.category_id === activeCat }"
          @click="switchCat(c.category_id)"
        >
          <span class="home__tab-icon" :class="`tone-${iconFor(c.name).tone}`">
            <CategoryIconDisplay :image="c.image" :name="c.name" size="17px" />
          </span>
          <span>{{ c.name }}</span>
        </div>
      </div>
    </div>

    <!-- 商品瀑布流 -->
    <div class="home__goods section-pad">
      <div v-if="loading" class="goods-grid">
        <div v-for="i in 4" :key="i" class="goods-card skeleton">
          <div class="sk-img" /><div class="sk-line" /><div class="sk-line short" />
        </div>
      </div>
      <div v-else-if="goods.length" class="goods-grid">
        <div
          v-for="g in goods"
          :key="g.goods_id"
          class="goods-card"
          :class="{ 'goods-card--out': isGreyState(cardState(g)) }"
          @click="$router.push(`/goods/${g.goods_id}`)"
        >
          <div class="goods-card__img">
            <img :src="g.good_thumb" loading="lazy" />
            <!-- 抢完的货留在场里当灰卡片，不要凭空消失；下一场开始自动被新货替换 -->
            <span v-if="cardLabel(cardState(g))" class="goods-card__flag">{{ cardLabel(cardState(g)) }}</span>
          </div>
          <div class="goods-card__body">
            <div class="goods-card__name ellipsis2">{{ g.goods_name }}</div>
            <div class="goods-card__foot">
              <div class="price">
                <span class="sym">¥</span>{{ intPart(g.goods_min_price) }}<span class="dec">.{{ decPart(g.goods_min_price) }}</span>
              </div>
              <div class="goods-card__sales" v-if="cardLabel(cardState(g))">{{ cardLabel(cardState(g)) }}</div>
              <div class="goods-card__sales" v-else>{{ g.sales_actual || 0 }}人付款</div>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty">暂无商品</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { api } from '../api.js';
import { cardState, cardLabel, isGreyState } from '../utils/goodsState.js';
import CategoryIconDisplay from '../../../shared/CategoryIconDisplay.vue';

const banners = ref([]);
const navs = ref([]);
const areas = ref([]);
const categories = ref([]);
const openNav = ref({});
const goods = ref([]);
const activeCat = ref(0);
const loading = ref(true);
// 首页分类栏总开关：后台关掉后整条都不渲染，商品列表照常展示
const categoryOpen = computed(() => String(openNav.value?.home_category_open ?? '10') !== '20');

// 场次开/关指纹：用来发现「这一场结束了／下一场开始了」，到点静默换货
// 用服务端时间 new_time 校准客户端时钟：本机慢几分钟就让「现在」也跟着慢，倒计时才准
const clockSkew = ref(0);
const nowSec = ref(Math.floor(Date.now() / 1000));
let timer;
let lastSig = '';
let lastPoll = 0;
const openSig = computed(() =>
  areas.value.map((a) => (nowSec.value >= a.time.start_time && nowSec.value <= a.time.end_time ? 1 : 0)).join(''),
);

const promiseText = computed(() => {
  const t = areas.value?.[0]?.title?.ordinary_title || '';
  return t.split(/[,，|｜]/).map((s) => s.replace(/[✔✓☑️✅🔒🚚⭐️✨]/gu, '').trim()).filter(Boolean);
});

const promiseIcon = (text = '') => {
  const value = String(text);
  if (/包邮|配送|顺丰|物流/.test(value)) return { tone: 'jade', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h11v10H3zM14 10h4l3 3v4h-7z"/><circle cx="7.5" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/></svg>' };
  if (/赔|正品|保障|假一/.test(value)) return { tone: 'rose', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4.5 6v6c0 4.4 3.2 8 7.5 9 4.3-1 7.5-4.6 7.5-9V6L12 3Z"/><path d="m8.8 12 2.2 2.2 4.2-4.4"/></svg>' };
  return { tone: 'gold', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/></svg>' };
};

const intPart = (v) => String(Number(v).toFixed(2)).split('.')[0];
const decPart = (v) => String(Number(v).toFixed(2)).split('.')[1];
const iconFor = (name = '') => {
  const n = String(name);
  let path = '<path d="M12 3.5 20 7v5c0 4.3-3.3 7.3-8 9-4.7-1.7-8-4.7-8-9V7l8-3.5Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>';
  let tone = 'gold';
  if (/翡|玉|宝石/.test(n)) { path = '<path d="m12 3 7.5 5-2 9L12 21l-5.5-4-2-9L12 3Z"/><path d="m4.5 8 7.5 5 7.5-5M12 13v8"/>'; tone = 'jade'; }
  else if (/首饰|珠宝|珍珠|饰品/.test(n)) { path = '<path d="M5 8.5a7 7 0 1 0 14 0 7 7 0 0 0-14 0Z"/><path d="M8 14.5 12 21l4-6.5M8 4.5 12 8l4-3.5"/>'; tone = 'rose'; }
  else if (/表|钟|数码|电器/.test(n)) { path = '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3.5 2M9 2.5h6M9 21.5h6"/>'; tone = 'blue'; }
  else if (/服|箱包|鞋|家居/.test(n)) { path = '<path d="M7 4h10l1.5 16h-13L7 4Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'; tone = 'lavender'; }
  return { tone, svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>` };
};

// 没有再点一次取消：点已选中的分类回到「全部商品」
function switchCat(id) {
  activeCat.value = activeCat.value === id ? 0 : id;
}

async function loadGoods() {
  loading.value = true;
  try {
    // 0 = 全部：不按分类过滤，展示所有在售抢购商品
    if (!activeCat.value) {
      const r = await api.lootGoods({ page: 1, limit: 20 });
      goods.value = r.data.data || [];
    } else {
      const r = await api.categoryGoods({ page: 1, limit: 20, category_id: activeCat.value });
      goods.value = r.data.data || [];
    }
  } catch {
    goods.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  // 商城信息由 App.vue 统一拉取并 provide，这里不再重复请求
  const [b, n, l, c, o] = await Promise.allSettled([
    api.banner(1), api.navs(), api.lootList(), api.categories({ home: 1 }), api.openNav(),
  ]);
  if (b.status === 'fulfilled') banners.value = b.value.data || [];
  if (n.status === 'fulfilled') navs.value = n.value.data || [];
  if (l.status === 'fulfilled') areas.value = l.value.data?.list || [];
  const clockRef = areas.value.find((a) => Number(a.time?.new_time) > 0);
  if (clockRef) clockSkew.value = Number(clockRef.time.new_time) - Math.floor(Date.now() / 1000);
  nowSec.value = Math.floor(Date.now() / 1000) + clockSkew.value;
  if (c.status === 'fulfilled') categories.value = c.value.data?.categoryList || [];
  if (o.status === 'fulfilled') openNav.value = o.value.data || {};
  await loadGoods();
  lastSig = openSig.value;
  lastPoll = Date.now();
  timer = setInterval(() => {
    nowSec.value = Math.floor(Date.now() / 1000) + clockSkew.value;
    const sig = openSig.value;
    // 某一场开始或结束时指纹会变：这时候后台换了一批货，首页要跟着换，不能停在上场的灰卡片上
    if (lastSig && sig !== lastSig) {
      lastSig = sig;
      refreshBySession();
      return;
    }
    // 兜底：跨天后场次时间戳还是昨天算的，指纹不会变，靠低频重拉把日期与商品一起换过来
    if (Date.now() - lastPoll > 300000) {
      lastPoll = Date.now();
      refreshBySession();
    }
  }, 1000);
});

onUnmounted(() => clearInterval(timer));

// 场次切换时静默换货（不置 loading，避免整页闪骨架屏）
async function refreshBySession() {
  try {
    const r = await api.lootList();
    areas.value = r.data.list || [];
    await loadGoods();
  } catch {
    /* 网络抖动就等下一次场次边界，不打断浏览 */
  }
}

watch(activeCat, () => loadGoods());
</script>

<style scoped>
.home { background: var(--bg); }

.home__searchbar {
  position: sticky;
  top: 0;
  z-index: 40;
  padding: 10px 14px;
  background: #fff;
}
.home__search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  border-radius: 19px;
  background: #f4f5f7;
  padding: 0 14px;
  color: #9aa0aa;
  font-size: 13px;
}

.home__banner { padding: 0 14px; }
.home__banner-img {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: 12px;
}
.home__banner--ph {
  height: 170px;
  margin: 0 14px;
  border-radius: 12px;
  background: linear-gradient(135deg, #8d1f2a, #3d0d13);
  display: flex;
  align-items: center;
  justify-content: center;
}
.home__banner-text { text-align: center; color: #f4e2c8; }
.home__brand-logo { width:42px;height:42px;object-fit:contain;margin:0 auto 8px;border-radius:12px;background:rgba(255,255,255,.14);padding:3px; }
.home__banner-text .t1 { font-size: 24px; font-weight: 700; letter-spacing: 4px; }
.home__banner-text .t2 { font-size: 12px; letter-spacing: 3px; margin-top: 6px; opacity: 0.8; }

.home__promise {
  display: flex;
  align-items: stretch;
  margin: 10px 14px 2px;
  padding: 8px 2px;
  background: #fff;
  border: 1px solid #f1eee8;
  border-radius: 13px;
  box-shadow: 0 3px 12px rgba(46, 38, 27, .035);
}
.home__promise-item {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 2px 4px;
  color: #59544d;
  font-size: 11px;
  font-weight: 550;
  line-height: 1.25;
}
.home__promise-item + .home__promise-item { border-left: 1px solid #f0ede8; }
.home__promise-icon { display: grid; place-items: center; flex: none; width: 25px; height: 25px; border-radius: 8px; }
.home__promise-icon svg { width: 15px; height: 15px; }
.promise-tone-gold { color: #a77d43; background: #f7f0e4; }
.promise-tone-jade { color: #5d8877; background: #eaf2ed; }
.promise-tone-rose { color: #ad7374; background: #f7ebeb; }
.home__promise-copy { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 360px) {
  .home__promise-item { gap: 4px; font-size: 10px; padding: 2px; }
  .home__promise-icon { width: 22px; height: 22px; border-radius: 7px; }
}

.home__tabs {
  margin-top: 6px;
  background: #fff;
  border-bottom: 1px solid #f2f3f5;
  overflow-x: auto;
  scrollbar-width: none;
}
.home__tabs::-webkit-scrollbar { display: none; }
.home__tabs-inner {
  display: flex;
  gap: 12px;
  padding: 9px 14px 10px;
  min-width: max-content;
}
.home__tab {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px 6px 7px;
  border-radius: 15px;
  background: #f6f6f4;
  font-size: 12px;
  color: #6b7280;
  font-weight: 450;
  white-space: nowrap;
}
.home__tab.on {
  color: #8b6735;
  font-weight: 700;
  background: #f3eadb;
}
.home__tab-icon { width:28px;height:28px;flex:none;overflow:hidden;border:1px solid rgba(92,74,48,.08);border-radius:9px;display:grid;place-items:center;box-shadow:inset 0 1px 0 rgba(255,255,255,.42),0 1px 2px rgba(40,35,28,.04); }
.home__tab-icon svg { width:17px;height:17px; }
.home__tab-icon img { width:100%;height:100%;object-fit:cover;border-radius:inherit; }
.tone-gold { color:#a57b3e; background:#f1e5d0; }
.tone-brand { color: var(--brand); background: #fff2f0; }
.tone-jade { color:#568371; background:#dfede6; }
.tone-rose { color:#ad6c70; background:#f3e2e3; }
.tone-blue { color:#65819a; background:#e0eaf1; }
.tone-lavender { color:#82729b; background:#e9e3f1; }

.home__goods { padding-top: 12px; }
.goods-grid {
  display: grid;
  /* minmax(0, 1fr)：允许列被内容压窄。写 1fr 时最小宽度取内容的 min-content，
     商品名一长（nowrap 的 ellipsis）就会把整列撑宽，卡片直接溢出屏幕 */
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.goods-card {
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--shadow);
}
.goods-card__img {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  background: #f6f7f9;
  overflow: hidden;
}
.goods-card__img img { width: 100%; height: 100%; object-fit: cover; }
/* 已抢完：图片去饱和压暗，名字与价格一起褪色，卡片仍留在原位 */
.goods-card--out .goods-card__img img { filter: grayscale(1); opacity: 0.42; }
.goods-card--out .goods-card__name { color: #a8adb7; }
.goods-card--out .goods-card__foot .price { color: #a8adb7; }
.goods-card__flag {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 4px 12px;
  border-radius: 12px;
  background: rgba(38, 41, 47, 0.72);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 1px;
  white-space: nowrap;
}
.goods-card__body { padding: 9px 10px 11px; }
.goods-card__name {
  font-size: 13px;
  line-height: 1.4;
  min-height: 36px;
  color: #22252b;
  font-weight: 450;
}
.goods-card__foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-top: 6px;
}
.goods-card__foot .price { font-size: 18px; }
.goods-card__sales { font-size: 11px; color: #a8adb7; }

/* 骨架 */
.skeleton { animation: pulse 1.4s ease-in-out infinite; }
.sk-img { aspect-ratio: 1; background: #f1f2f4; border-radius: 10px; }
.sk-line { height: 12px; background: #f1f2f4; border-radius: 6px; margin-top: 8px; }
.sk-line.short { width: 55%; }
@keyframes pulse { 50% { opacity: 0.55; } }
</style>
