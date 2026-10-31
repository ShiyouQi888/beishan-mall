import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import './styles/main.css';
import App from './App.vue';
import routes from './router.js';
import { adminApi } from './api.js';

// 老链接兼容：/#/orders（hash 路由时代）自动转成 /orders。
// base 由构建时的 VITE_BASE 决定（生产是 /admin/），createWebHistory 会自动带上。
if (location.hash.startsWith('#/')) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  history.replaceState(null, '', base + location.hash.slice(1));
}

const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach(async (to) => {
  const token = localStorage.getItem('ADMIN_TOKEN');
  if (to.path !== '/login' && !token) return { path: '/login' };
  if (to.path === '/login' && token) return { path: '/' };
  if (to.path === '/login' || to.path === '/forbidden') return true;
  try {
    const result = await adminApi.myPaths();
    const permission = to.meta.permissionPath || (to.path.startsWith('/setting/') ? to.path : '');
    if (result.data?.unrestricted || result.data?.paths?.includes(permission)) return true;
    return { path: '/forbidden', replace: true };
  } catch {
    return { path: '/login', replace: true };
  }
});

createApp(App).use(createPinia()).use(router).use(ElementPlus, { locale: zhCn }).mount('#app');
