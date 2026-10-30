<template>
  <div>
    <div class="page-head">
      <div>
        <h2>{{ pageTitle }}</h2>
        <div class="desc">{{ desc }}</div>
      </div>
      <div class="page-actions">
        <el-button v-if="modKey === 'orders'" @click="importOrders">批量导入</el-button>
        <el-button v-if="modKey === 'orders' && Number(fixed.type) === 3" type="primary" plain @click="openShopOrder">新建寄买单</el-button>
        <el-button v-if="modKey === 'orders' && Number(fixed.type) === 5" type="warning" @click="scanStreambeat">扫描流拍</el-button>
        <el-button v-if="modKey !== 'report' && modKey !== 'orders' && modKey !== 'scoreExchange'" type="primary" @click="openCreate">+ 新增{{ mod.label || '' }}</el-button>
      </div>
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
        <template v-if="modKey === 'category'">
          <el-button size="small" @click="batchHomeShow(10)">全部上首页</el-button>
          <el-button size="small" type="warning" plain @click="batchHomeShow(20)">关闭全部分类</el-button>
        </template>
        <template v-if="modKey === 'member' && sel.length">
          <span class="muted" style="margin-left: 6px">已选 {{ sel.length }} 项</span>
          <el-button size="small" type="warning" plain @click="batchMemberStatus(20)">批量禁用</el-button>
          <el-button size="small" type="success" plain @click="batchMemberStatus(10)">批量启用</el-button>
          <el-button size="small" type="danger" plain @click="batchMemberRemove">批量删除</el-button>
        </template>
        <template v-if="modKey === 'orders' && sel.length">
          <span class="muted" style="margin-left: 6px">已选 {{ sel.length }} 项</span>
          <el-button size="small" type="success" plain @click="batchConfirmPay">批量确认收款</el-button>
        </template>
        <template v-if="modKey === 'withdraw' && sel.length">
          <span class="muted" style="margin-left: 6px">已选 {{ sel.length }} 项</span>
          <el-button size="small" type="primary" plain @click="batchAuditWithdraw(true)">批量通过</el-button>
          <el-button size="small" type="danger" plain @click="batchAuditWithdraw(false)">批量驳回</el-button>
        </template>
        <div class="spacer" />
        <span class="total-hint">共 {{ total }} 条</span>
      </div>

      <div v-if="modKey === 'specialarea'" class="module-note">
        抢购时间已统一到「系统设置 → 交易设置 → 抢购总时间」，所有场次共用一套；本页只管场次内容与限购，不再单独设时间。
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
              <!-- 已转拍出去的单：买家手上没有实物，不会再有「待发货」这个动作 -->
              <span v-if="f.k === 'status' && modKey === 'orders' && row.transferred && Number(row[f.k]) === 10" class="tag-status tag-off">已转拍</span>
              <!-- 订单与兑换单用流转色；其它模块（如积分商品的在售/下架）用开关色 -->
              <span v-else-if="f.k === 'status'" class="tag-status" :class="(modKey === 'orders' || modKey === 'scoreExchange') ? orderStatusClass(row[f.k]) : statusClass(row[f.k])">{{ labelOf(f, row[f.k]) }}</span>
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
            <span v-else-if="f.type === 'timesec'" class="mono">{{ timeCell(f, row) }}</span>

            <!-- 开启日期 -->
            <span v-else-if="f.type === 'days'">{{ dayLabel(row[f.k]) }}</span>

            <!-- 富文本 -->
            <span v-else-if="f.type === 'rich'" class="muted">{{ stripHtml(row[f.k]) }}</span>

            <!-- 默认 -->
            <span v-else>{{ row[f.k] ?? '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" :width="modKey === 'member' ? 560 : modKey === 'orders' ? 300 : modKey === 'scoreExchange' ? 260 : modKey === 'goods' ? 280 : 210" fixed="right">
          <template #default="{ row }">
            <div class="ops">
              <template v-if="modKey === 'orders'">
                <el-button size="small" @click="openEdit(row)">详情</el-button>
                <el-button v-if="Number(row.is_examine) === 0" size="small" type="warning" @click="auditOrder(row, true)">审核</el-button>
                <el-button v-if="Number(row.is_examine) === 0" size="small" type="danger" @click="auditOrder(row, false)">拒绝</el-button>
                <el-button v-if="row.status === 10 && !row.transferred" size="small" type="primary" @click="openDeliver(row)">发货</el-button>
                <el-button v-if="row.status === 0" size="small" type="success" @click="confirmPay(row)">确认收款</el-button>
                <el-button v-if="row.status === 0" size="small" type="danger" @click="cancelOrder(row)">取消</el-button>
                <el-button v-if="row.type === 5 && row.status === 50" size="small" type="warning" @click="releaseStream(row)">释放</el-button>
                <el-button v-if="row.type === 5 && row.status === 50" size="small" type="danger" plain @click="recycleStream(row)">平台回收</el-button>
                <el-button v-if="row.type === 5" size="small" @click="openAssignStream(row)">指派会员</el-button>
                <el-button v-if="Number(row.pay_status) === 10" size="small" type="success" plain @click="grantAward(row)">补发直推奖</el-button>
                <el-button v-if="Number(row.num) > 1" size="small" @click="openSplitOrder(row)">拆分订单</el-button>
              </template>
              <template v-else-if="modKey === 'scoreExchange'">
                <el-button v-if="row.status === 10" size="small" type="primary" @click="openScoreDeliver(row)">发货</el-button>
                <el-button v-if="row.status === 10" size="small" type="danger" plain @click="cancelScoreExchange(row)">取消退分</el-button>
                <el-button size="small" @click="openEdit(row)">详情</el-button>
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
                <el-button size="small" @click="viewTeamOrders(row)">团队订单</el-button>
                <el-button size="small" @click="openEnergy(row)">资金流水</el-button>
                <el-button v-if="Number(row.e_card_number) > 0" size="small" type="warning" plain @click="clearCommission(row)">清除佣金</el-button>
                <el-button size="small" :type="Number(row.is_advance) === 10 ? 'warning' : 'primary'" @click="toggleAdvance(row)">
                  {{ Number(row.is_advance) === 10 ? '关闭提前抢购' : '开通提前抢购' }}
                </el-button>
                <el-button
                  size="small"
                  :type="Number(row.disabled) === 10 ? 'danger' : 'success'"
                  plain
                  @click="toggleMemberStatus(row)"
                >{{ Number(row.disabled) === 10 ? '禁用' : '启用' }}</el-button>
                <el-button size="small" type="danger" @click="removeMember(row)">删除</el-button>
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
                <el-button size="small" @click="openEdit(row)">编辑</el-button>
                <el-button size="small" type="danger" plain @click="removeOne(row)">删除</el-button>
              </template>
              <template v-else-if="modKey === 'goods'">
                <el-button size="small" @click="openEdit(row)">编辑</el-button>
                <el-button size="small" plain @click="duplicateGoods(row)">复制</el-button>
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
    <el-dialog v-model="dialog" :title="modKey === 'orders' ? '订单详情' : formTitle" width="620px" destroy-on-close>
      <el-descriptions v-if="modKey === 'orders'" :column="2" border>
        <el-descriptions-item label="订单号">{{ form.order_no || '—' }}</el-descriptions-item>
        <el-descriptions-item label="订单类型">{{ labelOf(mod.fields?.find((f) => f.k === 'type'), form.type) }}</el-descriptions-item>
        <el-descriptions-item label="支付方式">{{ labelOf(mod.fields?.find((f) => f.k === 'pay_type'), form.pay_type) }}</el-descriptions-item>
        <el-descriptions-item label="商品">{{ form.goods_name || '—' }}</el-descriptions-item>
        <el-descriptions-item label="数量">{{ form.num ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="订单金额">¥{{ Number(form.total_price || 0).toFixed(2) }}</el-descriptions-item>
        <el-descriptions-item label="订单状态">{{ labelOf(mod.fields?.find((f) => f.k === 'status'), form.status) }}</el-descriptions-item>
        <el-descriptions-item label="审核状态">{{ Number(form.is_examine) === 10 ? '已通过' : Number(form.is_examine) === 20 ? '已拒绝' : '待审核' }}</el-descriptions-item>
        <el-descriptions-item label="支付凭证" :span="2">
          <el-image
            v-if="form.pay_voucher"
            :src="form.pay_voucher"
            :preview-src-list="[form.pay_voucher]"
            fit="cover"
            style="width: 88px; height: 88px; border-radius: 8px"
          />
          <span v-else>—</span>
        </el-descriptions-item>
        <el-descriptions-item label="下单时间">{{ form.create_time || '—' }}</el-descriptions-item>
      </el-descriptions>
      <el-form v-else label-width="124px" label-position="right">
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
                :presets="imagePresets(f)"
                @update:model-value="form[f.k] = $event"
              />
              <div v-if="imageRecommendation(f)" class="image-guidance">{{ imageRecommendation(f) }}</div>
            </div>
          </template>
          <template v-else-if="f.type === 'images'">
            <div class="image-field">
              <ImageUploader :model-value="form[f.k]" :upload="uploadImage" :presets="imagePresets(f)" multiple @update:model-value="form[f.k] = $event" />
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
          <el-select v-else-if="f.type === 'vip'" v-model="form[f.k]" style="width: 100%">
            <el-option v-for="(label, idx) in VIP_LABELS" :key="idx" :value="idx" :label="label" />
          </el-select>
          <el-input v-else-if="f.type === 'rich'" v-model="form[f.k]" type="textarea" :rows="5" placeholder="支持 HTML" />
          <el-time-select
            v-else-if="f.type === 'timesec'"
            :model-value="timeModel(f)"
            start="00:00"
            step="00:01"
            end="23:59"
            editable
            clearable
            :placeholder="f.k === 'end_time' ? '不限' : '00:00'"
            style="width: 150px"
            @update:model-value="(v) => (form[f.k] = hmToSec(v))"
          />
          <div v-else-if="f.type === 'days'" class="days-field">
            <button
              v-for="d in 7"
              :key="d"
              type="button"
              class="day-btn"
              :class="{ on: dayOn(f.k, d) }"
              @click="toggleFormDay(f.k, d)"
            >
              周{{ DAY_NAMES[d - 1] }}
            </button>
          </div>
          <el-input-number
            v-else-if="f.type === 'money' || f.type === 'number'"
            v-model="form[f.k]"
            :precision="f.type === 'money' ? 2 : 0"
            :min="0"
            style="width: 100%"
            controls-position="right"
          />
          <el-select
            v-else-if="f.type === 'parent'"
            v-model="form[f.k]"
            filterable
            remote
            clearable
            reserve-keyword
            :remote-method="searchParentOptions"
            placeholder="搜索昵称或手机号；留空=设为根节点（无上级）"
            style="width: 100%"
            @visible-change="(v) => v && loadParentOptions()"
          >
            <el-option :value="0" label="无上级（根节点）" />
            <el-option
              v-for="m in parentOptions"
              :key="m.member_id"
              :value="m.member_id"
              :label="`${m.nick_name || '会员'} · ${m.mobile}`"
            />
          </el-select>
          <el-input v-else-if="f.type === 'password'" v-model="form[f.k]" type="password" show-password autocomplete="new-password"
            :placeholder="editing ? '留空则不修改密码' : `请设置${f.t}`" />
          <el-input v-else v-model="form[f.k]" :placeholder="`请输入${f.t}`" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">{{ modKey === 'orders' ? '关闭' : '取消' }}</el-button>
        <el-button v-if="modKey !== 'orders'" type="primary" :loading="saving" @click="save">保存</el-button>
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

    <!-- 积分兑换发货 -->
    <el-dialog v-model="scoreDeliverDlg" title="兑换发货" width="440px">
      <el-form label-width="90px">
        <el-form-item label="快递公司">
          <el-input v-model="scoreDeliverForm.express_company" placeholder="如 顺丰速运" />
        </el-form-item>
        <el-form-item label="快递单号">
          <el-input v-model="scoreDeliverForm.express_no" placeholder="请输入快递单号" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="scoreDeliverDlg = false">取消</el-button>
        <el-button type="primary" @click="doScoreDeliver">确认发货</el-button>
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

    <!-- 团队订单 -->
    <el-dialog v-model="teamDlg" :title="`${teamData.member || '会员'} · 团队订单`" width="820px">
      <div class="team-summary">
        <span>团队人数：{{ teamData.team_count || 0 }}</span>
        <span>订单数：{{ teamData.order_count || 0 }}</span>
        <span>订单金额：¥{{ Number(teamData.stats?.total_amount || 0).toFixed(2) }}</span>
        <span>已支付：¥{{ Number(teamData.stats?.paid_amount || 0).toFixed(2) }}</span>
      </div>
      <el-table :data="teamData.list || []" max-height="440" size="small">
        <el-table-column prop="order_no" label="订单号" min-width="165" />
        <el-table-column prop="goods_name" label="商品" min-width="150" />
        <el-table-column label="会员" min-width="130">
          <template #default="{ row }">{{ row.nick_name }} <span class="muted">{{ row.mobile }}</span></template>
        </el-table-column>
        <el-table-column prop="total_price" label="金额" width="100" />
        <el-table-column prop="status_text" label="订单状态" width="100" />
        <el-table-column prop="create_time" label="时间" min-width="150" />
      </el-table>
    </el-dialog>

    <!-- 会员资金流水 -->
    <el-dialog v-model="energyDlg" :title="`${energyMember} · 资金流水`" width="880px">
      <div class="team-summary">
        <span>共 {{ energyList.length }} 条</span>
        <span>合计：¥{{ Number(energyTotal).toFixed(2) }}</span>
        <span class="muted">含余额变动与返佣，最多显示最近 200 条</span>
      </div>
      <el-table :data="energyList" max-height="440" size="small">
        <el-table-column label="金额" width="120">
          <template #default="{ row }">
            <span :style="{ color: Number(row.face_value) < 0 ? '#e24b4a' : '#1a9c56', fontWeight: 500 }">
              {{ Number(row.face_value) > 0 ? '+' : '' }}{{ Number(row.face_value).toFixed(2) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="type_name" label="类型" width="130" />
        <el-table-column prop="remarks" label="备注" min-width="260" show-overflow-tooltip />
        <el-table-column prop="create_time" label="时间" width="165" />
      </el-table>
    </el-dialog>

    <!-- 流拍订单指派 -->
    <el-dialog v-model="assignDlg" title="指派流拍订单" width="560px">
      <div class="muted" style="margin-bottom: 12px">{{ assignRow.order_no }} · {{ assignRow.goods_name }}</div>
      <el-input v-model="assignKeyword" placeholder="搜索会员昵称或手机号" clearable @input="searchAssignMembers" />
      <el-select v-model="assignMemberId" placeholder="请选择接收会员" filterable style="width: 100%; margin-top: 12px">
        <el-option v-for="m in assignMembers" :key="m.member_id" :value="m.member_id" :label="`${m.nick_name || '会员'} · ${m.mobile}`" />
      </el-select>
      <template #footer>
        <el-button @click="assignDlg = false">取消</el-button>
        <el-button type="primary" :disabled="!assignMemberId" @click="assignStreambeat">确认指派</el-button>
      </template>
    </el-dialog>

    <!-- 订单操作 -->
    <el-dialog v-model="orderSplitDlg" title="拆分订单" width="460px">
      <el-form label-width="90px">
        <el-form-item label="订单号">{{ orderSplitRow.order_no }}</el-form-item>
        <el-form-item label="订单数量">{{ orderSplitRow.num }}</el-form-item>
        <el-form-item label="拆分份数"><el-input-number v-model="orderSplitNum" :min="2" :max="Number(orderSplitRow.num)" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="orderSplitDlg = false">取消</el-button>
        <el-button type="primary" @click="splitOrder">确认拆分</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="shopOrderDlg" title="新建寄买订单" width="500px">
      <el-form label-width="100px">
        <el-form-item label="商品 ID"><el-input-number v-model="shopOrderForm.goods_id" :min="1" /></el-form-item>
        <el-form-item label="会员 ID"><el-input-number v-model="shopOrderForm.member_id" :min="1" /></el-form-item>
        <el-form-item label="寄买价格"><el-input-number v-model="shopOrderForm.price" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="shopOrderForm.remark" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="shopOrderDlg = false">取消</el-button>
        <el-button type="primary" @click="createShopOrder">创建订单</el-button>
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
const teamDlg = ref(false);
const parentOptions = ref([]);
const energyDlg = ref(false);
const energyMember = ref('');
const energyList = ref([]);
const energyTotal = ref(0);
const teamData = ref({});
const assignDlg = ref(false);
const assignRow = ref({});
const assignKeyword = ref('');
const assignMembers = ref([]);
const assignMemberId = ref(0);
const orderSplitDlg = ref(false);
const orderSplitRow = ref({});
const orderSplitNum = ref(2);
const shopOrderDlg = ref(false);
const shopOrderForm = reactive({ goods_id: 0, member_id: 0, price: 0, remark: '' });

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

function imagePresets(field) {
  const key = field.k;
  const module = modKey.value;
  let size;
  if (module === 'banner' && key === 'file_path') size = [1080, 608];
  else if (module === 'goods' && ['good_thumb', 'images'].includes(key)) size = [800, 800];
  else if (module === 'category' && key === 'image') size = [512, 512];
  else if (module === 'navigation' && key === 'file_path') size = [512, 512];
  else if (module === 'certification') size = [1200, 800];
  else if (module === 'orders' && key === 'goods_thumb') size = [800, 800];
  return size ? [{ label: `推荐 ${size[0]} × ${size[1]} px`, width: size[0], height: size[1] }] : [];
}

const desc = computed(() => {
  const m = {
    goods: '抢购商品管理，支持编辑价格、场次、持有人与上下架状态',
    category: '首页抢购分类与商城分类维护',
    specialarea: '设置每日抢购场次的内容与限购；开放时间统一在「交易设置 → 抢购总时间」',
    orders: '全部订单查询、发货、审核与状态流转',
    settle: '大账结算、中账差额、小账凭证三类账目核对',
    energy: '会员佣金、余额、积分变更流水',
    withdraw: '会员提现申请审核，驳回自动退回余额',
    member: '会员资料、等级、团队关系与资金账户',
    certification: '会员实名认证资料审核',
    banner: '首页与抢购页轮播广告位',
    navigation: '首页宫格导航入口配置',
    notice: '平台公告发布与编辑',
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

// 开关取值：本系统约定 10 = 开启，另一个键 = 关闭。
// 不能按数值大小猜——member.disabled(10 正常/20 禁用)、navigation.disabled(10 显示/20 隐藏)、
// specialarea.is_open(10 启用/20 停用) 的 20 才是负向，按大小猜会把方向弄反、保存时写错状态。
const switchVals = (f) => {
  const keys = Object.keys(f.opts || {}).map(Number).filter((n) => !isNaN(n));
  const on = keys.includes(10) ? 10 : (keys.length ? Math.max(...keys) : 10);
  const off = keys.find((k) => k !== on) ?? 20;
  return { on, off };
};

const VIP_LABELS = ['普通会员', '银卡会员', '金卡会员', '铂金会员', '钻石会员'];
const vipLabel = (v) => VIP_LABELS[v] || `等级${v}`;

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


/* ---- 时间字段：列表展示与表单选择器（0 秒必须显示 00:00，不能当空值） ---- */
const secToHm = (sec) => {
  const n = Math.max(0, Number(sec) || 0);
  return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}`;
};
const hmToSec = (txt) => {
  const m = String(txt || '').match(/^(\d{1,2}):(\d{1,2})$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : 0;
};
// 结束时间 0 表示不限时，列表里显示「不限」而不是 00:00
const timeCell = (f, row) => (f.k === 'end_time' && !Number(row[f.k]) ? '不限' : secToHm(row[f.k]));
const timeModel = (f) => (f.k === 'end_time' && !Number(form[f.k]) ? '' : secToHm(form[f.k]));

/* ---- 星期多选（存成 "1,2,3,4,5"） ---- */
const formDayArr = (k) =>
  String(form[k] ?? '').split(',').map((s) => Number(String(s).trim())).filter((n) => n >= 1 && n <= 7);
const dayOn = (k, d) => formDayArr(k).includes(d);
function toggleFormDay(k, d) {
  const set = new Set(formDayArr(k));
  if (set.has(d)) set.delete(d);
  else set.add(d);
  form[k] = [...set].sort((a, b) => a - b).join(',');
}

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

async function batchHomeShow(value) {
  const label = value === 10 ? '上首页' : '从首页隐藏';
  try {
    await ElMessageBox.confirm(
      `把所有抢购分类设为「${label}」？`,
      '批量设置首页显示',
      { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    const r = await adminApi.batchCategoryHomeShow({ value });
    ElMessage.success(r.msg || '已更新');
    reload();
  } catch {}
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
  if ('home_show' in form && modKey.value === 'category') form.home_show = 10;
  // 新建场次默认周一到周日全开，避免一上来七个按钮都是灰的
  if ('open_days' in form && !form.open_days) form.open_days = '1,2,3,4,5,6,7';
  if ('disabled' in form && modKey.value === 'navigation') form.disabled = 10;
  if ('disabled' in form && modKey.value === 'member') form.disabled = 10;
  if ('is_valid' in form) form.is_valid = 10;
  if ('role_id' in form && optsCache.role?.length) form.role_id = optsCache.role[0].id;
  if ('status' in form && modKey.value === 'storeuser') form.status = 10;
  if ('type' in form) form.type = 1;
  if ('sort' in form) form.sort = 100;
  if ('num' in form) form.num = 1;
  dialog.value = true;
}

function openEdit(row) {
  editing.value = true;
  for (const k of Object.keys(form)) delete form[k];
  for (const f of mod.value.fields || []) form[f.k] = row[f.k];
  if (modKey.value === 'orders') {
    form.is_examine = row.is_examine;
    form.pay_status = row.pay_status;
  }
  if ('password' in form) form.password = '';
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

// 以现有商品为模板复制一条新的：图片/详情/价格/分类都带过来，编码与历史归零
async function duplicateGoods(row) {
  const r = await adminApi.duplicateGoods(row.goods_id);
  if (r?.code === 1) {
    ElMessage.success(r.msg || '已复制');
    load();
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

async function uploadImage(file, extra = {}) {
  const r = await adminApi.upload(file, extra);
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

// ---------- 积分兑换：发货 / 取消退分 ----------
const scoreDeliverDlg = ref(false);
const scoreDeliverForm = reactive({ exchange_id: 0, express_company: '顺丰速运', express_no: '' });

function openScoreDeliver(row) {
  scoreDeliverForm.exchange_id = row.exchange_id;
  scoreDeliverForm.express_company = '顺丰速运';
  scoreDeliverForm.express_no = '';
  scoreDeliverDlg.value = true;
}

async function doScoreDeliver() {
  if (!scoreDeliverForm.express_no) return ElMessage.warning('请输入快递单号');
  await adminApi.scoreDeliver({ ...scoreDeliverForm });
  ElMessage.success('发货成功');
  scoreDeliverDlg.value = false;
  load();
}

async function cancelScoreExchange(row) {
  const sure = await ElMessageBox.confirm(
    `取消后会把 ${row.total_score} 积分退回会员，库存也会还原。确定取消这笔兑换？`,
    '取消兑换',
    { type: 'warning', confirmButtonText: '确定取消', cancelButtonText: '再想想' },
  ).then(() => true).catch(() => false);
  if (!sure) return;
  const r = await adminApi.cancelScoreExchange({ exchange_id: row.exchange_id });
  if (r?.code === 1) {
    ElMessage.success('已取消并退还积分');
    load();
  }
}

async function confirmPay(row) {
  await adminApi.confirmPay({ order_id: row.order_id });
  ElMessage.success('已确认收款');
  load();
}

// 批量确认收款：只处理「待到账」的单，勾了别的会自动跳过
async function batchConfirmPay() {
  const ids = (sel.value || []).filter((r) => Number(r.status) === 0).map((r) => r.order_id);
  if (!ids.length) return ElMessage.warning('勾选的订单都已到账，无需确认');
  try {
    await ElMessageBox.confirm(
      `确认这 ${ids.length} 笔订单已收到款？会按每笔成交价入账并完成结算，不可撤销。`,
      '批量确认收款',
      { type: 'warning', confirmButtonText: '确认收款', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    const r = await adminApi.confirmPayBatch({ order_ids: ids });
    ElMessage.success(r.msg || `已确认 ${ids.length} 笔`);
    load();
  } catch {
    // 错误提示由请求拦截器统一弹出
  }
}

async function auditOrder(row, pass) {
  try {
    await ElMessageBox.confirm(pass ? '确认通过该订单审核？' : '确认拒绝该订单？', '订单审核', { type: 'warning' });
  } catch { return; }
  await adminApi.auditOrder({ order_id: row.order_id, pass });
  ElMessage.success(pass ? '审核通过' : '已拒绝');
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

// 批量审提现：驳回会把钱退回会员余额，所以确认文案必须写清楚
async function batchAuditWithdraw(pass) {
  const ids = (sel.value || []).filter((r) => Number(r.status) === 0).map((r) => r.withdraw_id);
  if (!ids.length) return ElMessage.warning('勾选的申请都已处理，无需再审');
  const tip = pass
    ? `通过这 ${ids.length} 笔提现申请？通过后请按各自收款方式线下打款。`
    : `驳回这 ${ids.length} 笔提现申请？金额会原路退回会员余额。`;
  try {
    await ElMessageBox.confirm(tip, pass ? '批量通过' : '批量驳回', {
      type: 'warning',
      confirmButtonText: pass ? '确认通过' : '确认驳回',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  try {
    const r = await adminApi.auditWithdrawBatch({ withdraw_ids: ids, pass });
    ElMessage.success(r.msg || (pass ? `已通过 ${ids.length} 笔` : `已驳回 ${ids.length} 笔`));
    load();
  } catch {
    // 错误提示由请求拦截器统一弹出
  }
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
    const r = await http.get('/stats/goods', { params: { type: Number(fixed.value.type) || 1 } });
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

// ---------- 平台回收 ----------
async function recycleStream(row) {
  const price = Number(row.total_price || 0);
  try {
    await ElMessageBox.confirm(
      `平台将按商品当前挂牌价 ¥${price.toFixed(2)} 回收，款项直接打给持有人，商品转为平台持仓并下架。确定回收？`,
      '平台回收',
      { type: 'warning', confirmButtonText: '确认回收' },
    );
  } catch {
    return;
  }
  const r = await adminApiPost('/streambeat/recycle', { order_id: row.order_id });
  if (r.code === 1) {
    ElMessage.success(r.msg || '已回收');
    load();
  } else ElMessage.warning(r.msg);
}

async function scanStreambeat() {  try {
    await ElMessageBox.confirm('将扫描全部场次中已超过转拍期限的商品，并按规则标记流拍。确定继续？', '扫描流拍', { type: 'warning' });
  } catch { return; }
  const r = await adminApi.scanStreambeat();
  ElMessage.success(r.msg || '扫描完成');
  load();
}

async function importOrders() {
  const example = JSON.stringify([{ goods_id: 1, member_id: 1, price: 100, num: 1, type: Number(fixed.value.type) || 1, remark: '后台导入' }], null, 2);
  let value;
  try {
    ({ value } = await ElMessageBox.prompt('粘贴订单 JSON 数组；每项至少包含 goods_id 和 member_id。', '批量导入订单', {
      inputType: 'textarea', inputValue: example, inputPlaceholder: example, inputValidator: (v) => {
        try { return Array.isArray(JSON.parse(v)); } catch { return '请输入有效的 JSON 数组'; }
      }, confirmButtonText: '开始导入', cancelButtonText: '取消',
    }));
  } catch { return; }
  const r = await adminApi.importOrders(JSON.parse(value));
  ElMessage.success(r.msg || '导入完成');
  load();
}

async function loadParentOptions(keyword = '') {
  try {
    const r = await http.get('/member/options', { params: { keyword } });
    parentOptions.value = r.data || [];
  } catch {
    parentOptions.value = [];
  }
}
const searchParentOptions = (kw) => loadParentOptions(kw || '');

async function openEnergy(row) {
  const r = await http.get('/member/energy-record', { params: { member_id: row.member_id, scope: 'all' } });
  const d = r.data || {};
  energyList.value = d.list || [];
  energyTotal.value = d.total || 0;
  energyMember.value = `${row.nick_name || '会员'} ${row.mobile || ''}`.trim();
  energyDlg.value = true;
}

async function viewTeamOrders(row) {
  const r = await adminApi.teamOrders(row.member_id);
  teamData.value = r.data || {};
  teamDlg.value = true;
}

// ---------- 会员启停用 / 删除 ----------
async function toggleMemberStatus(row) {
  const toDisable = Number(row.disabled) === 10;
  try {
    await ElMessageBox.confirm(
      toDisable
        ? `禁用后「${row.nick_name}」将无法登录、无法下单转拍，已登录的会话也会立刻失效。确定禁用？`
        : `启用后「${row.nick_name}」恢复正常使用。确定启用？`,
      toDisable ? '禁用会员' : '启用会员',
      { type: 'warning' },
    );
  } catch { return; }
  await http.post('/member/status', { ids: [row.member_id], disabled: toDisable ? 20 : 10 });
  ElMessage.success(toDisable ? '已禁用' : '已启用');
  load();
}

async function batchMemberStatus(disabled) {
  const ids = (sel.value || []).map((r) => r.member_id);
  if (!ids.length) return;
  const word = disabled === 20 ? '禁用' : '启用';
  try {
    await ElMessageBox.confirm(`确定${word}选中的 ${ids.length} 个会员？`, `批量${word}`, { type: 'warning' });
  } catch { return; }
  await http.post('/member/status', { ids, disabled });
  ElMessage.success(`已${word} ${ids.length} 个会员`);
  load();
}

async function removeMember(row) {
  try {
    await ElMessageBox.confirm(
      `删除后不可恢复。「${row.nick_name}」若已有订单、流水或下级会员，系统会拒绝并提示改用禁用。确定删除？`,
      '删除会员',
      { type: 'warning', confirmButtonText: '确认删除' },
    );
  } catch { return; }
  await http.post('/member/remove', { ids: [row.member_id] });
  ElMessage.success('已删除');
  load();
}

async function batchMemberRemove() {
  const ids = (sel.value || []).map((r) => r.member_id);
  if (!ids.length) return;
  try {
    await ElMessageBox.confirm(
      `确定删除选中的 ${ids.length} 个会员？有业务记录的会被跳过（请改用禁用）。`,
      '批量删除',
      { type: 'warning', confirmButtonText: '确认删除' },
    );
  } catch { return; }
  await http.post('/member/remove', { ids });
  load();
}

async function clearCommission(row) {
  try { await ElMessageBox.confirm(`将清空 ${row.nick_name} 当前 ¥${Number(row.e_card_number).toFixed(2)} 佣金，并写入负数流水。确定继续？`, '清除佣金', { type: 'warning' }); }
  catch { return; }
  await http.post('/member/clear-commission', { member_id: row.member_id });
  ElMessage.success('佣金已清除');
  load();
}

async function grantAward(row) {
  try { await ElMessageBox.confirm(`为订单 ${row.order_no} 补发直推奖？`, '补发直推奖', { type: 'warning' }); }
  catch { return; }
  await adminApi.grantAward({ order_id: row.order_id });
  ElMessage.success('直推奖已补发');
  load();
}

function openAssignStream(row) {
  assignRow.value = row;
  assignKeyword.value = '';
  assignMemberId.value = 0;
  assignDlg.value = true;
  searchAssignMembers();
}

let assignSearchTimer;
async function searchAssignMembers() {
  clearTimeout(assignSearchTimer);
  assignSearchTimer = setTimeout(async () => {
    const r = await adminApi.streambeatMembers(assignKeyword.value);
    assignMembers.value = r.data || [];
  }, 180);
}

async function assignStreambeat() {
  try { await ElMessageBox.confirm('指派后会把商品持有人改为所选会员，并更新订单状态。确定指派？', '确认操作', { type: 'warning' }); }
  catch { return; }
  await adminApi.assignStreambeat({ order_id: assignRow.value.order_id, member_id: assignMemberId.value });
  ElMessage.success('订单已指派');
  assignDlg.value = false;
  load();
}

function openSplitOrder(row) {
  orderSplitRow.value = row;
  orderSplitNum.value = 2;
  orderSplitDlg.value = true;
}

async function splitOrder() {
  await adminApi.splitOrder({ order_id: orderSplitRow.value.order_id, split_num: orderSplitNum.value });
  ElMessage.success('订单拆分完成');
  orderSplitDlg.value = false;
  load();
}

function openShopOrder() {
  Object.assign(shopOrderForm, { goods_id: 0, member_id: 0, price: 0, remark: '' });
  shopOrderDlg.value = true;
}

async function createShopOrder() {
  if (!shopOrderForm.goods_id || !shopOrderForm.member_id) return ElMessage.warning('请填写商品 ID 和会员 ID');
  const r = await adminApi.createShopOrder({ ...shopOrderForm });
  ElMessage.success(r.msg || '寄买订单已创建');
  shopOrderDlg.value = false;
  load();
}

async function toggleAdvance(row) {
  const enable = Number(row.is_advance) !== 10;
  let count = Number(row.advance_count) || 0;
  if (enable) {
    try {
      const answer = await ElMessageBox.prompt('请输入提前抢购次数（0 表示不限制）。', '开通提前抢购', {
        inputType: 'number', inputValue: String(count), confirmButtonText: '开通', cancelButtonText: '取消',
        inputValidator: (v) => Number.isInteger(Number(v)) && Number(v) >= 0 || '请输入大于等于 0 的整数',
      });
      count = Number(answer.value);
    } catch { return; }
  } else {
    try { await ElMessageBox.confirm(`确定关闭 ${row.nick_name} 的提前抢购资格？`, '提示', { type: 'warning' }); }
    catch { return; }
  }
  await adminApi.advanceMember({ member_id: row.member_id, enable, count });
  ElMessage.success(enable ? '已开通提前抢购' : '已关闭提前抢购');
  load();
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
  teamDlg.value = false;
  assignDlg.value = false;
  orderSplitDlg.value = false;
  shopOrderDlg.value = false;
  load();
});

onMounted(load);
</script>

<style scoped>
.page-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.team-summary { display: flex; flex-wrap: wrap; gap: 10px 22px; margin-bottom: 14px; color: #596273; font-size: 13px; }
.total-hint { font-size: 12.5px; color: #8c93a0; }

@media (max-width: 900px) {
  .page-actions { justify-content: flex-start; }
}

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

/* 星期多选（场次开放日期等） */
.days-field { display: flex; gap: 6px; flex-wrap: wrap; }
.day-btn {
  min-width: 44px;
  height: 30px;
  padding: 0 9px;
  border: 1px solid #e5e9ef;
  border-radius: 7px;
  background: #fafbfc;
  color: #6b7280;
  font-family: var(--font);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.day-btn:hover { border-color: #ffcdc5; color: #d14328; }
.day-btn.on { border-color: #ff8f7a; background: #fff1ee; color: #d14328; font-weight: 600; }
</style>
