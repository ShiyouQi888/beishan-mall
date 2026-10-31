import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { VantResolver } from '@vant/auto-import-resolver';

// 版号从 package.json 读，构建时注入成常量 —— 页面上写的版号就是这次打包的版号，
// 不会出现「改了这个文件忘了改那个」的两套数字。
// 展示用短版（V2.0），完整版（2.0.0）留给 title 提示和排查。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const APP_VERSION_SHORT = `V${pkg.version.split('.').slice(0, 2).join('.')}`;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION_SHORT),
    __APP_VERSION_FULL__: JSON.stringify(pkg.version),
  },
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
