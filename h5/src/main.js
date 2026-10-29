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
