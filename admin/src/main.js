import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory } from 'vue-router';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import './styles/main.css';
import App from './App.vue';
import routes from './router.js';
import { adminApi } from './api.js';

const router = createRouter({ history: createWebHashHistory(), routes });

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
