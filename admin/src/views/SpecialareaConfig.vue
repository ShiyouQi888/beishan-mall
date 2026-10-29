<template>
  <div>
    <div class="page-head">
      <div>
        <h2>抢购专场配置</h2>
        <div class="desc">设置该专场的开启日期、抢购时段、限购与转拍时限</div>
      </div>
      <el-button @click="$router.back()">返回列表</el-button>
    </div>

    <div class="panel" v-loading="loading">
      <el-form label-width="150px" label-position="right" class="cfg-form">
        <!-- 开启日期 -->
        <el-form-item label="开启日期" required>
          <div class="days">
            <button
              v-for="d in dayOptions"
              :key="d.v"
              type="button"
              class="day-btn"
              :class="{ on: days.includes(d.v) }"
              @click="toggleDay(d.v)"
            >{{ d.t }}</button>
          </div>
          <div class="hint">点击切换，实心为开启，灰色为关闭</div>
        </el-form-item>

        <!-- 抢购时间 -->
        <el-form-item label="抢购专场时间" required>
          <div class="time-row">
            <el-input v-model="form.startText" placeholder="10:18:00" class="time-input" @blur="normalize('startText')" />
            <span class="tilde">~</span>
            <el-input v-model="form.endText" placeholder="20:10:00" class="time-input" @blur="normalize('endText')" />
          </div>
          <div class="hint">每日在该时段内开放抢购，格式 时:分:秒</div>
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

const dayOptions = [
  { v: 1, t: '周一' }, { v: 2, t: '周二' }, { v: 3, t: '周三' }, { v: 4, t: '周四' },
  { v: 5, t: '周五' }, { v: 6, t: '周六' }, { v: 7, t: '周日' },
];

const days = ref([1, 2, 3, 4, 5, 6, 7]);
const form = reactive({
  specialarea_id: 0,
  name: '',
  title_main: '',
  title_ordinary: '',
  startText: '10:18:00',
  endText: '20:10:00',
  buy_num: 10,
  transposition_hours: 10,
  image_ordinary: '',
});

const pad = (n) => String(n).padStart(2, '0');
const secToText = (sec) => {
  const n = Number(sec) || 0;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
};
const textToSec = (txt) => {
  const m = String(txt).trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3] || 0);
  if (h > 23) return null;
  if (mi > 59) return null;
  if (s > 59) return null;
  return h * 3600 + mi * 60 + s;
};

function normalize(key) {
  const sec = textToSec(form[key]);
  if (sec === null) {
    ElMessage.warning('时间格式应为 时:分:秒，例如 10:18:00');
    return;
  }
  form[key] = secToText(sec);
}

function toggleDay(v) {
  if (days.value.includes(v)) {
    if (days.value.length === 1) return ElMessage.warning('至少保留一天');
    days.value = days.value.filter((x) => x !== v);
  } else {
    days.value = [...days.value, v].sort((a, b) => a - b);
  }
}

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
      startText: secToText(d.start_time),
      endText: secToText(d.end_time),
      buy_num: Number(d.buy_num || 1),
      transposition_hours: Number(d.transposition_hours || 0),
      image_ordinary: d.image_ordinary || '',
    });
    days.value = String(d.open_days || '1,2,3,4,5,6,7')
      .split(',').map(Number).filter((x) => x >= 1 && x <= 7);
    if (!days.value.length) days.value = [1, 2, 3, 4, 5, 6, 7];
  } finally {
    loading.value = false;
  }
}

async function save() {
  const st = textToSec(form.startText);
  const et = textToSec(form.endText);
  if (st === null || et === null) return ElMessage.warning('请填写正确的抢购时间');
  if (st >= et) return ElMessage.warning('结束时间必须晚于开始时间');
  if (!form.title_main) return ElMessage.warning('请填写专场标题');
  if (!form.image_ordinary) return ElMessage.warning('请上传专区图片');

  saving.value = true;
  try {
    const r = await http.post('/specialarea/save', {
        specialarea_id: form.specialarea_id,
        name: form.name,
        title_main: form.title_main,
        title_ordinary: form.title_ordinary,
        start_time: st,
        end_time: et,
        open_days: days.value.join(','),
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

onMounted(load);
</script>

<style scoped>
.cfg-form { max-width: 760px; padding: 10px 0 4px; }
.cfg-form :deep(.el-form-item) { margin-bottom: 24px; }

.days { display: flex; gap: 10px; flex-wrap: wrap; }
.day-btn {
  min-width: 62px;
  height: 38px;
  border-radius: 8px;
  border: 1px solid #e4e7ed;
  background: #f4f5f7;
  color: #7d848f;
  font-size: 13.5px;
  font-family: var(--font);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}
.day-btn:hover { border-color: #ffb3a6; color: #ff513a; }
.day-btn.on {
  background: linear-gradient(135deg, #ff6a4d, #ff513a);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 3px 10px rgba(255, 81, 58, 0.24);
}

.time-row { display: flex; align-items: center; gap: 12px; }
.time-input { width: 170px; }
.time-input :deep(input) { font-variant-numeric: tabular-nums; letter-spacing: 1px; }
.tilde { color: #a8adb7; }

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
