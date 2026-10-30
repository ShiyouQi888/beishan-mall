<template>
  <div>
    <div class="page-head">
      <div>
        <h2>{{ groupTitle }}</h2>
        <div class="desc">{{ groupDesc }}</div>
      </div>
      <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
    </div>

    <div class="panel" v-loading="loading">
      <PosterDesigner v-if="route.params.group === 'poster'" :values="values" :upload="uploadImage" />
      <el-form v-else label-width="174px" label-position="right" class="setting-form">
        <el-form-item v-for="it in items" :key="it.k" :label="it.t">
          <el-switch
            v-if="it.type === 'switch'"
            v-model="values[it.k]"
            :active-value="10"
            :inactive-value="20"
            active-text="开启"
            inactive-text="关闭"
          />
          <el-input
            v-else-if="it.type === 'text' || it.type === 'number'"
            v-model="values[it.k]"
            :type="it.type === 'number' ? 'number' : 'text'"
            style="max-width: 420px"
          />
          <div v-if="it.tip" class="field-tip">{{ it.tip }}</div>
          <el-input
            v-else-if="it.type === 'textarea'"
            v-model="values[it.k]"
            type="textarea"
            :rows="3"
            style="max-width: 560px"
          />
          <el-input
            v-else-if="it.type === 'richtext'"
            v-model="values[it.k]"
            type="textarea"
            :rows="7"
            placeholder="支持 HTML 富文本"
            style="max-width: 620px"
          />
          <div v-else-if="it.type === 'image'" class="upload-inline">
            <div class="image-field">
              <ImageUploader v-model="values[it.k]" :upload="uploadImage" />
              <div class="image-guidance">{{ imageRecommendation(it.k) }}</div>
            </div>
          </div>
        </el-form-item>
      </el-form>
    </div>

    <div class="tip">
      <span class="dot" />
      修改后请点击右上角「保存设置」生效，前端商城刷新后立即读取最新配置。
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { adminApi } from '../api.js';
import ImageUploader from '../components/ImageUploader.vue';
import PosterDesigner from '../components/PosterDesigner.vue';

const route = useRoute();
const items = ref([]);
const values = reactive({});
const loading = ref(false);
const saving = ref(false);

const META = {
  store: { t: '商城设置', d: '商城名称、Logo、客服、版权与备案信息' },
  trade: { t: '交易设置', d: '抢单服务费、转拍涨价与上架费、直推奖（仅一级）、注册与提现规则' },
  pay: { t: '支付设置', d: '支付方式开关与收款码配置' },
  nav: { t: '导航配置', d: '首页、分类、抢购、邀请和个人中心的底部导航开关' },
  storage: { t: '上传配置', d: '文件存储方式、访问域名与大小限制' },
  poster: { t: '海报配置', d: '邀请海报背景、Logo、二维码位置与文案' },
  prompt: { t: '须知配置', d: '注册协议、邀请须知、商城协议、交易协议，以及抢购/转拍/提现须知' },
};

const groupTitle = computed(() => META[route.params.group]?.t || '系统设置');
const groupDesc = computed(() => META[route.params.group]?.d || '');

function imageRecommendation(key) {
  const tips = {
    store_logo: '商城 Logo 推荐 512×512 px（1:1）；透明背景 PNG 或 WebP 更适合浅色、深色页面。',
    customer_service: '客服二维码推荐 600×600 px（1:1）；请保持二维码完整、边缘清晰，避免过度压缩。',
    region_bg_img: '首页背景推荐 1200×675 px（16:9）；主体和文字放在中央安全区。',
    zfb_qr: '支付宝收款码推荐 600×600 px（1:1）；确保二维码边缘完整、可识别。',
    wx_qr: '微信收款码推荐 600×600 px（1:1）；确保二维码边缘完整、可识别。',
    poster_bg: '邀请海报底图推荐 750×1334 px（竖版 9:16）；底部和中部留出二维码、文案叠加空间。',
  };
  return tips[key] || '推荐使用清晰原图；上传前可裁剪并压缩，文字、二维码等内容请保持完整。';
}

async function load() {
  loading.value = true;
  try {
    const r = await adminApi.setting(route.params.group);
    items.value = r.data.items || [];
    const vals = r.data.values || {};
    for (const it of items.value) {
      const raw = vals[it.k];
      // switch 必须与 active-value 同类型，否则会被判定为关闭并在保存时写错值
      const defaults = {
        poster_qr_x: '265', poster_qr_y: '850', poster_qr_size: '220',
        poster_logo_x: '54', poster_logo_y: '60', poster_logo_size: '116',
        poster_title: '邀请好友加入', poster_title_x: '60', poster_title_y: '240', poster_title_size: '54',
        poster_subtitle: '一起分享好物与收益', poster_subtitle_x: '60', poster_subtitle_y: '315', poster_subtitle_size: '30',
        poster_content: '长按识别二维码，立即加入', poster_content_x: '60', poster_content_y: '1190', poster_content_size: '25',
        poster_code_x: '60', poster_code_y: '1280', poster_code_size: '22',
      };
      const defaultSwitches = { nav_invite: 10, require_receiving_account: 20 };
      const switchValue = raw === '' || raw === null || raw === undefined ? (defaultSwitches[it.k] ?? 0) : raw;
      values[it.k] = it.type === 'switch' ? Number(switchValue) : (raw ?? defaults[it.k] ?? '');
    }
  } catch (e) {
    // 组名非法（如手工改地址栏）时接口会 reject，必须兜住：
    // 否则是未捕获的 Promise 异常，页面只剩空白表单且没有任何提示
    items.value = [];
    ElMessage.error(e?.message || '设置组不存在');
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    const payload = {};
    for (const it of items.value) {
      const v = values[it.k];
      payload[it.k] = it.type === 'switch' ? String(v) : v;
    }
    await adminApi.saveSetting({ group: route.params.group, values: payload });
    if (route.params.group === 'store') window.dispatchEvent(new Event('store-config-updated'));
    ElMessage.success('保存成功');
  } catch {
  } finally {
    saving.value = false;
  }
}

async function uploadImage(file) {
  const r = await adminApi.upload(file);
  return r.data.url;
}

watch(() => route.params.group, load);
onMounted(load);
</script>

<style scoped>
.setting-form { max-width: 860px; padding: 8px 0 4px; }
.setting-form :deep(.el-form-item) { margin-bottom: 20px; }
/* 说明文字必须独占一行：否则 switch 行会把它挤在开关右侧 */
.setting-form :deep(.el-form-item__content) { flex-wrap: wrap; }
.thumb-lg { width: 72px; height: 72px; border-radius: 8px; object-fit: cover; background: #f4f6f9; }
.upload-inline { display: flex; align-items: center; gap: 12px; }
.image-field { display:flex;flex-direction:column;align-items:flex-start;gap:7px;max-width:100%; }
.image-guidance { max-width:520px;color:#9299a3;font-size:11px;line-height:1.55; }
.upload-inline input[type='file'] { font-size: 12px; color: #8c93a0; }
.tip {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #8c93a0;
  margin-top: 12px;
}
.tip .dot { width: 6px; height: 6px; border-radius: 50%; background: #ff513a; opacity: 0.6; }
.field-tip { flex: 0 0 100%; max-width: 620px; color: #9299a3; font-size: 11.5px; line-height: 1.55; margin-top: 4px; }
</style>
