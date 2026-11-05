<template>
  <div class="audit-page">
    <div class="page-head">
      <div>
        <h2>操作审计</h2>
        <div class="desc">记录管理员登录、查看和业务变更。敏感字段会自动隐藏。</div>
      </div>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <div class="panel filters">
      <el-input
        v-model="filters.keyword"
        clearable
        placeholder="操作、管理员、接口或目标编号"
        style="width: 250px"
        @keyup.enter="search"
      />
      <el-select v-if="canViewAll" v-model="filters.admin_id" clearable placeholder="全部管理员" style="width: 180px">
        <el-option v-for="op in operators" :key="op.id" :label="op.name" :value="op.id" />
      </el-select>
      <el-select v-model="filters.result" clearable placeholder="全部结果" style="width: 130px">
        <el-option label="成功" value="1" />
        <el-option label="失败" value="0" />
      </el-select>
      <el-date-picker
        v-model="filters.dates"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        unlink-panels
        style="width: 270px"
      />
      <el-button type="primary" @click="search">查询</el-button>
      <el-button @click="reset">重置</el-button>
      <span class="scope-hint">{{ canViewAll ? '当前可查看所有管理员' : '当前仅显示自己的操作' }}</span>
    </div>

    <div class="panel table-panel">
      <el-table v-loading="loading" :data="list" size="small" style="width: 100%" empty-text="暂无操作记录">
        <el-table-column prop="create_time" label="时间" width="158" />
        <el-table-column label="管理员" min-width="132">
          <template #default="{ row }">
            <div class="operator">{{ row.admin_nick || row.admin_name || '未知账号' }}</div>
            <div class="sub">{{ row.admin_name || '登录名未知' }} · ID {{ row.admin_id || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="action" label="操作" min-width="148" show-overflow-tooltip />
        <el-table-column label="目标" min-width="116">
          <template #default="{ row }">
            <span>{{ row.target_type || '—' }}</span>
            <span v-if="row.target_id" class="sub">#{{ row.target_id }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结果" width="88" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="Number(row.result) === 1 ? 'success' : 'danger'">
              {{ Number(row.result) === 1 ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="请求" min-width="210" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="method">{{ row.method }}</span>
            <span class="path">{{ row.path }}</span>
            <div v-if="row.result_message" class="sub">{{ row.result_message }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="ip" label="IP 地址" width="138" show-overflow-tooltip />
        <el-table-column label="详情" width="76" fixed="right" align="center">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <span class="pager__total">共 {{ total }} 条</span>
        <el-pagination
          v-if="total > pageSize"
          layout="prev, pager, next, sizes, total"
          :total="total"
          :page-size="pageSize"
          :page-sizes="[20, 50, 100]"
          :current-page="page"
          small
          @current-change="onPage"
          @size-change="onSize"
        />
      </div>
    </div>

    <el-dialog v-model="detailVisible" title="操作记录详情" width="700px">
      <el-descriptions v-if="detail" :column="2" border size="small">
        <el-descriptions-item label="时间">{{ detail.create_time }}</el-descriptions-item>
        <el-descriptions-item label="结果">
          {{ Number(detail.result) === 1 ? '成功' : '失败' }} · HTTP {{ detail.http_status }}
        </el-descriptions-item>
        <el-descriptions-item label="管理员">{{ detail.admin_nick || detail.admin_name }}（{{ detail.admin_name }}）</el-descriptions-item>
        <el-descriptions-item label="角色 ID">{{ detail.role_id }}</el-descriptions-item>
        <el-descriptions-item label="操作">{{ detail.action }}</el-descriptions-item>
        <el-descriptions-item label="目标">{{ detail.target_type || '—' }} {{ detail.target_id ? `#${detail.target_id}` : '' }}</el-descriptions-item>
        <el-descriptions-item label="请求方法">{{ detail.method }}</el-descriptions-item>
        <el-descriptions-item label="IP 地址">{{ detail.ip || '—' }}</el-descriptions-item>
        <el-descriptions-item label="接口地址" :span="2">{{ detail.path }}</el-descriptions-item>
        <el-descriptions-item label="结果说明" :span="2">{{ detail.result_message || '—' }}</el-descriptions-item>
        <el-descriptions-item label="请求摘要" :span="2">
          <pre class="audit-json">{{ formatDetails(detail.details) }}</pre>
        </el-descriptions-item>
        <el-descriptions-item label="浏览器" :span="2">{{ detail.user_agent || '—' }}</el-descriptions-item>
      </el-descriptions>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { adminApi } from '../api.js';

const loading = ref(false);
const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const canViewAll = ref(false);
const operators = ref([]);
const detailVisible = ref(false);
const detail = ref(null);
const filters = reactive({ keyword: '', admin_id: '', result: '', dates: [] });

function params() {
  return {
    page: page.value,
    limit: pageSize.value,
    keyword: filters.keyword.trim(),
    admin_id: filters.admin_id || '',
    result: filters.result,
    start_date: filters.dates?.[0] || '',
    end_date: filters.dates?.[1] || '',
  };
}

async function load() {
  loading.value = true;
  try {
    const response = await adminApi.auditList(params());
    list.value = response.data?.list || [];
    total.value = Number(response.data?.total || 0);
    canViewAll.value = Boolean(response.data?.can_view_all);
    operators.value = response.data?.operators || [];
  } catch {
    list.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function search() {
  page.value = 1;
  load();
}

function reset() {
  filters.keyword = '';
  filters.admin_id = '';
  filters.result = '';
  filters.dates = [];
  search();
}

function onPage(value) {
  page.value = value;
  load();
}

function onSize(value) {
  pageSize.value = value;
  page.value = 1;
  load();
}

function openDetail(row) {
  detail.value = row;
  detailVisible.value = true;
}

function formatDetails(value) {
  if (!value) return '—';
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return String(value); }
}

onMounted(load);
</script>

<style scoped>
.audit-page { padding-bottom: 8px; }
.desc { color: #8c93a0; font-size: 12.5px; margin-top: 4px; line-height: 1.6; }
.filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.scope-hint { margin-left: auto; color: #8c93a0; font-size: 12px; }
.table-panel { padding: 6px 0 0; }
.operator { color: #2f3540; font-weight: 600; }
.sub { margin-top: 2px; color: #9aa1ad; font-size: 11px; line-height: 1.45; }
.method { display: inline-block; margin-right: 6px; color: #c9351f; font-size: 11px; font-weight: 700; }
.path { color: #626a76; font-size: 11.5px; }
.pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; }
.pager__total { flex: none; color: #8c93a0; font-size: 12px; }
.audit-json { max-height: 280px; overflow: auto; margin: 0; padding: 10px 12px; border-radius: 8px; background: #f6f7f9; color: #4f5662; font: 12px/1.55 Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
</style>
