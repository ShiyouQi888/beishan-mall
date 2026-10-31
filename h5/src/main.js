import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import './styles/main.css';
import App from './App.vue';
import routes from './router.js';

// 老链接兼容：以前是 /#/loot 这种 hash 路由，改成 history 模式后，
// 旧书签/二维码/分享链接里带 #/ 的会被直接转成新路径，不会白页。
// 必须在 createRouter 之前执行 —— router 初始化时就会读一次 location。
if (location.hash.startsWith('#/')) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  history.replaceState(null, '', base + location.hash.slice(1));
}

const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach((to, from, next) => {
  const needAuth = to.meta.auth !== false;
  const token = localStorage.getItem('TOKEN');
  if (needAuth && !token && to.path !== '/login') {
    return next({ path: '/login', query: { redirect: to.fullPath } });
  }
  next();
});

// 组件库改为按需引入（见 vite.config.js），不再 app.use(Vant) 整体注册
createApp(App).use(createPinia()).use(router).mount('#app');

// PWA：注册 Service Worker（开发环境不注册，避免热更新被缓存挡住）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
