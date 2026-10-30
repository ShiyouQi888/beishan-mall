<template>
  <div class="reg">
    <header class="reg__hero">
      <button class="reg__back" type="button" aria-label="返回" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <div class="reg__eyebrow">JOIN OUR COMMUNITY</div>
      <div class="reg__brand">
        <div class="reg__logo">
          <img v-if="store.logo" :src="store.logo" alt="商城 Logo" />
          <svg v-else viewBox="0 0 48 48" width="38" height="38" aria-hidden="true">
            <rect x="1" y="1" width="46" height="46" rx="13" fill="#fff" opacity=".18" />
            <path d="M15 20h18l-1.6 14.2a2 2 0 0 1-2 1.8H18.6a2 2 0 0 1-2-1.8L15 20Z" stroke="white" stroke-width="2.2" stroke-linejoin="round" />
            <path d="M19.5 20a4.5 4.5 0 0 1 9 0" stroke="white" stroke-width="2.2" stroke-linecap="round" />
          </svg>
        </div>
        <div class="reg__brand-name">{{ store.name || '北山商城' }}</div>
      </div>
      <div class="reg__lead">创建账号，开启品质生活</div>
    </header>

    <main class="reg__content">
      <section class="reg__card">
        <div class="reg__card-title">注册账号</div>
        <div class="reg__card-desc">填写以下信息，快速加入商城</div>
        <label class="reg__field">
          <span>手机号 <i>*</i></span>
          <input v-model="form.phone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="11" placeholder="请输入手机号" />
        </label>
        <label class="reg__field">
          <span>昵称 <small>选填</small></span>
          <input v-model="form.nickName" autocomplete="nickname" placeholder="选填，默认取手机尾号" />
        </label>
        <label class="reg__field">
          <span>登录密码 <i>*</i></span>
          <input v-model="form.password" type="password" autocomplete="new-password" placeholder="至少 6 位" />
        </label>
        <label class="reg__field reg__field--last">
          <span>邀请码 <i v-if="requireCode">*</i><small v-else>选填</small></span>
          <input
            v-model="form.code"
            autocomplete="off"
            :placeholder="requireCode ? '请输入邀请码' : '选填，填了可与邀请人绑定上下级'"
          />
        </label>
        <div class="reg__agreement">
          <input id="register-agreement" v-model="agreed" type="checkbox" />
          <label for="register-agreement">我已阅读并同意</label>
          <button type="button" @click="openAgreement('user')">《用户注册协议》</button>
          <span>和</span>
          <button type="button" @click="openAgreement('privacy')">《隐私政策》</button>
        </div>
        <button class="btn-main reg__submit" :disabled="loading" @click="submit">{{ loading ? '提交中…' : '创建账号' }}</button>
        <div class="reg__login" @click="$router.replace('/login')">已有账号？<b>去登录</b></div>
      </section>
    </main>

    <van-popup v-model:show="agreementVisible" position="bottom" round class="reg__agreement-popup">
      <div class="reg__agreement-head"><strong>{{ activeAgreement === 'user' ? '用户注册协议' : '隐私政策' }}</strong><button type="button" aria-label="关闭" @click="agreementVisible = false">×</button></div>
      <div class="reg__agreement-content" v-html="agreementContent" />
      <button class="btn-main reg__agreement-confirm" type="button" @click="acceptAgreement">阅读并同意</button>
    </van-popup>
  </div>
</template>

<script setup>
import { computed, inject, reactive, ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast } from '../utils/feedback.js';
import { api } from '../api.js';
import { sanitizeHtml } from '../../../shared/sanitize.js';

const router = useRouter();
const route = useRoute();
const store = inject('storeInfo', ref({}));
const form = reactive({ phone: '', nickName: '', password: '', code: String(route.query.code || '') });
const loading = ref(false);
const agreed = ref(false);
const agreements = ref({
  user: '<h3>用户注册协议</h3><p>欢迎使用本商城服务。注册并使用本服务，即表示您同意遵守商城规则，并对您提交的信息和账号操作负责。</p>',
  privacy: '<h3>隐私政策</h3><p>我们仅在提供账号、订单、支付及售后服务所需范围内处理您的个人信息，并采取合理措施保护信息安全。</p>',
});
const agreementVisible = ref(false);
// 邀请码是否必填，由后台「交易设置 → 注册必须填邀请码」控制
const requireCode = ref(true);
const activeAgreement = ref('user');
// 协议内容来自后台配置，渲染前净化
const agreementContent = computed(() => sanitizeHtml(agreements.value[activeAgreement.value]) || '<p>暂无协议内容</p>');

function openAgreement(type) {
  activeAgreement.value = type;
  agreementVisible.value = true;
}
function acceptAgreement() {
  agreed.value = true;
  agreementVisible.value = false;
}

async function submit() {
  if (!/^1\d{10}$/.test(form.phone)) return showToast('请输入正确的手机号');
  if (form.password.length < 6) return showToast('密码至少 6 位');
  if (requireCode.value && !form.code) return showToast('请输入邀请码');
  if (!agreed.value) return showToast('请先阅读并同意用户协议与隐私政策');
  loading.value = true;
  try {
    const r = await api.register(form);
    localStorage.setItem('TOKEN', r.data.token);
    showToast('注册成功');
    setTimeout(() => router.replace('/'), 400);
  } catch {
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  try {
    const r = await api.registerAgreements();
    if (r.data?.user) agreements.value.user = r.data.user;
    if (r.data?.privacy) agreements.value.privacy = r.data.privacy;
    if (r.data?.require_invite_code !== undefined) requireCode.value = String(r.data.require_invite_code) === '1';
  } catch {}
});
</script>

<style scoped>
.reg { min-height:100vh;min-height:100dvh;max-width:520px;margin:0 auto;background:#f4f5f7;position:relative;overflow:hidden;padding-bottom:max(28px,env(safe-area-inset-bottom)); }
.reg__hero { position:relative;min-height:244px;padding:max(28px,env(safe-area-inset-top)) 24px 66px;color:#fff;background:linear-gradient(145deg, var(--brand-hero-1) 0%, var(--brand-hero-2) 48%, var(--brand-hero-3) 100%);border-radius:0 0 30px 30px; }
.reg__back { display:grid;place-items:center;width:40px;height:40px;margin:0 0 22px -9px;border:1px solid rgba(255,255,255,.24);border-radius:13px;background:rgba(255,255,255,.14);color:#fff;cursor:pointer; }
.reg__eyebrow { font-size:10px;font-weight:700;letter-spacing:2px;opacity:.72; }
.reg__brand { display:flex;align-items:center;gap:10px;margin-top:9px; }
.reg__logo { display:flex;align-items:center;justify-content:center;width:45px;height:45px;flex:none;overflow:hidden;border:1px solid rgba(255,255,255,.32);border-radius:14px;background:rgba(255,255,255,.17);box-shadow:0 6px 18px rgba(125,30,17,.12); }
.reg__logo img { width:100%;height:100%;object-fit:contain;padding:3px;background:#fff;border-radius:12px; }
.reg__brand-name { color:#fff;font-size:19px;font-weight:700;letter-spacing:.5px; }
.reg__lead { margin-top:9px;font-size:12px;letter-spacing:.3px;opacity:.85; }
.reg__content { position:relative;margin:-44px 14px 0; }
.reg__card { padding:23px 20px 21px;border:1px solid rgba(255,255,255,.85);border-radius:22px;background:#fff;box-shadow:0 18px 44px rgba(32,38,48,.1),0 2px 8px rgba(32,38,48,.03); }
.reg__card-title { color:#222831;font-size:21px;line-height:1.3;font-weight:750; }
.reg__card-desc { margin:5px 0 20px;color:#89909b;font-size:12.5px; }
.reg__field { display:block;margin-bottom:14px; }
.reg__field > span { display:block;margin:0 0 7px 2px;color:#727b88;font-size:12px;font-weight:600; }
.reg__field i { color:#e45443;font-style:normal;margin-left:2px; }
.reg__field small { margin-left:5px;color:#a2a8b2;font-size:11px;font-weight:400; }
.reg__field input { display:block;width:100%;height:47px;padding:0 14px;border:1px solid #e8ebf0;border-radius:12px;background:#f8f9fb;color:#303641;font-family:var(--font);font-size:14px;outline:none;transition:border-color .16s,box-shadow .16s,background .16s; }
.reg__field input::placeholder { color:#aab0ba; }
.reg__field input:focus { border-color:#ff806b;background:#fff;box-shadow:0 0 0 3px rgba(var(--brand-rgb),.08); }
.reg__field--last { margin-bottom:0; }
.reg__agreement { display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:3px;margin:15px 0 13px;color:#969da7;font-size:10.5px;line-height:1.55; }
.reg__agreement input { width:15px;height:15px;margin:0 4px 0 0;accent-color:#e45443; }
.reg__agreement label { cursor:pointer; }
.reg__agreement > button { padding:0;border:0;background:none;color:#d94c39;font:inherit;cursor:pointer; }
.reg__agreement-popup { padding:20px 18px calc(18px + env(safe-area-inset-bottom)); }
.reg__agreement-head { display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;font-size:16px;color:#252a32; }
.reg__agreement-head button { width:30px;height:30px;border:0;border-radius:50%;background:#f3f4f6;color:#707985;font-size:22px;line-height:1; }
.reg__agreement-content { max-height:55vh;overflow:auto;color:#515966;font-size:13px;line-height:1.8;white-space:pre-line; }
.reg__agreement-content :deep(p) { margin:0 0 10px; }
.reg__agreement-content :deep(h3) { margin:12px 0 8px;color:#252a32;font-size:14px; }
.reg__agreement-confirm { margin-top:16px; }
.reg__submit { height:49px;border-radius:15px;box-shadow:0 8px 18px rgba(var(--brand-rgb),.2);font-size:15px;font-weight:650; }
.reg__submit:disabled { opacity:.68;box-shadow:none; }
.reg__login { margin-top:18px;color:#818995;font-size:13px;text-align:center;cursor:pointer; }
.reg__login b { color:var(--brand-dark);font-weight:650; }
@media(max-width:360px) { .reg__content { margin-left:10px;margin-right:10px; }.reg__card { padding-left:17px;padding-right:17px; } }
</style>
