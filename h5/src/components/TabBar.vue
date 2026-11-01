<template>
    <nav v-if="tabs.length" class="tabbar" aria-label="主导航">
    <div
      v-for="t in tabs"
      :key="t.path"
      class="tabbar__item"
      :class="{ on: isOn(t) }"
        role="button"
        tabindex="0"
        @keydown.enter.prevent="go(t)"
        @keydown.space.prevent="go(t)"
      @click="go(t)"
    >
      <span v-html="t.icon(isOn(t))" />
      <span>{{ t.label }}</span>
    </div>
  </nav>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';

const route = useRoute();
const router = useRouter();

const c = (on) => (on ? 'var(--brand)' : '#9aa0aa');

// 服务端会把导航开关预注入到入口 HTML（window.__BOOT__.nav）。
// 用它当初始值，首屏第一次渲染就是后台真实配置 —— 不会再出现「先 5 个菜单、后跳成 3 个」。
// 接口返回后仍然会再覆盖一次，保证管理后台改完刷新即可生效。
const boot = (typeof window !== 'undefined' && window.__BOOT__) || {};
const config = ref({
  index_open: '10', category_open: '10', loot_open: '10', invite_open: '10', member_open: '10',
  ...(boot.nav || {}),
});
const definitions = [
  {
    path: '/',
    label: '首页',
    setting: 'index_open',
    icon: (on) =>
      `<svg viewBox="0 0 24 24" fill="none"><path d="M3.5 10.5 12 3.5l8.5 7v9a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-4v6H5a1.5 1.5 0 0 1-1.5-1.5v-9Z" fill="${on ? c(on) : 'none'}" stroke="${c(on)}" stroke-width="1.7" stroke-linejoin="round"/></svg>`,
  },
  {
    path: '/category',
    label: '分类',
    setting: 'category_open',
    icon: (on) =>
      `<svg viewBox="0 0 24 24" fill="none"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="${c(on)}" stroke-width="1.7"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" stroke="${c(on)}" stroke-width="1.7"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" stroke="${c(on)}" stroke-width="1.7"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" stroke="${c(on)}" stroke-width="1.7"/></svg>`,
  },
  {
    path: '/loot',
    label: '抢购',
    setting: 'loot_open',
    icon: (on) =>
      `<svg viewBox="0 0 24 24" fill="none"><path d="M13 2 4.5 13.5H11l-1 8.5 9-12h-6.5L13 2Z" fill="${on ? c(on) : 'none'}" stroke="${c(on)}" stroke-width="1.7" stroke-linejoin="round"/></svg>`,
  },
  {
    path: '/invite',
    label: '邀请好友',
    setting: 'invite_open',
    icon: (on) =>
      `<svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.2" stroke="${c(on)}" stroke-width="1.7"/><path d="M3.5 20c0-3.2 2.5-5.5 5.5-5.5s5.5 2.3 5.5 5.5" stroke="${c(on)}" stroke-width="1.7" stroke-linecap="round"/><path d="M17 5v6M14 8h6" stroke="${c(on)}" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  },
  {
    path: '/mine',
    label: '我的',
    setting: 'member_open',
    icon: (on) =>
      `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.6" fill="${on ? c(on) : 'none'}" stroke="${c(on)}" stroke-width="1.7"/><path d="M4.5 20.5c.6-3.6 3.7-6 7.5-6s6.9 2.4 7.5 6" fill="${on ? c(on) : 'none'}" stroke="${c(on)}" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  },
];

const enabled = (value) => value === undefined || value === null || value === '' || Number(value) === 10;
const tabs = computed(() => definitions.filter((tab) => enabled(config.value[tab.setting])));

const minePaths = [
  '/mine', '/my-shop', '/order', '/team', '/commission', '/wallet',
  '/address', '/identify', '/score', '/setting', '/notice',
];
const isOn = (t) => {
  if (t.path === '/mine') return minePaths.some((path) => route.path === path || route.path.startsWith(`${path}/`));
  if (t.path === '/category' && route.path === '/search') return true;
  return t.path === '/' ? route.path === '/' : route.path.startsWith(t.path);
};

function go(t) {
  if (route.path !== t.path) router.push(t.path);
}

onMounted(async () => {
  try {
    const result = await api.openNav();
    config.value = { ...config.value, ...(result.data || {}) };
  } catch {}
});
</script>
