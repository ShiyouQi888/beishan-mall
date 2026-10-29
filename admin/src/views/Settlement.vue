<template>
  <div>
    <div class="page-head">
      <div>
        <h2>差价结算</h2>
        <div class="desc">统计场次内每人买入/卖出金额，做差价匹配并生成付款单（平台不经手资金）</div>
      </div>
      <div style="display: flex; gap: 10px; align-items: center">
        <el-select v-model="areaId" placeholder="全部场次" style="width: 170px" clearable>
          <el-option label="全部场次" :value="0" />
          <el-option v-for="a in areas" :key="a.specialarea_id" :label="a.title_main" :value="a.specialarea_id" />
        </el-select>
        <el-date-picker v-model="settleDate" type="date" placeholder="结算日期" style="width: 150px" value-format="YYYY-MM-DD" />
        <el-button type="primary" :loading="running" @click="doRun">执行结算</el-button>
      </div>
    </div>

    <div class="panel" style="margin-bottom: 14px">
      <div class="panel-head"><span>结算批次</span><span class="sub">共 {{ batches.length }} 批</span></div>
      <el-table :data="batches" v-loading="loading" highlight-current-row @current-change="pickBatch">
        <el-table-column prop="batch_id" label="批次" width="70" />
        <el-table-column prop="area_name" label="场次" min-width="150" show-overflow-tooltip />
        <el-table-column prop="batch_date" label="结算日期" width="120" />
        <el-table-column label="买入合计" width="120">
          <template #default="{ row }"><span class="money">¥{{ Number(row.total_buy).toFixed(2) }}</span></template>
        </el-table-column>
        <el-table-column label="卖出合计" width="120">
          <template #default="{ row }"><span class="money">¥{{ Number(row.total_sell).toFixed(2) }}</span></template>
        </el-table-column>
        <el-table-column label="上架费合计" width="120">
          <template #default="{ row }"><span class="money money-red">¥{{ Number(row.total_fee).toFixed(2) }}</span></template>
        </el-table-column>
        <el-table-column prop="member_count" label="参与人数" width="100" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <span class="tag-status" :class="row.status === 10 ? 'tag-ok' : 'tag-warn'">
              {{ row.status === 10 ? '已结算' : '待结算' }}
            </span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <template v-if="curBatch">
      <div class="panel" style="margin-bottom: 14px">
        <div class="panel-head">
          <span>中账 · 会员收支差额</span>
          <span class="sub">批次 #{{ curBatch.batch_id }} · 差额 = 卖出 − 买入</span>
        </div>
        <el-table :data="accounts" size="small" max-height="320">
          <el-table-column label="会员" min-width="130">
            <template #default="{ row }">{{ row.nick_name }}<span class="muted"> {{ row.mobile }}</span></template>
          </el-table-column>
          <el-table-column label="抢购金额" width="120">
            <template #default="{ row }">¥{{ Number(row.buy_amount).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="寄卖金额" width="120">
            <template #default="{ row }">¥{{ Number(row.consignment_amount).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="上架费" width="110">
            <template #default="{ row }">¥{{ Number(row.listing_fee_amount).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="收支差额" width="140">
            <template #default="{ row }">
              <span class="money" :class="Number(row.balance) >= 0 ? 'plus' : 'minus'">
                {{ Number(row.balance) >= 0 ? '+' : '' }}{{ Number(row.balance).toFixed(2) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="买单" min-width="120" show-overflow-tooltip>
            <template #default="{ row }"><span class="muted">{{ row.buy_order_ids || '—' }}</span></template>
          </el-table-column>
          <el-table-column label="卖单" min-width="140" show-overflow-tooltip>
            <template #default="{ row }"><span class="muted">{{ row.sell_order_ids || '—' }}</span></template>
          </el-table-column>
        </el-table>
      </div>

      <div class="panel">
        <div class="panel-head">
          <span>小账 · 差价匹配付款单</span>
          <span class="sub">应付方线下转账 → 上传凭证 → 收款方确认</span>
        </div>
        <el-table :data="matches" size="small">
          <el-table-column prop="match_id" label="#" width="60" />
          <el-table-column label="付款方" min-width="130">
            <template #default="{ row }">{{ row.payer_name }}<span class="muted"> {{ row.payer_mobile }}</span></template>
          </el-table-column>
          <el-table-column label="收款方" min-width="130">
            <template #default="{ row }">{{ row.payee_name }}<span class="muted"> {{ row.payee_mobile }}</span></template>
          </el-table-column>
          <el-table-column label="金额" width="130">
            <template #default="{ row }"><span class="money money-red">¥{{ Number(row.amount).toFixed(2) }}</span></template>
          </el-table-column>
          <el-table-column label="凭证" width="90">
            <template #default="{ row }">
              <el-image v-if="row.voucher" :src="row.voucher" :preview-src-list="[row.voucher]" class="voucher" fit="cover" preview-teleported />
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <span class="tag-status" :class="row.pay_status === 20 ? 'tag-ok' : row.pay_status === 10 ? 'tag-blue' : 'tag-warn'">
                {{ row.pay_status === 20 ? '已完成' : row.pay_status === 10 ? '待确认' : '待付款' }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{ row }">
              <el-button v-if="row.pay_status !== 20" size="small" type="primary" @click="confirmMatch(row)">确认收款</el-button>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>
    <div v-else class="panel empty-box">选择上方批次查看中账与小账明细</div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { adminApi } from '../api.js';
import axios from 'axios';

const http = axios.create({ baseURL: '/admin/api' });
http.interceptors.request.use((c) => {
  c.headers.token = localStorage.getItem('ADMIN_TOKEN');
  return c;
});
http.interceptors.response.use((r) => r.data);

const batches = ref([]);
const accounts = ref([]);
const matches = ref([]);
const curBatch = ref(null);
const areas = ref([]);
const areaId = ref(0);
const settleDate = ref('');
const loading = ref(false);
const running = ref(false);

async function load() {
  loading.value = true;
  try {
    const r = await http.get('/settle/batches');
    batches.value = r.data || [];
  } finally {
    loading.value = false;
  }
}

async function pickBatch(row) {
  if (!row) return;
  curBatch.value = row;
  const [a, m] = await Promise.all([
    http.get('/settle/accounts', { params: { batch_id: row.batch_id } }),
    http.get('/settle/matches', { params: { batch_id: row.batch_id } }),
  ]);
  accounts.value = a.data || [];
  matches.value = m.data || [];
}

async function doRun() {
  let tip = '确定执行结算？将统计所选场次当日的买卖差额并生成付款单。';
  try {
    await ElMessageBox.confirm(tip, '执行结算', { type: 'warning' });
  } catch {
    return;
  }
  running.value = true;
  try {
    const r = await http.post('/settle/run', { specialarea_id: areaId.value || 0, date: settleDate.value || '' });
    if (r.code === 1) {
      ElMessage.success(`结算完成：${r.data.member_count} 人参与，生成 ${r.data.match_count} 笔付款单`);
      await load();
      if (batches.value.length) {
        const b = batches.value.find((x) => x.batch_id === r.data.batch_id);
        if (b) pickBatch(b);
      }
    } else {
      ElMessage.warning(r.msg);
    }
  } finally {
    running.value = false;
  }
}

async function confirmMatch(row) {
  try {
    await ElMessageBox.confirm(`确认已收到 ¥${Number(row.amount).toFixed(2)}？`, '确认收款', { type: 'warning' });
  } catch {
    return;
  }
  const r = await http.post('/settle/confirm-match', { match_id: row.match_id, pass: true });
  if (r.code === 1) {
    ElMessage.success('已确认');
    pickBatch(curBatch.value);
  } else ElMessage.warning(r.msg);
}

onMounted(async () => {
  await load();
  try {
    const r = await adminApi.options('specialarea');
    areas.value = (r.data || []).map((x) => ({ specialarea_id: x.id, title_main: x.name }));
  } catch {}
});
</script>

<style scoped>
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 650;
  margin-bottom: 12px;
}
.panel-head .sub { font-size: 11.5px; color: #8c93a0; font-weight: 450; }
.money { font-variant-numeric: tabular-nums; font-weight: 600; }
.money-red { color: #e63c26; }
.plus { color: #1f9d5f; }
.minus { color: #d14328; }
.muted { color: #a8adb7; font-size: 12px; }
.voucher { width: 34px; height: 34px; border-radius: 6px; background: #f4f6f9; }
</style>
