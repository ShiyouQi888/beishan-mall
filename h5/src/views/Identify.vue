<template>
  <div class="page identify">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">实名认证</div>
    </div>

    <div class="section-pad" style="padding-top: 14px">
      <div class="id-status" :class="{ ok: status === 1 }">
        <span class="ico">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <path d="m5 12.5 4.2 4.2L19 6.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <div>
          <div class="t">{{ status === 1 ? '已完成实名认证' : status === 2 ? '审核中' : '未完成实名认证' }}</div>
          <div class="d">{{ status === 1 ? '您的账号已通过实名核验' : status === 2 ? '资料已提交，请耐心等待审核' : '完成实名后可参与抢购及提现' }}</div>
        </div>
      </div>

      <template v-if="status !== 1">
        <div class="form-card" style="margin-top: 14px">
          <div class="form-row">
            <div class="form-row__label">真实姓名<span class="req">*</span></div>
            <div class="form-row__ctrl"><input v-model="form.real_name" placeholder="请输入身份证姓名" /></div>
          </div>
          <div class="form-row">
            <div class="form-row__label">身份证号<span class="req">*</span></div>
            <div class="form-row__ctrl"><input v-model="form.idcard" maxlength="18" placeholder="请输入 18 位身份证号" /></div>
          </div>
        </div>

        <div class="upload-row">
          <div class="up" v-for="u in uploads" :key="u.k">
            <ImageUploader :model-value="form[u.k]" :upload="uploadImage" @update:model-value="form[u.k] = $event" />
            <div class="up__label">{{ u.t }}</div>
          </div>
        </div>

        <button class="btn-main" style="margin-top: 18px" :disabled="loading" @click="submit">
          {{ loading ? '提交中…' : '提交认证' }}
        </button>
      </template>

      <div class="id-tip">
        <p>· 您的身份信息仅用于实名核验，平台将严格保密。</p>
        <p>· 请确保姓名与身份证号完全一致，否则审核不通过。</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { showToast } from 'vant';
import { api } from '../api.js';
import ImageUploader from '../components/ImageUploader.vue';

const form = reactive({ real_name: '', idcard: '', front_image: '', back_image: '', hand_image: '' });
const status = ref(0);
const loading = ref(false);
const uploads = [
  { k: 'front_image', t: '身份证正面' },
  { k: 'back_image', t: '身份证反面' },
  { k: 'hand_image', t: '手持身份证' },
];

async function uploadImage(file) {
  const r = await api.upload(file);
  return r.data.url;
}

async function submit() {
  if (!form.real_name) return showToast('请输入真实姓名');
  if (!/^\d{17}[\dXx]$/.test(form.idcard)) return showToast('请输入正确的身份证号');
  loading.value = true;
  try {
    await api.certify(form);
    showToast('提交成功，等待审核');
    status.value = 2;
  } catch {
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  try {
    const [s, m] = await Promise.allSettled([api.certifyStatus(), api.me()]);
    if (m.status === 'fulfilled') {
      const d = m.value.data || {};
      status.value = d.is_certification || 0;
      form.real_name = d.certification_name || '';
    }
  } catch {}
});
</script>

<style scoped>
.identify { background: var(--bg); }
.id-status {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border-radius: 14px;
  background: #fff;
  box-shadow: var(--shadow);
}
.id-status .ico {
  width: 42px; height: 42px;
  border-radius: 13px;
  background: #f5f6f8;
  color: #b5bcc6;
  display: flex; align-items: center; justify-content: center;
  flex: none;
}
.id-status.ok .ico { background: #eefaf3; color: #2eb872; }
.id-status .t { font-size: 15px; font-weight: 650; }
.id-status .d { font-size: 12px; color: var(--text-3); margin-top: 4px; }

.upload-row { display: flex; gap: 8px; margin-top: 14px; justify-content:space-between; }
.up { min-width:0; }
.up__label { font-size: 11.5px; color: var(--text-3); text-align: center; margin-top: 6px; }

.id-tip { font-size: 11.5px; color: var(--text-4); line-height: 1.8; margin-top: 18px; }
.id-tip p { margin: 0 0 3px; }
</style>
