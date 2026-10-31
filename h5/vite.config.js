import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { VantResolver } from '@vant/auto-import-resolver';

export default defineConfig({
  plugins: [
    vue(),
    // Vant 按需引入：实际只用了 picker / popup / stepper / swipe / switch 这几个，
    // 全量引入会把整个组件库和它的样式都打进主包（之前主包 407KB，大头就在这里）
    Components({ resolvers: [VantResolver()], dts: false }),
  ],
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
