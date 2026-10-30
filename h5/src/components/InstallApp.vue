<template>
  <transition name="install-slide">
    <div v-if="visible" class="install">
      <div class="install__icon">
        <img v-if="store.logo" :src="store.logo" alt="" />
        <svg v-else viewBox="0 0 32 32" width="22" height="22" fill="none" aria-hidden="true">
          <path d="M9.5 13.5h13l-1.1 10.6a1.6 1.6 0 0 1-1.6 1.4h-7.6a1.6 1.6 0 0 1-1.6-1.4L9.5 13.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
          <path d="M12.6 13.5a3.4 3.4 0 0 1 6.8 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </div>
      <div class="install__text">
        <b>{{ title }}</b>
        <small>{{ subtitle }}</small>
      </div>
      <button class="install__go" type="button" @click="act">{{ actionText }}</button>
      <button class="install__close" type="button" aria-label="不再提示" @click="dismiss">×</button>
    </div>
  </transition>

  <!-- iOS / 微信里没有安装接口，用图文说明 -->
  <van-popup v-model:show="guideVisible" round position="bottom" :style="{ padding: '20px 20px 28px' }">
    <div class="guide">
      <h3>添加到桌面</h3>
      <p v-if="inWeChat">当前在微信里打开，需要先点右上角「···」→ <b>在浏览器打开</b>，再按下面步骤添加。</p>
      <ol>
        <li>点浏览器底部（或顶部）的 <b>分享</b> 按钮</li>
        <li>在菜单里选择 <b>添加到主屏幕</b></li>
        <li>确认后会像 App 一样出现在桌面，点开即可逛商城</li>
      </ol>
      <button class="guide__ok" type="button" @click="guideVisible = false">知道了</button>
    </div>
  </van-popup>
</template>

<script setup>
import { computed, inject, onMounted, ref } from 'vue';

const STORE_HIDE_DAYS = 7;
const KEY = 'INSTALL_HINT_TS';

const store = inject('storeInfo', ref({}));
const visible = ref(false);
const guideVisible = ref(false);
const deferred = ref(null);

const ua = navigator.userAgent;
const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const inWeChat = /micromessenger/i.test(ua);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const name = computed(() => store.value?.name || '商城');
const title = computed(() => `把${name.value}添加到桌面`);
const subtitle = computed(() => (isIOS ? '像 App 一样打开，不用每次找网址' : '一键打开，免安装'));
const actionText = computed(() => (deferred.value ? '添加' : '怎么加'));

function hide(days = STORE_HIDE_DAYS) {
  visible.value = false;
  localStorage.setItem(KEY, String(Date.now() + days * 86400000));
}

function dismiss() {
  hide();
}

async function act() {
  if (deferred.value) {
    deferred.value.prompt();
    try {
      await deferred.value.userChoice;
    } catch {}
    deferred.value = null;
    hide(30); // 已经装过的，一个月内别再烦
    return;
  }
  guideVisible.value = true;
}

onMounted(() => {
  if (standalone) return; // 已经是从桌面打开的
  const until = Number(localStorage.getItem(KEY) || 0);
  if (until > Date.now()) return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred.value = e;
    visible.value = true;
  });
  window.addEventListener('appinstalled', () => hide(30));

  // iOS / 微信不会触发 beforeinstallprompt，用延时兜底提示（避免首屏就弹）
  if (isIOS || inWeChat) setTimeout(() => { if (!deferred.value) visible.value = true; }, 2600);
});
</script>

<style scoped>
.install {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--tabbar-h, 54px) + 10px);
  width: min(calc(100vw - 24px), 406px);
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(10px);
  box-shadow: 0 8px 26px rgba(24, 28, 36, 0.14), 0 0 0 1px rgba(24, 28, 36, 0.05);
}
.install__icon {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, var(--brand-light, #ff6a4d), var(--brand));
}
.install__icon img { width: 100%; height: 100%; object-fit: contain; border-radius: inherit; background: #fff; padding: 3px; }
.install__text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.install__text b { font-size: 12.5px; font-weight: 600; color: var(--text-1); }
.install__text small { font-size: 11px; color: var(--text-3); }
.install__go {
  flex: none;
  height: 30px;
  padding: 0 14px;
  border: 0;
  border-radius: 15px;
  background: var(--brand);
  color: #fff;
  font-family: var(--font);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.install__close {
  flex: none;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 50%;
  background: #f2f4f7;
  color: var(--text-3);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.guide h3 { margin: 0 0 10px; font-size: 16px; }
.guide p { margin: 0 0 12px; font-size: 12.5px; color: var(--text-2); line-height: 1.7; }
.guide ol { margin: 0; padding-left: 20px; font-size: 12.5px; color: var(--text-2); line-height: 2; list-style: decimal; }
.guide li { list-style: decimal; }
.guide b { color: var(--brand); }
.guide__ok {
  width: 100%;
  height: 44px;
  margin-top: 16px;
  border: 0;
  border-radius: 12px;
  background: var(--brand);
  color: #fff;
  font-family: var(--font);
  font-size: 14.5px;
  font-weight: 600;
  cursor: pointer;
}

.install-slide-enter-active, .install-slide-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.install-slide-enter-from, .install-slide-leave-to { opacity: 0; transform: translate(-50%, 8px); }
</style>
