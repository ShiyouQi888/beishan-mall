<template>
  <div>
    <div class="page-head">
      <div>
        <h2>{{ pageTitle }}</h2>
        <div class="desc">{{ desc }}</div>
      </div>
      <div class="page-actions">
        <el-button v-if="modKey === 'orders'" type="primary" @click="openManualOrder">+ 新增订单</el-button>
        <el-button v-if="modKey === 'orders'" :loading="EXPORTING" @click="exportOrders">导出表格</el-button>
        <el-button v-if="modKey === 'orders'" @click="importOrders">批量导入</el-button>
        <span v-if="modKey === 'recycle'" class="auto-scan-hint">
          <i class="auto-scan-dot" />系统每 60 秒自动扫描 · 列表实时刷新
        </span>
        <el-button v-if="modKey !== 'orders' && modKey !== 'scoreExchange' && modKey !== 'recycle'" type="primary" @click="openCreate">+ 新增{{ mod.label || '' }}</el-button>
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
        <el-select v-if="modKey === 'orders'" v-model="filters.pay_status" placeholder="订单状态" clearable style="width: 130px" @change="reload">
          <el-option label="已确认" :value="10" />
          <el-option label="待确认" :value="0" />
        </el-select>
        <!-- 按持有人筛：订单的归属人（转让后就是新买家）。
             要查「某人名下有哪些单」「某人一共买了多少」都从这里选，导出也跟着走 -->
        <el-select
          v-if="modKey === 'orders'"
          v-model="filters.member_id"
          filterable
          remote
          clearable
          reserve-keyword
          :remote-method="searchHolderOptions"
          :loading="holderLoading"
          placeholder="持有人（昵称/手机号）"
          style="width: 212px"
          @change="reload"
          @visible-change="(v) => v && searchHolderOptions('')"
        >
          <el-option
            v-for="m in holderOptions"
            :key="m.member_id"
            :value="m.member_id"
            :label="`${m.nick_name || '未设置昵称'} · ${m.mobile}`"
          />
        </el-select>
        <!-- 订单时间范围：快捷档 + 自定义区间 -->
        <el-radio-group v-if="modKey === 'orders'" v-model="filters.range" size="default" @change="onRangeChange">
          <el-radio-button label="">全部</el-radio-button>
          <el-radio-button label="today">今日</el-radio-button>
          <el-radio-button label="yesterday">昨日</el-radio-button>
          <el-radio-button label="week">本周</el-radio-button>
          <el-radio-button label="month">本月</el-radio-button>
          <el-radio-button label="custom">自定义</el-radio-button>
        </el-radio-group>
        <el-date-picker
          v-if="modKey === 'orders' && filters.range === 'custom'"
          v-model="customRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          style="width: 250px"
          @change="onCustomRange"
        />
        <el-select v-if="modKey === 'settle'" v-model="filters.kind" placeholder="账目类型" clearable style="width: 140px" @change="reload">
          <el-option label="大帐-结算" value="large" />
          <el-option label="中账-差额" value="medium" />
          <el-option label="小账-凭证" value="small" />
        </el-select>
        <el-select v-if="modKey === 'member'" v-model="filters.disabled" placeholder="会员状态" clearable style="width: 130px" @change="reload">
          <el-option label="正常" :value="10" />
          <el-option label="禁用" :value="20" />
        </el-select>
        <el-select v-if="modKey === 'goods'" v-model="filters.source" placeholder="来源" clearable style="width: 118px" @change="reload">
          <el-option label="转拍货" value="transpose" />
          <el-option label="平台货" value="own" />
        </el-select>
        <el-select v-if="modKey === 'goods'" v-model="filters.area_id" placeholder="关联场次" clearable style="width: 140px" @change="reload">
          <el-option v-for="o in (optsCache.specialarea || [])" :key="o.id" :label="o.name" :value="o.id" />
        </el-select>
        <el-button @click="reload">查询</el-button>
        <!-- 订单没有自动刷新（只有商品/回收有），运营等新单时得有个明确的刷新入口，
             不用为了看一眼去改筛选条件再改回来 -->
        <el-button v-if="modKey === 'orders'" :disabled="loading" @click="reload">
          <svg class="refresh-ico" :class="{ spin: loading }" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
            <path d="M20 12a8 8 0 1 1-2.34-5.66" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            <path d="M20 4.6V9h-4.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="refresh-ico__text">刷新</span>
        </el-button>
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
          <el-button size="small" type="success" plain @click="batchConfirmPay">批量确认抢单</el-button>
          <el-button size="small" type="danger" plain @click="batchCancelOrders">批量取消</el-button>
        </template>
        <div class="spacer" />
        <span v-if="AUTO_REFRESH_MODULES.has(modKey)" class="auto-refresh-hint">水位/库存每 20 秒自动刷新</span>
        <span class="total-hint">共 {{ total }} 条</span>
      </div>

      <!-- 快捷筛选标签单独一行：塞在工具栏里会把「时间区间」那组挤变形，
           而且蓝色标签和「全部」选中态的蓝撞在一起，看着像同一种东西 -->
      <div v-if="modKey === 'orders'" class="chips-row">
        <!-- 取消来源标签：红色警示色。会员自己撤的单和运营取消的单要能分开看，
             排查「为什么这单没了」时第一时间分得清是谁动的 -->
        <div v-if="modKey === 'orders'" class="cancel-tabs">
          <el-tag
            v-for="t in CANCEL_TABS"
            :key="t.value"
            :effect="filters.cancel_by === t.value ? 'dark' : 'plain'"
            type="danger"
            round
            class="cancel-tabs__item"
            @click="toggleCancelFilter(t.value)"
          >{{ t.label }}</el-tag>
          <!-- 已转让：和「取消」不是一回事（取消是作废，转让是换人），
               所以换一组颜色并且单独隔开，别让运营点混 -->
          <span class="cancel-tabs__sep" />
          <el-tag
            :effect="filters.transferred === 1 ? 'dark' : 'plain'"
            type="primary"
            round
            class="cancel-tabs__item"
            @click="toggleTransferred"
          >已转让</el-tag>
        </div>
      </div>

      <div v-if="modKey === 'recycle'" class="module-note">
        商品的下一轮涨价会越过「价格上限」时即判定到顶，持有人无法再转拍；系统按商品「当前实际价格」接盘结算（商品转平台持仓）。
        自动回收关闭或超出每日上限时，记录会停在「待处理」，可在这里手动结算。
        新的回收会自动弹出提醒并语音播报（右上角「消息」里可关闭语音）。
      </div>

      <div v-if="modKey === 'specialarea'" class="module-note">
        每个场次各自有开放日期与抢购时段（在「配置」里设置）。商品归属由「配置 → 关联商品」决定，
        商品本身不再带场次字段；一件商品可以同时关联多个场次。
      </div>

      <el-table :data="rows" v-loading="loading" style="width: 100%" @selection-change="sel = $event">
        <el-table-column type="selection" width="42" />
        <el-table-column
          v-for="f in visibleFields"
          :key="f.k"
          :label="f.t"
          :min-width="f.w || 110"
          :fixed="f.k === mod.pk ? 'left' : undefined"
          :show-overflow-tooltip="!isStackedCell(f)"
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

            <!-- 提前抢购：开关 + 提前多少分钟 -->
            <span v-else-if="f.type === 'advance'">
              <span v-if="Number(row[f.k]) === 10" class="tag-status tag-warn">
                已开通{{ Number(row.advance_minutes) > 0 ? ` · 提前 ${row.advance_minutes} 分钟` : ' · 未设提前量' }}
              </span>
              <span v-else class="tag-status tag-off">未开通</span>
            </span>

            <!-- 状态 -->
            <span v-else-if="f.type === 'switch'" class="tag-status" :class="statusClass(row[f.k])">
              {{ labelOf(f, row[f.k]) }}
            </span>

            <!-- 下拉 -->
            <span v-else-if="f.type === 'select' && typeof f.opts === 'object' && !Array.isArray(f.opts)">
              <!-- 已转拍出去的单：买家手上没有实物，这里标成「已转拍」而不是支付状态 -->
              <span v-if="f.k === 'status' && modKey === 'orders' && row.transferred && Number(row[f.k]) === 10" class="tag-status tag-off">已转拍</span>
              <!-- 订单与兑换单用流转色；其它模块（如积分商品的在售/下架）用开关色 -->
              <span v-else-if="f.k === 'status'" class="tag-status" :class="modKey === 'recycle' ? (Number(row[f.k]) === 10 ? 'tag-ok' : 'tag-warn') : (modKey === 'orders' || modKey === 'scoreExchange') ? orderStatusClass(row[f.k]) : statusClass(row[f.k])">{{ labelOf(f, row[f.k]) }}</span>
              <span v-else-if="f.k === 'type' && modKey === 'orders'" class="tag-status tag-red">{{ labelOf(f, row[f.k]) }}</span>
              <span v-else>{{ labelOf(f, row[f.k]) }}</span>
            </span>

            <!-- 场次下拉 -->
            <span v-else-if="f.type === 'select' && typeof f.opts === 'string'">
              {{ row['_' + f.k.replace('_id', '')] || optLabel(f.opts, row[f.k]) }}
            </span>

            <!-- 会员关联 -->
            <!-- 买家/会员：昵称一行、手机号一行。昵称为空时直接显示手机号，
                 不再退回 member_id（一串没意义的数字，运营看不懂） -->
            <span v-else-if="f.type === 'member'" class="stacked">
              <span v-if="memberName(row)" class="stacked__main">{{ memberName(row) }}</span>
              <span v-if="memberMobile(row)" class="stacked__sub">{{ memberMobile(row) }}</span>
              <span v-if="!memberName(row) && !memberMobile(row)" class="muted">—</span>
            </span>

            <!-- 现持有人 -->
            <span v-else-if="f.type === 'holder'">
              <span v-if="row._holder">{{ row._holder }}<span class="muted" style="margin-left: 4px">{{ row._holder_mobile }}</span></span>
              <span v-else class="muted">平台</span>
            </span>

            <!-- 上级 -->
            <span v-else-if="f.type === 'parent'">
              {{ row._parent || '—' }}
            </span>

            <!-- 订单状态：已取消用红色警示，待确认黄色，已确认绿色 -->
            <span v-else-if="f.type === 'orderstate'">
              <span class="tag-status" :class="orderStateClass(row[f.k])">{{ row[f.k] }}</span>
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

            <!-- 关联场次（多对多，只读） -->
            <span v-else-if="f.type === 'areas'">
              <template v-if="row._areas">
                <span v-for="(name, i) in String(row._areas).split('、')" :key="i" class="tag-status tag-blue" style="margin-right: 4px">{{ name }}</span>
              </template>
              <span v-else class="muted">未关联</span>
            </span>

            <!-- 价格水位：绿 → 黄 → 红，红色表示已达上限 -->
            <span v-else-if="f.type === 'capbar'" class="capbar">
              <template v-if="row._cap && row._cap.cap_price > 0">
                <span class="capbar__track" :title="`基准价 ¥${row._cap.base_price} · 当前 ¥${row._cap.current} · 上限 ¥${row._cap.cap_price}`">
                  <span class="capbar__dot" :style="{ left: Math.min(100, Math.max(0, row._cap.ratio * 100)) + '%' }" />
                </span>
                <span class="capbar__text" :class="'capbar__text--' + row._cap.level">
                  <template v-if="row._cap.reached">已达上限</template>
                  <template v-else>¥{{ shortMoney(row._cap.current) }} <em>/ {{ shortMoney(row._cap.cap_price) }}</em></template>
                </span>
              </template>
              <span v-else class="muted">未设上限</span>
            </span>

            <!-- 富文本 -->
            <span v-else-if="f.type === 'rich'" class="muted">{{ stripHtml(row[f.k]) }}</span>

            <!-- 商品名（已回收封顶的打标签） -->
            <span v-else-if="f.k === 'goods_name' && row.recycled">
              {{ row[f.k] }}
              <span class="tag-status tag-red" style="margin-left: 6px">封顶</span>
            </span>

            <!-- 默认 -->
            <span v-else>{{ row[f.k] ?? '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" :width="modKey === 'member' ? 560 : modKey === 'orders' ? 292 : modKey === 'scoreExchange' ? 260 : modKey === 'goods' ? 220 : modKey === 'recycle' ? 176 : 210" fixed="right">
          <template #default="{ row }">
            <div class="ops">
              <template v-if="modKey === 'orders'">
                <el-button size="small" @click="openEdit(row)">详情</el-button>
                <!-- 确认抢单就等于通过，不需要再单独审核一次 -->
                <el-button v-if="row.status === 0" size="small" type="success" @click="confirmPay(row)">确认抢单</el-button>
                <!-- 转让：未付款=把名额给别人，已付款=订单归别人。
                     已取消的单没有可转的东西，直接不显示 -->
                <el-button v-if="row.status !== 40" size="small" type="primary" plain @click="openTransfer(row)">转让</el-button>
                <el-button v-if="row.status === 0" size="small" type="danger" @click="cancelOrder(row)">取消</el-button>
              </template>
              <template v-else-if="modKey === 'scoreExchange'">
                <el-button v-if="row.status === 10" size="small" type="primary" @click="openScoreDeliver(row)">发货</el-button>
                <el-button v-if="row.status === 10" size="small" type="danger" plain @click="cancelScoreExchange(row)">取消退分</el-button>
                <el-button size="small" @click="openEdit(row)">详情</el-button>
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
              <template v-else-if="modKey === 'recycle'">
                <el-button v-if="row.status === 20" size="small" type="primary" @click="settleRecycle(row)">立即结算</el-button>
                <el-button size="small" @click="openEdit(row)">查看</el-button>
              </template>
              <template v-else-if="modKey === 'specialarea'">
                <!-- 「配置」页已经把标题、时段、限购、转拍时限、图片、启用、排序都包了，
                     不再另开一个「编辑」弹窗，否则两处都能改、容易改出不一致 -->
                <el-button size="small" type="primary" @click="$router.push(`/specialarea/${row.specialarea_id}`)">配置</el-button>
                <el-button size="small" type="danger" plain @click="removeOne(row)">删除</el-button>
              </template>
              <template v-else-if="modKey === 'goods'">
                <el-button size="small" @click="openEdit(row)">编辑</el-button>
                <el-button size="small" plain @click="duplicateGoods(row)">复制</el-button>
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

    <!-- 后台手动新增订单 -->
    <el-dialog v-model="manualOrderDlg" title="新增订单" width="660px" destroy-on-close :close-on-click-modal="false">
      <el-alert
        title="每笔订单对应一件独立货权。待确认订单会锁定唯一件商品或占用一个库存名额；确认成交后自动完成货权过户。"
        type="info"
        :closable="false"
        show-icon
        class="manual-order-alert"
      />
      <el-form label-width="100px" class="manual-order-form">
        <el-form-item label="会员" required>
          <el-select
            v-model="manualOrderForm.member_id"
            filterable
            remote
            clearable
            reserve-keyword
            :remote-method="searchManualMembers"
            :loading="manualMemberLoading"
            placeholder="输入昵称、手机号或会员 ID 搜索"
            style="width: 100%"
            @change="onManualBuyerChange"
            @visible-change="(v) => v && !manualMemberOptions.length && searchManualMembers('')"
          >
            <el-option
              v-for="m in manualMemberOptions"
              :key="m.member_id"
              :value="m.member_id"
              :label="`${m.nick_name || '未设置昵称'} · ${m.mobile || `会员#${m.member_id}`}`"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="商品" required>
          <el-select
            v-model="manualOrderForm.goods_id"
            filterable
            remote
            clearable
            reserve-keyword
            :remote-method="searchManualGoods"
            :loading="manualGoodsLoading"
            :disabled="!manualOrderForm.member_id"
            placeholder="先选择会员，再搜索可售商品"
            style="width: 100%"
            @change="onManualGoodsChange"
            @visible-change="(v) => v && !manualGoodsOptions.length && searchManualGoods('')"
          >
            <el-option
              v-for="g in manualGoodsOptions"
              :key="g.goods_id"
              :value="g.goods_id"
              :label="`${g.goods_name} · ¥${Number(g.goods_min_price).toFixed(2)} · ${g.piece_sale ? `库存 ${g.stock_num}` : '唯一件'}`"
            />
          </el-select>
          <div v-if="manualSelectedGoods" class="manual-order-goods-meta">
            当前持有人：{{ manualSelectedGoods.holder_name || '平台' }}
            <span v-if="manualSelectedGoods.holder_mobile" class="muted">{{ manualSelectedGoods.holder_mobile }}</span>
            <span class="manual-order-meta-sep">·</span>
            {{ manualSelectedGoods.piece_sale ? `库存池，剩余 ${manualSelectedGoods.stock_num} 件` : '唯一件商品' }}
          </div>
        </el-form-item>
        <el-form-item label="订单类型">
          <el-tag type="danger" effect="light">抢购订单</el-tag>
          <span class="manual-order-hint">按商品成交与货权流转规则创建</span>
        </el-form-item>
        <el-form-item label="单价" required>
          <el-input-number v-model="manualOrderForm.price" :min="0.01" :precision="2" :step="10" controls-position="right" style="width: 100%" />
        </el-form-item>
        <el-form-item label="数量">
          <span>1 件</span>
          <span class="manual-order-hint">多件商品请分别新增，确保每件都有独立订单和货权记录</span>
        </el-form-item>
        <el-form-item label="商品金额">
          <span class="manual-order-money">¥{{ manualOrderTotal.toFixed(2) }}</span>
        </el-form-item>
        <el-form-item label="抢单服务费">
          <span>¥{{ manualOrderServiceFee.toFixed(2) }}</span>
          <span class="manual-order-hint">按后台费率 {{ manualOrderRates.service_charge_rate }}% 自动计算</span>
        </el-form-item>
        <el-form-item label="转拍上架费">
          <span>¥{{ manualOrderListingFee.toFixed(2) }}</span>
          <span class="manual-order-hint">按后台费率 {{ manualOrderRates.listing_fee_rate }}% 预收</span>
        </el-form-item>
        <el-form-item label="实付金额">
          <span class="manual-order-pay-total">¥{{ manualOrderPayTotal.toFixed(2) }}</span>
          <span class="manual-order-hint">商品金额 + 服务费 + 上架费</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="manualOrderForm.remark" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="选填，记录本次手动录入原因" />
        </el-form-item>
        <el-form-item label="成交处理">
          <el-checkbox v-model="manualOrderForm.confirm_paid">新增后立即确认收款并完成货权过户</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="manualOrderDlg = false">取消</el-button>
        <el-button type="primary" :loading="manualOrderSaving" :disabled="!manualOrderForm.member_id || !manualOrderForm.goods_id" @click="submitManualOrder">
          {{ manualOrderForm.confirm_paid ? '新增并确认成交' : '新增待确认订单' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 编辑 / 新增 弹窗 -->
    <el-dialog v-model="dialog" :title="modKey === 'orders' ? '订单详情' : modKey === 'recycle' ? '回收详情' : formTitle" :width="modKey === 'goods' ? '880px' : '620px'" destroy-on-close>
      <el-descriptions v-if="modKey === 'orders'" :column="2" border>
        <el-descriptions-item label="订单号">{{ form.order_no || '—' }}</el-descriptions-item>
        <el-descriptions-item label="订单类型">{{ labelOf(mod.fields?.find((f) => f.k === 'type'), form.type) }}</el-descriptions-item>
        <el-descriptions-item label="商品">{{ form.goods_name || '—' }}</el-descriptions-item>
        <el-descriptions-item label="数量">{{ form.num ?? '—' }}</el-descriptions-item>
        <!-- 买家带上手机号：客服要联系买家时不用再跳去会员管理里翻 -->
        <el-descriptions-item label="买家">
          <template v-if="form._buyer || form._buyer_mobile">
            {{ form._buyer || '未设置昵称' }}
            <span v-if="form._buyer_mobile" class="muted detail-mobile">{{ form._buyer_mobile }}</span>
          </template>
          <span v-else class="muted">—</span>
        </el-descriptions-item>
        <el-descriptions-item label="卖家">
          <template v-if="Number(form.seller_id) > 0">
            {{ form._seller || '未设置昵称' }}
            <span v-if="form._seller_mobile" class="muted detail-mobile">{{ form._seller_mobile }}</span>
          </template>
          <span v-else>平台</span>
        </el-descriptions-item>
        <el-descriptions-item label="商品金额">¥{{ Number(form.total_price || 0).toFixed(2) }}</el-descriptions-item>
        <!-- 状态必须用后端合并后的文案：只看 pay_status 会把已取消的单显示成「待确认」 -->
        <el-descriptions-item label="订单状态">{{ form.order_state_text || (Number(form.pay_status) === 10 ? '已确认' : '待确认') }}</el-descriptions-item>
        <!-- 实付由三笔构成：货款 + 抢单服务费 + 转拍上架费（下单时一并收取）。
             只显示货款的话，运营按会员转来的钱对账永远差一截 -->
        <el-descriptions-item label="抢单服务费">¥{{ Number(form.service_charge || 0).toFixed(2) }}</el-descriptions-item>
        <el-descriptions-item label="转拍上架费">¥{{ Number(form.listing_fee || 0).toFixed(2) }}</el-descriptions-item>
        <el-descriptions-item label="实付金额" :span="2">
          <b style="color: #d4380d">¥{{ payTotalOf(form).toFixed(2) }}</b>
          <span class="muted" style="margin-left: 8px">= 货款 + 服务费 + 上架费</span>
        </el-descriptions-item>
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
        <el-descriptions-item label="支付方式">
          {{ labelOf(mod.fields?.find((f) => f.k === 'pay_type'), form.pay_type) }}
        </el-descriptions-item>
        <el-descriptions-item label="下单时间">{{ form.create_time || '—' }}</el-descriptions-item>
        <el-descriptions-item v-if="form.pay_time" label="确认时间">{{ form.pay_time }}</el-descriptions-item>
        <el-descriptions-item label="备注" :span="2">{{ form.remark || '—' }}</el-descriptions-item>
      </el-descriptions>
      <!-- 转让记录：这单换过几次手、谁经手的，只能从这里看 -->
      <div v-if="modKey === 'orders' && transferHistory.length" class="transfer-log">
        <div class="transfer-log__title">转让记录</div>
        <div v-for="t in transferHistory" :key="t.transfer_id" class="transfer-log__item">
          <div class="transfer-log__line">
            <span class="transfer-log__from">{{ t.from_name || `会员${t.from_member_id}` }}</span>
            <span class="muted">{{ t.from_mobile }}</span>
            <span class="transfer-log__arrow">→</span>
            <span class="transfer-log__to">{{ t.to_name || `会员${t.to_member_id}` }}</span>
            <span class="muted">{{ t.to_mobile }}</span>
          </div>
          <div class="transfer-log__meta">
            {{ t.create_time }} · {{ t.reason }} · 操作人 {{ t.operator || 'admin' }}
            <span v-if="Number(t.paid_before) === 1"> · 已成交，线下结算参考 ¥{{ Number(t.amount || 0).toFixed(2) }}</span>
            <span v-else> · 未付款，仅转移名额</span>
          </div>
        </div>
      </div>
      <el-form
        v-else
        :label-width="modKey === 'goods' ? '92px' : '124px'"
        label-position="right"
        :class="{ 'form-grid': modKey === 'goods' }"
      >
        <el-form-item
          v-for="f in formFields"
          :key="f.k"
          :label="f.t"
          :class="{ 'is-wide': modKey === 'goods' && (f.type === 'rich' || f.k === 'detail_images') }"
        >
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
          <template v-else-if="f.type === 'rich'">
            <el-input
              :ref="(el) => setRichRef(f.k, el)"
              v-model="form[f.k]"
              type="textarea"
              :rows="5"
              placeholder="支持 HTML；也可以点下面「插入图片」把图片放进正文"
            />
            <div class="rich-tools">
              <el-button size="small" :loading="richUploading" @click="pickRichImage(f.k)">插入图片</el-button>
              <span class="rich-tools__tip">图片插在光标位置；不想写 HTML 也没关系，用下面的「详情图片」就能整段铺图</span>
            </div>
          </template>
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
          <!-- 用 template 包住：直接在 v-else-if 链中间插一个 v-if 的 div 会把后面的
               v-else-if / v-else 挂到这个 div 上，于是每个字段底下都多渲染一个输入框 -->
          <template v-else-if="f.type === 'money' || f.type === 'number'">
            <el-input-number
              v-model="form[f.k]"
              :precision="f.type === 'money' ? 2 : 0"
              :min="f.min ?? 0"
              :max="f.max ?? 999999"
              :disabled="priceLocked(f)"
              style="width: 100%"
              controls-position="right"
            />
            <div v-if="priceLocked(f)" class="price-lock-tip">
              转拍商品的价格由系统按涨幅自动计算，这里不能改；上下架、标题、图片仍可修改
            </div>
          </template>
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
        <el-button v-if="modKey !== 'orders' && modKey !== 'recycle'" type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 订单转让 -->
    <el-dialog v-model="transferDlg" title="订单转让" width="580px" destroy-on-close>
      <div class="tr-order">
        <div class="tr-order__row">
          <span class="muted">订单号</span>
          <span>{{ transferRow.order_no || '—' }}</span>
        </div>
        <div class="tr-order__row">
          <span class="muted">商品</span>
          <span class="ellipsis">{{ transferRow.goods_name || '—' }}</span>
        </div>
        <div class="tr-order__row">
          <span class="muted">金额</span>
          <span>¥{{ payTotalOf(transferRow).toFixed(2) }}</span>
        </div>
        <div class="tr-order__row">
          <span class="muted">原买家</span>
          <span>
            {{ transferRow._buyer || '未设置昵称' }}
            <span v-if="transferRow._buyer_mobile" class="muted">{{ transferRow._buyer_mobile }}</span>
          </span>
        </div>
      </div>

      <!-- 两种语义必须说清楚，否则运营会把「转名额」和「转订单」搞混 -->
      <el-alert
        v-if="Number(transferRow.pay_status) === 10"
        type="warning"
        :closable="false"
        show-icon
        title="该订单已成交"
        description="转让后订单与商品一并归新买家，货款由双方线下结清。平台不退款、不收款、不动余额。"
        class="tr-alert"
      />
      <el-alert
        v-else
        type="info"
        :closable="false"
        show-icon
        title="该订单尚未付款"
        description="转让后名额归新买家，由他继续付款；原买家不再持有该单，也无法再操作它。"
        class="tr-alert"
      />

      <el-form label-width="88px" style="margin-top: 14px">
        <el-form-item label="接手会员" required>
          <el-select
            v-model="transferForm.to_member_id"
            filterable
            remote
            clearable
            reserve-keyword
            :remote-method="searchCandidates"
            :loading="candidateLoading"
            placeholder="输入手机号 / 昵称 / 会员ID 搜索"
            style="width: 100%"
            @change="onPickCandidate"
          >
            <el-option
              v-for="m in candidateOptions"
              :key="m.member_id"
              :value="m.member_id"
              :label="`${m.nick_name || '未设置昵称'} · ${m.mobile}`"
              :disabled="m.disabled === 1 || m.is_current === 1"
            >
              <div class="tr-opt">
                <span>{{ m.nick_name || '未设置昵称' }} · {{ m.mobile }}</span>
                <span class="muted">
                  余额 ¥{{ Number(m.amount || 0).toFixed(2) }}
                  <template v-if="m.area_limit > 0"> · 本场已抢 {{ m.area_bought }}/{{ m.area_limit }}</template>
                  <template v-if="m.disabled === 1"> · 已禁用</template>
                  <template v-if="m.is_current === 1"> · 就是原买家</template>
                </span>
              </div>
            </el-option>
          </el-select>
        </el-form-item>

        <!-- 选中的会员要能看到「他已经抢了几件」，转让会占用他的本场额度 -->
        <el-form-item v-if="pickedCandidate" label="接手人">
          <div class="tr-picked">
            <b>{{ pickedCandidate.nick_name || '未设置昵称' }}</b>
            <span class="muted">{{ pickedCandidate.mobile }} · 余额 ¥{{ Number(pickedCandidate.amount || 0).toFixed(2) }}</span>
            <div v-if="pickedCandidate.area_limit > 0" class="tr-picked__limit" :class="{ 'is-over': pickedCandidate.over_limit === 1 }">
              本场已抢 {{ pickedCandidate.area_bought }} 件（限购 {{ pickedCandidate.area_limit }} 件）
              <template v-if="pickedCandidate.over_limit === 1">，转让后会超出限购 —— 请确认这是你的本意</template>
            </div>
          </div>
        </el-form-item>

        <el-form-item label="转让原因" required>
          <el-select v-model="transferForm.reason" style="width: 100%">
            <el-option v-for="r in TRANSFER_REASONS" :key="r" :label="r" :value="r" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input
            v-model="transferForm.remark"
            type="textarea"
            :rows="2"
            maxlength="80"
            show-word-limit
            placeholder="例如：会员用朋友账号代拍，现转到本人名下"
          />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="transferDlg = false">取消</el-button>
        <el-button
          type="primary"
          :loading="transferring"
          :disabled="!transferForm.to_member_id"
          @click="doTransfer"
        >确认转让</el-button>
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
        <span>已确认：¥{{ Number(teamData.stats?.paid_amount || 0).toFixed(2) }}</span>
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

    <!-- 开通提前抢购：提前多少分钟 + 可用次数 -->
    <el-dialog v-model="advanceDlg" title="开通提前抢购" width="460px">
      <el-form label-width="88px">
        <el-form-item label="会员">
          <b>{{ advanceForm.nick_name }}</b>
        </el-form-item>
        <el-form-item label="提前时间">
          <div class="advance-field">
            <div class="advance-row">
              <el-input-number v-model="advanceForm.minutes" :min="0" :max="60" :step="1" style="width: 128px" />
              <span class="muted">分钟（0 = 不提前）</span>
            </div>
            <div class="advance-quick">
              <el-button
                v-for="m in [1, 3, 5, 10]"
                :key="m"
                size="small"
                :type="advanceForm.minutes === m ? 'primary' : 'default'"
                @click="advanceForm.minutes = m"
              >
                提前 {{ m }} 分钟
              </el-button>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="可用次数">
          <el-input-number v-model="advanceForm.count" :min="0" style="width: 128px" />
          <span class="muted" style="margin-left: 8px">0 = 不限</span>
        </el-form-item>
        <div class="advance-tip">
          开通后，该会员在场次开始前 <b>{{ advanceForm.minutes || 0 }} 分钟</b> 就能下单；
          <b>结束时间不变</b>，场次结束后照样买不了。其他会员仍按原时间开抢。
        </div>
      </el-form>
      <template #footer>
        <el-button @click="advanceDlg = false">取消</el-button>
        <el-button type="primary" :loading="advanceSaving" @click="submitAdvance">开通</el-button>
      </template>
    </el-dialog>

    <!-- 详情正文插图用的隐藏选择器：走同一套上传接口，插到光标所在位置 -->
    <input ref="richInputEl" class="rich-file" type="file" accept="image/*" @change="onRichFile" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { adminApi } from '../api.js';
import http from '../api.js';
import ImageUploader from '../components/ImageUploader.vue';
import CategoryIcon from '../../../shared/CategoryIcon.vue';
import CategoryIconPicker from '../../../shared/CategoryIconPicker.vue';
import { categoryIconKey } from '../../../shared/category-icons.js';
import { prepareImage } from '../../../shared/imagePrepare.js';

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

const filters = reactive({ pay_status: '', kind: '', disabled: '', area_id: '', source: '', range: '', date_start: '', date_end: '', cancel_by: '', transferred: '', member_id: '' });

// 取消来源筛选标签（对应 orders.cancel_by：1=会员自己取消 2=后台取消）
// 持有人下拉：复用会员选项接口，按昵称/手机号远程搜
const holderOptions = ref([]);
const holderLoading = ref(false);
let holderTimer = null;
function searchHolderOptions(kw) {
  clearTimeout(holderTimer);
  holderTimer = setTimeout(async () => {
    holderLoading.value = true;
    try {
      const r = await http.get('/member/options', { params: { keyword: String(kw || '').trim() } });
      holderOptions.value = r.data || [];
    } catch {
      holderOptions.value = [];
    } finally {
      holderLoading.value = false;
    }
  }, 240);
}

const CANCEL_TABS = [
  { value: 1, label: '用户取消' },
  { value: 2, label: '后台取消' },
];
function toggleCancelFilter(v) {
  filters.cancel_by = filters.cancel_by === v ? '' : v;
  reload();
}
/** 只筛「转过手」的订单（后端按 transfer_count > 0） */
function toggleTransferred() {
  filters.transferred = filters.transferred === 1 ? '' : 1;
  reload();
}
/** 订单状态标签配色：取消一律红色（警示），待确认黄，已确认绿 */
function orderStateClass(text) {
  const t = String(text || '');
  if (t.includes('取消')) return 'tag-red';
  if (t === '已确认') return 'tag-ok';
  return 'tag-warn';
}
// 自定义日期区间（el-date-picker 用数组，提交时拆成 date_start / date_end）
const customRange = ref([]);
const EXPORTING = ref(false);
const manualOrderDlg = ref(false);
const manualOrderSaving = ref(false);
const manualMemberLoading = ref(false);
const manualGoodsLoading = ref(false);
const manualMemberOptions = ref([]);
const manualGoodsOptions = ref([]);
const manualOrderRates = reactive({ service_charge_rate: 0, listing_fee_rate: 0 });
const manualOrderForm = reactive({ member_id: null, goods_id: null, price: 0, num: 1, remark: '', confirm_paid: false });
let manualMemberTimer = null;
let manualGoodsTimer = null;

const manualSelectedGoods = computed(() => manualGoodsOptions.value.find((g) => Number(g.goods_id) === Number(manualOrderForm.goods_id)) || null);
const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const manualOrderTotal = computed(() => roundMoney(Number(manualOrderForm.price) || 0));
const manualOrderServiceFee = computed(() => roundMoney(manualOrderTotal.value * (Number(manualOrderRates.service_charge_rate) || 0) / 100));
const manualOrderListingFee = computed(() => roundMoney(manualOrderTotal.value * (Number(manualOrderRates.listing_fee_rate) || 0) / 100));
const manualOrderPayTotal = computed(() => roundMoney(manualOrderTotal.value + manualOrderServiceFee.value + manualOrderListingFee.value));

const dialog = ref(false);
const saving = ref(false);
const form = reactive({});
const editing = ref(false);


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

// 提前抢购：开通弹窗的临时表单
const advanceDlg = ref(false);
const advanceSaving = ref(false);
const advanceForm = reactive({ member_id: 0, nick_name: '', minutes: 3, count: 0 });

const visibleFields = computed(() => (mod.value.fields || []).filter((f) => !f.hide));
const formFields = computed(() =>
  (mod.value.fields || []).filter((f) => !f.readonly && f.k !== mod.value.pk),
);
const formTitle = computed(() => (editing.value ? `编辑${mod.value.label}` : `新增${mod.value.label}`));

// 转拍货（货在会员手上）的价格由系统算，后台锁死。
// 只锁价格相关的三个字段，上下架 / 标题 / 图片 / 分类 / 库存照常可改。
const PRICE_KEYS = ['goods_min_price', 'price_cap', 'line_price'];
// 「转拍货」由后端在 _kind 里给出（被别人买过、价格由系统接管的那种）
const priceLocked = (f) => modKey.value === 'goods'
  && form._kind === '转拍货'
  && PRICE_KEYS.includes(f.k);

/**
 * 只把「真图片地址」交给 <img>。
 * 分类图标存的是 icon:xxx 这种内置图标键；切换列表页时组件复用会有一帧
 * 「新模块 + 旧行数据」，若不校验就会把 icon:all 当 URL 请求，报 ERR_UNKNOWN_URL_SCHEME。
 */
function isImageSrc(v) {
  if (typeof v !== 'string' || !v) return false;
  return /^https?:\/\//i.test(v) || v.startsWith('data:image/') || v.startsWith('blob:') || v.startsWith('/');
}

// 色块里的金额：整数不带小数，避免 16800.00 把列宽撑爆
const shortMoney = (v) => {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

function imageRecommendation(field) {
  const key = field.k;
  const module = modKey.value;
  if (module === 'banner' && key === 'file_path') return '首页轮播按 16:9 显示，推荐 1080×608 px；原图可直接上传，想精确按 16:9 出图时在缩略图上点「裁剪」，重要文字和主体尽量靠中间。';
  if (module === 'goods' && key === 'good_thumb') return '商品卡片按正方形显示，推荐 800×800 px；主体居中，四周留少量空白。';
  if (module === 'goods' && key === 'images') return '商品详情图推荐 800×800 px（1:1），多张图尽量统一比例；建议单张不超过 2 MB。';
  if (module === 'category' && key === 'image') return '分类图标推荐 512×512 px（1:1），主体居中，建议使用透明背景 PNG 或 WebP。';
  if (module === 'navigation' && key === 'file_path') return '导航图标推荐 512×512 px（1:1），主体居中并预留边距。';
  if (module === 'certification') return '证件照片建议 1200×800 px（3:2）或更高分辨率；请完整拍入证件四边并保持文字清晰。';
  if (module === 'orders' && key === 'goods_thumb') return '商品缩略图按正方形显示，推荐 800×800 px。';
  return '建议使用清晰原图，选好即可直接上传（自动等比压缩）；需要调整取景时再点缩略图上的「裁剪」。';
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
    goods: '统一商品库：价格、库存、持有人与上下架。商品在哪个场次售卖，去「抢购场次 → 关联商品」里设置；被系统回收的商品带「封顶」标签，前台不再展示，改回上架即二次上架',
    category: '首页抢购分类与商城分类维护',
    specialarea: '设置每日抢购场次的内容、限购与关联商品',
    orders: '全部订单查询、确认抢单与取消',
    settle: '大账结算、中账差额、小账凭证三类账目核对',
    energy: '会员佣金、余额、积分变更流水',
    member: '会员资料、团队关系与资金账户',
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

// 会员名/手机号：不同模块后端给的字段名不一样（买家 _buyer、会员 _member、持有人 _holder）
// 这类列上下堆两行，不能再让 el-table 用 tooltip 截断
const isStackedCell = (f) => f.type === 'member';
const memberName = (row) => row._buyer || row._member || row._holder || '';
const memberMobile = (row) => row._buyer_mobile || row._member_mobile || row._holder_mobile || '';

const labelOf = (f, v) => {
  if (typeof f.opts === 'object') return f.opts[v] ?? v ?? '—';
  return v ?? '—';
};

// 订单实付 = 货款 + 抢单服务费 + 转拍上架费（后两笔都在下单时算进去、支付时一次扣清）。
// 后台对账、客服答疑都按这个口径，别再只看 total_price。
const payTotalOf = (o) => Number(o?.total_price || 0)
  + Number(o?.service_charge || 0)
  + Number(o?.listing_fee || 0);

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

async function load(opt = {}) {
  const silent = opt && opt.silent === true;
  if (!silent) loading.value = true;
  try {
    const params = { page: page.value, limit: limit.value };
    if (keyword.value) params.keyword = keyword.value;
    for (const [k, v] of Object.entries(filters)) {
      if (v !== '' && v !== undefined && v !== null) params[k] = v;
    }
    // 商品的「来源」筛选后端参数叫 kind（结算页的 kind 是账目类型，所以前端换个名字避免撞车）
    if (modKey.value === 'goods' && filters.source) {
      params.kind = filters.source;
      delete params.source;
    }
    Object.assign(params, fixed.value);
    const r = await adminApi.list(modKey.value, params);
    rows.value = r.data.data || [];
    total.value = r.data.total || 0;
    mod.value = r.data.module || mod.value;
    await loadSelects();
    loadStats();
  } catch {
    // 静默刷新失败时保留上一次的数据，别把表格清空给运营看
    if (!silent) rows.value = [];
  } finally {
    if (!silent) loading.value = false;
  }
}

async function loadSelects() {
  const need = new Set();
  for (const f of mod.value.fields || []) {
    if (f.type === 'select' && typeof f.opts === 'string') need.add(f.opts);
  }
  // 商品列表的「关联场次」筛选需要场次下拉，虽然商品表单里已经没有场次字段了
  if (modKey.value === 'goods') need.add('specialarea');
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

// 昵称是会员自己填的、商品名是运营填的，塞进 dangerouslyUseHTMLString 之前必须转义。
// 不转：有人把昵称改成 <img src=x onerror=...>，管理员一点「转让/确认抢单」就在后台页面里执行脚本。
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ---------- 订单转让 ----------
// 两种语义：未付款 = 把名额给别人（新买家自己去付款）；已付款 = 订单归别人。
// 两种都不动账，货款由会员之间线下结清 —— 平台介入退款会凭空造出资金流水。
const TRANSFER_REASONS = ['帮人代拍', '账号错误', '客服调整', '线下已结清', '其它'];
const transferDlg = ref(false);
const transferRow = ref({});
const transferForm = reactive({ to_member_id: null, reason: '客服调整', remark: '' });
const candidateOptions = ref([]);
const candidateLoading = ref(false);
const transferring = ref(false);
const transferHistory = ref([]);
const pickedMember = ref(null);
// 下拉重新搜索会替换候选列表，已选的那个人可能不在新列表里。
// 只从候选里找的话，接手人信息会突然消失、点确认还会提示「请先选择接手会员」——
// 所以另存一份已选对象兜底。
const pickedCandidate = computed(() => {
  const id = Number(transferForm.to_member_id);
  const hit = candidateOptions.value.find((m) => Number(m.member_id) === id);
  if (hit) return hit;
  return pickedMember.value && Number(pickedMember.value.member_id) === id ? pickedMember.value : null;
});
function onPickCandidate(id) {
  pickedMember.value = candidateOptions.value.find((m) => Number(m.member_id) === Number(id)) || null;
}

function openTransfer(row) {
  transferRow.value = row;
  transferForm.to_member_id = null;
  transferForm.reason = Number(row.pay_status) === 10 ? '客服调整' : '帮人代拍';
  transferForm.remark = '';
  candidateOptions.value = [];
  pickedMember.value = null;
  transferDlg.value = true;
}

let candidateTimer = null;
function searchCandidates(kw) {
  clearTimeout(candidateTimer);
  const key = String(kw || '').trim();
  if (!key) { candidateOptions.value = []; return; }
  // 每敲一个字就发一次请求会把接口打满，等 260ms 再说
  candidateTimer = setTimeout(async () => {
    candidateLoading.value = true;
    try {
      const r = await adminApi.transferCandidates({ keyword: key, order_id: transferRow.value.order_id });
      candidateOptions.value = r.data || [];
    } catch {
      candidateOptions.value = [];
    } finally {
      candidateLoading.value = false;
    }
  }, 260);
}

async function doTransfer() {
  const m = pickedCandidate.value;
  if (!m) { ElMessage.warning('请先选择接手会员'); return; }
  const paid = Number(transferRow.value.pay_status) === 10;
  const reason = transferForm.remark.trim()
    ? `${transferForm.reason}：${transferForm.remark.trim()}`
    : transferForm.reason;
  try {
    await ElMessageBox.confirm(
      `<div class="confirm-card">
        <p class="confirm-card__ask">${paid
          ? '这笔订单已成交。转让后订单与商品一并归新买家，货款由双方线下结清，平台不退款、不收款。操作不可撤销。'
          : '这笔订单尚未付款。转让后名额归新买家，由他继续付款。操作不可撤销。'}</p>
        <dl>
          <div><dt>订单号</dt><dd>${esc(transferRow.value.order_no) || '—'}</dd></div>
          <div><dt>商品</dt><dd>${esc(transferRow.value.goods_name) || '—'}</dd></div>
          <div><dt>原买家</dt><dd>${esc(transferRow.value._buyer) || '未设置昵称'} · ${esc(transferRow.value._buyer_mobile) || '—'}</dd></div>
          <div><dt>接手人</dt><dd>${esc(m.nick_name) || '未设置昵称'} · ${esc(m.mobile)}</dd></div>
          <div><dt>金额</dt><dd class="confirm-card__money">¥${payTotalOf(transferRow.value).toFixed(2)}</dd></div>
        </dl>
      </div>`,
      '确认转让',
      {
        type: 'warning',
        confirmButtonText: '确认转让',
        cancelButtonText: '再想想',
        dangerouslyUseHTMLString: true,
        customClass: 'order-confirm-box',
      },
    );
  } catch {
    return;
  }
  transferring.value = true;
  try {
    const r = await adminApi.transferOrder({
      order_id: transferRow.value.order_id,
      to_member_id: m.member_id,
      reason,
    });
    ElMessage.success(r.msg || '已转让');
    transferDlg.value = false;
    load();
  } catch {
    // 请求拦截器已经弹过具体原因，这里不重复提示
  } finally {
    transferring.value = false;
  }
}

function openEdit(row) {
  editing.value = true;
  for (const k of Object.keys(form)) delete form[k];
  for (const f of mod.value.fields || []) form[f.k] = row[f.k];
  // 列表行还带了 enrich 补出来的展示字段（_buyer / _buyer_mobile / _seller / order_state_text 等），
  // 它们不在列定义里，不复制过去详情弹窗就取不到 —— 买家、卖家会显示成「—」
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('_') || k === 'order_state_text' || k === 'transferred') form[k] = v;
  }
  // 换了一条记录，之前记住的文本域已经不在这个弹窗里了
  richFieldKey.value = '';
  if (modKey.value === 'orders') {
    form.is_examine = row.is_examine;
    form.pay_status = row.pay_status;
    // 转让记录单独拉：列表行里只有次数，没有流水。换一条记录先清空，
    // 否则会短暂显示上一条订单的转让历史
    transferHistory.value = [];
    adminApi.transferHistory(row.order_id)
      .then((r) => { transferHistory.value = r.data || []; })
      .catch(() => {});
  }
  if ('password' in form) form.password = '';
  dialog.value = true;
}

async function save() {
  // 场次时段：结束必须晚于开始（后端也拦，这里先给即时提示，省得提交了才报错）
  if (modKey.value === 'specialarea') {
    const st = Number(form.start_time) || 0;
    const et = Number(form.end_time) || 0;
    if (et > 0 && et <= st) {
      return ElMessage.warning('结束时间必须晚于开始时间（跨天时段不支持，请拆成两个场次）');
    }
  }
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
  // 删场次时后端可能顺带把场内转拍货退货，提示里会带件数，别吞掉
  const r = await adminApi.remove(modKey.value, [row[mod.value.pk]]);
  ElMessage.success(r?.msg || '已删除');
  load();
}

async function uploadImage(file, extra = {}) {
  const r = await adminApi.upload(file, extra);
  return r.data.url;
}

// ---------------- 详情富文本：插入图片 ----------------
// 为什么要拿 textarea 元素：点「插入图片」时输入框已经失焦，但 selectionStart
// 仍停在用户原来的光标处，取它才能把图插在想放的位置，而不是一律甩到末尾。
// 不靠 focus 事件记光标 —— 弹窗里有焦点陷阱，靠事件容易漏，直接问组件要 textarea 更稳。
const richInputEl = ref(null);
const richUploading = ref(false);
const richFieldKey = ref('');
const richRefs = {};

function setRichRef(key, el) {
  if (el) richRefs[key] = el;
  else delete richRefs[key];
}

/** el-input 的 textarea 在组件根节点里，无论它有没有暴露内部 ref 都能取到 */
function richTextareaOf(key) {
  const comp = richRefs[key];
  const root = comp?.$el || comp;
  return root?.querySelector?.('textarea') || null;
}

function pickRichImage(key) {
  richFieldKey.value = key;
  richInputEl.value?.click();
}

async function onRichFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  const key = richFieldKey.value;
  if (!file || !key) return;
  richUploading.value = true;
  try {
    // 和图片上传同一套预处理：只等比压缩，不裁剪
    const ready = await prepareImage(file);
    const url = await uploadImage(ready);
    insertRichImage(key, url);
  } catch (error) {
    ElMessage.error(error?.message || '插入图片失败，请重试');
  } finally {
    richUploading.value = false;
  }
}

function insertRichImage(key, url) {
  const cur = String(form[key] || '');
  const ta = richTextareaOf(key);
  const caret = ta && Number.isInteger(ta.selectionStart) ? ta.selectionStart : cur.length;
  const pos = Math.min(Math.max(caret, 0), cur.length);
  const tag = `<img src="${url}" alt="" />`;
  form[key] = cur.slice(0, pos) + tag + cur.slice(pos);
  // 光标落到图片后面，方便接着写下一段
  nextTick(() => {
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(pos + tag.length, pos + tag.length);
  });
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
  // 确认抢单 = 认定收到货款并完成成交，钱货都动，不可撤销，必须先弹卡片核对
  const buyer = esc(row._buyer) || '未设置昵称';
  const mobile = esc(row._buyer_mobile) || '—';
  try {
    await ElMessageBox.confirm(
      `<div class="confirm-card">
        <p class="confirm-card__ask">确认已收到这笔货款？确认后订单立即成交，商品归买家所有，不可撤销。</p>
        <dl>
          <div><dt>订单号</dt><dd>${esc(row.order_no) || '—'}</dd></div>
          <div><dt>商品</dt><dd>${esc(row.goods_name) || '—'}</dd></div>
          <div><dt>买家</dt><dd>${buyer} · ${mobile}</dd></div>
          <div><dt>实付金额</dt><dd class="confirm-card__money">¥${payTotalOf(row).toFixed(2)}</dd></div>
        </dl>
      </div>`,
      '确认抢单',
      {
        type: 'warning',
        confirmButtonText: '确认收款',
        cancelButtonText: '再想想',
        dangerouslyUseHTMLString: true,
        customClass: 'order-confirm-box',
      },
    );
  } catch {
    return;
  }
  const r = await adminApi.confirmPay({ order_id: row.order_id });
  if (r.code === 1) {
    ElMessage.success(r.msg || '已确认抢单');
    load();
  } else {
    ElMessage.error(r.msg || '确认失败');
  }
}

// 批量确认抢单：只处理「待确认」的单，勾了别的会自动跳过
async function batchConfirmPay() {
  const ids = (sel.value || []).filter((r) => Number(r.status) === 0).map((r) => r.order_id);
  if (!ids.length) return ElMessage.warning('勾选的订单都已到账，无需确认');
  try {
    await ElMessageBox.confirm(
      `确认这 ${ids.length} 笔订单已收到款？会按每笔成交价入账并完成结算，不可撤销。`,
      '批量确认抢单',
      { type: 'warning', confirmButtonText: '确认抢单', cancelButtonText: '取消' },
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

async function batchCancelOrders() {
  const ids = (sel.value || []).filter((r) => Number(r.pay_status) !== 10 && Number(r.status) !== 40).map((r) => r.order_id);
  if (!ids.length) return ElMessage.warning('勾选的订单都已确认或已取消，没有可取消的');
  try {
    await ElMessageBox.confirm(
      `取消这 ${ids.length} 笔订单？商品会立即释放、重新可抢；已确认的订单会自动跳过。`,
      '批量取消',
      { type: 'warning', confirmButtonText: '确定取消', cancelButtonText: '再想想' },
    );
  } catch {
    return;
  }
  try {
    const r = await adminApi.cancelOrderBatch({ order_ids: ids });
    ElMessage.success(r.msg || `已取消 ${ids.length} 笔`);
    load();
  } catch {}
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
    { k: '封顶商品总金额', v: Number(d.recycled_amount || 0), c: d.recycled_count || 0 },
  ];
});

async function loadStats() {
  if (modKey.value !== 'goods') return;
  try {
    const r = await http.get('/stats/goods');
    stats.value = r.data || null;
  } catch {}
}

/** 时间范围切换：自定义没选日期就先不查，免得白跑一次全量 */
function onRangeChange(v) {
  if (v === 'custom') {
    if (!customRange.value || customRange.value.length !== 2) return;
    onCustomRange(customRange.value);
    return;
  }
  filters.date_start = '';
  filters.date_end = '';
  page.value = 1;
  load();
}

function onCustomRange(v) {
  if (!v || v.length !== 2) {
    filters.date_start = '';
    filters.date_end = '';
    return;
  }
  [filters.date_start, filters.date_end] = v;
  page.value = 1;
  load();
}

/** 导出：走的是当前这套筛选条件，导出的是筛选后的全量而不是当前这一页 */
async function exportOrders() {
  if (filters.range === 'custom' && (!filters.date_start || !filters.date_end)) {
    return ElMessage.warning('请先选择自定义日期区间');
  }
  EXPORTING.value = true;
  try {
    const params = {};
    if (keyword.value) params.keyword = keyword.value;
    if (filters.pay_status !== '' && filters.pay_status !== null && filters.pay_status !== undefined) {
      params.pay_status = filters.pay_status;
    }
    // 列表上点了哪个标签，导出就得跟它一致 —— 否则筛了「用户取消」导出的却是全部
    if (filters.cancel_by !== '' && filters.cancel_by !== undefined) params.cancel_by = filters.cancel_by;
    if (filters.transferred === 1) params.transferred = 1;
    // 筛了持有人就只导这个人的单
    if (filters.member_id) params.member_id = filters.member_id;
    if (filters.range) params.range = filters.range;
    if (filters.range === 'custom') {
      params.date_start = filters.date_start;
      params.date_end = filters.date_end;
    }
    Object.assign(params, fixed.value);
    const res = await adminApi.exportOrders(params);
    const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orders-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    ElMessage.success('已导出，可用 Excel 直接打开');
  } catch {
    // 拦截器已提示
  } finally {
    EXPORTING.value = false;
  }
}

function openManualOrder() {
  Object.assign(manualOrderForm, { member_id: null, goods_id: null, price: 0, num: 1, remark: '', confirm_paid: false });
  manualMemberOptions.value = [];
  manualGoodsOptions.value = [];
  manualOrderRates.service_charge_rate = 0;
  manualOrderRates.listing_fee_rate = 0;
  manualOrderDlg.value = true;
  searchManualMembers('');
}

async function fetchManualOrderOptions(kind, keyword) {
  if (kind === 'member') manualMemberLoading.value = true;
  else {
    if (!manualOrderForm.member_id) { manualGoodsOptions.value = []; return; }
    manualGoodsLoading.value = true;
  }
  try {
    const r = await adminApi.orderCreateOptions({
      kind,
      keyword: String(keyword || '').trim(),
      ...(kind === 'goods' ? { member_id: manualOrderForm.member_id } : {}),
    });
    const data = r.data || {};
    if (kind === 'member') manualMemberOptions.value = data.rows || [];
    else manualGoodsOptions.value = data.rows || [];
    manualOrderRates.service_charge_rate = Number(data.service_charge_rate) || 0;
    manualOrderRates.listing_fee_rate = Number(data.listing_fee_rate) || 0;
  } catch {
    if (kind === 'member') manualMemberOptions.value = [];
    else manualGoodsOptions.value = [];
  } finally {
    if (kind === 'member') manualMemberLoading.value = false;
    else manualGoodsLoading.value = false;
  }
}

function searchManualMembers(keyword) {
  clearTimeout(manualMemberTimer);
  manualMemberTimer = setTimeout(() => fetchManualOrderOptions('member', keyword), 220);
}

function searchManualGoods(keyword) {
  clearTimeout(manualGoodsTimer);
  manualGoodsTimer = setTimeout(() => fetchManualOrderOptions('goods', keyword), 220);
}

function onManualBuyerChange() {
  manualOrderForm.goods_id = null;
  manualOrderForm.price = 0;
  manualGoodsOptions.value = [];
  if (manualOrderForm.member_id) searchManualGoods('');
}

function onManualGoodsChange(goodsId) {
  const goods = manualGoodsOptions.value.find((g) => Number(g.goods_id) === Number(goodsId));
  manualOrderForm.price = goods ? Number(goods.goods_min_price) || 0 : 0;
  manualOrderForm.num = 1;
}

async function submitManualOrder() {
  if (!manualOrderForm.member_id) return ElMessage.warning('请选择会员');
  if (!manualOrderForm.goods_id) return ElMessage.warning('请选择商品');
  if (!(Number(manualOrderForm.price) > 0)) return ElMessage.warning('请输入有效单价');

  manualOrderSaving.value = true;
  try {
    const result = await adminApi.createOrder({
      member_id: manualOrderForm.member_id,
      goods_id: manualOrderForm.goods_id,
      price: manualOrderForm.price,
      num: 1,
      remark: manualOrderForm.remark,
    });
    const order = result.data || {};
    if (manualOrderForm.confirm_paid) {
      try {
        await adminApi.confirmPay({ order_id: order.order_id });
        ElMessage.success('订单已新增并确认，货权已过户给买家');
      } catch {
        ElMessage.warning(`订单 ${order.order_no || ''} 已创建，但确认失败；请在订单列表中核对并重新确认`);
      }
    } else {
      ElMessage.success('订单已新增，等待确认收款');
    }
    manualOrderDlg.value = false;
    load();
  } catch {
    // API 拦截器已显示后端校验原因
  } finally {
    manualOrderSaving.value = false;
  }
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

async function toggleAdvance(row) {
  // 已开通 → 直接确认关闭；未开通 → 打开弹窗填提前量与次数
  if (Number(row.is_advance) === 10) {
    try {
      await ElMessageBox.confirm(`确定关闭 ${row.nick_name} 的提前抢购资格？`, '提示', { type: 'warning' });
    } catch { return; }
    await adminApi.advanceMember({ member_id: row.member_id, enable: false });
    ElMessage.success('已关闭提前抢购');
    load();
    return;
  }
  Object.assign(advanceForm, {
    member_id: row.member_id,
    nick_name: row.nick_name || '',
    minutes: Number(row.advance_minutes) > 0 ? Number(row.advance_minutes) : 3,
    count: Math.max(0, Number(row.advance_count) || 0),
  });
  advanceDlg.value = true;
}

async function submitAdvance() {
  advanceSaving.value = true;
  try {
    const r = await adminApi.advanceMember({
      member_id: advanceForm.member_id,
      enable: true,
      count: advanceForm.count,
      minutes: advanceForm.minutes,
    });
    ElMessage.success(r.msg || '已开通提前抢购');
    advanceDlg.value = false;
    load();
  } finally {
    advanceSaving.value = false;
  }
}

// ---------- 系统回收 ----------
async function settleRecycle(row) {
  try {
    await ElMessageBox.confirm(
      `按 ¥${Number(row.recycle_price || 0).toFixed(2)} 结算给「${row._member || '持有人'}」？结算后商品转平台持仓，不可撤销。`,
      '手动结算回收单',
      { type: 'warning', confirmButtonText: '确认结算', cancelButtonText: '取消' },
    );
  } catch { return; }
  const r = await http.post('/recycle/settle', { recycle_id: row.recycle_id });
  ElMessage.success(r.msg || '已结算');
  load();
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
  syncAutoRefresh();
  page.value = 1;
  keyword.value = '';
  filters.status = '';
  filters.kind = '';
  filters.disabled = '';
  filters.source = '';
  // 订单专属筛选也要清：否则从订单页带着「持有人/已转让/取消来源」跳到别的模块，
  // 回来时列表是筛过的，运营却看不出为什么少了一大半
  filters.pay_status = '';
  filters.cancel_by = '';
  filters.transferred = '';
  filters.member_id = '';
  filters.area_id = '';
  // 换模块时时间范围也要归零，否则从订单页跳到商品页会带着 range 参数
  filters.range = '';
  filters.date_start = '';
  filters.date_end = '';
  customRange.value = [];
  teamDlg.value = false;
  load();
});

// 自动刷新：商品列表（价格水位/库存/持有人会随前台成交、转拍变化）与回收台账
// 每 20 秒静默拉一次；弹窗打开、页面隐藏、正在加载时跳过，切回标签页立刻补一次。
const AUTO_REFRESH_MODULES = new Set(['goods', 'recycle']);
const AUTO_REFRESH_MS = 20000;
let autoRefreshTimer = 0;

function autoRefreshTick() {
  if (document.hidden || dialog.value || loading.value) return;
  load({ silent: true });
}

function syncAutoRefresh() {
  if (autoRefreshTimer) { window.clearInterval(autoRefreshTimer); autoRefreshTimer = 0; }
  if (!AUTO_REFRESH_MODULES.has(modKey.value)) return;
  autoRefreshTimer = window.setInterval(autoRefreshTick, AUTO_REFRESH_MS);
}

// 切回浏览器标签页时立即补一次，避免看到的是离开前的旧水位
function onVisibilityChange() {
  if (!document.hidden && AUTO_REFRESH_MODULES.has(modKey.value)) autoRefreshTick();
}

onMounted(async () => {
  await load();
  syncAutoRefresh();
  document.addEventListener('visibilitychange', onVisibilityChange);
});
onUnmounted(() => {
  if (autoRefreshTimer) window.clearInterval(autoRefreshTimer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>

<style scoped>
.price-lock-tip { font-size: 11.5px; color: #c88a1e; margin-top: 4px; line-height: 1.5; }

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
/* 两行堆叠单元格：主行昵称、次行手机号（表格列宽有限，横排一定被截断） */
.stacked { display: flex; flex-direction: column; line-height: 1.35; }
.stacked__main { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stacked__sub { color: var(--muted, #9098a3); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.detail-mobile { margin-left: 6px; font-size: 12px; font-variant-numeric: tabular-nums; }

/* ---- 订单转让 ---- */
.tr-order { border: 1px solid #eef0f4; border-radius: 10px; background: #fbfcfd; padding: 10px 12px; }
.tr-order__row { display: flex; justify-content: space-between; gap: 14px; font-size: 13px; line-height: 1.95; }
.tr-order__row > .muted { flex: none; }
.tr-order__row > span:last-child { text-align: right; word-break: break-all; }
.tr-alert { margin-top: 12px; }
.tr-opt { display: flex; justify-content: space-between; gap: 12px; }
.tr-opt .muted { font-size: 11.5px; }
.tr-picked { font-size: 13px; line-height: 1.7; }
.tr-picked .muted { margin-left: 6px; font-size: 12px; }
.tr-picked__limit { color: #7c8593; font-size: 12px; }
.tr-picked__limit.is-over { color: #d4380d; font-weight: 600; }

.transfer-log { margin-top: 14px; border-top: 1px dashed #eef0f4; padding-top: 12px; }
.transfer-log__title { font-size: 13px; font-weight: 600; color: #2b323d; margin-bottom: 6px; }
.transfer-log__item { font-size: 12.5px; line-height: 1.7; padding: 5px 0; }
.transfer-log__item + .transfer-log__item { border-top: 1px solid #f5f6f8; }
.transfer-log__from { color: #9098a3; }
.transfer-log__to { color: #2b323d; font-weight: 600; }
.transfer-log__arrow { margin: 0 4px; color: #c3c9d2; }
.transfer-log__meta { color: #9098a3; font-size: 11.5px; }

/* 订单列表的刷新按钮：图标 + 文字，刷新中图标转圈 */
.refresh-ico { vertical-align: -1px; }
.refresh-ico.spin { animation: list-refresh-spin .8s linear infinite; }
.refresh-ico__text { margin-left: 5px; }
@keyframes list-refresh-spin { to { transform: rotate(360deg); } }

/* 快捷筛选标签行：跟在工具栏下面单独一行，避免把时间区间那组挤变形 */
.chips-row { display: flex; align-items: center; gap: 8px; margin: -4px 0 12px; }

/* 快捷筛选标签行：跟在工具栏下面单独一行，避免把时间区间那组挤变形 */
.chips-row { display: flex; align-items: center; gap: 8px; margin: -4px 0 12px; }

/* 取消来源筛选标签：可点切换，选中用实心红 */
.cancel-tabs { display: flex; align-items: center; gap: 8px; }
.cancel-tabs__item { cursor: pointer; user-select: none; font-weight: 500; }
.cancel-tabs__item:hover { opacity: .82; }
/* 取消组与转让组之间拉一条细线，表示这是两个维度 */
.cancel-tabs__sep { width: 1px; height: 16px; background: #e6e9ef; margin: 0 2px; }
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

.manual-order-alert { margin-bottom: 18px; }
.manual-order-form :deep(.el-form-item) { margin-bottom: 16px; }
.manual-order-form :deep(.el-form-item__content) { min-width: 0; flex-wrap: wrap; }
.manual-order-goods-meta { width: 100%; margin-top: 5px; color: #606a78; font-size: 12px; line-height: 1.6; }
.manual-order-meta-sep { margin: 0 7px; color: #c0c4cc; }
.manual-order-hint { margin-left: 10px; color: #9098a3; font-size: 12px; line-height: 1.5; }
.manual-order-money { color: #303643; font-variant-numeric: tabular-nums; }
.manual-order-pay-total { color: #d4380d; font-size: 16px; font-weight: 650; font-variant-numeric: tabular-nums; }
@media (max-width: 640px) {
  .manual-order-form :deep(.el-form-item__label) { text-align: left; }
  .manual-order-hint { width: 100%; margin: 5px 0 0; }
}

/* 回收页：自动扫描状态提示 */
.auto-refresh-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-right: 10px;
  padding: 2px 8px;
  border-radius: 20px;
  background: #f2f5f9;
  color: #8c93a0;
  font-size: 12px;
}
.auto-refresh-hint::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
  animation: auto-scan-pulse 1.8s infinite;
}

/* 提前抢购弹窗 */
.advance-field { width: 100%; }
.advance-row { display: flex; align-items: center; gap: 8px; }
.advance-quick { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.advance-tip {
  margin-top: 4px;
  padding: 10px 12px;
  border-radius: 9px;
  background: #f7f8fa;
  color: #626a76;
  font-size: 12px;
  line-height: 1.7;
}
.advance-tip b { color: #c9351f; }

/* 详情富文本的工具栏：插入图片 + 一句说明，避免运营以为必须手写 HTML */
.rich-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.rich-tools__tip { color: #9098a4; font-size: 11.5px; line-height: 1.5; }
.rich-file { display: none; }

.auto-scan-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  background: #eefaf3;
  color: #1f9d5f;
  font-size: 12.5px;
}
.auto-scan-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.6);
  animation: auto-scan-pulse 1.8s infinite;
}
@keyframes auto-scan-pulse {
  0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.55); }
  70% { box-shadow: 0 0 0 7px rgba(34, 197, 94, 0); }
  100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
}

/* 星期多选（场次开放日期等） */
.days-field { display: flex; gap: 6px; flex-wrap: wrap; }

/* 商品编辑：横向双列网格（图片 / 图集 / 富文本通栏） */
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: 22px;
  align-items: start;
}
.form-grid .is-wide { grid-column: 1 / -1; }
.form-grid :deep(.el-form-item) { margin-bottom: 16px; }
.form-grid .is-wide :deep(.el-textarea__inner) { min-height: 110px; }
.form-grid :deep(.el-form-item__label) { color: #6b7280; }

/* 涨幅水位：一根绿→黄→红的色标，白点标出当前价的位置 */
.capbar { display: inline-flex; align-items: center; gap: 8px; width: 100%; }
.capbar__track {
  position: relative;
  flex: 1 1 auto;
  min-width: 56px;
  height: 8px;
  border-radius: 5px;
  /* 淡色刻度：整条只是「量程」，真正刺眼的是文字与圆点，避免绿色商品也看着像红灯 */
  background: linear-gradient(90deg, rgba(22, 163, 74, 0.35) 0%, rgba(234, 179, 8, 0.35) 55%, rgba(239, 68, 68, 0.4) 100%);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.05);
}
.capbar__dot {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #2b3040;
  transform: translate(-50%, -50%);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
  transition: left 0.2s;
}
.capbar__text { font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; color: #6b7280; }
.capbar__text em { font-style: normal; color: #a8adb7; }
.capbar__text--green { color: #16a34a; }
.capbar__text--yellow { color: #b45309; }
.capbar__text--orange { color: #ea580c; }
.capbar__text--red { color: #dc2626; font-weight: 600; }
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
