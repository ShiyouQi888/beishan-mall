<template>
  <div>
    <div class="page-head">
      <div>
        <h2>合同签署记录</h2>
        <div class="desc">会员注册时签署的《会员服务电子合同》：签名图、合同版本、阅读时长与来源信息</div>
      </div>
      <el-button :loading="exporting" @click="exportCsv">导出 CSV</el-button>
    </div>

    <div class="panel">
      <div class="filters">
        <el-input v-model="query.phone" placeholder="手机号" clearable style="width:170px" @keyup.enter="load(1)" />
        <el-input v-model="query.real_name" placeholder="签署姓名" clearable style="width:160px" @keyup.enter="load(1)" />
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width:250px" />
        <el-button type="primary" @click="load(1)">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </div>

      <el-table v-loading="loading" :data="rows" border stripe size="small" empty-text="暂无签署记录">
        <el-table-column prop="sign_id" label="ID" width="72" />
        <el-table-column prop="create_time" label="签署时间" width="170" />
        <el-table-column prop="phone" label="手机号" width="130" />
        <el-table-column prop="real_name" label="姓名" width="120" />
        <el-table-column prop="contract_title" label="合同名称" min-width="150" show-overflow-tooltip />
        <el-table-column prop="contract_version" label="合同版本" width="140">
          <template #default="{ row }"><code class="ver">{{ row.contract_version }}</code></template>
        </el-table-column>
        <el-table-column prop="read_seconds" label="阅读秒数" width="100" />
        <el-table-column prop="ip" label="IP" width="140" />
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }"><el-button link type="primary" @click="openDetail(row)">查看</el-button></template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          background layout="total, prev, pager, next, sizes"
          :total="total" :page-size="query.limit" :current-page="query.page"
          :page-sizes="[15, 30, 50, 100]"
          @current-change="load" @size-change="onSize"
        />
      </div>
    </div>

    <el-dialog v-model="detailVisible" title="签署详情" width="720px" destroy-on-close>
      <div v-loading="detailLoading" class="detail">
        <div class="detail__grid">
          <div><span>签署时间</span><b>{{ detail.create_time || '-' }}</b></div>
          <div><span>会员 ID</span><b>{{ detail.member_id }}</b></div>
          <div><span>手机号</span><b>{{ detail.phone }}</b></div>
          <div><span>签署姓名</span><b>{{ detail.real_name }}</b></div>
          <div><span>合同名称</span><b>{{ detail.contract_title }}</b></div>
          <div><span>合同版本</span><b><code class="ver">{{ detail.contract_version }}</code></b></div>
          <div><span>阅读秒数</span><b>{{ detail.read_seconds }}</b></div>
          <div><span>来源 IP</span><b>{{ detail.ip || '-' }}</b></div>
          <div class="detail__wide"><span>设备信息</span><b class="ua">{{ detail.user_agent || '-' }}</b></div>
        </div>

        <div class="detail__block">
          <div class="detail__label">手写签名</div>
          <div class="sign-box">
            <img v-if="detail.sign_image_url" :src="detail.sign_image_url" alt="会员手写签名" />
            <span v-else class="sign-box__empty">无签名图片</span>
          </div>
        </div>

        <div class="detail__block">
          <div class="detail__label">签署时的合同正文（版本快照）</div>
          <div class="contract-snapshot rich-content" v-html="safeSnapshot" />
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, reactive, ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { adminApi } from '../api.js';
import { sanitizeHtml } from '../../../shared/sanitize.js';
import { renderRich } from '../../../shared/markdown.js';

const loading = ref(false);
const exporting = ref(false);
const detailVisible = ref(false);
const detailLoading = ref(false);
const rows = ref([]);
const total = ref(0);
const range = ref([]);
const detail = ref({});
const query = reactive({ page: 1, limit: 15, phone: '', real_name: '' });

const safeSnapshot = computed(() => sanitizeHtml(renderRich(detail.value.contract_html || '')) || '<p>暂无正文快照</p>');

function params() {
  return {
    ...query,
    start: range.value?.[0] || '',
    end: range.value?.[1] || '',
  };
}

async function load(p = query.page) {
  loading.value = true;
  query.page = p;
  try {
    const r = await adminApi.contractSignList(params());
    rows.value = r.data?.list || [];
    total.value = Number(r.data?.total || 0);
  } finally {
    loading.value = false;
  }
}

function onSize(n) {
  query.limit = n;
  load(1);
}

function reset() {
  query.phone = '';
  query.real_name = '';
  range.value = [];
  load(1);
}

async function openDetail(row) {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = {};
  try {
    const r = await adminApi.contractSignDetail({ id: row.sign_id });
    detail.value = r.data || {};
  } finally {
    detailLoading.value = false;
  }
}

function toCsv(list) {
  if (!list.length) return '';
  const keys = Object.keys(list[0]);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '\ufeff' + [keys.join(','), ...list.map((x) => keys.map((k) => cell(x[k])).join(','))].join('\r\n');
}

async function exportCsv() {
  exporting.value = true;
  try {
    const r = await adminApi.contractSignExport(params());
    const list = r.data?.list || [];
    if (!list.length) return ElMessage.warning('当前条件下没有可导出的记录');
    const blob = new Blob([toCsv(list)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `合同签署记录-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    ElMessage.success(`已导出 ${list.length} 条`);
  } finally {
    exporting.value = false;
  }
}

onMounted(() => load(1));
</script>

<style scoped>
.filters { display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px; }
.pager { display:flex;justify-content:flex-end;margin-top:16px; }
.ver { padding:2px 6px;border-radius:5px;background:#f2f4f7;color:#5b6575;font-size:11px;font-family:var(--font-mono, monospace); }
.detail { max-height:70vh;overflow:auto;padding-right:4px; }
.detail__grid { display:grid;grid-template-columns:1fr 1fr;gap:10px 20px; }
.detail__grid > div { display:flex;flex-direction:column;gap:3px;padding:8px 10px;border-radius:8px;background:#f7f8fa; }
.detail__grid span { color:#8c93a0;font-size:11.5px; }
.detail__grid b { color:#2f3641;font-size:13px;font-weight:600;word-break:break-all; }
.detail__wide { grid-column:1 / -1; }
.ua { font-size:11.5px !important;line-height:1.55;font-weight:400 !important; }
.detail__block { margin-top:18px; }
.detail__label { margin-bottom:8px;color:#5b6575;font-size:12.5px;font-weight:600; }
.sign-box { display:flex;align-items:center;justify-content:center;min-height:130px;padding:10px;border:1px dashed #d9dee6;border-radius:10px;background:#fff; }
.sign-box img { max-width:100%;max-height:180px;object-fit:contain; }
.sign-box__empty { color:#a2a8b2;font-size:12px; }
.contract-snapshot { max-height:280px;overflow:auto;padding:14px 16px;border:1px solid #e8ebf0;border-radius:10px;background:#fff;font-size:12.5px; }
</style>
