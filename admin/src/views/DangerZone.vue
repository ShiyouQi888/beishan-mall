<template>
  <div>
    <div class="page-head">
      <div>
        <h2>数据清除</h2>
        <div class="desc">给真人全量测试用的清库工具：把测试过程产生的订单、资金、会员清掉，商品复位，回到干净起点</div>
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
        真出问题可以拿备份文件回滚。后台账号、权限、系统配置、分类、场次、广告、公告都不会被动；
        商品只复位、不删除。
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
          <li>商品详情文字、详情长图、主图与图集（复位时一律不动）</li>
          <li>广告、导航、公告、运费模板、会员等级</li>
          <li>官方账号（邀请码来源 + 商品初始持有人）</li>
        </ul>
      </div>
    </div>

    <div class="panel mt14 factory">
      <div class="factory-main">
        <div class="factory-t">恢复出厂</div>
        <div class="factory-d">
          一次做完四件事：清空<b>会员、订单、财务与资金流水</b>；<b>复位商品</b>（持有人回官方、名额复原、转拍与销量归零、解除封顶并重新上架）；
          <b>清理没人用的素材</b>。只留下官方账号，回到刚部署好的状态。
          <br />
          <b>商品不删除：详情文字、详情长图、主图与图集、分类、场次关联、系统设置全部保留。</b>
        </div>
      </div>
      <el-button type="danger" @click="factoryReset">恢复出厂设置</el-button>
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
          <!-- 勾选框自己也要能点：以前这里挂了 @click.stop 但没有处理函数，
               点方框本身完全没反应，只能点卡片空白处，看起来就是「选不动」 -->
          <el-checkbox :model-value="scopes.includes(key)" @click.stop.prevent="toggle(key)" />
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
          <span v-if="!scopes.length" class="muted">（还没选任何范围）</span>
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
        <div v-if="scopes.includes('member')" class="risk-safe goods">
          商品原本挂在被清理的会员名下时，会自动回到官方账号名下。只改「现持有人」这一个字段，
          价格、状态、销量、详情、图片都不动。
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

/** 某个范围会影响多少行。detail 由后端按「全部范围」统计，跟选没选中无关 */
function rowsOf(key) {
  return (detail.value[key] || []).reduce((s, x) => s + Number(x.rows || 0), 0);
}

/** 本次要清多少行：只算勾上的，跟着勾选实时变 */
const total = computed(() => scopes.value.reduce((s, k) => s + rowsOf(k), 0));

async function load() {
  try {
    const r = await adminApi.resetPlan(scopes.value);
    scopeMeta.value = r.data?.scopes || {};
    detail.value = r.data?.detail || {};
    summary.value = r.data?.summary || {};
    confirmText.value = r.data?.confirm_text || '';
  } catch {}
}

function toggle(key) {
  const i = scopes.value.indexOf(key);
  if (i >= 0) {
    scopes.value.splice(i, 1);
    load();
    return;
  }
  scopes.value.push(key);
  // 只清会员会留下指向不存在会员的孤儿订单，后端也会拦。
  // 与其让用户点完被报错拦下，不如勾会员时自动把订单资金一起带上，并说清楚。
  if (key === 'member' && !scopes.value.includes('trade')) {
    scopes.value.push('trade');
    ElMessage.warning('已同时勾选「订单与资金」：只清会员会留下孤儿订单');
  }
  load();
}

function selectAll() {
  scopes.value = Object.keys(scopeMeta.value);
  load();
}

/** 恢复出厂 = 四项全带：会员、订单资金、商品复位、没人用的素材 */
const FACTORY_SCOPES = ['trade', 'member', 'goods', 'media'];

/** 恢复出厂：四个范围全选，直接进确认弹窗 */
function factoryReset() {
  const keys = Object.keys(scopeMeta.value);
  scopes.value = keys.length ? keys.filter((k) => FACTORY_SCOPES.includes(k)) : [...FACTORY_SCOPES];
  load();
  openConfirm();
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

/* 恢复出厂：一整块独立卡片，和下面的细粒度勾选分开，避免被当成普通选项 */
.factory {
  display: flex;
  align-items: center;
  gap: 18px;
  border: 1px solid #ffd9d2;
  background: linear-gradient(180deg, #fffaf9, #fff);
}
.factory-main { flex: 1; min-width: 0; }
.factory-t { font-size: 14px; font-weight: 700; color: #c9351f; }
.factory-d { margin-top: 5px; font-size: 12.5px; color: #626a76; line-height: 1.75; }
.factory-d b { color: #22252b; }

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
.foot-tip .muted { color: #a8adb7; margin-left: 4px; }

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
.risk-safe.goods { margin-top: 8px; background: #f4f7fd; color: #3f5f92; }
.risk-safe.goods b { color: #2b4a7d; }

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
