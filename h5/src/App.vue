<template>
  <div class="app-root">
    <router-view v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
    <footer v-if="store.copyright || store.icp_number" class="site-footer">
      <span v-if="store.copyright">{{ store.copyright }}</span>
      <span v-if="store.icp_number">{{ store.icp_number }}</span>
    </footer>
    <TabBar v-if="showTab" />
    <InstallApp v-if="showTab" />
  </div>
</template>

<script setup>
import { computed, onMounted, provide, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import TabBar from './components/TabBar.vue';
import InstallApp from './components/InstallApp.vue';
import { api } from './api.js';

const route = useRoute();
const showTab = computed(() => !route.meta.hideTab);
const store = ref({});
provide('storeInfo', store);

// 主题：把后台选中的那套 CSS 变量写到 :root，页面刷新即生效
function applyTheme(info = {}) {
  const vars = info.theme && info.theme.vars;
  if (!vars) return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  // 顺带让手机浏览器状态栏跟着品牌色
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = vars['--brand'] || '#ff513a';
}

function applyBrand(info = {}) {
  if (info.name) document.title = info.name;
  const appTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (appTitle && info.name) appTitle.content = info.name;
  if (info.logo) {
    let icon = document.querySelector('link[rel~="icon"]');
    if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.appendChild(icon); }
    icon.href = info.logo;
  }
}

onMounted(async () => {
  try {
    const r = await api.storeInfo();
    store.value = r.data || {};
    applyTheme(store.value);
    applyBrand(store.value);
  } catch {}
});
watch(() => route.fullPath, () => applyBrand(store.value));
</script>

<style>
.app-root {
  width: 100%;
  max-width: var(--h5-width, 430px);
  min-height: 100vh;
  margin: 0 auto;
  position: relative;
  background: var(--bg);
  overflow-x: clip;
}
.site-footer { display:flex;flex-direction:column;align-items:center;gap:3px;padding:14px 16px calc(var(--tabbar-h, 54px) + 14px);color:#a5a8ae;font-size:10px;text-align:center;line-height:1.45; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.18s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
