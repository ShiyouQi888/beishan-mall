<template>
  <main class="denied">
    <div class="card">
      <div class="code">403</div>
      <h1>当前账号没有此页面的权限</h1>
      <p>如需访问，请联系超级管理员分配相应菜单权限。</p>
      <el-button v-if="fallbackPath" type="primary" @click="$router.replace(fallbackPath)">返回可访问页面</el-button>
      <el-button v-else type="primary" @click="logout">重新登录</el-button>
    </div>
  </main>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { adminApi } from '../api.js';

const router = useRouter();
const fallbackPath = ref('');

function logout() {
  localStorage.removeItem('ADMIN_TOKEN');
  router.replace('/login');
}

onMounted(async () => {
  try {
    const { data } = await adminApi.myPaths();
    fallbackPath.value = data?.unrestricted ? '/' : data?.paths?.includes('/') ? '/' : data?.paths?.[0] || '';
  } catch {
    fallbackPath.value = '';
  }
});
</script>

<style scoped>
.denied { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f4f6f9; }
.card { width: min(440px, 100%); text-align: center; padding: 36px 28px; border-radius: 16px; background: #fff; box-shadow: 0 12px 40px rgba(25, 35, 55, .08); }
.code { color: #ff513a; font-size: 52px; font-weight: 750; letter-spacing: 2px; }
h1 { margin: 8px 0; font-size: 19px; }
p { margin: 0 0 24px; color: #8c93a0; font-size: 13px; }
</style>
