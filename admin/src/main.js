import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory } from 'vue-router';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import './styles/main.css';
import App from './App.vue';
import routes from './router.js';

const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach((to) => {
  const token = localStorage.getItem('ADMIN_TOKEN');
  if (to.path !== '/login' && !token) return { path: '/login' };
  if (to.path === '/login' && token) return { path: '/' };
  return true;
});

createApp(App).use(createPinia()).use(router).use(ElementPlus, { locale: zhCn }).mount('#app');
