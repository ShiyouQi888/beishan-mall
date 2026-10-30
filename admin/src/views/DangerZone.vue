<template>
  <div>
    <div class="page-head">
      <div>
        <h2>数据清除</h2>
        <div class="desc">给真人全量测试用的清库工具：把测试过程产生的订单、资金、会员清掉，回到干净起点</div>
      </div>
      <el-button @click="load">刷新数据量</el-button>
    </div>

    <div class="warn-banner">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
        <path d="M12 3.8 21 19.5H3L12 3.8Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
        <path d="M12 9.6v4.2M12 16.7v.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />
      </svg>
      <div>
        <b>删除后无法撤销。</b>执行前系统会自动把数据库备份到 <code>server/data/backup/</code>，
        真出问题可以拿备份文件回滚。后台账号、权限、系统配置、分类、场次、商品、广告、公告都不会被动。
      </div>
    </div>

    <div class="grid2">
      <div class="panel">
        <div class="panel-head"><span>当前数据量</span><span class="sub">实时统计</span></div>
        <div class="stat-row">
          <div class="stat" v-for="s in statCards" :key="s.k">
            <div class="v">{{ s.v }}</div>
            <div class="k">{{ s.k }}</div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <span>保留什么</span>
          <span class="sub">这些清掉之后页面就打不开了</span>
        </div>
        <ul class="keep-list">
          <li>后台账号、角色与权限节点</li>
          <li>系统设置（费率、导航、支付、须知等全部配置）</li>
          <li>商品分类、抢购场次、商品本身（只复位，不删除）</li>
          <li>广告、导航、公告、运费模板、会员等级</li>
          <li>官方账号（邀请码来源 + 商品初始持有人）</li>
        </ul>
      </div>
    </div>

    <div class="panel mt14">
      <div class="panel-head">
        <span>选择清除范围</span>
        <span class="sub">
          <a class="link" @click="selectAll">全选</a>
          <i class="sep">·</i>
          <a class="link" @click="scopes = []">全不选</a>
        </span>
      </div>

      <div class="scope-grid">
        <div v-for="(cfg, key) in scopeMeta" :key="key" class="scope" :class="{ on: scopes.includes(key) }" @click="toggle(key)">
          <el-checkbox :model-value="scopes.includes(key)" @click.stop />
          <div class="scope-main">
            <div class="scope-t">{{ cfg.label }}</div>
            <div class="scope-d">{{ cfg.desc }}</div>
          </div>
          <div class="scope-n">
            <b>{{ rowsOf(key) }}</b>
            <span>行</span>
          </div>
        </div>
      </div>

      <div class="foot">
        <div class="foot-tip">
          本次将清除约 <b>{{ total }}</b> 行数据
          <span v-if="scopes.includes('member') && !scopes.includes('trade')" class="bad">（清除会员必须同时清除订单，否则会产生孤儿订单）</span>
        </div>
        <el-button type="danger" :disabled="!scopes.length" @click="openConfirm">清除选中数据</el-button>
      </div>
    </div>

    <div v-if="result" class="panel mt14 result">
      <div class="panel-head"><span>已清除</span><span class="sub">{{ result.backup }}</span></div>
      <div class="res-row">
        <div class="res" v-for="(n, k) in result.removed" :key="k">
          <span>{{ scopeMeta[k]?.label || k }}</span>
          <b>{{ n }} 行</b>
        </div>
      </div>
      <div class="res-note">
        共 {{ result.total }} 行；数据库已备份为 <code>{{ result.backup }}</code>。
        测试可以从干净状态开始：邀请码 <code>{{ result.official?.code }}</code>，
        官方账号 <code>{{ result.official?.mobile }}</code>。
      </div>
    </div>

    <!-- 确认弹窗 -->
    <el-dialog v-model="confirmDlg" title="确认清除数据" width="560px" :close-on-click-modal="false" @closed="typed = ''">
      <div class="risk">
        <div class="risk-t">即将清除以下数据，且无法撤销：</div>
        <ul>
          <li v-for="k in scopes" :key="k">
            <b>{{ scopeMeta[k]?.label }}</b> —— {{ scopeMeta[k]?.desc }}
            <span class="num">约 {{ rowsOf(k) }} 行</span>
          </li>
        </ul>
        <div class="risk-safe">
          会自动备份数据库；后台账号、权限、系统设置、商品、分类、场次、广告、公告不受影响。
        </div>
      </div>

      <div class="confirm-box">
        <div class="cb-t">请把下面这句话原样输入到输入框里，才能执行：</div>
        <div class="cb-phrase">
          <code>{{ confirmText }}</code>
          <el-button size="small" text type="primary" @click="copyPhrase">{{ copied ? '已复制' : '一键复制' }}</el-button>
        </div>
        <el-input v-model="typed" :placeholder="`粘贴或输入：${confirmText}`" @keyup.enter="doReset" />
        <div class="cb-hint" :class="{ ok: matched }">
          {{ matched ? '✓ 确认文字一致，可以执行' : '输入内容与上方文字完全一致后才能点确认' }}
        </div>
      </div>

      <template #footer>
        <el-button @click="confirmDlg = false">取消</el-button>
        <el-button type="danger" :disabled="!matched || saving" :loading="saving" @click="doReset">
          确认清除
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { adminApi } from '../api.js';

const scopes = ref([]);
const scopeMeta = ref({});
const detail = ref({});
const total = ref(0);
const summary = ref({});
const confirmText = ref('');
const confirmDlg = ref(false);
const typed = ref('');
const saving = ref(false);
const result = ref(null);
const copied = ref(false);

const matched = computed(() => typed.value.trim() === confirmText.value && !!confirmText.value);

const statCards = computed(() => [
  { k: '会员', v: summary.value.member ?? 0 },
  { k: '订单', v: summary.value.orders ?? 0 },
  { k: '资金流水', v: summary.value.energy ?? 0 },
  { k: '提现申请', v: summary.value.withdraw ?? 0 },
  { k: '商品', v: summary.value.goods ?? 0 },
  { k: '素材文件', v: summary.value.media ?? 0 },
]);

const rowsOf = (key) => (detail.value[key] || []).reduce((s, x) => s + Number(x.rows || 0), 0);

async function load() {
  try {
    const r = await adminApi.resetPlan(scopes.value);
    scopeMeta.value = r.data?.scopes || {};
    detail.value = r.data?.detail || {};
    total.value = Number(r.data?.total || 0);
    summary.value = r.data?.summary || {};
    confirmText.value = r.data?.confirm_text || '';
  } catch {}
}

function toggle(key) {
  const i = scopes.value.indexOf(key);
  if (i >= 0) scopes.value.splice(i, 1);
  else scopes.value.push(key);
  load();
}

function selectAll() {
  scopes.value = Object.keys(scopeMeta.value);
  load();
}

async function copyPhrase() {
  try {
    await navigator.clipboard.writeText(confirmText.value);
    copied.value = true;
    ElMessage.success('已复制，直接粘贴到下方输入框');
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    ElMessage.warning('浏览器不允许自动复制，请手动选中上面那行文字');
  }
}

function openConfirm() {
  typed.value = '';
  confirmDlg.value = true;
}

async function doReset() {
  if (!matched.value) return;
  saving.value = true;
  try {
    const r = await adminApi.resetData({ scopes: scopes.value, confirm: typed.value.trim() });
    result.value = r.data || null;
    ElMessage.success(r.msg || '已清除');
    confirmDlg.value = false;
    await load();
  } catch {
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.mt14 { margin-top: 14px; }
.grid2 { display: grid; grid-template-columns: 1.15fr 1fr; gap: 14px; }

.warn-banner {
  display: flex;
  gap: 11px;
  align-items: flex-start;
  padding: 14px 16px;
  margin-bottom: 14px;
  border: 1px solid #ffd9d2;
  border-radius: 12px;
  background: #fff6f4;
  color: #a8402f;
  font-size: 12.5px;
  line-height: 1.75;
}
.warn-banner b { color: #c9351f; }
.warn-banner code { background: #ffe9e5; padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }

.panel-head { display: flex; align-items: center; justify-content: space-between; font-size: 14px; font-weight: 650; margin-bottom: 14px; }
.panel-head .sub { font-size: 11.5px; color: #8c93a0; font-weight: 450; }
.panel-head .link { color: #ff513a; cursor: pointer; }
.panel-head .link:hover { text-decoration: underline; }
.panel-head .sep { margin: 0 6px; opacity: 0.4; }

.stat-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.stat { background: #fafbfc; border-radius: 10px; padding: 11px 12px; }
.stat .v { font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat .k { font-size: 11.5px; color: #8c93a0; margin-top: 2px; }

.keep-list { margin: 0; padding-left: 18px; font-size: 12.5px; color: #626a76; line-height: 2; }

.scope-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.scope {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 13px 14px;
  border: 1px solid #eceff3;
  border-radius: 12px;
  cursor: pointer;
  transition: border-color 0.16s, background 0.16s;
}
.scope:hover { border-color: #ffcdc5; }
.scope.on { border-color: #ff8f7a; background: #fffaf9; }
.scope-main { flex: 1; min-width: 0; }
.scope-t { font-size: 13px; font-weight: 620; }
.scope-d { font-size: 11.5px; color: #8c93a0; margin-top: 4px; line-height: 1.6; }
.scope-n { flex: none; text-align: right; }
.scope-n b { font-size: 17px; font-variant-numeric: tabular-nums; color: #22252b; }
.scope-n span { font-size: 11px; color: #a8adb7; margin-left: 2px; }

.foot { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; padding-top: 14px; border-top: 1px solid #f2f4f7; }
.foot-tip { font-size: 12.5px; color: #626a76; }
.foot-tip b { color: #c9351f; font-size: 15px; }
.foot-tip .bad { color: #c9351f; margin-left: 6px; }

.result .res-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
.res { display: flex; align-items: baseline; justify-content: space-between; background: #fafbfc; border-radius: 10px; padding: 10px 12px; font-size: 12.5px; }
.res span { color: #8c93a0; }
.res b { font-variant-numeric: tabular-nums; }
.res-note { margin-top: 12px; font-size: 12px; color: #8c93a0; line-height: 1.8; }
.res-note code { background: #f4f6f9; padding: 1px 5px; border-radius: 4px; }

.risk { font-size: 12.5px; color: #4f5662; }
.risk-t { font-weight: 650; color: #c9351f; margin-bottom: 8px; }
.risk ul { margin: 0 0 10px; padding-left: 18px; line-height: 1.9; }
.risk .num { color: #a8adb7; margin-left: 4px; white-space: nowrap; }
.risk-safe { padding: 10px 12px; background: #f5faf7; border-radius: 9px; color: #3d7a58; font-size: 12px; line-height: 1.7; }

.confirm-box { margin-top: 14px; padding-top: 14px; border-top: 1px solid #f2f4f7; }
.cb-t { font-size: 12.5px; color: #626a76; margin-bottom: 8px; }
.cb-phrase { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; margin-bottom: 10px; background: #fafbfc; border: 1px dashed #d7dbe2; border-radius: 9px; }
.cb-phrase code { font-size: 13px; color: #22252b; letter-spacing: 0.5px; user-select: all; }
.cb-hint { margin-top: 7px; font-size: 11.5px; color: #a8adb7; }
.cb-hint.ok { color: #1f9d5f; }

@media (max-width: 1000px) {
  .grid2 { grid-template-columns: 1fr; }
  .scope-grid { grid-template-columns: 1fr; }
}
</style>
