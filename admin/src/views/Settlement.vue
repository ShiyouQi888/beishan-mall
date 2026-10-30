<template>
  <div>
    <div class="page-head">
      <div>
        <h2>差价对账</h2>
        <div class="desc">按场次统计每人的买入/卖出差额，只读对账用</div>
      </div>
      <el-button @click="loadBatches">刷新</el-button>
    </div>

    <div class="settle-warn">
      <b>这里不再执行结算，只做对账</b>
      <span>
        成交时就已经入账了：买家扣余额、卖家当场收到货款，钱当场结清。
        原来那套「场次结束再按差价生成会员间付款单」会让收款方收第二次钱，已停用并移除。
        这一页保留历史批次、中账与付款单，供你核对每场谁进谁出多少。
      </span>
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
const loading = ref(false);

async function loadBatches() {
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

onMounted(loadBatches);
</script>

<style scoped>
.settle-warn {
  display: flex; flex-direction: column; gap: 5px;
  margin-bottom: 14px; padding: 14px 16px;
  border: 1px solid #ffd8a8; border-radius: 10px;
  background: #fff9ef; color: #8a5a1a; font-size: 12.5px; line-height: 1.7;
}
.settle-warn b { font-size: 13px; color: #a2550c; }
.settle-warn em { font-style: normal; font-weight: 700; color: #d4380d; }

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
