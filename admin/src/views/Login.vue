<template>
  <div class="login">
    <div class="login__left">
      <div class="brand">
        <div class="brand__logo">
          <img v-if="store.logo" :src="store.logo" alt="商城 Logo" />
          <svg v-else viewBox="0 0 32 32" width="30" height="30">
            <path d="M9 13h14l-1.2 11.4a1.6 1.6 0 0 1-1.6 1.4h-8.4a1.6 1.6 0 0 1-1.6-1.4L9 13Z" stroke="#fff" stroke-width="1.8" stroke-linejoin="round" fill="none" />
            <path d="M12.2 13a3.8 3.8 0 0 1 7.6 0" stroke="#fff" stroke-width="1.8" stroke-linecap="round" fill="none" />
          </svg>
        </div>
        <span>{{ store.name || '北山商城' }} · 管理后台</span>
      </div>

      <div class="hero">
        <h1>场次抢购 · 寄售转拍<br />多级分销一体化运营</h1>
        <p>商品、订单、会员、财务、分销团队，一个后台全部管好。</p>
      </div>

      <div class="features">
        <div class="f" v-for="f in features" :key="f.t">
          <div class="f-dot" />
          <div>
            <div class="f-t">{{ f.t }}</div>
            <div class="f-d">{{ f.d }}</div>
          </div>
        </div>
      </div>

      <div class="foot">
        <span v-if="store.copyright">{{ store.copyright }}</span>
        <span v-if="store.icp_number">{{ store.icp_number }}</span>
        <span v-if="!store.copyright && !store.icp_number">© {{ new Date().getFullYear() }} {{ store.name || '北山商城' }} · 管理后台</span>
      </div>
    </div>

    <div class="login__right">
      <div class="form">
        <h2>后台登录</h2>
        <p class="sub">请使用管理员账号登录系统</p>

        <el-form @submit.prevent>
          <el-form-item>
            <el-input v-model="form.user_name" size="large" placeholder="登录账号" />
          </el-form-item>
          <el-form-item>
            <el-input v-model="form.password" size="large" type="password" show-password placeholder="登录密码" @keyup.enter="submit" />
          </el-form-item>
          <el-button type="primary" size="large" class="submit" :loading="loading" @click="submit">
            登 录
          </el-button>
        </el-form>

        <div class="demo">
          <span class="k">演示账号</span>
          <span class="v">admin1 / 123456</span>
          <span class="fill" @click="fill">一键填入</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { adminApi } from '../api.js';

const router = useRouter();
const form = reactive({ user_name: '', password: '' });
const loading = ref(false);
const store = ref({});

onMounted(async () => {
  try {
    store.value = await adminApi.storeInfo();
    if (store.value.name) document.title = `${store.value.name} · 管理后台`;
  } catch {}
});

const features = [
  { t: '场次抢购', d: '自定义每日多场次，限时限量开抢' },
  { t: '寄售转拍', d: '商品反复流转，服务费自动结算' },
  { t: '三级分销', d: '团队佣金按级自动计算入账' },
];

function fill() {
  form.user_name = 'admin1';
  form.password = '123456';
}

async function submit() {
  if (!form.user_name || !form.password) return ElMessage.warning('请输入账号和密码');
  loading.value = true;
  try {
    const r = await adminApi.login(form);
    localStorage.setItem('ADMIN_TOKEN', r.data.token);
    ElMessage.success('登录成功');
    router.replace('/');
  } catch {
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 28px;
  background: radial-gradient(ellipse at 20% 15%, #fff 0, #f3f5f9 48%, #e9edf4 100%);
}
.login > * { height: min(760px, calc(100vh - 56px)); min-height: min(600px, calc(100vh - 56px)); }
.login { width: 100%; }
.login__left { max-width: 650px; border-radius: 22px 0 0 22px; }
.login__right { border-radius: 0 22px 22px 0; box-shadow: 18px 18px 60px rgba(31, 39, 55, .12); }

.login__left {
  flex: 1;
  background: linear-gradient(155deg, #20263a 0%, #161a28 55%, #10131d 100%);
  padding: 38px 52px;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}
.login__left::before {
  content: '';
  position: absolute;
  width: 520px; height: 520px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 81, 58, 0.22), transparent 65%);
  right: -160px; top: -120px;
}
.login__left::after {
  content: '';
  position: absolute;
  width: 380px; height: 380px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(80, 130, 255, 0.14), transparent 68%);
  left: -120px; bottom: -140px;
}

.brand { display: flex; align-items: center; gap: 11px; color: #fff; font-size: 14.5px; font-weight: 550; letter-spacing: 0.4px; position: relative; }
.brand__logo {
  width: 36px; height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, #ff6a4d, #e03a24);
  display: flex; align-items: center; justify-content: center;
}
.brand__logo img { width:100%;height:100%;object-fit:contain;border-radius:inherit;background:#fff;padding:3px; }

.hero { margin-top: auto; position: relative; }
.hero h1 {
  color: #fff;
  font-size: 30px;
  line-height: 1.42;
  font-weight: 700;
  letter-spacing: 0.5px;
  margin: 0;
}
.hero p { color: rgba(255, 255, 255, 0.5); font-size: 13.5px; margin: 14px 0 0; line-height: 1.7; }

.features { margin: 34px 0 auto; display: flex; flex-direction: column; gap: 15px; position: relative; }
.f { display: flex; gap: 11px; align-items: flex-start; }
.f-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: #ff513a;
  margin-top: 6px;
  flex: none;
  box-shadow: 0 0 0 3px rgba(255, 81, 58, 0.16);
}
.f-t { color: rgba(255, 255, 255, 0.92); font-size: 13px; font-weight: 550; }
.f-d { color: rgba(255, 255, 255, 0.42); font-size: 11.5px; margin-top: 2px; }

.foot { color: rgba(255, 255, 255, 0.38); font-size: 11.5px; position: relative; display:flex;flex-direction:column;gap:3px; }

.login__right {
  width: 460px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  flex: none;
}
.form { width: 100%; max-width: 330px; }
.form h2 { font-size: 24px; font-weight: 700; margin: 0; letter-spacing: 0.3px; }
.form .sub { font-size: 12.5px; color: #8c93a0; margin: 7px 0 26px; }

.submit { width: 100%; height: 44px; font-size: 15px; font-weight: 600; border-radius: 10px; margin-top: 4px; }

.demo {
  margin-top: 22px;
  background: #f7f8fa;
  border-radius: 9px;
  padding: 11px 13px;
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12px;
}
.demo .k { color: #8c93a0; }
.demo .v { color: #34383f; font-variant-numeric: tabular-nums; }
.demo .fill { margin-left: auto; color: #ff513a; cursor: pointer; font-weight: 550; }

@media (max-width: 900px) {
  .login { padding: 22px; }
  .login > * { height: min(640px, calc(100vh - 44px)); min-height: 520px; }
  .login__left { display: none; }
  .login__right { width: min(460px, 100%); border-radius: 20px; box-shadow: 0 20px 60px rgba(31, 39, 55, .12); }
}
@media (max-width: 520px) {
  .login { min-height: 100dvh; padding: 16px; background: #f4f6f9; }
  .login > * { height: auto; min-height: min(540px, calc(100dvh - 32px)); }
  .login__right { padding: 32px 24px; }
}
</style>
