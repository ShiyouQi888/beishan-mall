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
          <span>点击创建账号即表示您已阅读并同意</span>
          <button type="button" @click="openDoc('contract', 'view')">《{{ contractTitle }}》</button>
          <span>和</span>
          <button type="button" @click="openDoc('privacy', 'view')">《隐私政策》</button>
        </div>
        <button class="btn-main reg__submit" :disabled="loading" @click="submit">{{ loading ? '提交中…' : '创建账号' }}</button>
        <div class="reg__login" @click="$router.replace('/login')">已有账号？<b>去登录</b></div>
      </section>
    </main>

    <van-popup
      v-model:show="docVisible"
      position="bottom"
      round
      close-on-click-overlay
      :style="{ height: '88vh' }"
      class="reg__doc"
      @closed="resetDoc"
    >
      <div class="reg__doc-head">
        <strong>{{ docType === 'privacy' ? '隐私政策' : contractTitle }}</strong>
        <button type="button" aria-label="关闭" @click="docVisible = false">×</button>
      </div>
      <div ref="docBody" class="reg__doc-body" @scroll.passive="onDocScroll">
        <div class="reg__doc-content rich-content" v-html="docContent" />
        <div v-if="needGate" class="reg__doc-tip" :class="{ 'is-done': reachedBottom }">
          {{ reachedBottom ? '已阅读至底部' : '请向下滑动，阅读到合同底部' }}
        </div>
      </div>
      <div class="reg__doc-foot">
        <div v-if="needGate" class="reg__doc-count">
          <template v-if="countdown > 0">强制阅读倒计时 <b>{{ countdown }}</b> 秒</template>
          <template v-else>强制阅读已完成，可确认注册</template>
        </div>
        <button
          class="btn-main reg__doc-btn"
          type="button"
          :disabled="needGate && !gatePassed"
          @click="onDocPrimary"
        >
          {{ docButtonLabel }}
        </button>
      </div>
    </van-popup>
  </div>
</template>

<script setup>
import { computed, inject, reactive, ref, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast } from '../utils/feedback.js';
import { api } from '../api.js';
import { sanitizeHtml } from '../../../shared/sanitize.js';
import { renderRich } from '../../../shared/markdown.js';

const router = useRouter();
const route = useRoute();
const store = inject('storeInfo', ref({}));
const form = reactive({ phone: '', nickName: '', password: '', code: String(route.query.code || '') });
const loading = ref(false);
// 邀请码是否必填，由后台「交易设置 → 注册必须填邀请码」控制
const requireCode = ref(true);

// 《会员服务电子合同》：名称、正文、强制阅读参数全部来自后台「须知配置」
const contractTitle = ref('会员服务电子合同');
const forceRead = ref(true);
const readSeconds = ref(15);
const agreements = ref({
  contract: '<h3>会员服务电子合同</h3><p>欢迎使用本商城服务。注册并使用本服务，即表示您同意遵守商城规则，并对您提交的信息和账号操作负责。</p>',
  privacy: '<h3>隐私政策</h3><p>我们仅在提供账号、订单、支付及售后服务所需范围内处理您的个人信息，并采取合理措施保护信息安全。</p>',
});

const docVisible = ref(false);
const docType = ref('contract'); // contract = 电子合同 / privacy = 隐私政策
const docMode = ref('read');     // read = 注册前必须读完确认；view = 仅查看内容
const docBody = ref(null);
const reachedBottom = ref(false);
const countdown = ref(0);
let tickTimer = null;

// 只有「注册前读合同」这一路才受门控约束，主动点开查看不受限
const needGate = computed(() => docMode.value === 'read' && docType.value === 'contract' && forceRead.value);
const gatePassed = computed(() => !needGate.value || (reachedBottom.value && countdown.value <= 0));
const docContent = computed(() => {
  const raw = agreements.value[docType.value === 'privacy' ? 'privacy' : 'contract'];
  return sanitizeHtml(renderRich(raw)) || '<p>暂无内容</p>';
});
const docButtonLabel = computed(() => {
  if (docMode.value !== 'read') return '我知道了';
  if (!needGate.value) return '确认注册';
  if (!reachedBottom.value) return countdown.value > 0 ? `请阅读至底部（${countdown.value}s）` : '请阅读至底部';
  return countdown.value > 0 ? `确认注册（${countdown.value}s）` : '确认注册';
});

function stopTimer() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function startTimer() {
  stopTimer();
  countdown.value = needGate.value ? Math.max(0, Number(readSeconds.value) || 0) : 0;
  if (countdown.value <= 0) return;
  tickTimer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) stopTimer();
  }, 1000);
}

/** 内容不足一屏时视为已读到底，否则按钮永远点不动 */
function measureBottom() {
  const el = docBody.value;
  if (!el || !docVisible.value) return;
  const h = el.clientHeight;
  if (!h) return; // 弹层还在进场动画里，高度尚未确定
  if (el.scrollHeight - h <= 8) reachedBottom.value = true;
}

function onDocScroll(e) {
  const el = e?.target;
  if (!el || reachedBottom.value) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight <= 12) reachedBottom.value = true;
}

function openDoc(type, mode) {
  docType.value = type;
  docMode.value = mode;
  reachedBottom.value = false;
  countdown.value = 0;
  docVisible.value = true;
  nextTick(() => {
    measureBottom();
    // 进场动画结束后再量一次真实高度
    setTimeout(measureBottom, 320);
  });
  startTimer();
}

function resetDoc() {
  stopTimer();
  countdown.value = 0;
  reachedBottom.value = false;
}

function onDocPrimary() {
  if (docMode.value !== 'read') {
    docVisible.value = false;
    return;
  }
  if (!gatePassed.value) return;
  docVisible.value = false;
  doRegister();
}

function submit() {
  if (!/^1\d{10}$/.test(form.phone)) return showToast('请输入正确的手机号');
  if (form.password.length < 6) return showToast('密码至少 6 位');
  if (requireCode.value && !form.code) return showToast('请输入邀请码');
  // 表单校验通过后先弹合同，读完确认才真正提交注册
  openDoc('contract', 'read');
}

async function doRegister() {
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
    if (r.data?.user) agreements.value.contract = r.data.user;
    if (r.data?.privacy) agreements.value.privacy = r.data.privacy;
    if (r.data?.title) contractTitle.value = r.data.title;
    if (r.data?.force_read !== undefined) forceRead.value = !!r.data.force_read;
    if (r.data?.read_seconds !== undefined) readSeconds.value = Number(r.data.read_seconds) || 0;
    if (r.data?.require_invite_code !== undefined) requireCode.value = String(r.data.require_invite_code) === '1';
  } catch {}
});

onBeforeUnmount(stopTimer);
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
.reg__agreement { display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:3px;margin:15px 0 13px;color:#969da7;font-size:10.5px;line-height:1.55;text-align:center; }
.reg__agreement > button { padding:0;border:0;background:none;color:#d94c39;font:inherit;cursor:pointer; }
.reg__doc { display:flex;flex-direction:column;box-sizing:border-box;padding:16px 16px calc(14px + env(safe-area-inset-bottom)); }
.reg__doc-head { display:flex;flex:none;align-items:center;justify-content:space-between;gap:12px;padding-bottom:11px;border-bottom:1px solid #f0f2f5; }
.reg__doc-head strong { flex:1;min-width:0;overflow:hidden;color:#252a32;font-size:16px;font-weight:700;text-overflow:ellipsis;white-space:nowrap; }
.reg__doc-head button { flex:none;width:30px;height:30px;border:0;border-radius:50%;background:#f3f4f6;color:#707985;font-size:22px;line-height:1;cursor:pointer; }
.reg__doc-body { flex:1;min-height:0;overflow-y:auto;padding:13px 2px 6px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain; }
.reg__doc-content { color:#515966;font-size:13px;line-height:1.85;word-break:break-word; }
.reg__doc-tip { margin:4px 0 2px;padding:8px 10px;border-radius:10px;background:#f5f6f8;color:#98a0ab;font-size:11.5px;text-align:center;transition:background .2s,color .2s; }
.reg__doc-tip.is-done { background:#f0f8f3;color:#4a9463; }
.reg__doc-foot { flex:none;padding-top:12px; }
.reg__doc-count { margin-bottom:9px;color:#969da7;font-size:11.5px;text-align:center; }
.reg__doc-count b { color:#e45443;font-size:13px;font-weight:700; }
.reg__doc-btn { width:100%;height:47px;border-radius:14px;font-size:15px;font-weight:650; }
.reg__doc-btn:disabled { opacity:.55;box-shadow:none;cursor:not-allowed; }
.reg__submit { height:49px;border-radius:15px;box-shadow:0 8px 18px rgba(var(--brand-rgb),.2);font-size:15px;font-weight:650; }
.reg__submit:disabled { opacity:.68;box-shadow:none; }
.reg__login { margin-top:18px;color:#818995;font-size:13px;text-align:center;cursor:pointer; }
.reg__login b { color:var(--brand-dark);font-weight:650; }
@media(max-width:360px) { .reg__content { margin-left:10px;margin-right:10px; }.reg__card { padding-left:17px;padding-right:17px; } }
</style>
