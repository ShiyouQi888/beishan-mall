<template>
  <div>
    <div class="page-head">
      <div>
        <h2>抢购专场配置</h2>
        <div class="desc">设置该专场的标题、配图、限购与转拍时限；开放时间由「交易设置」统一控制</div>
      </div>
      <el-button @click="$router.back()">返回列表</el-button>
    </div>

    <div class="panel" v-loading="loading">
      <el-form label-width="150px" label-position="right" class="cfg-form">
        <!-- 开放时间：全站统一，这里只展示 -->
        <el-form-item label="开放时间">
          <div class="window-info">
            <b>{{ windowText }}</b>
            <span>对所有场次生效 · <a @click="goTrade">去交易设置修改</a></span>
          </div>
        </el-form-item>

        <!-- 限购 -->
        <el-form-item label="每场每人限购次数" required>
          <el-input-number v-model="form.buy_num" :min="1" :max="999" controls-position="right" style="width: 200px" />
          <span class="unit">次</span>
        </el-form-item>

        <!-- 转拍时限 -->
        <el-form-item label="转拍延长时间(小时)" required>
          <el-input-number v-model="form.transposition_hours" :min="0" :max="720" controls-position="right" style="width: 200px" />
          <span class="unit">小时（0 = 不限）</span>
        </el-form-item>

        <!-- 标题 -->
        <el-form-item label="专场标题" required>
          <el-input v-model="form.title_main" placeholder="抢购专场" style="max-width: 460px" />
        </el-form-item>

        <!-- 专区图片 -->
        <el-form-item label="专区图片" required>
          <ImageUploader v-model="form.image_ordinary" :upload="uploadImage" />
          <div class="hint">前台场次横幅按 3:1 显示，推荐尺寸：1080×360 px。裁剪时可选「横幅 3:1」，并将主体放在画面中间；图片会在浏览器内转 WebP 并压缩后上传。</div>
        </el-form-item>

        <el-form-item>
          <el-button type="primary" size="large" :loading="saving" @click="save">确认提交</el-button>
        </el-form-item>
      </el-form>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { adminApi } from '../api.js';
import http from '../api.js';
import ImageUploader from '../components/ImageUploader.vue';

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const saving = ref(false);

const form = reactive({
  specialarea_id: 0,
  name: '',
  title_main: '',
  title_ordinary: '',
  buy_num: 10,
  transposition_hours: 10,
  image_ordinary: '',
});

// 开放时间全站统一（交易设置 → 抢购总时间），这里只读展示，避免手输格式出错
const windowText = ref('');
const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const hm = (sec) => `${String(Math.floor(Number(sec || 0) / 3600)).padStart(2, '0')}:${String(Math.floor((Number(sec || 0) % 3600) / 60)).padStart(2, '0')}`;

async function loadWindow() {
  try {
    const r = await http.get('/setting/trade');
    const v = r.data?.values || {};
    const days = String(v.buy_open_days || '1,2,3,4,5,6,7').split(',').map((x) => Number(x)).filter((n) => n >= 1 && n <= 7);
    const start = Number(v.buy_start_time || 0);
    const end = Number(v.buy_end_time || 0);
    const daysText = days.length === 0 || days.length === 7 ? '每天' : days.map((d) => `周${DAY_NAMES[d - 1]}`).join(' ');
    windowText.value = `${daysText} · ${hm(start)} ~ ${end ? hm(end) : '不限时'}`;
  } catch {
    windowText.value = '读取失败，请到交易设置查看';
  }
}

const goTrade = () => router.push('/setting/trade');

async function uploadImage(file) {
  const r = await adminApi.upload(file);
  return r.data.url;
}

async function load() {
  const id = Number(route.params.id);
  if (!id) return;
  loading.value = true;
  try {
    const resp = await http.get('/specialarea/detail', { params: { id } });
    const d = resp.data || {};
    Object.assign(form, {
      specialarea_id: d.specialarea_id,
      name: d.name || '',
      title_main: d.title_main || '',
      title_ordinary: d.title_ordinary || '',
      buy_num: Number(d.buy_num || 1),
      transposition_hours: Number(d.transposition_hours || 0),
      image_ordinary: d.image_ordinary || '',
    });
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!form.title_main) return ElMessage.warning('请填写专场标题');
  if (!form.image_ordinary) return ElMessage.warning('请上传专区图片');

  saving.value = true;
  try {
    const r = await http.post('/specialarea/save', {
        specialarea_id: form.specialarea_id,
        name: form.name,
        title_main: form.title_main,
        title_ordinary: form.title_ordinary,
        buy_num: form.buy_num,
        transposition_hours: form.transposition_hours,
        image_ordinary: form.image_ordinary,
      });
    if (r.code === 1) {
      ElMessage.success('保存成功');
      setTimeout(() => router.push('/specialarea'), 600);
    } else ElMessage.warning(r.msg);
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  load();
  loadWindow();
});
</script>

<style scoped>
.cfg-form { max-width: 760px; padding: 10px 0 4px; }
.cfg-form :deep(.el-form-item) { margin-bottom: 24px; }

.window-info { display: flex; flex-direction: column; gap: 4px; }
.window-info b { font-size: 14px; color: #22252b; letter-spacing: 0.3px; }
.window-info span { font-size: 12px; color: #a8adb7; }
.window-info a { color: #ff513a; cursor: pointer; }
.window-info a:hover { text-decoration: underline; }

.unit { margin-left: 10px; font-size: 12.5px; color: #8c93a0; }

.hint { width: 100%; font-size: 12px; color: #a8adb7; margin-top: 7px; line-height: 1.5; }

.uploader { display: flex; align-items: center; gap: 12px; }
.up-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 38px;
  padding: 0 18px;
  border-radius: 8px;
  background: linear-gradient(135deg, #ff6a4d, #ff513a);
  color: #fff;
  font-size: 13.5px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 3px 10px rgba(255, 81, 58, 0.22);
}
.up-btn:hover { opacity: 0.92; }

.preview {
  width: 100%;
  margin-top: 12px;
}
.preview img {
  width: 132px;
  height: 132px;
  border-radius: 10px;
  object-fit: cover;
  background: #f4f6f9;
  border: 1px solid #eef0f3;
}
</style>
