<template>
  <div class="login">
    <div class="stage">
      <!-- 左：品牌栏 -->
      <aside class="brandside">
        <header class="brandline">
          <div class="brandline__logo">
            <img v-if="store.logo" :src="store.logo" alt="" />
            <svg v-else viewBox="0 0 32 32" width="18" height="18" aria-hidden="true">
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
            <svg v-else viewBox="0 0 32 32" width="18" height="18" aria-hidden="true">
              <path d="M9.5 13.5h13l-1.1 10.6a1.6 1.6 0 0 1-1.6 1.4h-7.6a1.6 1.6 0 0 1-1.6-1.4L9.5 13.5Z" stroke="#fff" stroke-width="1.8" stroke-linejoin="round" fill="none" />
              <path d="M12.6 13.5a3.4 3.4 0 0 1 6.8 0" stroke="#fff" stroke-width="1.8" stroke-linecap="round" fill="none" />
            </svg>
          </div>
          <span>{{ store.name || '北山商城' }}</span>
        </div>

        <div class="form">
          <div class="form__head">
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
    d: '商品逐轮流转，上架费按单收取',
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
/* ---------------- 页面：深色底 + 居中的整块舞台 ---------------- */
.login {
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 36px 24px;
  background:
    radial-gradient(900px 620px at 22% 10%, rgba(255, 81, 58, 0.16), transparent 62%),
    radial-gradient(760px 560px at 84% 92%, rgba(64, 108, 255, 0.13), transparent 64%),
    linear-gradient(160deg, #12182a 0%, #0c111d 54%, #080b13 100%);
  position: relative;
  overflow: hidden;
}
/* 全页细网格，舞台浮在上面 */
.login::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(circle at 50% 42%, #000 0%, transparent 78%);
  -webkit-mask-image: radial-gradient(circle at 50% 42%, #000 0%, transparent 78%);
  pointer-events: none;
}

.stage {
  position: relative;
  z-index: 1;
  width: min(1040px, 100%);
  min-height: 576px;
  display: grid;
  grid-template-columns: 1.04fr 1fr;
  border-radius: 24px;
  overflow: hidden;
  background: #fff;
  box-shadow: 0 40px 100px rgba(4, 8, 18, 0.5);
}

/* ---------------- 左：品牌栏 ---------------- */
.brandside {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 34px 40px 32px;
  color: #fff;
  background:
    radial-gradient(560px 420px at 12% 4%, rgba(255, 81, 58, 0.2), transparent 60%),
    radial-gradient(520px 400px at 96% 98%, rgba(64, 108, 255, 0.14), transparent 62%),
    linear-gradient(156deg, #151b2d 0%, #0e1321 56%, #0a0e18 100%);
}
/* 品牌栏里的细网格（比整页略明显） */
.brandside::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(circle at 26% 20%, #000 0%, transparent 80%);
  -webkit-mask-image: radial-gradient(circle at 26% 20%, #000 0%, transparent 80%);
  pointer-events: none;
}
.brandside::after {
  content: '';
  position: absolute;
  right: -96px;
  top: -108px;
  width: 290px;
  height: 290px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: inset 0 0 0 38px rgba(255, 255, 255, 0.014);
  pointer-events: none;
}

.brandline {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}
.brandline__logo {
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 9px;
  background: linear-gradient(135deg, #ff6f52, #e0371f);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 5px 14px rgba(224, 55, 31, 0.32);
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
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.brandline__tag {
  font-size: 10.5px;
  color: rgba(255, 255, 255, 0.54);
  padding: 2px 6px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 5px;
  letter-spacing: 0.4px;
}

.pitch {
  position: relative;
  z-index: 1;
  margin: auto 0;
  padding: 24px 0 22px;
}
.eyebrow {
  display: inline-block;
  font-size: 10px;
  letter-spacing: 2.4px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.4);
  padding-bottom: 12px;
}
.pitch h1 {
  margin: 0;
  font-size: clamp(22px, 1.9vw, 28px);
  line-height: 1.44;
  font-weight: 750;
  letter-spacing: 0.5px;
}
.pitch h1 em {
  font-style: normal;
  background: linear-gradient(96deg, #ffb9a9 0%, #ff6a4d 54%, #ff4a31 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.pitch__sub {
  margin: 11px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.5);
}

.points {
  list-style: none;
  margin: 22px 0 0;
  padding: 0;
}
.points li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}
.points li:first-child { border-top: 0; }
.points__ico {
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ff8b74;
  background: rgba(255, 81, 58, 0.13);
  border: 1px solid rgba(255, 81, 58, 0.2);
}
.points__txt { display: flex; flex-direction: column; gap: 1px; }
.points__txt b { font-size: 12.5px; font-weight: 600; color: rgba(255, 255, 255, 0.93); }
.points__txt small { font-size: 11px; color: rgba(255, 255, 255, 0.4); line-height: 1.5; }

.brandfoot {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 10.5px;
  color: rgba(255, 255, 255, 0.3);
}

/* ---------------- 右：表单栏 ---------------- */
.formside {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 38px 40px 46px;
  background: #fff;
}
.mobile-brand { display: none; }

.form {
  width: 100%;
  max-width: 316px;
}
.form__head h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 750;
  letter-spacing: 0.3px;
  color: #1b1f26;
}
.form__head p {
  margin: 6px 0 21px;
  font-size: 12px;
  color: #8c93a0;
}

.field { margin-bottom: 14px; }
.field__label {
  display: block;
  margin: 0 0 6px 2px;
  font-size: 11.5px;
  font-weight: 550;
  color: #6b7280;
  letter-spacing: 0.2px;
}
.field__ico { color: #aab1bc; transition: color 0.16s ease; }

:deep(.el-input__wrapper) {
  height: 44px;
  padding: 0 12px;
  border-radius: 10px;
  background: #f7f8fa;
  box-shadow: inset 0 0 0 1px #e9edf2;
  transition: box-shadow 0.18s ease, background 0.18s ease;
}
:deep(.el-input__wrapper:hover) { box-shadow: inset 0 0 0 1px #d9dfe7; }
:deep(.el-input__wrapper.is-focus) {
  background: #fff;
  box-shadow: inset 0 0 0 1px #ff513a, 0 0 0 4px rgba(255, 81, 58, 0.1);
}
:deep(.el-input__wrapper.is-focus .field__ico) { color: #ff513a; }
:deep(.el-input__inner) { font-size: 13.5px; color: #1b1f26; }
:deep(.el-input__inner::placeholder) { color: #aab1bc; }
:deep(.el-input__prefix) { margin-right: 3px; }
:deep(.el-input__suffix-inner .el-input__icon) { color: #aab1bc; }

.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 20px;
  margin: 2px 0 14px;
}
:deep(.el-checkbox__label) { font-size: 12px; color: #6b7280; padding-left: 6px; }
.caps {
  font-size: 11px;
  color: #c9351f;
  background: #fff3f0;
  border-radius: 5px;
  padding: 2px 7px;
}

.submit {
  width: 100%;
  height: 44px;
  border: 0;
  border-radius: 10px;
  cursor: pointer;
  font-family: var(--font);
  font-size: 14px;
  font-weight: 650;
  letter-spacing: 2px;
  color: #fff;
  background: linear-gradient(135deg, #ff6f52 0%, #f0442a 100%);
  box-shadow: 0 7px 18px rgba(240, 68, 42, 0.26);
  transition: transform 0.16s ease, box-shadow 0.16s ease, filter 0.16s ease;
}
.submit:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 11px 24px rgba(240, 68, 42, 0.32);
  filter: saturate(1.04);
}
.submit:active:not(:disabled) { transform: translateY(0); }
.submit:disabled { cursor: default; opacity: 0.72; box-shadow: none; }
.submit__loading { display: inline-flex; align-items: center; gap: 8px; letter-spacing: 0.5px; }
.spin {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.42);
  border-top-color: #fff;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.notice {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin: 13px 0 0;
  font-size: 10.5px;
  color: #a8adb7;
}

/* 桌面端版权只放左侧品牌栏，避免同一张卡里出现两份 */
.formfoot { display: none; }

/* ---------------- 响应式 ---------------- */
@media (max-width: 1080px) {
  .stage { width: min(880px, 100%); }
  .brandside { padding: 30px 32px 28px; }
  .formside { padding: 32px 32px 44px; }
}

/* 平板及以下：舞台变单列，品牌栏收成顶部条 */
@media (max-width: 900px) {
  .login {
    padding: 22px 16px;
    background:
      radial-gradient(680px 480px at 50% -8%, rgba(255, 81, 58, 0.15), transparent 66%),
      linear-gradient(160deg, #f7f9fc 0%, #eef2f7 100%);
  }
  .login::before { display: none; }
  .stage {
    width: min(520px, 100%);
    grid-template-columns: 1fr;
    min-height: auto;
    border-radius: 20px;
    box-shadow: 0 24px 60px rgba(19, 26, 40, 0.16);
  }
  .brandside { display: none; }
  .formside { padding: 28px 26px 34px; }
  .mobile-brand {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    max-width: 356px;
    margin-bottom: 18px;
    font-size: 13.5px;
    font-weight: 600;
    color: #22252b;
  }
  .mobile-brand .brandline__logo { width: 30px; height: 30px; }
  .form { max-width: 356px; }
  .formfoot {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    margin-top: 20px;
    font-size: 10.5px;
    color: #a8adb7;
  }
}

@media (max-width: 480px) {
  .login { padding: 14px 10px; }
  .formside { padding: 24px 18px 28px; }
  .form__head h2 { font-size: 20px; }
}

/* 矮屏（笔记本 13 寸 / 浏览器被压扁）别让舞台顶满 */
@media (max-height: 700px) and (min-width: 901px) {
  .login { padding: 20px 20px; }
  .brandside { padding: 26px 34px 24px; }
  .pitch { padding: 16px 0 4px; }
  .points { margin-top: 16px; }
  .points li { padding: 6px 0; }
  .formside { padding: 28px 34px 40px; }
  .form__head p { margin-bottom: 16px; }
}
</style>
