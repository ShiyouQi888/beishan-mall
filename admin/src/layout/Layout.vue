<template>
  <div class="layout">
    <aside class="sidebar" :class="{ collapsed }">
      <div class="brand">
        <div class="brand__logo">
          <img v-if="store.logo" :src="store.logo" alt="商城 Logo" />
          <svg v-else viewBox="0 0 32 32" width="26" height="26">
            <path d="M9 13h14l-1.2 11.4a1.6 1.6 0 0 1-1.6 1.4h-8.4a1.6 1.6 0 0 1-1.6-1.4L9 13Z" stroke="#fff" stroke-width="1.8" stroke-linejoin="round" fill="none" />
            <path d="M12.2 13a3.8 3.8 0 0 1 7.6 0" stroke="#fff" stroke-width="1.8" stroke-linecap="round" fill="none" />
          </svg>
        </div>
        <div class="brand__text" v-show="!collapsed">
          <div class="t">{{ store.name || '锦云商城' }}</div>
          <div class="s">管理后台</div>
        </div>
      </div>

      <nav class="menu">
        <template v-for="g in menus" :key="g.label">
          <div class="menu__group" v-show="!collapsed">{{ g.label }}</div>
          <router-link
            v-for="m in g.items"
            :key="m.path"
            :to="m.path"
            class="menu__item"
            :class="{ on: isActive(m.path) }"
            :title="m.title"
          >
            <span class="menu__icon" v-html="menuIcon(m.icon)" />
            <span class="menu__label" v-show="!collapsed">{{ m.title }}</span>
          </router-link>
        </template>
      </nav>
    </aside>

    <div class="main">
      <header class="topbar">
        <button class="collapse-btn" @click="collapsed = !collapsed">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
        <div class="crumb">
          <span class="crumb__root">首页</span>
          <span class="crumb__sep">/</span>
          <span class="crumb__cur">{{ route.meta.title || '' }}</span>
        </div>
        <div class="topbar__right">
          <a class="visit" href="http://127.0.0.1:5273" target="_blank">访问商城</a>
          <div class="user">
            <div class="avatar">{{ (user.nick || 'A').slice(0, 1) }}</div>
            <span class="uname">{{ user.nick || user.name }}</span>
          </div>
          <button class="logout" @click="logout">退出</button>
        </div>
      </header>

      <main class="content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
        <footer class="site-footer" v-if="store.copyright || store.icp_number">
          <span v-if="store.copyright">{{ store.copyright }}</span>
          <span v-if="store.icp_number">{{ store.icp_number }}</span>
        </footer>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { adminApi } from '../api.js';
import http from '../api.js';

const route = useRoute();
const router = useRouter();
const collapsed = ref(false);
const user = ref({});
const store = ref({});

// 菜单由后端 /admin/api/menu 下发（单一数据源：server/src/lib/menu.config.js）
const menus = ref([]);

const isActive = (p) => (p === '/' ? route.path === '/' : route.path === p);
const menuIcon = (icon = '') => {
  const paths = String(icon).replace(/<\/?svg\b[^>]*>/gi, '');
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
};


function logout() {
  localStorage.removeItem('ADMIN_TOKEN');
  router.push('/login');
}

async function loadStoreInfo() {
  try {
    store.value = await adminApi.storeInfo();
    if (store.value.name) document.title = `${store.value.name} · 管理后台`;
  } catch {}
}

onMounted(async () => {
  loadStoreInfo();
  window.addEventListener('store-config-updated', loadStoreInfo);
  try {
    const r = await adminApi.me();
    user.value = r.data || {};
  } catch {}
  try {
    const m = await http.get('/menu');
    menus.value = m.data?.menus || [];
  } catch {
    menus.value = [];
  }
});
onUnmounted(() => window.removeEventListener('store-config-updated', loadStoreInfo));
</script>

<style scoped>
.layout { display: flex; height: 100vh; background: #f4f6f9; }

.sidebar {
  width: 218px;
  background: #1b2030;
  display: flex;
  flex-direction: column;
  transition: width 0.2s;
  flex: none;
}
.sidebar.collapsed { width: 62px; }

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 60px;
  padding: 0 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex: none;
}
.brand__logo {
  width: 32px; height: 32px;
  border-radius: 9px;
  background: linear-gradient(135deg, #ff6a4d, #e03a24);
  display: flex; align-items: center; justify-content: center;
  flex: none;
}
.brand__logo img { width:100%;height:100%;object-fit:contain;border-radius:inherit;background:#fff;padding:2px; }
.brand__text .t { color: #fff; font-size: 14px; font-weight: 650; letter-spacing: 0.4px; }
.brand__text .s { color: rgba(255, 255, 255, 0.42); font-size: 10.5px; margin-top: 1px; }

.menu { flex: 1; overflow-y: auto; padding: 8px 10px 20px; }
.menu::-webkit-scrollbar { width: 4px; }
.menu::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.12); border-radius: 2px; }
.menu__group {
  font-size: 10.5px;
  color: rgba(255, 255, 255, 0.32);
  padding: 14px 8px 6px;
  letter-spacing: 0.6px;
}
.menu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  padding: 0 10px;
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.66);
  font-size: 13px;
  margin-bottom: 2px;
  transition: all 0.14s;
}
.menu__item:hover { background: rgba(255, 255, 255, 0.06); color: #fff; }
.menu__item.on {
  background: linear-gradient(90deg, rgba(255, 81, 58, 0.9), rgba(255, 81, 58, 0.65));
  color: #fff;
  font-weight: 550;
  box-shadow: 0 3px 10px rgba(255, 81, 58, 0.24);
}
.menu__icon { display: flex; flex: none; width: 20px; height: 20px; align-items: center; justify-content: center; color: currentColor; }
.menu__icon :deep(svg) { display: block; width: 18px; height: 18px; flex: none; }
.menu__label { white-space: nowrap; overflow: hidden; }

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

.topbar {
  height: 56px;
  background: #fff;
  border-bottom: 1px solid #eef1f5;
  display: flex;
  align-items: center;
  padding: 0 18px;
  gap: 14px;
  flex: none;
}
.collapse-btn {
  width: 30px; height: 30px;
  border: none;
  background: transparent;
  color: #6b7280;
  display: flex; align-items: center; justify-content: center;
  border-radius: 7px;
  cursor: pointer;
}
.collapse-btn:hover { background: #f3f5f8; }
.crumb { font-size: 13px; color: #8c93a0; display: flex; gap: 7px; align-items: center; }
.crumb__cur { color: #22252b; font-weight: 550; }
.crumb__sep { opacity: 0.5; }

.topbar__right { margin-left: auto; display: flex; align-items: center; gap: 14px; }
.visit {
  font-size: 12.5px;
  color: #ff513a;
  background: #fff1ee;
  padding: 5px 12px;
  border-radius: 7px;
  font-weight: 500;
}
.user { display: flex; align-items: center; gap: 8px; }
.avatar {
  width: 30px; height: 30px;
  border-radius: 9px;
  background: linear-gradient(135deg, #ff6a4d, #e03a24);
  color: #fff;
  font-size: 13px;
  font-weight: 650;
  display: flex; align-items: center; justify-content: center;
}
.uname { font-size: 13px; color: #34383f; }
.logout {
  border: none;
  background: transparent;
  color: #8c93a0;
  font-size: 12.5px;
  cursor: pointer;
  font-family: var(--font);
}
.logout:hover { color: #d14328; }

.content { flex: 1; overflow-y: auto; padding: 18px; }
.site-footer { display:flex;flex-direction:column;align-items:center;gap:3px;padding:18px 12px 4px;color:#a5aab3;font-size:11px;text-align:center;line-height:1.45; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.16s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
