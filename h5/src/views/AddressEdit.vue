<template>
  <div class="page addredit">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">{{ id ? '编辑地址' : '新增地址' }}</div>
    </div>

    <div class="section-pad" style="padding-top: 12px">
      <div class="form-card">
        <div class="form-row">
          <div class="form-row__label">收货人<span class="req">*</span></div>
          <div class="form-row__ctrl"><input v-model="form.name" placeholder="请输入姓名" /></div>
        </div>
        <div class="form-row">
          <div class="form-row__label">手机号<span class="req">*</span></div>
          <div class="form-row__ctrl"><input v-model="form.mobile" type="tel" maxlength="11" placeholder="请输入手机号" /></div>
        </div>
        <div class="form-row">
          <div class="form-row__label">所在地区<span class="req">*</span></div>
          <div class="form-row__ctrl region-ctrl" @click="showPicker = true">
            <span :class="{ ph: !regionText }">{{ regionText || '请选择省 / 市 / 区' }}</span>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="m9 5 7 7-7 7" stroke="#c4c8d0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </div>
        </div>
        <div class="form-row">
          <div class="form-row__label">详细地址<span class="req">*</span></div>
          <div class="form-row__ctrl"><textarea v-model="form.detail" rows="2" placeholder="街道、门牌号等" /></div>
        </div>
        <div class="form-row">
          <div class="form-row__label">设为默认</div>
          <div class="form-row__ctrl">
            <van-switch v-model="form.is_default" size="20" active-color="var(--brand)" :active-value="1" :inactive-value="0" />
          </div>
        </div>
      </div>

      <button class="btn-main" style="margin-top: 18px" :disabled="loading" @click="save">
        {{ loading ? '保存中…' : '保存地址' }}
      </button>
    </div>

    <van-popup v-model:show="showPicker" position="bottom" round>
      <van-picker
        :columns="columns"
        @cancel="showPicker = false"
        @confirm="onConfirm"
        title="选择地区"
      />
    </van-popup>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast } from 'vant';
import { api } from '../api.js';

const route = useRoute();
const router = useRouter();
const id = route.query.id ? Number(route.query.id) : 0;
const form = reactive({ name: '', mobile: '', province: '', city: '', district: '', detail: '', is_default: 0 });
const showPicker = ref(false);
const regions = ref([]);
const loading = ref(false);

const regionText = computed(() =>
  [form.province, form.city, form.district].filter(Boolean).join(' / '),
);

const columns = computed(() =>
  regions.value.map((p) => ({
    text: p.name,
    value: p.name,
    children: (p.city || []).map((c) => ({
      text: c.name,
      value: c.name,
      children: (c.region || []).map((d) => ({ text: d.name, value: d.name })),
    })),
  })),
);

function onConfirm({ selectedOptions }) {
  const [p, c, d] = selectedOptions || [];
  form.province = p?.text || '';
  form.city = c?.text || '';
  form.district = d?.text || '';
  showPicker.value = false;
}

async function save() {
  if (!form.name) return showToast('请输入收货人');
  if (!/^1\d{10}$/.test(form.mobile)) return showToast('请输入正确的手机号');
  if (!form.detail) return showToast('请输入详细地址');
  loading.value = true;
  try {
    if (id) await api.addressEdit({ address_id: id, ...form });
    else await api.addressAdd(form);
    showToast('保存成功');
    setTimeout(() => router.back(), 500);
  } catch {
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  try {
    const r = await api.regions();
    regions.value = r.data || [];
  } catch {}
  if (id) {
    try {
      const r = await api.addressDetail(id);
      Object.assign(form, r.data || {});
    } catch {}
  }
});
</script>

<style scoped>
.addredit { background: var(--bg); }
.region-ctrl {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 0;
  font-size: 14px;
}
.region-ctrl .ph { color: var(--text-4); }
</style>
