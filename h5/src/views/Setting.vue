<template>
  <div class="page setting">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">设置</div>
    </div>

    <div class="section-pad" style="padding-top: 12px">
      <div class="card set-card">
        <div class="set-row" @click="editing = 'nick'">
          <span>昵称</span><span class="val">{{ me.nickName || '—' }}<i class="arrow">›</i></span>
        </div>
        <div class="set-row">
          <span>手机号</span><span class="val">{{ me.mobile || '—' }}</span>
        </div>
        <div class="set-row" @click="editing = 'pwd'">
          <span>登录密码</span><span class="val">修改<i class="arrow">›</i></span>
        </div>
        <div class="set-row" @click="editing = 'paypwd'">
          <span>支付密码</span><span class="val">{{ hasPayPwd ? '已设置' : '未设置' }}<i class="arrow">›</i></span>
        </div>
      </div>

      <div class="card set-card" style="margin-top: 10px">
        <div class="set-row" @click="$router.push('/address')">
          <span>收货地址</span><span class="val"><i class="arrow">›</i></span>
        </div>
        <div class="set-row" @click="$router.push('/address?tab=card')">
          <span>收款账户</span><span class="val"><i class="arrow">›</i></span>
        </div>
        <div class="set-row" @click="$router.push('/notice')">
          <span>平台公告</span><span class="val"><i class="arrow">›</i></span>
        </div>
      </div>

      <div class="set-brand">
        <img v-if="store.logo" :src="store.logo" alt="" />
        <span>{{ store.name || '锦云商城' }} · v1.0.0</span>
      </div>
    </div>

    <van-popup v-model:show="showEdit" position="bottom" round :style="{ padding: '20px 18px 26px' }">
      <div class="pop-title">{{ popTitle }}</div>
      <input v-model="input1" class="pop-input" :placeholder="placeholder1" type="password" v-if="editing === 'pwd' && hasOld" />
      <input v-model="input2" class="pop-input" :placeholder="placeholder2" :type="editing === 'nick' ? 'text' : 'password'" />
      <input v-model="input3" class="pop-input" placeholder="确认新密码" type="password" v-if="editing !== 'nick'" />
      <button class="btn-main" style="margin-top: 14px" @click="save">保存</button>
    </van-popup>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { showToast } from 'vant';
import { api } from '../api.js';

const me = ref({});
const store = ref({});
const editing = ref('');
const input1 = ref('');
const input2 = ref('');
const input3 = ref('');
const hasPayPwd = ref(false);

const showEdit = computed({
  get: () => !!editing.value,
  set: (v) => { if (!v) editing.value = ''; },
});
const hasOld = ref(false);
const popTitle = computed(() => ({ nick: '修改昵称', pwd: '修改登录密码', paypwd: '设置支付密码' }[editing.value] || ''));
const placeholder1 = '原密码';
const placeholder2 = computed(() => (editing.value === 'nick' ? '请输入新昵称' : '请输入新密码（至少6位）'));

watch(editing, (v) => {
  input1.value = '';
  input2.value = '';
  input3.value = '';
  if (v === 'paypwd') hasOld.value = hasPayPwd.value;
  else hasOld.value = false;
});

async function save() {
  try {
    if (editing.value === 'nick') {
      if (!input2.value) return showToast('请输入昵称');
      await api.editMember({ nickName: input2.value });
    } else if (editing.value === 'pwd') {
      if (input2.value.length < 6) return showToast('新密码至少 6 位');
      if (input2.value !== input3.value) return showToast('两次输入不一致');
      await api.editPwd({ newPwd: input2.value });
    } else if (editing.value === 'paypwd') {
      if (input2.value.length < 6) return showToast('密码至少 6 位');
      const http = (await import('../api.js')).default;
      await http.post('/member/verificationPayPassword', { pwd: input2.value });
      hasPayPwd.value = true;
    }
    showToast('保存成功');
    editing.value = '';
    load();
  } catch {}
}

async function load() {
  try {
    const [m, s, p] = await Promise.allSettled([api.me(), api.storeInfo(), api.payPwdStatus()]);
    if (m.status === 'fulfilled') me.value = m.value.data || {};
    if (s.status === 'fulfilled') store.value = s.value.data || {};
    if (p.status === 'fulfilled') hasPayPwd.value = p.value.data === '1';
  } catch {}
}

onMounted(load);
</script>

<style scoped>
.setting { background: var(--bg); }
.set-card { padding: 0 14px; }
.set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
  font-size: 14px;
}
.set-card .set-row:last-child { border-bottom: none; }
.val { font-size: 13.5px; color: var(--text-3); display: flex; align-items: center; gap: 4px; }
.arrow { font-style: normal; color: #c4c8d0; font-size: 17px; margin-left: 2px; }
.set-brand { display:flex;align-items:center;justify-content:center;gap:7px;text-align:center;font-size:11.5px;color:var(--text-4);margin-top:26px; }
.set-brand img { width:20px;height:20px;object-fit:contain;border-radius:5px; }

.pop-title { font-size: 16px; font-weight: 650; margin-bottom: 14px; }
.pop-input {
  width: 100%;
  height: 46px;
  border: 1px solid #ebedf1;
  background: #fafbfc;
  border-radius: 12px;
  padding: 0 14px;
  font-size: 15px;
  font-family: var(--font);
  outline: none;
  margin-bottom: 10px;
}
</style>
