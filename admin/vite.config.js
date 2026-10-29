import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  // 一体化部署时后台挂在 /admin/ 下，用 VITE_BASE=/admin/ 构建；开发模式保持 '/'
  base: process.env.VITE_BASE || '/',
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5274,
    strictPort: true,
    fs: { allow: ['..'] },
    proxy: {
      '/admin/api': { target: 'http://127.0.0.1:3300', changeOrigin: true },
      '/api': { target: 'http://127.0.0.1:3300', changeOrigin: true },
      '/uploads': { target: 'http://127.0.0.1:3300', changeOrigin: true },
    },
  },
});
