<template>
  <div class="login">
    <!-- 左：品牌区 -->
    <aside class="brandside">
      <header class="brandline">
        <div class="brandline__logo">
          <img v-if="store.logo" :src="store.logo" alt="" />
          <svg v-else viewBox="0 0 32 32" width="19" height="19" aria-hidden="true">
            <path d="M9.5 13.5h13l-1.1 10.6a1.6 1.6 0 0 1-1.6 1.4h-7.6a1.6 1.6 0 0 1-1.6-1.4L9.5 13.5Z" stroke="#fff" stroke-width="1.8" stroke-linejoin="round" fill="none" />
            <path d="M12.6 13.5a3.4 3.4 0 0 1 6.8 0" stroke="#fff" stroke-width="1.8" stroke-linecap="round" fill="none" />
          </svg>
        </div>
        <span class="brandline__name">{{ store.name || '北山商城' }}</span>
        <span class="brandline__tag">管理后台</span>
      </header>

      <div class="pitch">
        <span class="eyebrow">ADMIN CONSOLE</span>
        <h1>商品、订单、资金<br /><em>放在同一块看板</em></h1>
        <p class="pitch__sub">场次抢购、寄售转拍、一级分销到差价结算，一条链路跑完。</p>

        <ul class="points">
          <li v-for="f in features" :key="f.t">
            <span class="points__ico" v-html="f.icon" />
            <div class="points__txt">
              <b>{{ f.t }}</b>
              <small>{{ f.d }}</small>
            </div>
          </li>
        </ul>
      </div>

      <footer class="brandfoot">
        <span v-if="store.copyright">{{ store.copyright }}</span>
        <span v-if="store.icp_number">{{ store.icp_number }}</span>
        <span v-if="!store.copyright && !store.icp_number">© {{ year }} {{ store.name || '北山商城' }}</span>
      </footer>
    </aside>

    <!-- 右：登录表单 -->
    <main class="formside">
      <div class="mobile-brand">
        <div class="brandline__logo">
          <img v-if="store.logo" :src="store.logo" alt="" />
          <svg v-else viewBox="0 0 32 32" width="19" height="19" aria-hidden="true">
            <path d="M9.5 13.5h13l-1.1 10.6a1.6 1.6 0 0 1-1.6 1.4h-7.6a1.6 1.6 0 0 1-1.6-1.4L9.5 13.5Z" stroke="#fff" stroke-width="1.8" stroke-linejoin="round" fill="none" />
            <path d="M12.6 13.5a3.4 3.4 0 0 1 6.8 0" stroke="#fff" stroke-width="1.8" stroke-linecap="round" fill="none" />
          </svg>
        </div>
        <span>{{ store.name || '北山商城' }}</span>
      </div>

      <div class="card">
        <div class="card__head">
          <h2>登录后台</h2>
          <p>使用管理员账号继续</p>
        </div>

        <div class="field">
          <span class="field__label">账号</span>
          <el-input
            v-model="form.user_name"
            size="large"
            placeholder="管理员账号"
            autocomplete="username"
            @keyup.enter="submit"
          >
            <template #prefix>
              <svg class="field__ico" viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
                <circle cx="12" cy="8.2" r="3.4" stroke="currentColor" stroke-width="1.7" />
                <path d="M5.2 19.4c0-3.3 3-5.6 6.8-5.6s6.8 2.3 6.8 5.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
              </svg>
            </template>
          </el-input>
        </div>

        <div class="field">
          <span class="field__label">密码</span>
          <el-input
            v-model="form.password"
            size="large"
            type="password"
            show-password
            placeholder="登录密码"
            autocomplete="current-password"
            @keyup.enter="submit"
            @keyup="checkCaps"
            @keydown="checkCaps"
          >
            <template #prefix>
              <svg class="field__ico" viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
                <rect x="4.8" y="10.4" width="14.4" height="9.4" rx="2.4" stroke="currentColor" stroke-width="1.7" />
                <path d="M8.4 10.4V8a3.6 3.6 0 0 1 7.2 0v2.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
              </svg>
            </template>
          </el-input>
        </div>

        <div class="meta">
          <el-checkbox v-model="remember" size="small">记住账号</el-checkbox>
          <span v-if="capsOn" class="caps">大写锁定已开启</span>
        </div>

        <button class="submit" type="button" :disabled="loading" @click="submit">
          <span v-if="!loading">登 录</span>
          <span v-else class="submit__loading"><i class="spin" />登录中</span>
        </button>

        <p class="notice">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
            <rect x="4.5" y="10.2" width="15" height="9.6" rx="2.4" stroke="currentColor" stroke-width="1.7" />
            <path d="M8.2 10.2V7.8a3.8 3.8 0 0 1 7.6 0v2.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
          </svg>
          仅限授权管理员访问
        </p>
      </div>

      <div class="formfoot">
        <span v-if="store.copyright">{{ store.copyright }}</span>
        <span v-if="store.icp_number">{{ store.icp_number }}</span>
        <span v-if="!store.copyright && !store.icp_number">© {{ year }} {{ store.name || '北山商城' }} · 管理后台</span>
      </div>
    </main>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { adminApi } from '../api.js';

const router = useRouter();
const STORE_KEY = 'ADMIN_LAST_USER';
const year = new Date().getFullYear();

const form = reactive({ user_name: '', password: '' });
const loading = ref(false);
const store = ref({});
const remember = ref(false);
const capsOn = ref(false);

onMounted(async () => {
  // 只记住账号，不碰密码
  const saved = localStorage.getItem(STORE_KEY);
  if (saved) {
    form.user_name = saved;
    remember.value = true;
  }
  try {
    store.value = await adminApi.storeInfo();
    if (store.value.name) document.title = `${store.value.name} · 管理后台`;
  } catch {}
});

const features = [
  {
    t: '场次抢购',
    d: '每日多场次，限时限量开抢',
    icon: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none"><circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="1.7"/><path d="M12 7.6V12l3 1.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  },
  {
    t: '寄售转拍',
    d: '商品逐轮流转，服务费自动结算',
    icon: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none"><path d="M4 8.4h12.6l-2.8-2.8M20 15.6H7.4l2.8 2.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  },
  {
    t: '一级分销',
    d: '直推奖实时入账，绑定关系清晰',
    icon: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none"><circle cx="8.6" cy="9" r="2.9" stroke="currentColor" stroke-width="1.7"/><circle cx="17" cy="10.2" r="2.2" stroke="currentColor" stroke-width="1.7"/><path d="M3.6 18.8c0-2.7 2.2-4.6 5-4.6s5 1.9 5 4.6M14.4 18.8c0-2.2 1.3-3.7 3.4-3.7s3.4 1.5 3.4 3.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  },
];

function checkCaps(e) {
  if (typeof e.getModifierState === 'function' && e.key !== 'CapsLock') {
    capsOn.value = e.getModifierState('CapsLock');
  }
}

async function submit() {
  if (!form.user_name || !form.password) return ElMessage.warning('请输入账号和密码');
  loading.value = true;
  try {
    const r = await adminApi.login({ user_name: form.user_name.trim(), password: form.password });
    localStorage.setItem('ADMIN_TOKEN', r.data.token);
    if (remember.value) localStorage.setItem(STORE_KEY, form.user_name.trim());
    else localStorage.removeItem(STORE_KEY);
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
  min-height: 100vh;
  min-height: 100dvh;
  background: #f5f7fa;
}

/* ---------------- 左：品牌区 ---------------- */
.brandside {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 46px 64px 36px;
  overflow: hidden;
  color: #fff;
  background:
    radial-gradient(760px 520px at 16% 6%, rgba(255, 81, 58, 0.24), transparent 62%),
    radial-gradient(680px 520px at 92% 96%, rgba(64, 108, 255, 0.16), transparent 64%),
    linear-gradient(158deg, #12182a 0%, #0d1220 52%, #080b13 100%);
}
/* 细网格，给深色底一点纹理，不至于糊成一块 */
.brandside::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.045) 1px, transparent 1px);
  background-size: 46px 46px, 46px 46px;
  mask-image: radial-gradient(circle at 30% 24%, #000 0%, transparent 78%);
  -webkit-mask-image: radial-gradient(circle at 30% 24%, #000 0%, transparent 78%);
  pointer-events: none;
}
/* 右上角一圈细环 */
.brandside::after {
  content: '';
  position: absolute;
  right: -110px;
  top: -130px;
  width: 380px;
  height: 380px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.13);
  box-shadow: inset 0 0 0 46px rgba(255, 255, 255, 0.015);
  pointer-events: none;
}

.brandline {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  z-index: 1;
}
.brandline__logo {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 10px;
  background: linear-gradient(135deg, #ff6f52, #e0371f);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 16px rgba(224, 55, 31, 0.34);
}
.brandline__logo img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: inherit;
  background: #fff;
  padding: 3px;
}
.brandline__name {
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.brandline__tag {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.56);
  padding: 2px 7px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 5px;
  letter-spacing: 0.5px;
}

.pitch {
  position: relative;
  z-index: 1;
  margin: auto 0;
  padding: 36px 0;
  max-width: 540px;
}
.eyebrow {
  display: inline-block;
  font-size: 10.5px;
  letter-spacing: 2.6px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.42);
  padding-bottom: 16px;
}
.pitch h1 {
  margin: 0;
  font-size: clamp(26px, 2.5vw, 34px);
  line-height: 1.42;
  font-weight: 750;
  letter-spacing: 0.6px;
}
.pitch h1 em {
  font-style: normal;
  background: linear-gradient(96deg, #ffb9a9 0%, #ff6a4d 52%, #ff4a31 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.pitch__sub {
  margin: 16px 0 0;
  font-size: 13px;
  line-height: 1.75;
  color: rgba(255, 255, 255, 0.52);
  max-width: 400px;
}

.points {
  list-style: none;
  margin: 34px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.points li {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 11px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}
.points li:first-child {
  border-top: 0;
}
.points__ico {
  width: 26px;
  height: 26px;
  flex: none;
  margin-top: 1px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ff8b74;
  background: rgba(255, 81, 58, 0.14);
  border: 1px solid rgba(255, 81, 58, 0.22);
}
.points__txt {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.points__txt b {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.94);
}
.points__txt small {
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.42);
  line-height: 1.6;
}

.brandfoot {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.32);
}

/* ---------------- 右：表单区 ---------------- */
.formside {
  flex: 0 0 clamp(430px, 44%, 600px);
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  background:
    radial-gradient(560px 420px at 76% 6%, #ffffff 0%, transparent 70%),
    radial-gradient(520px 380px at 88% 92%, rgba(255, 81, 58, 0.05), transparent 72%),
    linear-gradient(180deg, #f7f8fb 0%, #f0f3f8 100%);
}
.mobile-brand {
  display: none;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  font-weight: 600;
  color: #22252b;
  margin-bottom: 22px;
}
.mobile-brand .brandline__logo {
  width: 32px;
  height: 32px;
}

.card {
  width: 100%;
  max-width: 352px;
  padding: 30px 30px 24px;
  background: #fff;
  border: 1px solid #eef1f5;
  border-radius: 20px;
  box-shadow:
    0 1px 2px rgba(19, 26, 40, 0.04),
    0 18px 48px rgba(19, 26, 40, 0.09);
}
.card__head h2 {
  margin: 0;
  font-size: 23px;
  font-weight: 750;
  letter-spacing: 0.3px;
  color: #1b1f26;
}
.card__head p {
  margin: 6px 0 24px;
  font-size: 12.5px;
  color: #8c93a0;
}

.field {
  margin-bottom: 15px;
}
.field__label {
  display: block;
  margin: 0 0 7px 2px;
  font-size: 11.5px;
  font-weight: 550;
  color: #6b7280;
  letter-spacing: 0.2px;
}
.field__ico {
  color: #aab1bc;
  transition: color 0.16s ease;
}

/* Element Plus 输入框：去掉默认的灰色描边，换成「填充底 + 焦点描边」 */
:deep(.el-input__wrapper) {
  height: 46px;
  padding: 0 13px;
  border-radius: 11px;
  background: #f7f8fa;
  box-shadow: inset 0 0 0 1px #e9edf2;
  transition: box-shadow 0.18s ease, background 0.18s ease;
}
:deep(.el-input__wrapper:hover) {
  box-shadow: inset 0 0 0 1px #d9dfe7;
}
:deep(.el-input__wrapper.is-focus) {
  background: #fff;
  box-shadow: inset 0 0 0 1px #ff513a, 0 0 0 4px rgba(255, 81, 58, 0.1);
}
:deep(.el-input__wrapper.is-focus .field__ico) {
  color: #ff513a;
}
:deep(.el-input__inner) {
  font-size: 13.5px;
  color: #1b1f26;
}
:deep(.el-input__inner::placeholder) {
  color: #aab1bc;
}
:deep(.el-input__prefix) {
  margin-right: 4px;
}
:deep(.el-input__suffix-inner .el-input__icon) {
  color: #aab1bc;
}

.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 20px;
  margin: 2px 0 16px;
}
:deep(.el-checkbox__label) {
  font-size: 12px;
  color: #6b7280;
  padding-left: 6px;
}
.caps {
  font-size: 11px;
  color: #c9351f;
  background: #fff3f0;
  border-radius: 5px;
  padding: 2px 7px;
}

.submit {
  width: 100%;
  height: 46px;
  border: 0;
  border-radius: 11px;
  cursor: pointer;
  font-family: var(--font);
  font-size: 14.5px;
  font-weight: 650;
  letter-spacing: 2px;
  color: #fff;
  background: linear-gradient(135deg, #ff6f52 0%, #f0442a 100%);
  box-shadow: 0 8px 20px rgba(240, 68, 42, 0.28);
  transition: transform 0.16s ease, box-shadow 0.16s ease, filter 0.16s ease;
}
.submit:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 12px 26px rgba(240, 68, 42, 0.34);
  filter: saturate(1.04);
}
.submit:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: 0 6px 14px rgba(240, 68, 42, 0.26);
}
.submit:disabled {
  cursor: default;
  opacity: 0.72;
  box-shadow: none;
}
.submit__loading {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  letter-spacing: 0.5px;
}
.spin {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.42);
  border-top-color: #fff;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

.notice {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin: 16px 0 0;
  font-size: 11px;
  color: #a8adb7;
}

/* 桌面端把页脚钉在底部，否则它会把登录卡顶离视觉中心 */
@media (min-width: 981px) {
  .formfoot {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 26px;
  }
}
.formfoot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  margin-top: 20px;
  font-size: 11px;
  color: #a8adb7;
}

/* ---------------- 响应式 ---------------- */
@media (max-width: 1180px) {
  .brandside { padding: 36px 40px 30px; }
  .formside { flex-basis: 440px; padding: 32px; }
}

@media (max-width: 980px) {
  .brandside { display: none; }
  .formside {
    flex: 1;
    padding: 26px 20px 30px;
    justify-content: center;
    background:
      radial-gradient(420px 320px at 50% -6%, #fff 0%, transparent 68%),
      linear-gradient(180deg, #f6f8fb 0%, #eef2f7 100%);
  }
  .mobile-brand { display: flex; }
  .card { max-width: 380px; }
}

@media (max-width: 480px) {
  .formside { padding: 26px 16px 28px; }
  .card { padding: 26px 20px 20px; border-radius: 18px; }
  .card__head h2 { font-size: 21px; }
}

@media (max-height: 720px) and (min-width: 981px) {
  .pitch { padding: 20px 0; margin: 24px 0 auto; }
  .points { margin-top: 22px; }
  .points li { padding: 8px 0; }
  .card { padding: 24px 26px 20px; }
  .card__head p { margin-bottom: 18px; }
}
</style>
