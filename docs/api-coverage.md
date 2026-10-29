# 后台接口覆盖对照表

> 原站后台接口清单从 32 个页面 HTML 中提取（`BASE_URL + 'action'`、`url:`、`href` 三种来源），共 **30 个控制器 / 125 个接口**。
> 我方实现为「模块注册表 + 通用 CRUD」，因此原站各模块的 `index`/`add`/`h`/`remove`/`renew`/`details` 由 4 个通用接口统一覆盖。

图例：✅ 已实现 ｜ ⚠️ 部分实现/语义不同 ｜ ❌ 未实现

---

## 一、通用 CRUD（原站 ~60 个接口 → 我方 4 个）

| 原站接口族 | 覆盖情况 |
|---|---|
| `*/index`、`*/add`、`*/h`、`*/remove`、`*/renew`、`*/details` | ✅ `/:module/list`、`/:module/save`、`/:module/remove`、`/:module/detail` |
| `order.*/all_list`、`*_list`（按状态筛选） | ✅ 通用 list + `status` 筛选 |
| `member.certification/upstatus` | ✅ `/certification/audit` |
| `finance.withdraw/reviewstatus` | ✅ `/withdraw/audit` |
| `upload/originalupload` | ✅ `/api/upload/image` |
| `login/logout` | ✅ 前端清 token |

---

## 二、控制面板

| 原站 | 功能 | 状态 |
|---|---|---|
| `index/index` | 控制面板 | ✅ `/dashboard` |
| `index/todayorderdetail` | 今日订单明细 | ✅ `/stats/today-orders` |
| `index/test` | 调试 | — 不需要 |

---

## 三、商品

| 原站 | 功能 | 状态 |
|---|---|---|
| `goods.goods/getstatistics` | 商品金额统计（总量/上架/下架/流拍） | ✅ `/stats/goods` + 列表页统计卡片 |
| `goods.goods/operation` | 批量操作 | ⚠️ 仅单条编辑 |
| `goods.split/getstatistics` | 拆分商品统计 | ✅ 复用 `/stats/goods`（含拆分库存折算） |
| `goods.shop/*` | 商城商品（独立菜单） | ⚠️ 合并在 goods 模块，无独立入口 |

---

## 四、订单

| 原站 | 功能 | 状态 |
|---|---|---|
| `order.order/details` | 订单详情 | ✅ |
| `order.order/importorder` | 导入订单 | ✅ `/orders/import`（逐行校验，失败行返回原因） |
| `order.order/setnumsplitorder` | 拆分订单 | ✅ `/orders/split` |
| `order.order/team_list`、`team_failed` | 团队/拼团订单 | ✅ `/member/team-orders` |
| `order.consignment/informant_list` | **举报列表** | ✅ `report` 模块 + `/report/audit` |
| `order.goods/set_goods_order` | 设置寄买订单 | ✅ `/orders/set-goods-order` |
| `order.goods/toreleaseorder` | 释放订单 | ✅ 流拍释放 + 指派订单 |
| `order.streambeat/assignorder`、`toassignorder`、`getmemberlist` | **指派订单** | ✅ `/streambeat/assign`、`/streambeat/members` |

---

## 五、财务（大中小账）

| 原站 | 功能 | 状态 |
|---|---|---|
| `order.pay/large`、`medium`、`small` | 三类账目列表 | ✅ `/settle/*`（差价结算，语义已对齐） |
| `order.pay/generate_pay_large`、`medium`、`small` | 生成三类账目 | ✅ `/settle/run` |
| `order.pay/grant_drive_award` | **发放直推奖** | ✅ `/award/grant`（支持补发，自动防重复） |
| `order.pay/updatepaystatus` | 更新支付状态 | ✅ `/orders/confirm-pay` |
| `order.pay/upload_voucher` | 上传凭证 | ⚠️ 仅 H5 端，后台可通过「确认收款」代操作 |
| `order.pay/yjf_sell` | 疑似"业绩分卖出" | ❌ 未确认语义 |
| `finance.energy/index` | 佣金记录 | ✅ `energy` 模块 |
| `finance.withdraw/index` | 提现审核 | ✅ |

---

## 六、会员

| 原站 | 功能 | 状态 |
|---|---|---|
| `member.member/advance` | **提前抢购**授权 | ✅ `/member/advance` |
| `member.member/clearcommission` | 清除佣金 | ✅ `/member/clear-commission`（记负数流水留痕） |
| `member.member/energyclear` | 能量值清零 | ❌ 待补 |
| `member.member/energyrecord` | 佣金发放记录 | ✅ `/member/energy-record`（支持全局汇总/单个会员） |

---

## 七、系统设置

| 原站 | 功能 | 状态 |
|---|---|---|
| `setting/store`、`trade`、`pay`、`auction` | 基础配置 | ✅ |
| `setting/grade` | 会员等级配置 | ✅ 落在 `member_grade` 模块（后台「会员等级」页），**不再重复做协议组** |
| `setting/specialarea` | 抢购专场配置 | ✅ 独立页面 |
| `setting/notice` | 公告 | ✅ `notice` 模块 |
| `setting/poster` | **海报配置** | ✅ `/setting/poster` |
| `setting/prompt` | **须知配置** | ✅ `/setting/prompt`（注册协议/邀请/商城/交易/抢购/转拍/提现 共 7 项，已合并原「协议与须知」） |
| `setting/sms` | 短信配置 | ❌ 未做（无短信通道） |
| `setting/storage` | **上传配置** | ✅ `/setting/storage` |
| `setting.cache/clear` | 清除缓存 | ✅ `/cache/clear`（WAL checkpoint + optimize） |
| `setting.delivery/index` | **运费模板** | ✅ `delivery` 模块（按件/按重量计费） |
| `store.node/*` | **权限节点** | ✅ 节点管理页 + 角色分配 + 菜单过滤 |

---

## 八、微信 / 分销商

| 原站 | 功能 | 状态 |
|---|---|---|
| `wx.app/index`、`wx.pay/pay_index`、`wx.wx/wx_index` | 微信配置 | ❌ 未接入支付，暂不做 |
| `apps.dealer.withdraw/wechat_pay` | 分销商微信提现 | ❌ 同上 |

---

## 九、汇总

| 状态 | 数量 | 说明 |
|---|---|---|
| ✅ 已实现 | ~78 | 含通用 CRUD 覆盖的 ~60 个接口族 |
| ⚠️ 部分/语义不同 | 3 | 见备注 |
| ❌ 未实现 | 5 | 仅剩短信与微信支付相关 |

### 本轮已补齐（2026-10-29）

新增 10 个接口 + 3 个后台页面/模块：

| 接口 | 页面 |
|---|---|
| `/stats/goods`、`/stats/today-orders`、`/sysinfo` | 商品列表顶部统计卡片 |
| `/member/advance`、`/member/clear-commission`、`/member/energy-record` | 会员列表操作 |
| `/award/grant` | 订单补发直推奖 |
| `/streambeat/assign`、`/streambeat/members` | 流拍订单指派 |
| `/cache/clear` | — |
| `/report/audit` | 举报处理（新菜单） |
| `delivery` 模块 | 运费模板（新菜单） |

同时把 H5 举报从「写订单日志」改为写入独立 `order_report` 表，后台可审核。

### 下一轮已补齐（菜单单一数据源 / 权限收口）

新增 6 个接口 + 3 个后台页面：

| 接口 | 页面 |
|---|---|
| `GET /menu` | 后台侧边栏（服务端按权限过滤后下发，含图标） |
| `GET/POST /role/nodes` | 角色管理 → 分配权限 |
| `GET /node/tree` | 节点管理 |
| `POST /orders/import` | 订单导入 |
| `POST /orders/split` | 后台拆分订单 |
| `GET /member/team-orders` | 团队订单视图 |
| `POST /orders/set-goods-order` | 设置寄买订单 |
| `GET/POST /setting/storage`、`/setting/poster`、`/setting/prompt` | 上传配置 / 海报配置 / 须知配置 |

商品列表支持 `type=1|2` 过滤，抢购商品与商城商品拆成两个菜单。

### 路径对齐与前端健壮性（同一轮）

| 问题 | 处理 |
|---|---|
| 积分商城接口挂在 `/api/goods/score/`，而 H5 按原站控制器调 `/api/score/` → 404 | 拆出独立控制器 `routes/score.js` 挂载到 `/api/score`，原路径下线 |
| 列表经 `fmtGoods` 格式化后丢失 `score_price`/`score_stock`，积分商品永远显示不出兑换分、兑换按钮恒可点 | 在 score.js 里显式补回这两个字段 |
| 订单详情 / 确认订单在接口返回业务失败时静默渲染空对象 → 金额显示 `¥NaN`、空商品页可提交 | 前端校验 `code !== 1` 或缺少主键时提示并回退，按钮禁用，不再出现 `NaN` |
| `router.back()` 在直接打开链接（无历史记录）时是空操作 | 改为显式 `router.replace()` 到列表页 |

### 补做优先级

**P0 / P1 / P2 全部完成。**

### 仅剩未做（5 个，均依赖外部服务）

| 接口 | 原因 |
|---|---|
| `setting/sms` | 短信配置需接入短信服务商，无通道 |
| `wx.app`、`wx.pay/wx_index`、`wx.wx/wx_index` | 微信支付/公众号需商户号与备案域名 |
| `apps.dealer.withdraw/wechat_pay` | 同上 |

### 抢单服务费（新一轮）

原站有 `/order/getServiceCharge`、`/order/toServiceCharge` 两个接口和 `orders.service_charge` 字段，
但之前这三处口径互不相干：下单写死 0、查询接口按配置算、H5 展示读商品详情字段，后台也没有配置入口。

现已统一为一份（`lib/helper.js`）：

| 项 | 说明 |
|---|---|
| 配置键 | `service_charge`（交易设置 → 抢单服务费(%)，默认 **0**） |
| 计算 | `calcServiceCharge(总额)` = 总额 × 费率，两位小数 |
| 承担方 | **买家额外承担**：实付 = 商品总额 + 服务费；卖家仍收商品全额，服务费不进卖家口袋 |
| 生效范围 | 仅抢购单（type=1）；转拍/寄卖走 2.8% 上架费，不叠加服务费 |
| 一致性 | 下单落库、`/order/getServiceCharge`、`/order/toServiceCharge`、商品详情 `service_charge_rate` 全部同源 |

默认 0 与原站实证一致（抢购环节平台不收费，平台收入来自转拍上架费），
配了费率才收；两个查询接口现在支持 `num`，按「单价×数量」算，与多件下单口径一致。

### 权限节点实现说明

菜单只有一个数据源：`server/src/lib/menu.config.js`（8 分组 / 33 菜单项，含 SVG 图标）。
后台侧边栏、路由权限校验、权限节点表**全部由它派生**，新增菜单只需改这一处 + 前端路由。

- 节点由 `lib/nodes.js` 的 `ensureNodes()` 在服务启动时按菜单结构**幂等同步**（41 个节点：8 分组 + 33 菜单）
- 启动时同时做两项清理：下线菜单对应的节点 + 指向已不存在角色的孤儿权限绑定（`store_role_node`），
  避免将来新建同 ID 角色凭空继承历史权限
- 节点以「前端路由 path」作为 `action_name`，前端可直接按路由过滤菜单
- 角色 → 节点为多对多（`store_role_node`）
- 登录后 `GET /my-paths` 返回可访问路由集合；超级管理员（role_id=6）返回 `unrestricted: true`，
  且其权限**不可被修改**（`POST /role/nodes` 对 role_id=6 直接拒绝，不存在的角色也拒绝）
- `GET /menu` 在服务端完成权限过滤后再下发，前端不再持有菜单副本，也拿不到无权限的菜单
- 后台「权限管理 → 节点管理」查看节点树，「角色管理 → 分配权限」勾选（支持分组半选）

### 后台角色 vs 会员等级（已分离）

原实现把会员等级（普通/银卡/金卡/铂金/钻石）塞进了 `store_role`，导致后台账号若沿用旧 role_id
会指向一个不存在的角色，表现为「登录成功但菜单空白」。现已拆开：

| 表 | 内容 |
|---|---|
| `store_role` | 仅后台角色：`6 超级管理员` / `7 运营` |
| `member_grade` | 仅会员等级：5 档，可后台动态维护 |

**不做**
- `wx.*`、`apps.dealer.*`：未接入真实支付通道
- `index/test`：调试接口
