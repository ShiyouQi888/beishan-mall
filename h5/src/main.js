import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory } from 'vue-router';
import Vant from 'vant';
import 'vant/lib/index.css';
import './styles/main.css';
import App from './App.vue';
import routes from './router.js';

const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach((to, from, next) => {
  const needAuth = to.meta.auth !== false;
  const token = localStorage.getItem('TOKEN');
  if (needAuth && !token && to.path !== '/login') {
    return next({ path: '/login', query: { redirect: to.fullPath } });
  }
  next();
});

createApp(App).use(createPinia()).use(router).use(Vant).mount('#app');

// PWA：注册 Service Worker（开发环境不注册，避免热更新被缓存挡住）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
