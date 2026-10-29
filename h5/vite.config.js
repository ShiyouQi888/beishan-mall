import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:3300', changeOrigin: true },
      '/uploads': { target: 'http://127.0.0.1:3300', changeOrigin: true },
    },
  },
});
