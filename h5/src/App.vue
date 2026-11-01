<template>
  <div class="app-root" :class="{ 'app-root--tab': showTab }">
    <router-view v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
    <!-- 页面底部：版权 / 备案 / 版号。版号来自 package.json，构建时注入（见 vite.config.js） -->
    <footer class="site-footer">
      <span v-if="store.copyright">{{ store.copyright }}</span>
      <span v-if="store.icp_number">{{ store.icp_number }}</span>
      <span class="site-footer__ver" :title="`前端版本 ${appVersionFull}`">{{ appVersion }}</span>
    </footer>
    <TabBar v-if="showTab" />
    <InstallApp v-if="route.meta.tab" />
  </div>
</template>

<script setup>
import { computed, onMounted, provide, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import TabBar from './components/TabBar.vue';
import InstallApp from './components/InstallApp.vue';
import { api } from './api.js';

const route = useRoute();
// 构建时由 vite define 注入：__APP_VERSION__ = "V2.0"，__APP_VERSION_FULL__ = "2.0.0"
const appVersion = __APP_VERSION__;
const appVersionFull = __APP_VERSION_FULL__;
const showTab = computed(() => {
  const hide = route.meta.hideTab;
  return !(typeof hide === 'function' ? hide(route) : hide);
});
// 服务端注入的首屏数据（店名/logo/版权/主题/导航开关），见 server/src/app.js 的 renderH5Index。
// 有它就能第一帧就渲染成正式名称与配色，不会先闪一下默认店名再跳变；接口回来后再补全。
const boot = (typeof window !== 'undefined' && window.__BOOT__) || {};
const store = ref({
  name: boot.name || '',
  logo: boot.logo || '',
  copyright: boot.copyright || '',
  icp_number: boot.icp_number || '',
  theme: boot.theme || null,
});
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

// 同步应用一次注入值：storeInfo 接口通常要几十到几百毫秒，
// 等它回来才设标题的话，用户会先看到一个默认标题
if (boot.name || boot.theme) {
  applyTheme(store.value);
  applyBrand(store.value);
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
.app-root--tab .page { padding-bottom: calc(var(--tabbar-h, 54px) + 16px); }
.site-footer { display:flex;flex-direction:column;align-items:center;gap:3px;padding:14px 16px calc(var(--tabbar-h, 54px) + 14px);color:#a5a8ae;font-size:10px;text-align:center;line-height:1.45; }
.site-footer__ver { font-size: 10px; letter-spacing: .3px; color: #b9bcc2; font-variant-numeric: tabular-nums; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.18s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
