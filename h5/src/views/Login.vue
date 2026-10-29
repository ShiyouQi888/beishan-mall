<template>
  <div class="login">
    <div class="login__bg" />
    <div class="login__brand">
      <div class="login__logo">
        <img v-if="store.logo" :src="store.logo" alt="商城 Logo" />
        <svg v-else viewBox="0 0 48 48" width="46" height="46">
          <rect x="1" y="1" width="46" height="46" rx="13" fill="#fff" opacity=".16" />
          <path d="M15 20h18l-1.6 14.2a2 2 0 0 1-2 1.8H18.6a2 2 0 0 1-2-1.8L15 20Z" stroke="#fff" stroke-width="2.2" stroke-linejoin="round" />
          <path d="M19.5 20a4.5 4.5 0 0 1 9 0" stroke="#fff" stroke-width="2.2" stroke-linecap="round" />
        </svg>
      </div>
      <div class="login__brand-name">{{ store.name || '北山商城' }}</div>
      <div class="login__slogan">精品严选 <i /> 品质生活</div>
    </div>

    <div class="login__card">
      <div class="login__title">登录</div>
      <div class="login__desc">欢迎回来，请登录您的账号</div>

      <div class="field">
        <label>手机号</label>
        <input v-model="phone" type="tel" maxlength="11" placeholder="请输入手机号" />
      </div>
      <div class="field">
        <label>密码</label>
        <input v-model="password" type="password" placeholder="请输入登录密码" @keyup.enter="submit" />
      </div>

      <button class="btn-main" :disabled="loading" @click="submit">
        {{ loading ? '登录中…' : '登 录' }}
      </button>

      <div class="login__foot">
        <span @click="$router.push('/register')">注册新账号</span>
        <span class="dot">·</span>
        <span @click="$router.push('/')">先逛逛</span>
      </div>

      <div class="login__demo">
        测试账号：13822367845 / 密码同手机号
      </div>
    </div>
  </div>
</template>

<script setup>
import { inject, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { showToast } from 'vant';
import { api } from '../api.js';

const router = useRouter();
const route = useRoute();
const phone = ref('');
const password = ref('');
const loading = ref(false);
const store = inject('storeInfo', ref({}));

async function submit() {
  if (!/^1\d{10}$/.test(phone.value)) return showToast('请输入正确的手机号');
  if (!password.value) return showToast('请输入密码');
  loading.value = true;
  try {
    const r = await api.login({ phone: phone.value, password: password.value });
    localStorage.setItem('TOKEN', r.data.token);
    showToast('登录成功');
    setTimeout(() => router.replace(route.query.redirect || '/'), 400);
  } catch {
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login { min-height:100vh;min-height:100dvh;max-width:520px;margin:0 auto;padding-bottom:max(28px,env(safe-area-inset-bottom));background:#f4f5f7;position:relative;overflow:hidden; }
.login__bg { position:absolute;top:0;left:0;right:0;height:328px;background:linear-gradient(145deg,#ff795d 0%,#f04c36 48%,#d83727 100%);border-radius:0 0 32px 32px; }
.login__brand { position:relative;padding:max(46px,calc(env(safe-area-inset-top) + 28px)) 26px 70px;color:#fff; }
.login__logo { display:flex;align-items:center;justify-content:center;width:58px;height:58px;margin-bottom:13px;border:1px solid rgba(255,255,255,.35);border-radius:18px;background:rgba(255,255,255,.18);box-shadow:0 8px 22px rgba(124,30,17,.14);overflow:hidden; }
.login__logo img { width:100%;height:100%;object-fit:contain;border-radius:16px;background:#fff;padding:4px; }
.login__brand-name { font-size:25px;font-weight:750;line-height:1.2;letter-spacing:1.5px;text-shadow:0 2px 8px rgba(123,31,19,.12); }
.login__slogan { display:flex;align-items:center;gap:8px;font-size:12px;opacity:.88;margin-top:8px;letter-spacing:.4px; }
.login__slogan i { width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.75; }
.login__card { position:relative;margin:-47px 16px 0;padding:27px 22px 22px;border:1px solid rgba(255,255,255,.8);border-radius:23px;background:#fff;box-shadow:0 18px 44px rgba(32,38,48,.1),0 2px 8px rgba(32,38,48,.03); }
.login__title { color:#222831;font-size:22px;font-weight:750;line-height:1.25; }
.login__desc { margin:7px 0 23px;color:#89909b;font-size:13px; }
.field { margin-bottom:16px; }
.field label { display:block;margin:0 0 7px 2px;color:#727b88;font-size:12px;font-weight:550; }
.field input { width:100%;height:48px;padding:0 15px;border:1px solid #e8ebf0;border-radius:13px;background:#f8f9fb;font-family:var(--font);font-size:14px;font-weight:450;outline:none;transition:border-color .16s,background .16s,box-shadow .16s; }
.field input:focus { border-color:#ff806b;background:#fff;box-shadow:0 0 0 3px rgba(255,81,58,.08); }
.field input::placeholder { color:#aab0ba; }
.btn-main { height:49px;margin-top:5px;border-radius:15px;box-shadow:0 8px 18px rgba(255,81,58,.2);font-size:15px;font-weight:650; }
.btn-main:disabled { opacity:.68;box-shadow:none; }
.login__foot { display:flex;align-items:center;justify-content:center;gap:8px;margin-top:19px;color:#818995;font-size:13px; }
.login__foot span { cursor:pointer; }
.login__foot span:first-child { color:#db4937;font-weight:600; }
.login__foot .dot { opacity:.4; }
.login__demo { margin-top:20px;padding:10px 12px;border:1px solid #fff0ed;border-radius:11px;background:#fff7f5;color:#c45a49;font-size:11px;text-align:center; }
@media(max-width:360px) { .login__card { margin-left:12px;margin-right:12px;padding-left:18px;padding-right:18px; } }
</style>
