import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
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
