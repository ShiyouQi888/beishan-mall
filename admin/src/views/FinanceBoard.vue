<template>
  <div v-loading="loading">
    <div class="page-head">
      <div>
        <h2>财务大盘</h2>
        <div class="desc">每日 / 每月盈亏 · 现金缺口 · 会员负债 · 风险提示</div>
      </div>
      <div class="head-actions">
        <el-button @click="showRule = true">口径说明</el-button>
        <el-button type="primary" @click="load">刷新数据</el-button>
      </div>
    </div>

    <template v-if="d">
      <!-- 第一排：盈亏主线 -->
      <div class="stat-grid">
        <div class="stat-card" v-for="c in mainCards" :key="c.label">
          <div class="label">{{ c.label }}</div>
          <div class="value" :style="{ color: c.color }">
            <span class="sym">¥</span>{{ c.value }}
          </div>
          <div class="hint">{{ c.hint }}</div>
        </div>
      </div>

      <!-- 第二排：现金与缺口 -->
      <div class="stat-grid mt14">
        <div class="stat-card" v-for="c in subCards" :key="c.label">
          <div class="label">{{ c.label }}</div>
          <div class="value small" :style="{ color: c.color }">
            <span class="sym" v-if="c.money">¥</span>{{ c.value }}<span class="unit" v-if="c.unit">{{ c.unit }}</span>
          </div>
          <div class="hint">{{ c.hint }}</div>
        </div>
      </div>

      <!-- 风险提示 -->
      <div class="panel mt14">
        <div class="panel-head">
          <span>风险与异常</span>
          <span class="sub">{{ riskCount }}</span>
        </div>
        <div class="risk-list">
          <div class="risk" v-for="(x, i) in d.risks" :key="i" :class="'lv-' + x.level">
            <div class="risk-dot" />
            <div class="risk-main">
              <div class="risk-t">{{ x.title }}</div>
              <div class="risk-d">{{ x.detail }}</div>
            </div>
            <span class="risk-tag">{{ levelText[x.level] }}</span>
          </div>
        </div>
      </div>

      <!-- 收入结构 + 费率 -->
      <div class="grid2 mt14">
        <div class="panel">
          <div class="panel-head">
            <span>累计收入结构</span>
            <span class="sub">按已支付订单统计</span>
          </div>
          <div class="split">
            <div class="split-bar">
              <div class="seg seg-a" :style="{ width: pct(d.total.service_fee) + '%' }" />
              <div class="seg seg-b" :style="{ width: pct(d.total.listing_fee) + '%' }" />
            </div>
            <div class="split-legend">
              <div class="lg">
                <i style="background: #ff513a" />
                <span class="lg-k">抢单服务费</span>
                <span class="lg-v">¥{{ fmt(d.total.service_fee) }}</span>
                <span class="lg-p">{{ pct(d.total.service_fee) }}%</span>
              </div>
              <div class="lg">
                <i style="background: #ffb020" />
                <span class="lg-k">转拍上架费</span>
                <span class="lg-v">¥{{ fmt(d.total.listing_fee) }}</span>
                <span class="lg-p">{{ pct(d.total.listing_fee) }}%</span>
              </div>
            </div>
          </div>
          <div class="divider" />
          <div class="kv-list">
            <div class="kv"><span>累计经营收入</span><b>¥{{ fmt(d.total.income) }}</b></div>
            <div class="kv"><span>累计直推奖支出</span><b :class="d.total.drive_award > 0 ? 'neg' : 'zero'">{{ spend(d.total.drive_award) }}</b></div>
            <div class="kv"><span>平台回收支出</span><b :class="d.total.recycle_cost > 0 ? 'neg' : 'zero'">{{ spend(d.total.recycle_cost) }}</b></div>
            <div class="kv strong"><span>累计经营净利</span><b :class="sgn(d.total.net)">¥{{ fmt(d.total.net) }}</b></div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <span>费率与单均毛利</span>
            <a class="more" @click="$router.push('/setting/trade')">去调整 ›</a>
          </div>
          <div class="rate-grid">
            <div class="rate" v-for="x in rateCards" :key="x.k">
              <div class="rate-k">{{ x.k }}</div>
              <div class="rate-v" :style="{ color: x.color || '#22252b' }">{{ x.v }}<span class="unit">%</span></div>
            </div>
          </div>
          <div class="formula">
            <div class="f-title">单均毛利 = 抢单服务费 − 直推奖</div>
            <div class="f-body">
              {{ fmtRate(d.rate.service_charge) }}% − {{ fmtRate(d.rate.drive_award) }}% =
              <b :class="sgn(d.rate.per_order)">{{ fmtRate(d.rate.per_order) }}%</b>
            </div>
            <div class="f-note">
              即每成交 ¥10,000 的订单，平台净赚 ¥{{ fmt((10000 * d.rate.per_order) / 100) }}
            </div>
          </div>
          <div class="divider" />
          <div class="kv-list">
            <div class="kv"><span>今日经营净利</span><b :class="sgn(d.today.net)">¥{{ fmt(d.today.net) }}</b></div>
            <div class="kv"><span>本月经营净利</span><b :class="sgn(d.month.net)">¥{{ fmt(d.month.net) }}</b></div>
            <div class="kv"><span>本月成交额</span><b>¥{{ fmt(d.month.gmv) }}</b></div>
            <div class="kv"><span>本月订单数</span><b>{{ d.month.orders }} 单</b></div>
          </div>
        </div>
      </div>

      <!-- 30 日趋势 -->
      <div class="panel mt14">
        <div class="panel-head">
          <span>近 30 日经营净利</span>
          <span class="sub">红=盈利 · 绿=亏损</span>
        </div>
        <div class="chart">
          <div class="cw" v-for="(it, i) in d.trend_daily" :key="it.date">
            <div class="col" :title="`${it.date}\n订单 ${it.orders} 单\n收入 ¥${fmt(it.income)}\n支出 ¥${fmt(it.drive_award)}\n净利 ¥${fmt(it.net)}`">
              <div class="axis" />
              <div
                class="bar"
                :class="it.net >= 0 ? 'up' : 'down'"
                :style="barStyle(it.net)"
              />
            </div>
            <div class="lbl">{{ i % 5 === 0 || i === d.trend_daily.length - 1 ? it.date.slice(5) : '' }}</div>
          </div>
        </div>
        <div v-if="!d.trend_daily.some((x) => x.orders)" class="chart-empty">近 30 日暂无成交数据</div>
      </div>

      <!-- 月度趋势 -->
      <div class="panel mt14">
        <div class="panel-head">
          <span>近 6 个月经营明细</span>
          <span class="sub">单位：元</span>
        </div>
        <el-table :data="d.trend_monthly" size="small" style="width: 100%">
          <el-table-column prop="month" label="月份" width="100" />
          <el-table-column prop="orders" label="订单数" width="90" align="right" />
          <el-table-column label="成交额" align="right" min-width="120">
            <template #default="{ row }">{{ fmt(row.gmv) }}</template>
          </el-table-column>
          <el-table-column label="服务费" align="right" min-width="110">
            <template #default="{ row }">{{ fmt(row.service_fee) }}</template>
          </el-table-column>
          <el-table-column label="上架费" align="right" min-width="100">
            <template #default="{ row }">{{ fmt(row.listing_fee) }}</template>
          </el-table-column>
          <el-table-column label="经营收入" align="right" min-width="110">
            <template #default="{ row }">{{ fmt(row.income) }}</template>
          </el-table-column>
          <el-table-column label="直推奖" align="right" min-width="110">
            <template #default="{ row }">
              <span :class="row.drive_award > 0 ? 'neg' : 'zero'">{{ spendNum(row.drive_award) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="经营净利" align="right" min-width="120">
            <template #default="{ row }">
              <b :class="sgn(row.net)">{{ fmt(row.net) }}</b>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>

    <div v-else-if="!loading" class="panel empty-box">暂无财务数据，请先完成一笔订单</div>

    <el-dialog v-model="showRule" title="财务口径说明" width="640px">
      <div class="rule">
        <div class="rule-item" v-for="x in rules" :key="x.k">
          <div class="rule-k">{{ x.k }}</div>
          <div class="rule-c">{{ x.c }}</div>
        </div>
      </div>
      <div class="rule-tip">
        所有金额均取自已支付且未取消的订单；退款、未支付订单不计入收入。
      </div>
      <template #footer>
        <el-button type="primary" @click="showRule = false">知道了</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { adminApi } from '../api.js';

const d = ref(null);
const loading = ref(false);
const showRule = ref(false);

const levelText = { high: '高风险', warn: '关注', info: '提示', ok: '正常' };

const rules = [
  { k: '经营收入', c: '抢单服务费（买家额外支付的费用）+ 转拍上架费。这两项才是平台真正赚到的钱，商品成交额不归平台。' },
  { k: '经营支出', c: '直推奖。买家上级拿到的奖励，由平台从收入里出。' },
  { k: '经营净利', c: '经营收入 − 经营支出。这是平台最核心的盈利指标。' },
  { k: '平台回收支出', c: '流拍后平台把商品收回、把钱付给会员。这是「钱换成货」的资产转换，不计入经营损益，单独列示。' },
  { k: '现金净流', c: '经营净利 − 平台回收支出。反映平台账上现金的真实增减，为负说明在垫钱囤货。' },
  { k: '会员负债', c: '全体会员余额 + 可提现佣金。这是平台欠会员的钱，必须随时能兑付。' },
  { k: '单均毛利', c: '抢单服务费 − 直推奖。小于等于 0 意味着每做一单都亏钱，是最高优先级的风险。' },
];

const fmt = (v) => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 百分比：去掉无意义的小数尾巴，1.5 → 1.5，2 → 2 */
const fmtRate = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
/** 支出：为零时不显示负号，避免“−¥0.00”这种噪音 */
const spend = (v) => (Number(v) > 0 ? `− ¥${fmt(v)}` : `¥${fmt(0)}`);
/** 表格里统一不带货币符号（表头已标注单位：元） */
const spendNum = (v) => (Number(v) > 0 ? `−${fmt(v)}` : fmt(0));
const sgn = (v) => (Number(v) > 0 ? 'pos' : Number(v) < 0 ? 'neg' : 'zero');
const pct = (v) => {
  const total = Number(d.value?.total?.income || 0);
  if (!total) return 0;
  return Math.round((Number(v || 0) / total) * 1000) / 10;
};

const mainCards = computed(() => {
  const x = d.value;
  if (!x) return [];
  return [
    {
      label: '今日经营净利',
      value: fmt(x.today.net),
      color: Number(x.today.net) >= 0 ? '#e63c26' : '#1f9d5f',
      hint: `收入 ¥${fmt(x.today.income)} − 支出 ¥${fmt(x.today.drive_award)}`,
    },
    {
      label: '本月经营净利',
      value: fmt(x.month.net),
      color: Number(x.month.net) >= 0 ? '#e63c26' : '#1f9d5f',
      hint: `${x.month.orders} 单 · 成交 ¥${fmt(x.month.gmv)}`,
    },
    {
      label: '累计经营净利',
      value: fmt(x.total.net),
      color: Number(x.total.net) >= 0 ? '#e63c26' : '#1f9d5f',
      hint: `累计成交 ¥${fmt(x.total.gmv)}`,
    },
    {
      label: '会员负债',
      value: fmt(x.liability.total),
      color: '#22252b',
      hint: `余额 ¥${fmt(x.liability.balance)} + 佣金 ¥${fmt(x.liability.commission)}`,
    },
  ];
});

const subCards = computed(() => {
  const x = d.value;
  if (!x) return [];
  return [
    {
      label: '累计现金净流',
      value: fmt(x.total.cash_net),
      money: true,
      color: Number(x.total.cash_net) >= 0 ? '#e63c26' : '#1f9d5f',
      hint: `经营净利 ¥${fmt(x.total.net)} − 回收 ¥${fmt(x.total.recycle_cost)}`,
    },
    {
      label: '待审核提现',
      value: fmt(x.liability.pending_withdraw),
      money: true,
      color: '#c88a1e',
      hint: `已打款 ¥${fmt(x.liability.paid_withdraw)}`,
    },
    {
      label: '单均毛利',
      value: fmtRate(x.rate.per_order),
      unit: '%',
      color: Number(x.rate.per_order) > 0 ? '#e63c26' : '#1f9d5f',
      hint: `服务费 ${fmtRate(x.rate.service_charge)}% − 直推奖 ${fmtRate(x.rate.drive_award)}%`,
    },
  ];
});

const rateCards = computed(() => {
  const x = d.value;
  if (!x) return [];
  return [
    { k: '抢单服务费', v: fmtRate(x.rate.service_charge), color: '#e63c26' },
    { k: '直推奖', v: fmtRate(x.rate.drive_award), color: '#1f9d5f' },
    { k: '转拍上架费', v: fmtRate(x.rate.listing_fee) },
    { k: '单均毛利', v: fmtRate(x.rate.per_order), color: Number(x.rate.per_order) > 0 ? '#e63c26' : '#1f9d5f' },
  ];
});

const riskCount = computed(() => {
  const list = d.value?.risks || [];
  const bad = list.filter((x) => x.level === 'high' || x.level === 'warn').length;
  return bad ? `${bad} 项需要处理` : '全部正常';
});

const maxAbs = computed(() => {
  const list = d.value?.trend_daily || [];
  return Math.max(1, ...list.map((x) => Math.abs(Number(x.net) || 0)));
});

const barStyle = (v) => {
  const h = (Math.abs(Number(v) || 0) / maxAbs.value) * 48;
  const height = `${Number(v) === 0 ? 0 : Math.max(1.5, h)}%`;
  return Number(v) >= 0 ? { bottom: '50%', height } : { top: '50%', height };
};

async function load() {
  loading.value = true;
  try {
    const r = await adminApi.financeOverview();
    d.value = r.data || null;
  } catch {
    d.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.mt14 { margin-top: 14px; }
.head-actions { display: flex; gap: 9px; }

.stat-card .value.small { font-size: 21px; }
.stat-card .sym { font-size: 14px; font-weight: 600; margin-right: 1px; opacity: 0.8; }
.stat-card .unit { font-size: 14px; font-weight: 600; margin-left: 2px; opacity: 0.8; }

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 650;
  margin-bottom: 14px;
}
.panel-head .sub { font-size: 11.5px; color: #8c93a0; font-weight: 450; }
.panel-head .more { font-size: 12px; color: #8c93a0; cursor: pointer; font-weight: 450; }
.panel-head .more:hover { color: #ff513a; }

.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.divider { height: 1px; background: #f0f2f5; margin: 14px 0; }

/* ---- 风险 ---- */
.risk-list { display: flex; flex-direction: column; gap: 10px; }
.risk {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 12px 14px;
  border-radius: 11px;
  background: #fafbfc;
  border-left: 3px solid #d7dbe2;
}
.risk-dot { width: 7px; height: 7px; border-radius: 50%; background: #b9bfc9; margin-top: 6px; flex: none; }
.risk-main { flex: 1; min-width: 0; }
.risk-t { font-size: 13px; font-weight: 620; }
.risk-d { font-size: 12px; color: #7d848f; margin-top: 4px; line-height: 1.6; }
.risk-tag { flex: none; font-size: 11.5px; padding: 2px 9px; border-radius: 6px; background: #f2f4f7; color: #7d848f; font-weight: 500; }

.lv-high { background: #fff1ee; border-left-color: #e63c26; }
.lv-high .risk-dot { background: #e63c26; }
.lv-high .risk-tag { background: #ffe0da; color: #c9351f; }

.lv-warn { background: #fff7e8; border-left-color: #e0a02a; }
.lv-warn .risk-dot { background: #e0a02a; }
.lv-warn .risk-tag { background: #fdeecb; color: #a8720f; }

.lv-info { background: #eef4ff; border-left-color: #3d6fdd; }
.lv-info .risk-dot { background: #3d6fdd; }
.lv-info .risk-tag { background: #dfe9ff; color: #2f5bbe; }

.lv-ok { background: #eefaf3; border-left-color: #1f9d5f; }
.lv-ok .risk-dot { background: #1f9d5f; }
.lv-ok .risk-tag { background: #d8f2e4; color: #18804d; }

/* ---- 收入结构 ---- */
.split { padding-top: 2px; }
.split-bar {
  display: flex;
  height: 12px;
  border-radius: 7px;
  overflow: hidden;
  background: #f2f4f7;
}
.seg { transition: width 0.35s; }
.seg-a { background: linear-gradient(90deg, #ff826e, #ff513a); }
.seg-b { background: linear-gradient(90deg, #ffc861, #ffb020); }

.split-legend { margin-top: 12px; display: flex; flex-direction: column; gap: 9px; }
.lg { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.lg i { width: 8px; height: 8px; border-radius: 3px; flex: none; }
.lg-k { color: #7d848f; flex: 1; }
.lg-v { font-variant-numeric: tabular-nums; font-weight: 600; }
.lg-p { width: 48px; text-align: right; color: #a8adb7; font-size: 11.5px; font-variant-numeric: tabular-nums; }

.kv-list { display: flex; flex-direction: column; gap: 9px; }
.kv { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; }
.kv span { color: #7d848f; }
.kv b { font-variant-numeric: tabular-nums; font-weight: 620; }
.kv.strong { padding-top: 9px; border-top: 1px dashed #eceff3; }
.kv.strong span { color: #22252b; font-weight: 600; }
.kv.strong b { font-size: 15px; }

/* ---- 费率 ---- */
.rate-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.rate { background: #fafbfc; border-radius: 10px; padding: 11px 12px; }
.rate-k { font-size: 11.5px; color: #8c93a0; }
.rate-v { font-size: 18px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
.rate-v .unit { font-size: 12px; font-weight: 600; margin-left: 1px; opacity: 0.75; }

.formula { margin-top: 12px; background: #fff8f6; border: 1px solid #ffe4dd; border-radius: 11px; padding: 12px 14px; }
.f-title { font-size: 12px; color: #a8adb7; }
.f-body { font-size: 15px; font-weight: 650; margin-top: 5px; font-variant-numeric: tabular-nums; }
.f-note { font-size: 11.5px; color: #8c93a0; margin-top: 5px; }

/* ---- 趋势图 ---- */
.chart { display: flex; align-items: stretch; gap: 4px; height: 190px; }
.cw { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.col { flex: 1; position: relative; }
.axis {
  position: absolute;
  left: 0; right: 0; top: 50%;
  height: 1px;
  background: #eceff3;
}
.bar {
  position: absolute;
  left: 14%;
  width: 72%;
  border-radius: 3px;
  transition: height 0.3s;
}
.bar.up { background: linear-gradient(180deg, #ff826e, #ff513a); border-radius: 4px 4px 2px 2px; }
.bar.down { background: linear-gradient(0deg, #34b37a, #1f9d5f); border-radius: 2px 2px 4px 4px; }
.lbl { height: 17px; text-align: center; font-size: 10px; color: #a8adb7; padding-top: 4px; white-space: nowrap; }
.chart-empty { text-align: center; font-size: 12px; color: #a8adb7; margin-top: -18px; padding-bottom: 6px; }

.pos { color: #e63c26; }
.neg { color: #1f9d5f; }
.zero { color: #7d848f; }

/* ---- 说明弹窗 ---- */
.rule { display: flex; flex-direction: column; gap: 13px; }
.rule-item { display: flex; gap: 14px; }
.rule-k { flex: 0 0 88px; font-size: 12.5px; font-weight: 650; color: #222831; }
.rule-c { flex: 1; font-size: 12.5px; color: #626a76; line-height: 1.68; }
.rule-tip {
  margin-top: 16px;
  padding: 11px 14px;
  background: #fafbfc;
  border-radius: 10px;
  font-size: 12px;
  color: #8c93a0;
  line-height: 1.65;
}

@media (max-width: 1100px) {
  .grid2 { grid-template-columns: 1fr; }
}
</style>
