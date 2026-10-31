import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import ElementPlus from 'unplugin-element-plus/vite';

export default defineConfig({
  // 一体化部署时后台挂在 /admin/ 下，用 VITE_BASE=/admin/ 构建；开发模式保持 '/'
  base: process.env.VITE_BASE || '/',
  plugins: [
    vue(),
    // Element Plus 按需引入：模板里的 el-* 用哪个引哪个（含样式与 v-loading 指令），
    // 不再打包整个组件库 —— 之前主包 1.14MB，大头全在这里
    Components({ resolvers: [ElementPlusResolver()], dts: false }),
    // ElMessage / ElMessageBox 这类函数式组件不在模板里，靠这个插件补上它们要的样式
    ElementPlus({ useSource: false }),
  ],
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
