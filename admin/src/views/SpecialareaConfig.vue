<template>
  <div>
    <div class="page-head">
      <div>
        <h2>抢购专场配置</h2>
        <div class="desc">设置该专场的开放日期、抢购时段、限购与转拍时限，并关联本场售卖的商品</div>
      </div>
      <el-button @click="$router.back()">返回列表</el-button>
    </div>

    <div class="panel" v-loading="loading">
      <el-form label-width="150px" label-position="right" class="cfg-form">
        <!-- 开放日期 -->
        <el-form-item label="开放日期" required>
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

        <!-- 抢购时段 -->
        <el-form-item label="抢购时段" required>
          <div class="time-row">
            <el-time-select v-model="form.startText" start="00:00" step="00:01" end="23:59" editable placeholder="开始" style="width: 150px" />
            <span class="tilde">~</span>
            <el-time-select v-model="form.endText" start="00:00" step="00:01" end="23:59" editable clearable placeholder="不限" style="width: 150px" />
          </div>
          <div class="hint">每日在这个时段内开放抢购；结束时间留空表示不限（跨天时段不支持，请拆成两个场次）</div>
        </el-form-item>

        <!-- 限购 -->
        <el-form-item label="每场每人限购件数" required>
          <el-input-number v-model="form.buy_num" :min="1" :max="999" controls-position="right" style="width: 200px" />
          <span class="unit">件</span>
          <div class="hint">本场次内每人最多买这么多件，<b>不同商品合并计算</b>（买 3 件 A + 7 件 B 就满了）。
            同一场次第二天重新计数，换到别的场次不占用这里的额度。</div>
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

        <!-- 副标题 -->
        <el-form-item label="专场副标题">
          <el-input v-model="form.title_ordinary" placeholder="如：正品保障，顺丰包邮" style="max-width: 560px" />
          <div class="hint">前台商品详情页显示的「服务承诺」，用逗号分隔，留空则不显示</div>
        </el-form-item>

        <!-- 专区图片 -->
        <el-form-item label="专区图片" required>
          <ImageUploader v-model="form.image_ordinary" :upload="uploadImage" :presets="[{ label: '推荐 1080 × 360 px', width: 1080, height: 360 }]" />
          <div class="hint">前台场次横幅按 3:1 显示，推荐尺寸：1080×360 px。原图可直接上传（浏览器内自动转 WebP 并等比压缩）；想精确按 3:1 出图时，点缩略图上的「裁剪」并选「横幅 3:1」，主体放在画面中间。</div>
        </el-form-item>

        <!-- 开放预约 -->
        <el-form-item label="开放预约">
          <el-switch v-model="form.is_subscribe" :active-value="10" :inactive-value="0" active-text="开启" inactive-text="关闭" />
          <div class="hint">开启后会员可以在开抢前预约本场</div>
        </el-form-item>

        <!-- 启用状态 -->
        <el-form-item label="启用状态">
          <el-switch v-model="form.is_open" :active-value="10" :inactive-value="20" active-text="启用" inactive-text="停用" />
          <div class="hint">停用后本场不出现在前台抢购页，也不参与下单校验</div>
        </el-form-item>

        <!-- 排序 -->
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" :max="9999" controls-position="right" style="width: 200px" />
          <span class="unit">数字越小越靠前</span>
        </el-form-item>

        <el-form-item>
          <el-button type="primary" size="large" :loading="saving" @click="save">确认提交</el-button>
        </el-form-item>
      </el-form>
    </div>

    <!-- 关联商品：商品不再自带场次，这里才是「本场卖什么」的唯一入口 -->
    <div class="panel related" v-loading="goodsLoading">
      <div class="rel-head">
        <div>
          <h3>
            关联商品
            <span class="rel-count">{{ goodsList.length }} 件</span>
          </h3>
          <div class="hint rel-hint">
            本场次售卖的商品都在这里维护。一件商品可以同时关联多个场次；
            没关联任何场次的商品，相当于首页/分类里随时可买的普通商品，不受场次时段限制。
            <br />
            <b>「开抢日期」标了未来某天的商品，要等到那天才会出现在 H5</b> —— 转拍上架时系统会自动把它排到下一场，
            所以本场关联了 4 件、前台只看到 2 件，多半是另外 2 件排到了明天。
          </div>
        </div>
        <el-button type="primary" plain @click="openPicker">+ 关联商品</el-button>
      </div>

      <el-table :data="goodsList" style="width: 100%" empty-text="这个场次还没有关联任何商品">
        <el-table-column label="图片" width="76">
          <template #default="{ row }">
            <img v-if="row.good_thumb" :src="row.good_thumb" class="rel-thumb" />
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="商品" min-width="200">
          <template #default="{ row }">
            <div class="rel-name">{{ row.goods_name }}</div>
            <div class="rel-no">{{ row.goods_no || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="售卖价" width="110">
          <template #default="{ row }">
            <span class="money">¥{{ Number(row.goods_min_price || 0).toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="库存" width="84">
          <template #default="{ row }">{{ Number(row.stock_num || 0) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="96">
          <template #default="{ row }">
            <span class="tag-status" :class="statusClass(row.goods_status)">{{ statusText(row.goods_status) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="开抢日期" width="118">
          <template #default="{ row }">
            <!-- 商品带开抢日期时，只有到了那天才会在 H5 出现；这是转拍落场用的，
                 运营看不到就会疑惑「明明关联了 4 件，前台只有 2 件」 -->
            <span :class="['open-date', dateClass(row.area_date)]">{{ dateText(row.area_date) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="其它场次" min-width="130">
          <template #default="{ row }">
            <span v-if="row.other_areas">{{ row.other_areas }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="danger" plain @click="removeGoods(row)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 关联商品选择弹窗 -->
    <el-dialog v-model="pickerDlg" title="关联商品到本场次" width="760px" destroy-on-close @opened="focusPicker">
      <div class="pick-bar">
        <el-input
          v-model="pickKeyword"
          placeholder="搜索商品名称 / 编码"
          clearable
          style="width: 250px"
          @keyup.enter="loadCandidates"
          @clear="loadCandidates"
        />
        <el-button @click="loadCandidates">搜索</el-button>
        <div class="spacer" />
        <span class="muted pick-tip">转拍商品的场次由系统按轮转自动维护，不能手动关联</span>
        <span class="muted">已选 {{ picked.length }} 件</span>
      </div>

      <el-table
        ref="pickTableRef"
        :data="candidates"
        height="380"
        v-loading="pickLoading"
        row-key="goods_id"
        empty-text="没有找到商品"
        @selection-change="picked = $event"
      >
        <!-- 转拍货的场次由系统自动维护，这里直接禁选，避免手动挪场 -->
        <el-table-column type="selection" width="44" :selectable="(row) => !row.in_area && !row.blocked" />
        <el-table-column label="图片" width="66">
          <template #default="{ row }">
            <img v-if="row.good_thumb" :src="row.good_thumb" class="rel-thumb" />
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="商品" min-width="190">
          <template #default="{ row }">
            <div class="rel-name">{{ row.goods_name }}</div>
            <div class="rel-no">{{ row.goods_no || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="售卖价" width="104">
          <template #default="{ row }">¥{{ Number(row.goods_min_price || 0).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="库存" width="76">
          <template #default="{ row }">{{ Number(row.stock_num || 0) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <span class="tag-status" :class="statusClass(row.goods_status)">{{ statusText(row.goods_status) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="归属" min-width="180">
          <template #default="{ row }">
            <span v-if="row.in_area" class="tag-status tag-ok">已在本场</span>
            <span v-else-if="row.blocked" class="tag-status tag-warn">转拍货 · {{ row.blocked_reason }}</span>
            <span v-else-if="row.other_areas" class="muted">已在 {{ row.other_areas }}</span>
            <span v-else class="muted">可关联</span>
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="pickerDlg = false">取消</el-button>
        <el-button type="primary" :loading="picking" :disabled="!picked.length" @click="confirmPick">
          确认关联{{ picked.length ? `（${picked.length}）` : '' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
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
  startText: '09:00',
  endText: '',
  buy_num: 10,
  transposition_hours: 10,
  image_ordinary: '',
  is_subscribe: 0,
  is_open: 10,
  sort: 100,
});

const dayOptions = [
  { v: 1, t: '周一' }, { v: 2, t: '周二' }, { v: 3, t: '周三' }, { v: 4, t: '周四' },
  { v: 5, t: '周五' }, { v: 6, t: '周六' }, { v: 7, t: '周日' },
];
const days = ref([1, 2, 3, 4, 5, 6, 7]);

// 秒 ⇄ HH:mm（0 秒要显示 00:00，不能当空值；结束时间空 = 不限）
const secToHm = (sec) => {
  const n = Math.max(0, Number(sec) || 0);
  return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}`;
};
const hmToSec = (txt) => {
  const m = String(txt || '').match(/^(\d{1,2}):(\d{1,2})$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : 0;
};

function toggleDay(v) {
  if (days.value.includes(v)) {
    if (days.value.length === 1) return ElMessage.warning('至少保留一天');
    days.value = days.value.filter((x) => x !== v);
  } else {
    days.value = [...days.value, v].sort((a, b) => a - b);
  }
}

async function uploadImage(file, extra = {}) {
  const r = await adminApi.upload(file, extra);
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
      startText: secToHm(d.start_time),
      endText: Number(d.end_time) ? secToHm(d.end_time) : '',
      buy_num: Number(d.buy_num || 1),
      transposition_hours: Number(d.transposition_hours || 0),
      image_ordinary: d.image_ordinary || '',
      is_subscribe: Number(d.is_subscribe) === 10 ? 10 : 0,
      is_open: Number(d.is_open) === 20 ? 20 : 10,
      sort: Number(d.sort ?? 100),
    });
    days.value = String(d.open_days || '1,2,3,4,5,6,7')
      .split(',').map(Number).filter((x) => x >= 1 && x <= 7);
    if (!days.value.length) days.value = [1, 2, 3, 4, 5, 6, 7];
  } finally {
    loading.value = false;
  }
}

async function save() {
  const st = hmToSec(form.startText);
  const et = form.endText ? hmToSec(form.endText) : 0;
  if (!form.startText) return ElMessage.warning('请选择抢购开始时间');
  if (et && et <= st) return ElMessage.warning('结束时间必须晚于开始时间');
  if (!form.title_main) return ElMessage.warning('请填写专场标题');
  if (!form.image_ordinary) return ElMessage.warning('请上传专区图片');

  saving.value = true;
  try {
    const r = await http.post('/specialarea/save', {
        specialarea_id: form.specialarea_id,
        name: form.name,
        title_main: form.title_main,
        title_ordinary: form.title_ordinary,
        open_days: days.value.join(','),
        start_time: st,
        end_time: et,
        buy_num: form.buy_num,
        transposition_hours: form.transposition_hours,
        image_ordinary: form.image_ordinary,
        is_subscribe: form.is_subscribe,
        is_open: form.is_open,
        sort: form.sort,
      });
    if (r.code === 1) {
      ElMessage.success('保存成功');
      setTimeout(() => router.push('/specialarea'), 600);
    } else ElMessage.warning(r.msg);
  } finally {
    saving.value = false;
  }
}

// ---------- 关联商品 ----------
const goodsList = ref([]);
const goodsLoading = ref(false);
const pickerDlg = ref(false);
const pickKeyword = ref('');
const candidates = ref([]);
const picked = ref([]);
const picking = ref(false);
const pickLoading = ref(false);
const pickTableRef = ref(null);

const STATUS_TEXT = { 10: '上架', 20: '下架', 30: '流拍' };
const statusText = (v) => STATUS_TEXT[Number(v)] || '—';

/* 开抢日期：空 = 不限（随时可买），今天 = 本场正常露出，未来 = 那天才上架 */
const todayStr = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 固定东八区，和业务时间对齐
  return d.toISOString().slice(0, 10);
};
function dateText(v) {
  const d = String(v || '').trim();
  if (!d) return '不限';
  const t = todayStr();
  if (d === t) return '今天';
  if (d > t) return `${d.slice(5)} 起`;
  return d.slice(5);
}
function dateClass(v) {
  const d = String(v || '').trim();
  if (!d) return 'is-none';
  const t = todayStr();
  if (d === t) return 'is-today';
  return d > t ? 'is-future' : 'is-past';
}
const statusClass = (v) => (Number(v) === 10 ? 'tag-ok' : Number(v) === 30 ? 'tag-warn' : 'tag-off');

async function loadGoods() {
  const id = Number(route.params.id);
  if (!id) return;
  goodsLoading.value = true;
  try {
    const r = await http.get(`/specialarea/${id}/goods`);
    goodsList.value = r.code === 1 ? (r.data?.list || []) : [];
  } catch {
    goodsList.value = [];
  } finally {
    goodsLoading.value = false;
  }
}

function openPicker() {
  pickerDlg.value = true;
  pickKeyword.value = '';
  picked.value = [];
  loadCandidates();
}

function focusPicker() {
  pickTableRef.value?.clearSelection();
}

async function loadCandidates() {
  const id = Number(route.params.id);
  if (!id) return;
  pickLoading.value = true;
  try {
    const r = await http.get(`/specialarea/${id}/pick-goods`, { params: { keyword: pickKeyword.value } });
    candidates.value = r.code === 1 ? (r.data || []) : [];
  } catch {
    candidates.value = [];
  } finally {
    pickLoading.value = false;
  }
}

async function confirmPick() {
  const id = Number(route.params.id);
  if (!id || !picked.value.length) return;
  picking.value = true;
  try {
    const r = await http.post('/specialarea/goods/add', {
      specialarea_id: id,
      goods_ids: picked.value.map((g) => g.goods_id),
    });
    if (r.code === 1) {
      if (r.data?.rejected?.length) ElMessage.warning(r.msg || '已关联，部分转拍商品被跳过');
      else ElMessage.success(r.msg || '已关联');
      pickerDlg.value = false;
      picked.value = [];
      loadGoods();
    } else ElMessage.warning(r.msg);
  } finally {
    picking.value = false;
  }
}

async function removeGoods(row) {
  try {
    await ElMessageBox.confirm(
      `把「${row.goods_name}」从本场次移除？商品本身不会被删除，只是不再在本场售卖。\n\n`
      + '如果它是会员正在挂牌的转拍货、且只挂在本场，系统会拒绝移除 —— 需要先到「商品管理」把它下架，'
      + '再回来移除（下架会自动解除挂牌）。',
      '移除关联',
      { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  const id = Number(route.params.id);
  const r = await http.post('/specialarea/goods/remove', { specialarea_id: id, goods_ids: [row.goods_id] });
  if (r.code === 1) {
    // 后端可能顺带把转拍货退货，提示里带件数与商品名，别吞掉
    ElMessage.success(r.msg || '已移除');
    loadGoods();
  } else ElMessage.warning(r.msg);
}

onMounted(() => {
  load();
  loadGoods();
});
</script>

<style scoped>
.pick-tip { font-size: 11.5px; color: #c88a1e; margin-right: 12px; }

/* 开抢日期：未来那天才上架，用橙色提醒，别让运营以为漏显示了 */
.open-date { font-size: 12px; font-variant-numeric: tabular-nums; }
.open-date.is-today { color: #1f9d5f; }
.open-date.is-future { color: #c88a1e; font-weight: 600; }
.open-date.is-past, .open-date.is-none { color: #a8adb7; }

.cfg-form { max-width: 760px; padding: 10px 0 4px; }
.cfg-form :deep(.el-form-item) { margin-bottom: 24px; }

.days { display: flex; gap: 8px; flex-wrap: wrap; }
.day-btn {
  min-width: 54px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid #e4e7ed;
  background: #f4f5f7;
  color: #7d848f;
  font-size: 13px;
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

.time-row { display: flex; align-items: center; gap: 10px; }
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

/* 关联商品 */
.related { margin-top: 16px; }
.rel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.rel-head h3 { margin: 0; font-size: 15px; font-weight: 600; color: #1f2430; }
.rel-count {
  margin-left: 8px;
  padding: 1px 9px;
  border-radius: 20px;
  background: #fff1ee;
  color: #ff513a;
  font-size: 12px;
  font-weight: 600;
}
.rel-hint { margin-top: 6px; max-width: 660px; }
.rel-thumb { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; background: #f4f6f9; }
.rel-name { font-size: 13.5px; color: #1f2430; line-height: 1.4; }
.rel-no { font-size: 12px; color: #a8adb7; margin-top: 2px; }
.money { font-variant-numeric: tabular-nums; color: #ff513a; font-weight: 600; }
.muted { color: #a8adb7; font-size: 12.5px; }
.pick-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.spacer { flex: 1; }
</style>
