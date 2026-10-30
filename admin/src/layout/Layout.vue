<template>
  <div class="layout">
    <aside class="sidebar" :class="{ collapsed }">
      <div class="brand">
        <div class="brand__logo">
          <img v-if="store.logo" :src="store.logo" alt="商城 Logo" />
          <svg v-else viewBox="0 0 32 32" width="26" height="26">
            <path d="M9 13h14l-1.2 11.4a1.6 1.6 0 0 1-1.6 1.4h-8.4a1.6 1.6 0 0 1-1.6-1.4L9 13Z" stroke="#fff" stroke-width="1.8" stroke-linejoin="round" fill="none" />
            <path d="M12.2 13a3.8 3.8 0 0 1 7.6 0" stroke="#fff" stroke-width="1.8" stroke-linecap="round" fill="none" />
          </svg>
        </div>
        <div class="brand__text" v-show="!collapsed">
          <div class="t">{{ store.name || '北山商城' }}</div>
          <div class="s">管理后台</div>
        </div>
      </div>

      <nav class="menu">
        <template v-for="g in menus" :key="g.label">
          <div class="menu__group" v-show="!collapsed">{{ g.label }}</div>
          <router-link
            v-for="m in g.items"
            :key="m.path"
            :to="m.path"
            class="menu__item"
            :class="{ on: isActive(m.path) }"
            :title="m.title"
          >
            <span class="menu__icon" v-html="menuIcon(m.icon)" />
            <span class="menu__label" v-show="!collapsed">{{ m.title }}</span>
          </router-link>
        </template>
      </nav>
    </aside>

    <div class="main">
      <header class="topbar">
        <button class="collapse-btn" @click="collapsed = !collapsed">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
        <div class="crumb">
          <span class="crumb__root">首页</span>
          <span class="crumb__sep">/</span>
          <span class="crumb__cur">{{ route.meta.title || '' }}</span>
        </div>
        <div class="topbar__right">
          <el-popover v-if="canReceiveNotifications" placement="bottom-end" :width="360" :persistent="false" trigger="click" @show="markNotificationsRead">
            <template #reference>
              <button class="notification-trigger" type="button" aria-label="消息通知">
                <svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">
                  <path d="M18 9a6 6 0 0 0-12 0c0 7-2.5 7-2.5 9h17C20.5 16 18 16 18 9Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
                  <path d="M10 21h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
                </svg>
                <span>消息</span>
                <i v-if="unreadNotificationCount" class="notification-badge">{{ unreadNotificationCount > 99 ? '99+' : unreadNotificationCount }}</i>
              </button>
            </template>
            <div class="notification-panel">
              <div class="notification-panel__head">
                <div><strong>消息通知</strong><small>{{ unreadNotificationCount ? `${unreadNotificationCount} 条未读` : '暂无未读通知' }}</small></div>
                <label class="notification-voice">语音提醒<el-switch v-model="voiceEnabled" size="small" @change="setVoiceEnabled" /></label>
              </div>
              <div v-if="notificationList.length" class="notification-list">
                <button v-for="item in notificationList" :key="item.key" type="button" class="notification-item" @click="openNotification(item)">
                  <span class="notification-item__dot" />
                  <span class="notification-item__main">
                    <strong>{{ notificationTitle(item) }}</strong>
                    <small>{{ notificationDescription(item) }}</small>
                  </span>
                  <b>¥{{ notificationAmount(item) }}</b>
                </button>
              </div>
              <div v-else class="notification-empty">新订单、提现申请或系统回收会显示在这里</div>
              <div class="notification-panel__foot">
                <span v-if="!canUseSpeech">当前浏览器不支持语音播报</span>
                <button v-if="orderListPath" type="button" @click="router.push(orderListPath)">查看订单</button>
                <button v-if="withdrawListPath" type="button" @click="router.push(withdrawListPath)">查看提现</button>
                <button v-if="recycleListPath" type="button" @click="router.push(recycleListPath)">查看回收</button>
                <button v-if="notificationList.length" type="button" @click="clearNotifications">清空</button>
              </div>
            </div>
          </el-popover>
          <a class="visit" :href="shopFrontUrl" target="_blank" rel="noopener noreferrer">访问商城</a>
          <div class="user">
            <div class="avatar">{{ (user.nick || 'A').slice(0, 1) }}</div>
            <span class="uname">{{ user.nick || user.name }}</span>
          </div>
          <button class="pwd" @click="openPwd">修改密码</button>
          <button class="logout" @click="logout">退出</button>
        </div>
      </header>

      <main class="content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
        <footer class="site-footer" v-if="store.copyright || store.icp_number">
          <span v-if="store.copyright">{{ store.copyright }}</span>
          <span v-if="store.icp_number">{{ store.icp_number }}</span>
        </footer>
      </main>
    </div>

    <el-dialog v-model="pwdDlg" title="修改登录密码" width="440px" @closed="resetPwd">
      <el-form ref="pwdFormRef" :model="pwdForm" :rules="pwdRules" label-width="96px">
        <el-form-item label="原密码" prop="old_password">
          <el-input v-model="pwdForm.old_password" type="password" show-password placeholder="当前登录密码" />
        </el-form-item>
        <el-form-item label="新密码" prop="new_password">
          <el-input v-model="pwdForm.new_password" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirm">
          <el-input v-model="pwdForm.confirm" type="password" show-password placeholder="再输入一次新密码" @keyup.enter="submitPwd" />
        </el-form-item>
      </el-form>
      <div class="pwd-tip">改完密码后，当前已登录的会话不会被强制退出；下次登录请使用新密码。</div>
      <template #footer>
        <el-button @click="pwdDlg = false">取消</el-button>
        <el-button type="primary" :loading="pwdSaving" @click="submitPwd">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElNotification } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';
import { adminApi } from '../api.js';
import http from '../api.js';

const route = useRoute();
const router = useRouter();
const collapsed = ref(false);
const user = ref({});
const store = ref({});
const shopFrontUrl = computed(() => {
  const configuredUrl = String(import.meta.env.VITE_H5_URL || '').trim();
  if (configuredUrl) {
    try { return new URL(configuredUrl, window.location.origin).href; } catch {}
  }
  const url = new URL('/', window.location.href);
  url.search = '';
  url.hash = '';
  if (import.meta.env.DEV) url.port = '5273';
  return url.href;
});

// ---- 修改登录密码 ----
const pwdDlg = ref(false);
const pwdSaving = ref(false);
const pwdFormRef = ref(null);
const pwdForm = reactive({ old_password: '', new_password: '', confirm: '' });
const pwdRules = {
  old_password: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  new_password: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, max: 32, message: '新密码 6-32 位', trigger: 'blur' },
  ],
  confirm: [
    { required: true, message: '请再输入一次新密码', trigger: 'blur' },
    {
      validator: (_r, v, cb) => (v === pwdForm.new_password ? cb() : cb(new Error('两次输入的新密码不一致'))),
      trigger: 'blur',
    },
  ],
};

function openPwd() {
  pwdDlg.value = true;
}
function resetPwd() {
  pwdForm.old_password = '';
  pwdForm.new_password = '';
  pwdForm.confirm = '';
  pwdFormRef.value?.clearValidate();
}
async function submitPwd() {
  try {
    await pwdFormRef.value.validate();
  } catch {
    return;
  }
  pwdSaving.value = true;
  try {
    await adminApi.changePassword({ old_password: pwdForm.old_password, new_password: pwdForm.new_password });
    ElMessage.success('密码已修改，下次登录请使用新密码');
    pwdDlg.value = false;
  } catch {
  } finally {
    pwdSaving.value = false;
  }
}

// 菜单由后端 /admin/api/menu 下发（单一数据源：server/src/lib/menu.config.js）
const menus = ref([]);
const voiceEnabled = ref(localStorage.getItem('ADMIN_ORDER_VOICE') !== '0');
const notificationList = ref([]);
const unreadNotificationCount = ref(0);
const canUseSpeech = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
let notificationPollTimer = 0;
let notificationPollBusy = false;
const notificationCursors = new Map();

const isActive = (p) => (p === '/' ? route.path === '/' : route.path === p);
const visibleMenuPaths = () => new Set(menus.value.flatMap((group) => (group.items || []).map((item) => item.path)));
const orderListPath = computed(() => {
  const paths = visibleMenuPaths();
  return paths.has('/orders') ? '/orders' : paths.has('/orders/shop') ? '/orders/shop' : '';
});
const withdrawListPath = computed(() => (visibleMenuPaths().has('/withdraw') ? '/withdraw' : ''));
const recycleListPath = computed(() => (visibleMenuPaths().has('/recycle') ? '/recycle' : ''));
const canReceiveNotifications = computed(() =>
  Boolean(orderListPath.value || withdrawListPath.value || recycleListPath.value));
const menuIcon = (icon = '') => {
  const paths = String(icon).replace(/<\/?svg\b[^>]*>/gi, '');
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
};


function logout() {
  localStorage.removeItem('ADMIN_TOKEN');
  router.push('/login');
}

async function loadStoreInfo() {
  try {
    store.value = await adminApi.storeInfo();
    if (store.value.name) document.title = `${store.value.name} · 管理后台`;
  } catch {}
}

function notificationTargets() {
  const paths = visibleMenuPaths();
  const targets = [];
  if (paths.has('/orders')) targets.push({ key: 'orders:all', kind: 'order', idField: 'order_id', type: 0 });
  else if (paths.has('/orders/shop')) targets.push({ key: 'orders:shop', kind: 'order', idField: 'order_id', type: 3 });
  if (paths.has('/withdraw')) targets.push({ key: 'withdrawals', kind: 'withdrawal', idField: 'withdraw_id' });
  if (paths.has('/recycle')) targets.push({ key: 'recycles', kind: 'recycle', idField: 'recycle_id' });
  return targets;
}

function notificationRoute(item) {
  if (item.kind === 'withdrawal') return withdrawListPath.value || '/';
  if (item.kind === 'recycle') return recycleListPath.value || '/';
  const paths = visibleMenuPaths();
  if ((Number(item.type) === 3 || Number(item.type) === 4) && paths.has('/orders/shop')) return '/orders/shop';
  return orderListPath.value || '/';
}

function speak(text) {
  if (!voiceEnabled.value || !canUseSpeech) return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    const chineseVoice = window.speechSynthesis.getVoices().find((voice) => /^zh(-|_)/i.test(voice.lang));
    if (chineseVoice) utterance.voice = chineseVoice;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  } catch {}
}

function setVoiceEnabled(enabled) {
  voiceEnabled.value = Boolean(enabled);
  localStorage.setItem('ADMIN_ORDER_VOICE', voiceEnabled.value ? '1' : '0');
  if (voiceEnabled.value) speak('消息语音提醒已开启');
  else if (canUseSpeech) window.speechSynthesis.cancel();
}

function markNotificationsRead() {
  unreadNotificationCount.value = 0;
}

function clearNotifications() {
  notificationList.value = [];
  unreadNotificationCount.value = 0;
}

function openNotification(item) {
  router.push(item.route || '/');
}

function notificationTitle(item) {
  if (item.kind === 'recycle') return `${item.goods_name || '商品'} 到顶回收`;
  if (item.kind === 'withdrawal') {
    const member = item.nick_name || `会员 #${item.member_id}`;
    return `${member} 提交了提现申请`;
  }
  return item.goods_name || '新订单';
}

function notificationDescription(item) {
  if (item.kind === 'recycle') {
    const who = item.nick_name || `会员 #${item.member_id}`;
    const state = Number(item.status) === 10 ? '已自动结算' : '待处理';
    return `${who} · 买入 ¥${Number(item.buy_price || 0).toFixed(2)} · ${state} · ${item.create_time}`;
  }
  return item.kind === 'withdrawal'
    ? `提现申请 · ${item.create_time}`
    : `${item.order_no} · ${item.create_time}`;
}

function notificationAmount(item) {
  if (item.kind === 'recycle') return Number(item.recycle_price || 0).toFixed(2);
  return Number(item.kind === 'withdrawal' ? item.amount : item.total_price || 0).toFixed(2);
}

function notifyNewItems(items) {
  if (!items.length) return;
  const ordered = items.slice().sort((a, b) => String(a.create_time || '').localeCompare(String(b.create_time || '')));
  const newest = ordered[ordered.length - 1];
  notificationList.value = [
    ...ordered.slice().reverse().map((item) => ({ ...item, key: `${item.kind}-${item.id}`, route: notificationRoute(item) })),
    ...notificationList.value,
  ].slice(0, 30);
  unreadNotificationCount.value += ordered.length;

  const withdrawalCount = ordered.filter((item) => item.kind === 'withdrawal').length;
  const recycleCount = ordered.filter((item) => item.kind === 'recycle').length;
  const member = newest.nick_name || `会员 #${newest.member_id}`;
  const message = ordered.length === 1
    ? newest.kind === 'withdrawal'
      ? `${member}提交了提现申请，金额 ${Number(newest.amount || 0).toFixed(2)} 元。`
      : newest.kind === 'recycle'
        ? `新的系统回收：${newest.goods_name || '商品'}，回收价 ${Number(newest.recycle_price || 0).toFixed(2)} 元，原持有人${member}。`
        : `收到新订单，${newest.goods_name || '商品'}，金额 ${Number(newest.total_price || 0).toFixed(2)} 元。`
    : `收到 ${ordered.length} 条新消息${
      [recycleCount ? `系统回收 ${recycleCount} 笔` : '', withdrawalCount ? `提现申请 ${withdrawalCount} 笔` : '']
        .filter(Boolean).length
        ? `，其中${[recycleCount ? `系统回收 ${recycleCount} 笔` : '', withdrawalCount ? `提现申请 ${withdrawalCount} 笔` : ''].filter(Boolean).join('、')}`
        : ''
    }，请及时处理。`;
  speak(message);
  const recycleOnly = recycleCount === ordered.length;
  ElNotification({
    title: recycleOnly ? '系统回收提醒' : '新业务消息',
    message,
    type: recycleOnly ? 'warning' : 'success',
    duration: 8000,
    onClick: () => openNotification({ ...newest, route: notificationRoute(newest) }),
  });
}

async function pollNotifications() {
  if (notificationPollBusy || !localStorage.getItem('ADMIN_TOKEN')) return;
  const targets = notificationTargets();
  if (!targets.length) return;
  notificationPollBusy = true;
  const found = [];
  try {
    await Promise.all(targets.map(async (target) => {
      const cursor = notificationCursors.get(target.key);
      const params = {};
      if (target.type) params.type = target.type;
      if (cursor !== undefined) params.after_id = cursor;
      try {
        const request = target.kind === 'withdrawal'
          ? adminApi.withdrawalNotifications(params)
          : target.kind === 'recycle'
            ? adminApi.recycleNotifications(params)
            : adminApi.orderNotifications(params);
        const result = await request;
        const data = result.data || {};
        const latestId = Number(data.latest_id) || 0;
        if (cursor === undefined) {
          notificationCursors.set(target.key, latestId);
          return;
        }
        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length) {
          const normalized = items.map((item) => ({ ...item, id: Number(item[target.idField]), kind: target.kind }));
          notificationCursors.set(target.key, normalized[normalized.length - 1].id || latestId);
          found.push(...normalized);
        } else if (Number.isSafeInteger(latestId) && latestId >= cursor) {
          notificationCursors.set(target.key, latestId);
        }
      } catch {
        // Один通知源短暂失败时，保留其他通知源的结果，下一轮继续重试。
      }
    }));
    notifyNewItems(found);
  } catch {
    // 通知轮询在后台静默失败，下一轮继续重试。
  } finally {
    notificationPollBusy = false;
  }
}

onMounted(async () => {
  loadStoreInfo();
  window.addEventListener('store-config-updated', loadStoreInfo);
  try {
    const r = await adminApi.me();
    user.value = r.data || {};
  } catch {}
  try {
    const m = await http.get('/menu');
    menus.value = m.data?.menus || [];
  } catch {
    menus.value = [];
  }
  if (notificationTargets().length) {
    await pollNotifications();
    notificationPollTimer = window.setInterval(pollNotifications, 15000);
  }
});
onUnmounted(() => {
  window.removeEventListener('store-config-updated', loadStoreInfo);
  if (notificationPollTimer) window.clearInterval(notificationPollTimer);
  if (canUseSpeech) window.speechSynthesis.cancel();
});
</script>

<style scoped>
.layout { display: flex; height: 100vh; background: #f4f6f9; }

.sidebar {
  width: 218px;
  background: #1b2030;
  display: flex;
  flex-direction: column;
  transition: width 0.2s;
  flex: none;
}
.sidebar.collapsed { width: 62px; }

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 60px;
  padding: 0 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex: none;
}
.brand__logo {
  width: 32px; height: 32px;
  border-radius: 9px;
  background: linear-gradient(135deg, #ff6a4d, #e03a24);
  display: flex; align-items: center; justify-content: center;
  flex: none;
}
.brand__logo img { width:100%;height:100%;object-fit:contain;border-radius:inherit;background:#fff;padding:2px; }
.brand__text .t { color: #fff; font-size: 14px; font-weight: 650; letter-spacing: 0.4px; }
.brand__text .s { color: rgba(255, 255, 255, 0.42); font-size: 10.5px; margin-top: 1px; }

.menu { flex: 1; overflow-y: auto; padding: 8px 10px 20px; }
.menu::-webkit-scrollbar { width: 4px; }
.menu::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.12); border-radius: 2px; }
.menu__group {
  font-size: 10.5px;
  color: rgba(255, 255, 255, 0.32);
  padding: 14px 8px 6px;
  letter-spacing: 0.6px;
}
.menu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  padding: 0 10px;
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.66);
  font-size: 13px;
  margin-bottom: 2px;
  transition: all 0.14s;
}
.menu__item:hover { background: rgba(255, 255, 255, 0.06); color: #fff; }
.menu__item.on {
  background: linear-gradient(90deg, rgba(255, 81, 58, 0.9), rgba(255, 81, 58, 0.65));
  color: #fff;
  font-weight: 550;
  box-shadow: 0 3px 10px rgba(255, 81, 58, 0.24);
}
.menu__icon { display: flex; flex: none; width: 20px; height: 20px; align-items: center; justify-content: center; color: currentColor; }
.menu__icon :deep(svg) { display: block; width: 18px; height: 18px; flex: none; }
.menu__label { white-space: nowrap; overflow: hidden; }

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

.topbar {
  height: 56px;
  background: #fff;
  border-bottom: 1px solid #eef1f5;
  display: flex;
  align-items: center;
  padding: 0 18px;
  gap: 14px;
  flex: none;
}
.collapse-btn {
  width: 30px; height: 30px;
  border: none;
  background: transparent;
  color: #6b7280;
  display: flex; align-items: center; justify-content: center;
  border-radius: 7px;
  cursor: pointer;
}
.collapse-btn:hover { background: #f3f5f8; }
.crumb { font-size: 13px; color: #8c93a0; display: flex; gap: 7px; align-items: center; }
.crumb__cur { color: #22252b; font-weight: 550; }
.crumb__sep { opacity: 0.5; }

.topbar__right { margin-left: auto; display: flex; align-items: center; gap: 14px; }
.notification-trigger { position:relative;display:inline-flex;align-items:center;gap:6px;padding:7px 9px;border:0;border-radius:8px;background:transparent;color:#68717e;font:inherit;font-size:12px;cursor:pointer; }
.notification-trigger:hover,.notification-trigger:focus-visible { color:#e24c35;background:#fff2ef;outline:none; }
.notification-badge { position:absolute;top:0;right:0;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:#e64b36;color:#fff;font-size:10px;font-style:normal;font-weight:700;line-height:16px;text-align:center;box-shadow:0 0 0 2px #fff; }
.notification-panel { display:flex;flex-direction:column;gap:8px;color:#29313d; }
.notification-panel__head { display:flex;align-items:center;justify-content:space-between;padding:0 2px 10px;border-bottom:1px solid #edf0f4; }
.notification-panel__head>div { display:flex;flex-direction:column;gap:3px; }
.notification-panel__head strong { font-size:14px; }
.notification-panel__head small { color:#929aa6;font-size:11px; }
.notification-voice { display:flex;align-items:center;gap:7px;color:#67717f;font-size:11px; }
.notification-list { max-height:330px;overflow:auto; }
.notification-item { display:flex;width:100%;align-items:center;gap:9px;padding:10px 2px;border:0;border-bottom:1px solid #f0f2f5;background:#fff;text-align:left;cursor:pointer; }
.notification-item:hover { background:#fafbfc; }
.notification-item__dot { width:7px;height:7px;flex:none;border-radius:50%;background:#f26850; }
.notification-item__main { display:flex;min-width:0;flex:1;flex-direction:column;gap:3px; }
.notification-item__main strong { overflow:hidden;color:#323a46;font-size:12px;font-weight:600;text-overflow:ellipsis;white-space:nowrap; }
.notification-item__main small { color:#9aa1ab;font-size:10px; }
.notification-item>b { flex:none;color:#e24c35;font-size:12px;font-weight:650; }
.notification-empty { padding:28px 0;text-align:center;color:#a0a6b0;font-size:12px; }
.notification-panel__foot { display:flex;align-items:center;justify-content:flex-end;gap:12px;padding-top:5px;color:#9aa1ab;font-size:10px; }
.notification-panel__foot button { padding:3px 0;border:0;background:transparent;color:#e24c35;font:inherit;font-size:11px;cursor:pointer; }
.visit {
  font-size: 12.5px;
  color: #ff513a;
  background: #fff1ee;
  padding: 5px 12px;
  border-radius: 7px;
  font-weight: 500;
}
.user { display: flex; align-items: center; gap: 8px; }
.avatar {
  width: 30px; height: 30px;
  border-radius: 9px;
  background: linear-gradient(135deg, #ff6a4d, #e03a24);
  color: #fff;
  font-size: 13px;
  font-weight: 650;
  display: flex; align-items: center; justify-content: center;
}
.uname { font-size: 13px; color: #34383f; }
.logout {
  border: none;
  background: transparent;
  color: #8c93a0;
  font-size: 12.5px;
  cursor: pointer;
  font-family: var(--font);
}
.logout:hover { color: #d14328; }
.pwd {
  border: none;
  background: transparent;
  color: #8c93a0;
  font-size: 12.5px;
  cursor: pointer;
  font-family: var(--font);
}
.pwd:hover { color: #ff513a; }
.pwd-tip { margin: 2px 0 0 96px; font-size: 12px; color: #8c93a0; line-height: 1.65; }

.content { flex: 1; overflow-y: auto; padding: 18px; }
.site-footer { display:flex;flex-direction:column;align-items:center;gap:3px;padding:18px 12px 4px;color:#a5aab3;font-size:11px;text-align:center;line-height:1.45; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.16s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
