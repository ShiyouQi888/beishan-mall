<template>
  <div>
    <div class="page-head">
      <div>
        <h2>{{ pageTitle }}</h2>
        <div class="desc">{{ desc }}</div>
      </div>
      <el-button v-if="modKey !== 'report'" type="primary" @click="openCreate">+ 新增{{ mod.label || '' }}</el-button>
    </div>

    <div class="stat-row" v-if="modKey === 'goods' && stats">
      <div class="s-card" v-for="it in statItems" :key="it.k">
        <div class="s-label">{{ it.k }}</div>
        <div class="s-value">¥{{ it.v.toFixed(2) }}</div>
        <div class="s-sub">{{ it.c }} 件</div>
      </div>
    </div>

    <div class="panel">
      <div class="toolbar">
        <el-input
          v-model="keyword"
          placeholder="搜索关键词"
          style="width: 220px"
          clearable
          @keyup.enter="reload"
          @clear="reload"
        />
        <el-select v-if="modKey === 'orders'" v-model="filters.status" placeholder="订单状态" clearable style="width: 130px" @change="reload">
          <el-option label="待付款" :value="0" />
          <el-option label="待发货" :value="10" />
          <el-option label="待收货" :value="20" />
          <el-option label="已完成" :value="30" />
          <el-option label="已取消" :value="40" />
        </el-select>
        <el-select v-if="modKey === 'settle'" v-model="filters.kind" placeholder="账目类型" clearable style="width: 140px" @change="reload">
          <el-option label="大帐-结算" value="large" />
          <el-option label="中账-差额" value="medium" />
          <el-option label="小账-凭证" value="small" />
        </el-select>
        <el-select v-if="modKey === 'member'" v-model="filters.disabled" placeholder="会员状态" clearable style="width: 130px" @change="reload">
          <el-option label="正常" :value="10" />
          <el-option label="禁用" :value="20" />
        </el-select>
        <el-button @click="reload">查询</el-button>
        <div class="spacer" />
        <span class="total-hint">共 {{ total }} 条</span>
      </div>

      <el-table :data="rows" v-loading="loading" style="width: 100%" @selection-change="sel = $event">
        <el-table-column type="selection" width="42" />
        <el-table-column
          v-for="f in visibleFields"
          :key="f.k"
          :label="f.t"
          :min-width="f.w || 110"
          :fixed="f.k === mod.pk ? 'left' : undefined"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            <!-- 图片 -->
            <CategoryIcon
              v-if="f.type === 'image' && modKey === 'category' && f.k === 'image' && categoryIconKey(row[f.k])"
              :icon-key="categoryIconKey(row[f.k])"
              class="category-thumb"
            />
            <img v-else-if="f.type === 'image' && isImageSrc(row[f.k])" :src="row[f.k]" class="thumb" />
            <span v-else-if="f.type === 'image'" class="muted">—</span>

            <!-- 头像 -->
            <div v-else-if="f.type === 'avatar'" class="avatar-sm">
              <img v-if="isImageSrc(row[f.k])" :src="row[f.k]" />
              <span v-else>{{ (row.nick_name || 'U').slice(0, 1) }}</span>
            </div>

            <!-- 金额 -->
            <span v-else-if="f.type === 'money'" class="money" :class="{ 'money-red': Number(row[f.k]) > 0 && (f.k === 'total_price' || f.k === 'pay_price') }">
              ¥{{ Number(row[f.k] || 0).toFixed(2) }}
            </span>

            <!-- 状态 -->
            <span v-else-if="f.type === 'switch'" class="tag-status" :class="statusClass(row[f.k])">
              {{ labelOf(f, row[f.k]) }}
            </span>

            <!-- 下拉 -->
            <span v-else-if="f.type === 'select' && typeof f.opts === 'object' && !Array.isArray(f.opts)">
              <span v-if="f.k === 'status'" class="tag-status" :class="orderStatusClass(row[f.k])">{{ labelOf(f, row[f.k]) }}</span>
              <span v-else-if="f.k === 'type' && modKey === 'orders'" class="tag-status tag-red">{{ labelOf(f, row[f.k]) }}</span>
              <span v-else>{{ labelOf(f, row[f.k]) }}</span>
            </span>

            <!-- 场次下拉 -->
            <span v-else-if="f.type === 'select' && typeof f.opts === 'string'">
              {{ row['_' + f.k.replace('_id', '')] || optLabel(f.opts, row[f.k]) }}
            </span>

            <!-- 会员关联 -->
            <span v-else-if="f.type === 'member'">{{ row._member || row._buyer || row.member_id || '—' }}</span>

            <!-- 现持有人 -->
            <span v-else-if="f.type === 'holder'">
              <span v-if="row._holder">{{ row._holder }}<span class="muted" style="margin-left: 4px">{{ row._holder_mobile }}</span></span>
              <span v-else class="muted">平台</span>
            </span>

            <!-- 上级 -->
            <span v-else-if="f.type === 'parent'">
              {{ row._parent || '—' }}
            </span>

            <!-- 等级 -->
            <span v-else-if="f.type === 'vip'">
              <span class="tag-status tag-blue">{{ vipLabel(row[f.k]) }}</span>
            </span>

            <!-- 实名 -->
            <span v-else-if="f.type === 'cert'">
              <span class="tag-status" :class="row[f.k] === 1 ? 'tag-ok' : row[f.k] === 2 ? 'tag-warn' : 'tag-off'">
                {{ row[f.k] === 1 ? '已认证' : row[f.k] === 2 ? '审核中' : '未认证' }}
              </span>
            </span>

            <!-- 秒 → 时间 -->
            <span v-else-if="f.type === 'timesec'" class="mono">{{ secToTime(row[f.k]) }}</span>

            <!-- 开启日期 -->
            <span v-else-if="f.type === 'days'">{{ dayLabel(row[f.k]) }}</span>

            <!-- 富文本 -->
            <span v-else-if="f.type === 'rich'" class="muted">{{ stripHtml(row[f.k]) }}</span>

            <!-- 默认 -->
            <span v-else>{{ row[f.k] ?? '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <div class="ops">
              <template v-if="modKey === 'orders'">
                <el-button size="small" @click="openEdit(row)">详情</el-button>
                <el-button v-if="row.status === 10" size="small" type="primary" @click="openDeliver(row)">发货</el-button>
                <el-button v-if="row.status === 0" size="small" type="success" @click="confirmPay(row)">确认收款</el-button>
                <el-button v-if="row.status === 0" size="small" type="danger" @click="cancelOrder(row)">取消</el-button>
                <el-button v-if="row.type === 5 && row.status === 50" size="small" type="warning" @click="releaseStream(row)">释放</el-button>
              </template>
              <template v-else-if="modKey === 'withdraw'">
                <el-button v-if="row.status === 0" size="small" type="primary" @click="auditWithdraw(row, true)">通过</el-button>
                <el-button v-if="row.status === 0" size="small" type="danger" @click="auditWithdraw(row, false)">驳回</el-button>
                <el-button size="small" @click="openEdit(row)">查看</el-button>
              </template>
              <template v-else-if="modKey === 'certification'">
                <el-button v-if="row.status === 0" size="small" type="primary" @click="auditCert(row, true)">通过</el-button>
                <el-button v-if="row.status === 0" size="small" type="danger" @click="auditCert(row, false)">拒绝</el-button>
                <el-button size="small" @click="openEdit(row)">查看</el-button>
              </template>
              <template v-else-if="modKey === 'settle'">
                <el-button v-if="row.pay_status === 0" size="small" type="primary" @click="confirmSettle(row)">确认</el-button>
                <el-button size="small" @click="openEdit(row)">查看</el-button>
              </template>
              <template v-else-if="modKey === 'member'">
                <el-button size="small" @click="openEdit(row)">编辑</el-button>
                <el-button size="small" type="success" @click="openAdjust(row)">调账</el-button>
              </template>
              <template v-else-if="modKey === 'role'">
                <el-button v-if="row.role_id !== 6" size="small" type="primary" @click="openPerm(row)">分配权限</el-button>
                <el-button size="small" @click="openEdit(row)">编辑</el-button>
                <el-button v-if="row.role_id !== 6" size="small" type="danger" plain @click="removeOne(row)">删除</el-button>
              </template>
              <template v-else-if="modKey === 'report'">
                <el-button v-if="row.status === 0" size="small" type="primary" @click="auditReport(row)">处理</el-button>
                <el-button size="small" @click="openEdit(row)">查看</el-button>
              </template>
              <template v-else-if="modKey === 'specialarea'">
                <el-button size="small" type="primary" @click="$router.push(`/specialarea/${row.specialarea_id}`)">配置</el-button>
                <el-button size="small" type="danger" plain @click="removeOne(row)">删除</el-button>
              </template>
              <template v-else-if="modKey === 'role'">
                <el-button v-if="row.role_id !== 6" size="small" type="primary" @click="openPerm(row)">分配权限</el-button>
                <el-button size="small" @click="openEdit(row)">编辑</el-button>
                <el-button v-if="row.role_id !== 6" size="small" type="danger" plain @click="removeOne(row)">删除</el-button>
              </template>
              <template v-else-if="modKey === 'report'">
                <el-button v-if="row.status === 0" size="small" type="primary" @click="auditReport(row)">处理</el-button>
                <el-button size="small" @click="openEdit(row)">查看</el-button>
              </template>
              <template v-else-if="modKey === 'specialarea'">
                <el-button size="small" type="primary" @click="$router.push(`/specialarea/${row.specialarea_id}`)">配置</el-button>
                <el-button size="small" type="danger" plain @click="removeOne(row)">删除</el-button>
              </template>
              <template v-else-if="modKey === 'goods'">
                <el-button size="small" @click="openEdit(row)">编辑</el-button>
                <el-button v-if="!row.is_split" size="small" type="success" @click="openSplit(row)">拆分</el-button>
                <el-button v-else size="small" disabled>已拆分</el-button>
                <el-button size="small" type="danger" plain @click="removeOne(row)">删除</el-button>
              </template>
              <template v-else>
                <el-button size="small" @click="openEdit(row)">编辑</el-button>
                <el-button size="small" type="danger" plain @click="removeOne(row)">删除</el-button>
              </template>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="limit"
          :page-sizes="[10, 15, 30, 50]"
          :total="total"
          layout="total, sizes, prev, pager, next, jumper"
          background
          @current-change="load"
          @size-change="reload"
        />
      </div>
    </div>

    <!-- 编辑 / 新增 弹窗 -->
    <el-dialog v-model="dialog" :title="formTitle" width="620px" destroy-on-close>
      <el-form label-width="104px" label-position="right">
        <el-form-item v-for="f in formFields" :key="f.k" :label="f.t">
          <template v-if="f.type === 'image'">
            <div class="image-field">
              <template v-if="modKey === 'category' && f.k === 'image'">
                <div class="category-picker-label">内置专业图标</div>
                <CategoryIconPicker :model-value="form[f.k]" @update:model-value="form[f.k] = $event" />
                <div class="image-guidance">选择后会同步显示在 H5 首页分类导航和商品分类页；也可以继续上传自定义分类图。</div>
              </template>
              <ImageUploader
                :model-value="modKey === 'category' && f.k === 'image' && categoryIconKey(form[f.k]) ? '' : form[f.k]"
                :upload="uploadImage"
                @update:model-value="form[f.k] = $event"
              />
              <div v-if="imageRecommendation(f)" class="image-guidance">{{ imageRecommendation(f) }}</div>
            </div>
          </template>
          <template v-else-if="f.type === 'images'">
            <div class="image-field">
              <ImageUploader :model-value="form[f.k]" :upload="uploadImage" multiple @update:model-value="form[f.k] = $event" />
              <div v-if="imageRecommendation(f)" class="image-guidance">{{ imageRecommendation(f) }}</div>
            </div>
          </template>
          <el-select v-else-if="f.type === 'select'" v-model="form[f.k]" style="width: 100%">
            <el-option
              v-for="o in selectOptions(f)"
              :key="o.v"
              :label="o.t"
              :value="o.v"
            />
          </el-select>
          <el-switch
            v-else-if="f.type === 'switch'"
            v-model="form[f.k]"
            :active-value="switchVals(f).on"
            :inactive-value="switchVals(f).off"
            active-text="开启"
            inactive-text="关闭"
          />
          <el-input v-else-if="f.type === 'rich'" v-model="form[f.k]" type="textarea" :rows="5" placeholder="支持 HTML" />
          <el-input v-else-if="f.type === 'timesec'" :model-value="secToTime(form[f.k])" placeholder="如 09:00" @update:model-value="(v) => (form[f.k] = timeToSec(v))" />
          <el-input-number
            v-else-if="f.type === 'money' || f.type === 'number'"
            v-model="form[f.k]"
            :precision="f.type === 'money' ? 2 : 0"
            :min="0"
            style="width: 100%"
            controls-position="right"
          />
          <el-input v-else v-model="form[f.k]" :placeholder="`请输入${f.t}`" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 发货弹窗 -->
    <el-dialog v-model="deliverDlg" title="订单发货" width="440px">
      <el-form label-width="90px">
        <el-form-item label="快递公司">
          <el-input v-model="deliverForm.express_company" placeholder="如 顺丰速运" />
        </el-form-item>
        <el-form-item label="快递单号">
          <el-input v-model="deliverForm.express_no" placeholder="请输入快递单号" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="deliverDlg = false">取消</el-button>
        <el-button type="primary" @click="doDeliver">确认发货</el-button>
      </template>
    </el-dialog>

    <!-- 分配权限 -->
    <el-dialog v-model="permDlg" title="分配权限" width="660px" destroy-on-close>
      <div class="perm-head">
        角色：<b>{{ permRole.role_name }}</b>
        <span class="muted">勾选该角色可以访问的菜单</span>
      </div>
      <div class="perm-tree" v-loading="permLoading">
        <div class="perm-group" v-for="g in nodeTree" :key="g.id">
          <el-checkbox
            :model-value="groupChecked(g)"
            :indeterminate="groupIndeterminate(g)"
            @change="(v) => toggleGroup(g, v)"
          >
            <b>{{ g.name }}</b>
          </el-checkbox>
          <div class="perm-children">
            <el-checkbox
              v-for="c in g.children"
              :key="c.id"
              :model-value="!!permChecked[c.id]"
              @change="(v) => (permChecked[c.id] = v)"
            >{{ c.name }}</el-checkbox>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="permDlg = false">取消</el-button>
        <el-button type="primary" @click="savePerm">保存权限</el-button>
      </template>
    </el-dialog>

    <!-- 商品拆分 -->
    <el-dialog v-model="splitDlg" title="拆分商品" width="440px">
      <el-form label-width="96px">
        <el-form-item label="商品">{{ splitRow.goods_name }}</el-form-item>
        <el-form-item label="当前价格">
          <span class="money">¥{{ Number(splitRow.goods_min_price || 0).toFixed(2) }}</span>
        </el-form-item>
        <el-form-item label="拆分份数">
          <el-input-number v-model="splitParts" :min="2" :max="1000" style="width: 100%" controls-position="right" />
        </el-form-item>
        <el-form-item label="每份价格">
          <span class="money money-red">
            ¥{{ (Number(splitRow.goods_min_price || 0) / (splitParts || 1)).toFixed(2) }}
          </span>
          <span class="muted" style="margin-left: 8px">按份出售，每份独立成交</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="splitDlg = false">取消</el-button>
        <el-button type="primary" @click="doSplit">确认拆分</el-button>
      </template>
    </el-dialog>

    <!-- 会员调账 -->
    <el-dialog v-model="adjustDlg" title="会员资金调整" width="440px">
      <el-form label-width="90px">
        <el-form-item label="会员">{{ adjustRow.nick_name }}</el-form-item>
        <el-form-item label="调整项目">
          <el-select v-model="adjustForm.field" style="width: 100%">
            <el-option label="账户余额" value="amount" />
            <el-option label="佣金" value="e_card_number" />
            <el-option label="积分" value="score" />
            <el-option label="礼券" value="fy_price" />
            <el-option label="抢购金额" value="rush_amount" />
          </el-select>
        </el-form-item>
        <el-form-item label="变更数量">
          <el-input-number v-model="adjustForm.value" :precision="2" style="width: 100%" controls-position="right" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="adjustForm.remark" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustDlg = false">取消</el-button>
        <el-button type="primary" @click="doAdjust">确认调整</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { adminApi } from '../api.js';
import http from '../api.js';
import ImageUploader from '../components/ImageUploader.vue';
import CategoryIcon from '../../../shared/CategoryIcon.vue';
import CategoryIconPicker from '../../../shared/CategoryIconPicker.vue';
import { categoryIconKey } from '../../../shared/category-icons.js';

const adminApiPost = async (url, data) => (await http.post(url, data)).data;

const route = useRoute();
const modKey = computed(() => route.meta.module);
const fixed = computed(() => route.meta.fixed || {});
const pageTitle = computed(() => route.meta.title || '列表');

const mod = ref({});
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const limit = ref(15);
const keyword = ref('');
const loading = ref(false);
const sel = ref([]);
const optsCache = reactive({});

const filters = reactive({ status: '', kind: '', disabled: '' });

const dialog = ref(false);
const saving = ref(false);
const form = reactive({});
const editing = ref(false);

const deliverDlg = ref(false);
const deliverForm = reactive({ order_id: 0, express_company: '顺丰速运', express_no: '' });

const adjustDlg = ref(false);
const adjustRow = ref({});
const adjustForm = reactive({ field: 'amount', value: 0, remark: '' });

const visibleFields = computed(() => (mod.value.fields || []).filter((f) => !f.hide));
const formFields = computed(() =>
  (mod.value.fields || []).filter((f) => !f.readonly && f.k !== mod.value.pk),
);
const formTitle = computed(() => (editing.value ? `编辑${mod.value.label}` : `新增${mod.value.label}`));

/**
 * 只把「真图片地址」交给 <img>。
 * 分类图标存的是 icon:xxx 这种内置图标键；切换列表页时组件复用会有一帧
 * 「新模块 + 旧行数据」，若不校验就会把 icon:all 当 URL 请求，报 ERR_UNKNOWN_URL_SCHEME。
 */
function isImageSrc(v) {
  if (typeof v !== 'string' || !v) return false;
  return /^https?:\/\//i.test(v) || v.startsWith('data:image/') || v.startsWith('blob:') || v.startsWith('/');
}

function imageRecommendation(field) {
  const key = field.k;
  const module = modKey.value;
  if (module === 'banner' && key === 'file_path') return '首页轮播按 16:9 显示，推荐 1080×608 px；裁剪请选择「16:9」，重要文字和主体尽量靠中间。';
  if (module === 'goods' && key === 'good_thumb') return '商品卡片按正方形显示，推荐 800×800 px；主体居中，四周留少量空白。';
  if (module === 'goods' && key === 'images') return '商品详情图推荐 800×800 px（1:1），多张图尽量统一比例；建议单张不超过 2 MB。';
  if (module === 'category' && key === 'image') return '分类图标推荐 512×512 px（1:1），主体居中，建议使用透明背景 PNG 或 WebP。';
  if (module === 'navigation' && key === 'file_path') return '导航图标推荐 512×512 px（1:1），主体居中并预留边距。';
  if (module === 'certification') return '证件照片建议 1200×800 px（3:2）或更高分辨率；请完整拍入证件四边并保持文字清晰。';
  if (module === 'report' && key === 'images') return '凭证截图建议长边至少 1200 px；请保留完整内容，避免裁掉订单号或关键信息。';
  if (module === 'orders' && key === 'goods_thumb') return '商品缩略图按正方形显示，推荐 800×800 px。';
  return '建议使用清晰原图；裁剪比例按前台展示需要选择，重要内容留在画面中央。';
}

const desc = computed(() => {
  const m = {
    goods: '抢购商品管理，支持编辑价格、场次、持有人与上下架状态',
    category: '首页抢购分类与商城分类维护',
    specialarea: '每日抢购场次设置，控制开始/结束时间与限购数量',
    orders: '全部订单查询、发货、审核与状态流转',
    settle: '大账结算、中账差额、小账凭证三类账目核对',
    energy: '会员佣金、余额、积分变更流水',
    withdraw: '会员提现申请审核，驳回自动退回余额',
    member: '会员资料、等级、团队关系与资金账户',
    certification: '会员实名认证资料审核',
    banner: '首页与抢购页轮播广告位',
    navigation: '首页宫格导航入口配置',
    notice: '平台公告发布与编辑',
    recharge: '充值面值与赠送积分套餐',
    storeuser: '后台管理员账号管理',
    role: '后台角色与会员等级定义',
  };
  return m[modKey.value] || '';
});

const optLabel = (name, v) => {
  const list = optsCache[name] || [];
  return list.find((x) => String(x.id) === String(v))?.name || (v || '—');
};

const selectOptions = (f) => {
  if (typeof f.opts === 'string') {
    return (optsCache[f.opts] || []).map((x) => ({ v: x.id, t: x.name }));
  }
  return Object.entries(f.opts || {}).map(([v, t]) => ({
    v: isNaN(Number(v)) ? v : Number(v),
    t,
  }));
};

const labelOf = (f, v) => {
  if (typeof f.opts === 'object') return f.opts[v] ?? v ?? '—';
  return v ?? '—';
};

const switchVals = (f) => {
  const keys = Object.keys(f.opts || { 10: '开', 20: '关' }).map(Number).filter((n) => !isNaN(n));
  const sorted = keys.sort((a, b) => a - b);
  return { on: sorted[sorted.length - 1] ?? 10, off: sorted[0] ?? 0 };
};

const vipLabel = (v) =>
  ['普通会员', '银卡会员', '金卡会员', '铂金会员', '钻石会员'][v] || `等级${v}`;

const statusClass = (v) => {
  const n = Number(v);
  if (n === 10) return 'tag-ok';
  if (n === 20) return 'tag-off';
  return 'tag-warn';
};

const orderStatusClass = (v) => {
  const n = Number(v);
  if (n === 30) return 'tag-ok';
  if (n === 10 || n === 20) return 'tag-blue';
  if (n === 0) return 'tag-warn';
  return 'tag-off';
};

const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const dayLabel = (v) => {
  const arr = String(v || '')
    .split(',')
    .map(Number)
    .filter((x) => x >= 1 && x <= 7)
    .sort((a, b) => a - b);
  if (!arr.length) return '—';
  if (arr.length === 7) return '每天';
  if (arr.join(',') === '6,7') return '周末';
  if (arr.join(',') === '1,2,3,4,5') return '工作日';
  return arr.map((x) => '周' + DAY_NAMES[x - 1]).join(' ');
};

const secToTime = (sec) => {
  const n = Number(sec) || 0;
  if (!n) return '—';
  return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}`;
};
const timeToSec = (txt) => {
  const m = String(txt || '').match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
};

const stripHtml = (h) => String(h || '').replace(/<[^>]+>/g, '').slice(0, 40);
const imgList = (s) => {
  try {
    const a = JSON.parse(s || '[]');
    return Array.isArray(a) ? a : [s];
  } catch {
    return s ? [s] : [];
  }
};

async function load() {
  loading.value = true;
  try {
    const params = { page: page.value, limit: limit.value };
    if (keyword.value) params.keyword = keyword.value;
    for (const [k, v] of Object.entries(filters)) {
      if (v !== '' && v !== undefined && v !== null) params[k] = v;
    }
    Object.assign(params, fixed.value);
    const r = await adminApi.list(modKey.value, params);
    rows.value = r.data.data || [];
    total.value = r.data.total || 0;
    mod.value = r.data.module || mod.value;
    await loadSelects();
    loadStats();
  } catch {
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadSelects() {
  const need = new Set();
  for (const f of mod.value.fields || []) {
    if (f.type === 'select' && typeof f.opts === 'string') need.add(f.opts);
  }
  for (const n of need) {
    if (!optsCache[n]) {
      try {
        const r = await adminApi.options(n);
        optsCache[n] = r.data || [];
      } catch {
        optsCache[n] = [];
      }
    }
  }
}

function reload() {
  page.value = 1;
  load();
}

function openCreate() {
  editing.value = false;
  for (const k of Object.keys(form)) delete form[k];
  mod.value.fields?.forEach((f) => {
    if (f.readonly) return;
    form[f.k] = f.type === 'money' || f.type === 'number' ? 0 : '';
  });
  if ('goods_status' in form) form.goods_status = 10;
  if ('is_open' in form) form.is_open = 10;
  if ('disabled' in form && modKey.value === 'navigation') form.disabled = 10;
  if ('type' in form) form.type = 1;
  if ('sort' in form) form.sort = 100;
  if ('num' in form) form.num = 1;
  dialog.value = true;
}

function openEdit(row) {
  editing.value = true;
  for (const k of Object.keys(form)) delete form[k];
  for (const f of mod.value.fields || []) form[f.k] = row[f.k];
  dialog.value = true;
}

async function save() {
  saving.value = true;
  try {
    await adminApi.save(modKey.value, { ...form });
    ElMessage.success('保存成功');
    dialog.value = false;
    load();
  } catch {
  } finally {
    saving.value = false;
  }
}

async function removeOne(row) {
  try {
    await ElMessageBox.confirm(`确定删除该${mod.value.label}？`, '提示', { type: 'warning' });
  } catch {
    return;
  }
  await adminApi.remove(modKey.value, [row[mod.value.pk]]);
  ElMessage.success('已删除');
  load();
}

async function uploadImage(file) {
  const r = await adminApi.upload(file);
  return r.data.url;
}

function openDeliver(row) {
  deliverForm.order_id = row.order_id;
  deliverForm.express_company = '顺丰速运';
  deliverForm.express_no = '';
  deliverDlg.value = true;
}

async function doDeliver() {
  if (!deliverForm.express_no) return ElMessage.warning('请输入快递单号');
  await adminApi.deliver({ ...deliverForm });
  ElMessage.success('发货成功');
  deliverDlg.value = false;
  load();
}

async function confirmPay(row) {
  await adminApi.confirmPay({ order_id: row.order_id });
  ElMessage.success('已确认收款');
  load();
}

async function cancelOrder(row) {
  try {
    await ElMessageBox.confirm('确定取消该订单？', '提示', { type: 'warning' });
  } catch {
    return;
  }
  await adminApi.cancelOrder({ order_id: row.order_id });
  ElMessage.success('已取消');
  load();
}

async function auditWithdraw(row, pass) {
  try {
    await ElMessageBox.confirm(pass ? '确认通过该提现申请？' : '确认驳回并退回余额？', '提示', { type: 'warning' });
  } catch {
    return;
  }
  await adminApi.auditWithdraw({ withdraw_id: row.withdraw_id, pass });
  ElMessage.success(pass ? '已通过' : '已驳回');
  load();
}

async function auditCert(row, pass) {
  await adminApi.auditCert({ certification_id: row.certification_id, pass });
  ElMessage.success('审核完成');
  load();
}

async function confirmSettle(row) {
  await adminApi.confirmSettle({ id: row.id });
  ElMessage.success('已确认');
  load();
}

// ---------- 角色权限分配 ----------
const permDlg = ref(false);
const permLoading = ref(false);
const permRole = ref({});
const nodeTree = ref([]);
const permChecked = ref({});

const groupChecked = (g) => g.children.length > 0 && g.children.every((c) => permChecked.value[c.id]);
const groupIndeterminate = (g) => {
  const n = g.children.filter((c) => permChecked.value[c.id]).length;
  return n > 0 && n < g.children.length;
};

function toggleGroup(g, v) {
  const next = { ...permChecked.value };
  g.children.forEach((c) => { next[c.id] = v; });
  permChecked.value = next;
}

async function openPerm(row) {
  permRole.value = row;
  permDlg.value = true;
  permLoading.value = true;
  try {
    const [t, n] = await Promise.all([
      http.get('/node/tree'),
      http.get('/role/nodes', { params: { role_id: row.role_id } }),
    ]);
    nodeTree.value = t.data?.tree || [];
    const ids = n.data?.node_ids || [];
    const map = {};
    ids.forEach((id) => { map[id] = true; });
    permChecked.value = map;
  } finally {
    permLoading.value = false;
  }
}

async function savePerm() {
  const ids = [];
  for (const g of nodeTree.value) {
    if (groupChecked(g) || groupIndeterminate(g)) ids.push(g.id);
    g.children.forEach((c) => { if (permChecked.value[c.id]) ids.push(c.id); });
  }
  const r = await http.post('/role/nodes', { role_id: permRole.value.role_id, node_ids: ids });
  if (r.code === 1) {
    ElMessage.success('权限已保存');
    permDlg.value = false;
  } else ElMessage.warning(r.msg);
}

// ---------- 商品统计 ----------
const stats = ref(null);
const statItems = computed(() => {
  const d = stats.value || {};
  return [
    { k: '商品总金额', v: Number(d.total_amount || 0), c: d.total_count || 0 },
    { k: '上架商品总金额', v: Number(d.online_amount || 0), c: d.online_count || 0 },
    { k: '下架商品总金额', v: Number(d.offline_amount || 0), c: d.offline_count || 0 },
    { k: '流拍商品总金额', v: Number(d.pending_amount || 0), c: d.pending_count || 0 },
  ];
});

async function loadStats() {
  if (modKey.value !== 'goods') return;
  try {
    const r = await http.get('/stats/goods');
    stats.value = r.data || null;
  } catch {}
}

// ---------- 举报处理 ----------
async function auditReport(row) {
  let result = '';
  try {
    const { value } = await ElMessageBox.prompt('请输入处理结果', '举报处理', {
      inputPlaceholder: '例如：已联系双方核实，交易正常',
      confirmButtonText: '标记已处理',
      cancelButtonText: '驳回',
      distinguishCancelAndClose: true,
      inputValue: '',
    });
    result = value || '';
    await http.post('/report/audit', { report_id: row.report_id, pass: true, result });
    ElMessage.success('已处理');
    load();
  } catch (e) {
    if (e === 'cancel') {
      await http.post('/report/audit', { report_id: row.report_id, pass: false, result: '驳回' });
      ElMessage.success('已驳回');
      load();
    }
  }
}

// ---------- 流拍释放 ----------
async function releaseStream(row) {
  try {
    await ElMessageBox.confirm('释放后商品恢复可售，确定释放？', '释放流拍', { type: 'warning' });
  } catch {
    return;
  }
  const r = await adminApiPost('/streambeat/release', { order_id: row.order_id });
  if (r.code === 1) {
    ElMessage.success('已释放');
    load();
  } else ElMessage.warning(r.msg);
}

// ---------- 商品拆分 ----------
const splitDlg = ref(false);
const splitRow = ref({});
const splitParts = ref(2);

function openSplit(row) {
  splitRow.value = row;
  splitParts.value = 2;
  splitDlg.value = true;
}

async function doSplit() {
  const r = await adminApiPost('/goods/split', { goods_id: splitRow.value.goods_id, parts: splitParts.value });
  if (r.code === 1) {
    ElMessage.success(r.msg || '拆分成功');
    splitDlg.value = false;
    load();
  } else ElMessage.warning(r.msg);
}

function openAdjust(row) {
  adjustRow.value = row;
  adjustForm.field = 'amount';
  adjustForm.value = 0;
  adjustForm.remark = '';
  adjustDlg.value = true;
}

async function doAdjust() {
  if (!adjustForm.value) return ElMessage.warning('请输入变更数量');
  await adminApi.adjustMember({ member_id: adjustRow.value.member_id, ...adjustForm });
  ElMessage.success('调整成功');
  adjustDlg.value = false;
  load();
}

watch(() => route.fullPath, () => {
  page.value = 1;
  keyword.value = '';
  filters.status = '';
  filters.kind = '';
  filters.disabled = '';
  load();
});

onMounted(load);
</script>

<style scoped>
.total-hint { font-size: 12.5px; color: #8c93a0; }

.perm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 14px;
  color: #4a4f57;
}
.perm-tree { max-height: 440px; overflow-y: auto; }
.perm-group {
  border: 1px solid #eef1f5;
  border-radius: 9px;
  padding: 10px 14px;
  margin-bottom: 10px;
}
.perm-children {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px 10px;
  margin-top: 8px;
  padding-left: 24px;
}

.stat-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-bottom: 14px;
}
.s-card {
  background: #fff;
  border-radius: 12px;
  padding: 14px 16px;
  box-shadow: 0 1px 3px rgba(20, 26, 38, 0.05);
}
.s-label { font-size: 12px; color: #8c93a0; }
.s-value {
  font-size: 20px;
  font-weight: 700;
  margin-top: 6px;
  color: #e63c26;
  font-variant-numeric: tabular-nums;
}
.s-sub { font-size: 11.5px; color: #a8adb7; margin-top: 3px; }
.pager { display: flex; justify-content: flex-end; margin-top: 14px; }
.ops { display: flex; gap: 6px; flex-wrap: wrap; }
.ops :deep(.el-button + .el-button) { margin-left: 0; }

.thumb-lg { width: 62px; height: 62px; border-radius: 8px; object-fit: cover; background: #f4f6f9; }
.category-thumb { width:40px;height:40px;padding:8px;border:1px solid #f0e7da;border-radius:10px;background:#faf5ec;color:#9a7447; }
.category-picker-label { color:#5d6571;font-size:12px;font-weight:600; }
.image-field { display:flex;flex-direction:column;align-items:flex-start;gap:7px;max-width:100%; }
.image-guidance { max-width:420px;color:#9299a3;font-size:11px;line-height:1.55; }
.upload-inline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.upload-inline input[type='file'] { font-size: 12px; color: #8c93a0; }

.avatar-sm {
  width: 30px; height: 30px;
  border-radius: 8px;
  background: linear-gradient(135deg, #ff826e, #ff513a);
  color: #fff;
  font-size: 12px;
  font-weight: 650;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}
.avatar-sm img { width: 100%; height: 100%; object-fit: cover; }

.mono { font-variant-numeric: tabular-nums; }
.muted { color: #a8adb7; }
</style>
