<template>
  <div class="page unsold">
    <div class="page__head">
      <div>
        <div class="page__title">流拍订单</div>
        <div class="page__sub">场次结束仍无人成交、已下架退回持有人的转拍货，可指定给会员视同抢单成交</div>
      </div>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="商品名 / 持有人 / 订单号"
        clearable
        style="width: 260px"
        @keyup.enter="reload"
        @clear="reload"
      />
      <el-button type="primary" @click="reload">查询</el-button>
      <div class="spacer" />
      <span class="total-hint">共 {{ total }} 条</span>
    </div>

    <el-table v-loading="loading" :data="list" style="width: 100%" size="small">
      <el-table-column label="商品" min-width="200">
        <template #default="{ row }">
          <div class="goods">
            <el-image v-if="row.good_thumb" :src="row.good_thumb" fit="cover" class="goods__img" />
            <div v-else class="goods__img goods__img--empty" />
            <div class="goods__body">
              <div class="goods__name">{{ row.goods_name }}</div>
              <div class="muted">#{{ row.goods_id }} · 第 {{ Number(row.turn_beat_num) + 1 }} 手待接</div>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="当前持有人" min-width="150">
        <template #default="{ row }">
          <div>{{ row.holder_name || `会员#${row.holder_id}` }}</div>
          <div class="muted">{{ row.holder_mobile }}</div>
        </template>
      </el-table-column>
      <el-table-column label="当前标价" width="115" align="right">
        <template #default="{ row }"><b>¥{{ row.goods_min_price }}</b></template>
      </el-table-column>
      <el-table-column label="上一手成交" width="120" align="right">
        <template #default="{ row }">¥{{ row.last_price }}</template>
      </el-table-column>
      <el-table-column label="原场次" min-width="150">
        <template #default="{ row }">
          <div>{{ row.area_text }}</div>
          <div class="muted">{{ row.area_date || '不限日期' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="最后挂牌 / 流拍" min-width="170">
        <template #default="{ row }">{{ row.last_listing_time || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button size="small" type="primary" @click="openAssign(row)">指定给会员</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <div class="empty">暂无流拍商品。场次到期未成交并自动下架后，会显示在这里。</div>
      </template>
    </el-table>

    <div class="pager" v-if="total > limit">
      <el-pagination
        v-model:current-page="pageNo"
        :page-size="limit"
        :total="total"
        layout="total, prev, pager, next"
        background
        @current-change="load"
      />
    </div>

    <el-dialog v-model="assignDlg" title="指定给会员（视同抢单成交）" width="540px" destroy-on-close>
      <el-form label-width="96px">
        <el-form-item label="商品"><b>{{ cur.goods_name }}</b></el-form-item>
        <el-form-item label="当前持有人">{{ cur.holder_name || `会员#${cur.holder_id}` }} <span class="muted" style="margin-left: 8px">{{ cur.holder_mobile }}</span></el-form-item>
        <el-form-item label="指派标价">¥{{ cur.goods_min_price }}</el-form-item>
        <el-form-item label="接手会员" required>
          <el-select
            v-model="assignForm.member_id"
            filterable
            remote
            reserve-keyword
            :remote-method="searchMember"
            :loading="memberLoading"
            placeholder="输入昵称 / 手机号 / 会员ID 搜索"
            style="width: 100%"
          >
            <el-option
              v-for="m in memberOptions"
              :key="m.member_id"
              :label="`${m.nick_name || '未设置昵称'} · ${m.mobile || `会员#${m.member_id}`}`"
              :value="m.member_id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="指派原因">
          <el-input v-model="assignForm.reason" placeholder="选填，写进订单备注与操作审计" maxlength="100" />
        </el-form-item>
      </el-form>
      <div class="hint">
        按「后台确认收款」口径生成一笔已成交订单：结算卖家货款 / 直推奖 / 积分，货权归接手会员，商品下架。
        <b>场次延续今天</b>，不推到明天。平台不实际收款，货款由双方线下结清。
      </div>
      <template #footer>
        <el-button @click="assignDlg = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitAssign">确认指派</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { adminApi } from '../api.js';

const list = ref([]);
const total = ref(0);
const pageNo = ref(1);
const limit = 20;
const keyword = ref('');
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const r = await adminApi.unsoldList({ page: pageNo.value, limit, keyword: keyword.value.trim() });
    list.value = r.data?.data || [];
    total.value = Number(r.data?.total || 0);
  } finally {
    loading.value = false;
  }
}
function reload() {
  pageNo.value = 1;
  load();
}

const assignDlg = ref(false);
const cur = ref({});
const assignForm = reactive({ member_id: null, reason: '' });
const memberOptions = ref([]);
const memberLoading = ref(false);
const submitting = ref(false);

async function searchMember(kw) {
  memberLoading.value = true;
  try {
    const r = await adminApi.orderCreateOptions({ kind: 'member', keyword: kw || '' });
    memberOptions.value = r.data?.rows || [];
  } catch {
    memberOptions.value = [];
  } finally {
    memberLoading.value = false;
  }
}

async function openAssign(row) {
  cur.value = row;
  assignForm.member_id = null;
  assignForm.reason = '';
  memberOptions.value = [];
  assignDlg.value = true;
  await searchMember('');
}

async function submitAssign() {
  if (submitting.value) return;
  const m = memberOptions.value.find((x) => Number(x.member_id) === Number(assignForm.member_id));
  if (!m) return ElMessage.warning('请先选择接手会员');
  const who = m.nick_name || m.mobile || `会员#${m.member_id}`;
  try {
    await ElMessageBox.confirm(
      `将「${cur.value.goods_name}」（标价 ¥${cur.value.goods_min_price}）指定给 ${who}。\n`
      + '系统会生成一笔已成交订单（视同抢单），按确认收款口径结算货款 / 佣金 / 积分，货权归该会员，商品下架；'
      + '场次延续今天。平台不实际收款，货款由双方线下结清。\n确定继续？',
      '确认指派流拍商品',
      { type: 'warning', confirmButtonText: '确认指派', cancelButtonText: '取消' },
    );
  } catch { return; }
  submitting.value = true;
  try {
    const r = await adminApi.unsoldAssign({
      goods_id: cur.value.goods_id,
      member_id: assignForm.member_id,
      reason: assignForm.reason.trim(),
      confirm: 'ASSIGN_UNSOLD',
    });
    ElMessage.success(r?.msg || '指派成功');
    assignDlg.value = false;
    load();
  } catch {
    // 失败提示由 http 拦截器统一给出
  } finally {
    submitting.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.unsold { padding: 4px 2px 20px; }
.page__head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }
.page__title { font-size: 17px; font-weight: 700; color: #2b323d; }
.page__sub { font-size: 12px; color: #9098a3; margin-top: 5px; }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.spacer { flex: 1; }
.total-hint { font-size: 12.5px; color: #9098a3; }
.goods { display: flex; align-items: center; gap: 10px; padding: 5px 0; }
.goods__img { width: 42px; height: 42px; border-radius: 8px; flex: none; background: #f6f7f9; }
.goods__img--empty { border: 1px dashed #e3e6eb; }
.goods__body { min-width: 0; }
.goods__name { font-size: 13px; font-weight: 550; color: #2f3540; }
.muted { color: #a8adb7; font-size: 11.5px; }
.pager { display: flex; justify-content: flex-end; margin-top: 14px; }
.empty { padding: 42px 12px; color: #a8adb7; font-size: 12.5px; }
.hint {
  margin: 4px 0 0; padding: 10px 12px; border-radius: 9px;
  background: #f6f8fb; color: #606877; font-size: 12px; line-height: 1.75;
}
.hint b { color: #d14328; }
</style>
