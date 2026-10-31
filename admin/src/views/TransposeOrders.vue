<template>
  <div class="transpose">
    <div class="page-head">
      <div>
        <h2>转拍订单</h2>
        <div class="desc">
          正在挂牌、等下一手买走的单子。被买走、到期自动下架、或被系统回收后，会自动从这里消失。
        </div>
      </div>
      <el-button :loading="exporting" @click="exportCsv">导出表格</el-button>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <div class="stat-grid">
      <div v-for="s in statCards" :key="s.k" class="stat">
        <div class="v">{{ s.v }}</div>
        <div class="k">{{ s.k }}</div>
        <div v-if="s.sub" class="s">{{ s.sub }}</div>
      </div>
    </div>

    <div class="panel filters">
      <div class="range-tabs">
        <button
          v-for="r in RANGES"
          :key="r.k"
          type="button"
          class="rt"
          :class="{ on: range === r.k }"
          @click="setRange(r.k)"
        >
          {{ r.t }}
        </button>
      </div>
      <el-date-picker
        v-if="range === 'custom'"
        v-model="customRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        :clearable="false"
        style="width: 258px"
        @change="reload"
      />
      <el-input
        v-model="keyword"
        placeholder="订单号 / 商品 / 用户 / 手机号"
        clearable
        style="width: 236px"
        @keyup.enter="reload"
        @clear="reload"
      />
      <el-button type="primary" @click="reload">查询</el-button>
      <span class="range-hint">{{ rangeText }}</span>
    </div>

    <div class="panel table-panel">
      <el-table v-loading="loading" :data="list" size="small" style="width: 100%" empty-text="这个时间范围内没有正在转拍的订单">
        <el-table-column label="商品" min-width="190">
          <template #default="{ row }">
            <div class="goods">
              <el-image v-if="row.good_thumb" :src="row.good_thumb" fit="cover" class="goods__img" />
              <div v-else class="goods__img goods__img--empty">无图</div>
              <div class="goods__main">
                <div class="goods__name">{{ row.goods_name }}</div>
                <div class="goods__sub">#{{ row.goods_id }} · 已转拍 {{ row.turn_beat_num }} 次</div>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column prop="order_no" label="订单号" width="176" show-overflow-tooltip />

        <el-table-column label="买卖链路" width="150">
          <template #default="{ row }">
            <div class="chain">
              <span class="chain__seller" :title="`卖家 ${row.seller_name || '平台'}`">{{ row.seller_name || '平台' }}</span>
              <span class="chain__arrow">→</span>
              <span class="chain__buyer" :title="`买家 ${row.buyer_name || ''}`">{{ row.buyer_name || '—' }}</span>
            </div>
            <div class="nick__sub">{{ row.buyer_mobile || '' }}</div>
          </template>
        </el-table-column>

        <el-table-column label="买入价" width="92" align="right">
          <template #default="{ row }">¥{{ money(row.buy_price) }}</template>
        </el-table-column>

        <el-table-column label="当前标价" width="110" align="right">
          <template #default="{ row }">
            <b class="sell">¥{{ money(row.sell_price) }}</b>
            <div class="gain" :class="row.gain > 0 ? 'gain-up' : 'gain-flat'">
              {{ row.gain > 0 ? '+' : '' }}{{ money(row.gain) }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="上架费" width="88" align="right">
          <template #default="{ row }">¥{{ money(row.listing_fee) }}</template>
        </el-table-column>

        <el-table-column label="挂牌时间" width="146">
          <template #default="{ row }">
            <div class="time">{{ row.transposition_time }}</div>
            <div class="nick__sub">已挂 {{ dur(row.online_minutes) }}</div>
          </template>
        </el-table-column>

        <el-table-column label="所在场次" width="150">
          <template #default="{ row }">
            <div class="area">{{ row.area_name || '未关联场次' }}</div>
            <div v-if="row.area_date" class="nick__sub">{{ row.area_date }}</div>
            <!-- 下一场：这件货没卖掉的话，下一轮落在哪一场、什么时候开 -->
            <div
              v-if="row.next_slot"
              class="next-slot"
              :title="row.next_slot.text"
            >
              下一场 {{ row.next_slot.short }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="价格水位" width="132">
          <template #default="{ row }">
            <div class="cap">
              <div class="cap__bar"><i :style="{ width: `${row.cap_ratio}%`, background: capColor(row) }" /></div>
              <span class="cap__txt" :class="{ 'is-hot': row.cap_reached }">
                {{ row.cap_reached ? '已封顶' : row.cap_price > 0 ? `${row.cap_ratio}%` : '不限' }}
              </span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="76" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openDetail(row)">详情</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <span class="pager__total">共 {{ total }} 单</span>
        <el-pagination
          v-if="total > pageSize"
          layout="prev, pager, next"
          small
          :total="total"
          :page-size="pageSize"
          :current-page="page"
          @current-change="onPage"
        />
      </div>
    </div>

    <el-dialog v-model="detailVisible" title="转拍订单详情" width="680px">
      <div v-if="detail" class="detail">
        <div class="detail__goods">
          <el-image v-if="detail.goods?.good_thumb" :src="detail.goods.good_thumb" fit="cover" class="detail__img" />
          <div>
            <div class="detail__name">{{ detail.goods?.goods_name || '—' }}</div>
            <div class="detail__meta">
              标价 ¥{{ money(detail.goods?.goods_min_price) }}
              <span v-if="Number(detail.goods?.base_price) > 0">· 基准价 ¥{{ money(detail.goods?.base_price) }}</span>
              <span v-if="Number(detail.goods?.price_cap) > 0">· 上限 ¥{{ money(detail.goods?.price_cap) }}</span>
            </div>
          </div>
        </div>

        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="订单号">{{ detail.order.order_no }}</el-descriptions-item>
          <el-descriptions-item label="订单状态">{{ orderStatus(detail.order) }}</el-descriptions-item>
          <el-descriptions-item label="卖家">{{ detail.order._seller || '平台' }}</el-descriptions-item>
          <el-descriptions-item label="买家（转拍人）">{{ detail.order._nick || '—' }}</el-descriptions-item>
          <el-descriptions-item label="这一手买入价">¥{{ money(detail.order.total_price) }}</el-descriptions-item>
          <el-descriptions-item label="服务费">¥{{ money(detail.order.service_charge) }}</el-descriptions-item>
          <el-descriptions-item label="转拍上架费">¥{{ money(detail.order.listing_fee) }}</el-descriptions-item>
          <el-descriptions-item label="挂牌时间">{{ detail.order.transposition_time || '—' }}</el-descriptions-item>
          <el-descriptions-item label="支付时间">{{ detail.order.pay_time || '—' }}</el-descriptions-item>
          <el-descriptions-item label="所在场次">{{ detail.goods?.area_name || '未关联场次' }} · {{ detail.goods?.area_date || '不限日期' }}</el-descriptions-item>
          <el-descriptions-item label="下一场">
            <span v-if="detail.goods?.next_slot">{{ detail.goods.next_slot.text }}</span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>
        </el-descriptions>

        <!-- 流转链路：这件货被经过的每一手 -->
        <div class="chainbox" v-if="detail.chain?.length">
          <div class="logs__t">流转链路（共 {{ detail.chain.length }} 手）</div>
          <div
            v-for="c in detail.chain"
            :key="c.order_id"
            class="chainline"
            :class="{ 'is-current': c.current }"
          >
            <span class="chainline__step">第 {{ c.step }} 手</span>
            <span class="chainline__who">{{ c.seller_name }}<i>→</i>{{ c.buyer_name }}</span>
            <span class="chainline__price">¥{{ money(c.price) }}</span>
            <span class="chainline__time">{{ c.pay_time }}</span>
          </div>
        </div>

        <div class="logs">
          <div class="logs__t">操作记录</div>
          <div v-if="!detail.logs?.length" class="logs__empty">暂无记录</div>
          <div v-for="(l, i) in detail.logs" :key="i" class="log">
            <span class="log__t">{{ l.create_time }}</span>
            <span class="log__a">{{ l.action }}</span>
            <span class="log__r">{{ l.remark }}</span>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { adminApi } from '../api.js';

const RANGES = [
  { k: 'today', t: '今日' },
  { k: 'yesterday', t: '昨日' },
  { k: 'week', t: '本周' },
  { k: 'month', t: '本月' },
  { k: 'custom', t: '自定义' },
  { k: 'all', t: '全部' },
];

const range = ref('today');
const customRange = ref([]);
const keyword = ref('');
const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 15;
const loading = ref(false);
const exporting = ref(false);
const summary = ref({ count: 0, goods_count: 0, fee: 0, price: 0, gain: 0 });
const rangeInfo = ref({ start: '', end: '' });

const detailVisible = ref(false);
const detail = ref(null);

const money = (v) => Number(v || 0).toFixed(2);
const capColor = (row) => (row.cap_reached ? '#e24b4a' : row.cap_ratio >= 70 ? '#f0a020' : '#2eb872');

/** 分钟 → 人话，最长显示到天 */
function dur(min) {
  if (min === null || min === undefined) return '—';
  const m = Number(min);
  if (!Number.isFinite(m)) return '—';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

const rangeText = computed(() => {
  if (range.value === 'custom') {
    const [s, e] = customRange.value || [];
    return s && e ? `${s} ~ ${e}` : '请选择日期范围';
  }
  const r = rangeInfo.value;
  if (!r?.start) return '不限时间（全部在挂单）';
  return `${r.start} ~ ${r.end}`;
});

const statCards = computed(() => [
  { k: '正在转拍', v: summary.value.count ?? 0, sub: `涉及 ${summary.value.goods_count ?? 0} 件商品` },
  { k: '挂牌标价合计', v: `¥${money(summary.value.price)}` },
  { k: '上架费合计', v: `¥${money(summary.value.fee)}` },
  { k: '累计涨价', v: `¥${money(summary.value.gain)}` },
]);

const orderStatus = (o) => {
  if (Number(o.pay_status) !== 10) return '待付款';
  if (Number(o.status) === 10) return '已成交';
  if (Number(o.status) === 20) return '已完成';
  if (Number(o.status) === 30) return '已转拍';
  if (Number(o.status) === 40) return '已取消';
  return `状态 ${o.status}`;
};

async function load() {
  if (range.value === 'custom') {
    const [s, e] = customRange.value || [];
    if (!s || !e) {
      list.value = [];
      total.value = 0;
      return;
    }
  }
  loading.value = true;
  try {
    const params = { range: range.value, keyword: keyword.value || '', page: page.value, limit: pageSize };
    if (range.value === 'custom') {
      params.start = customRange.value[0];
      params.end = customRange.value[1];
    }
    const r = await adminApi.transposeList(params);
    list.value = r.data?.list || [];
    total.value = Number(r.data?.total || 0);
    summary.value = r.data?.summary || summary.value;
    rangeInfo.value = r.data?.range || rangeInfo.value;
  } catch {
    list.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function reload() {
  page.value = 1;
  load();
}

/** 导出：跟当前列表同一套筛选（时间范围 + 关键词），字段比页面更全 */
async function exportCsv() {
  if (range.value === 'custom') {
    const [s, e] = customRange.value || [];
    if (!s || !e) return ElMessage.warning('请先选择自定义日期区间');
  }
  exporting.value = true;
  try {
    const params = { range: range.value, keyword: keyword.value || '' };
    if (range.value === 'custom') {
      params.start = customRange.value[0];
      params.end = customRange.value[1];
    }
    const res = await adminApi.exportTranspose(params);
    const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transpose-orders-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    ElMessage.success('已导出，可用 Excel 直接打开');
  } catch {
    // 拦截器已提示
  } finally {
    exporting.value = false;
  }
}

function setRange(k) {
  if (range.value === k) return;
  range.value = k;
  page.value = 1;
  if (k === 'custom' && (!customRange.value || customRange.value.length !== 2)) {
    // 先别查，等用户把日期选出来
    list.value = [];
    total.value = 0;
    summary.value = { count: 0, goods_count: 0, fee: 0, price: 0, gain: 0 };
    return;
  }
  load();
}

function onPage(p) {
  page.value = p;
  load();
}

async function openDetail(row) {
  detail.value = null;
  detailVisible.value = true;
  try {
    const r = await adminApi.transposeDetail(row.order_id);
    detail.value = r.data || null;
  } catch {
    ElMessage.error('读取订单详情失败');
  }
}

onMounted(load);
</script>

<style scoped>
.transpose { padding-bottom: 8px; }

.desc { color: #8c93a0; font-size: 12.5px; margin-top: 4px; line-height: 1.6; }

.stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #eef0f3; border-radius: 12px; padding: 14px 16px; }
.stat .v { font-size: 21px; font-weight: 700; font-variant-numeric: tabular-nums; color: #22252b; }
.stat .k { font-size: 12px; color: #8c93a0; margin-top: 3px; }
.stat .s { font-size: 11px; color: #a8adb7; margin-top: 2px; }

.filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.range-tabs { display: inline-flex; background: #f4f6f9; border-radius: 9px; padding: 3px; }
.rt {
  border: 0; background: transparent; color: #626a76; font: inherit; font-size: 12.5px;
  padding: 6px 13px; border-radius: 7px; cursor: pointer; transition: background 0.16s, color 0.16s;
}
.rt:hover { color: #c9351f; }
.rt.on { background: #fff; color: #c9351f; font-weight: 650; box-shadow: 0 1px 4px rgba(20, 26, 38, 0.08); }
.range-hint { margin-left: auto; font-size: 12px; color: #a8adb7; }

.table-panel { padding: 6px 0 0; }
.goods { display: flex; align-items: center; gap: 9px; }
.goods__img { width: 38px; height: 38px; border-radius: 7px; flex: none; background: #f5f6f8; }
.goods__img--empty { display: grid; place-items: center; font-size: 10px; color: #b9bfc9; }
.goods__name { font-size: 12.5px; color: #22252b; font-weight: 550; line-height: 1.35; }
.goods__sub { font-size: 11px; color: #a8adb7; margin-top: 2px; }

.nick { font-size: 12.5px; color: #2f3540; }
.nick__sub { font-size: 11px; color: #a8adb7; margin-top: 1px; }

.sell { color: #c9351f; font-variant-numeric: tabular-nums; }
.gain { font-size: 11px; margin-top: 1px; font-variant-numeric: tabular-nums; }
.gain-up { color: #e24b4a; }
.gain-flat { color: #a8adb7; }
.time { font-size: 12px; font-variant-numeric: tabular-nums; color: #2f3540; }
.area { font-size: 12px; color: #2f3540; }
/* 下一场：跟着场次走，字比场次小一号、用品牌色区分开 */
.next-slot {
  margin-top: 2px;
  font-size: 11px;
  color: #c9351f;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cap { display: flex; align-items: center; gap: 7px; }
.cap__bar { flex: 1; height: 6px; border-radius: 3px; background: #eef0f3; overflow: hidden; }
.cap__bar i { display: block; height: 100%; border-radius: 3px; transition: width 0.3s ease; }
.cap__txt { font-size: 11px; color: #8c93a0; font-variant-numeric: tabular-nums; white-space: nowrap; }
.cap__txt.is-hot { color: #c9351f; font-weight: 600; }

.pager { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; }
.pager__total { font-size: 12px; color: #8c93a0; }

.detail__goods { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.detail__img { width: 56px; height: 56px; border-radius: 9px; background: #f5f6f8; }
.detail__name { font-size: 14px; font-weight: 650; }
.detail__meta { font-size: 12px; color: #8c93a0; margin-top: 4px; }

.chain { display: flex; align-items: center; gap: 4px; font-size: 12.5px; }
.chain__seller { color: var(--text-3, #8c93a0); max-width: 58px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chain__arrow { color: #b9bfc9; font-size: 11px; }
.chain__buyer { color: #22252b; font-weight: 550; max-width: 58px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.chainbox { margin-top: 14px; }
.chainline {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: #626a76;
}
.chainline + .chainline { margin-top: 4px; }
.chainline.is-current { background: #fff6f4; color: #c9351f; }
.chainline__step { color: #a8adb7; white-space: nowrap; }
.chainline.is-current .chainline__step { color: #c9351f; }
.chainline__who { flex: 1; min-width: 0; }
.chainline__who i { font-style: normal; color: #b9bfc9; margin: 0 6px; }
.chainline__price { font-variant-numeric: tabular-nums; white-space: nowrap; }
.chainline__time { color: #a8adb7; white-space: nowrap; font-variant-numeric: tabular-nums; }

.logs { margin-top: 14px; }
.logs__t { font-size: 12.5px; font-weight: 650; margin-bottom: 8px; }
.logs__empty { font-size: 12px; color: #a8adb7; }
.log { display: flex; gap: 10px; font-size: 12px; color: #626a76; padding: 5px 0; border-bottom: 1px dashed #f2f4f7; }
.log__t { color: #a8adb7; white-space: nowrap; font-variant-numeric: tabular-nums; }
.log__a { color: #2f3540; font-weight: 550; white-space: nowrap; }
.log__r { flex: 1; min-width: 0; word-break: break-all; }

@media (max-width: 1200px) {
  .stat-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
