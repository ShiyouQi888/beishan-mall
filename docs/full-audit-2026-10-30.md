# 北山商城全量审计

日期：2026-10-30  
范围：Express/SQLite 服务端、管理后台、H5、共享上传/富文本组件、Docker 与环境配置。检查以当前工作区代码为准；没有连接或修改线上环境和真实账务数据。

## 结果摘要

- **严重 1 项**：生产 Docker 默认值允许用公开的 JWT 密钥伪造管理员身份，并提供默认超级管理员口令。
- **高 8 项**：角色权限自我扩张、地址越权读取、后台未扣买家余额就可确认成交、提现台账可改后触发退款、商城商品走错订单类型、商品类型权限可伪造、敏感上传文件公开访问、取消订单仍可付款。
- **中 3 项**：停用场次仍可直接下单、会员改密码无需旧密码、接口缺少登录/上传限流与文件配额。
- **未发现已知依赖漏洞**：对 server、admin、h5 执行 npm audit（官方 npm registry），结果均为 0 条已知漏洞。

## 严重

### A-01 生产配置默认使用公开 JWT 密钥和管理员密码

`docker-compose.yml` 默认 `NODE_ENV=production`，但没有 `.env` 时仍会设置 `JWT_SECRET=please-change-this-secret`、`ADMIN_PASSWORD=123456`。JWT 密钥在仓库中公开，攻击者可自行签发 `scope=admin` token；默认口令也能直接登录全权限管理员。服务启动时没有在生产模式拒绝这些值。

证据：[docker-compose.yml:32](../docker-compose.yml#L32)、[docker-compose.yml:36](../docker-compose.yml#L36)、[auth.js:20](../server/src/lib/auth.js#L20)、[builtinAdmin.js:14](../server/src/lib/builtinAdmin.js#L14)。

建议：生产环境缺少强随机密钥或强管理员密码时直接拒绝启动；开发默认值只能用于开发模式。轮换密钥前需安排现有 token 失效和重新登录。

## 高

### A-02 有角色管理权限的管理员可给自己的角色授予任意菜单权限

`/role/nodes` 只要求当前角色有 `/role` 权限；保存时允许把任意节点绑定到任意非超管角色，没有限制“只能分配自己已有的权限”。管理员可将危险设置、财务、会员等节点加给自己的角色，下一次请求即可使用这些接口。

证据：[helper.js:66](../server/src/lib/helper.js#L66)、[extra.js:454](../server/src/routes/admin/extra.js#L454)、[extra.js:459](../server/src/routes/admin/extra.js#L459)、[nodes.js:119](../server/src/lib/nodes.js#L119)。

建议：非超管只能管理授权范围内的节点，禁止自我提权；对角色权限变更写入操作者、旧权限和新权限审计记录。

### A-03 订单可绑定他人地址并读取完整收货信息

下单接口直接保存客户端传来的 `address_id`，没有验证地址属于当前会员。订单详情只验证订单参与者，随后只按地址 ID 查询记录。因此会员可在自己的订单中指定猜到的他人地址 ID，再通过自己的订单详情读取姓名、手机号和详细地址。

证据：[order.js:81](../server/src/routes/order.js#L81)、[order.js:147](../server/src/routes/order.js#L147)、[order.js:298](../server/src/routes/order.js#L298)。

建议：创建订单时验证 `address_id` 属于当前会员；详情查询同时约束地址所有者，并只返回订单展示需要的字段。

### A-04 后台可确认余额订单而不扣买家余额

订单列表对所有待处理订单显示“确认收款”。确认接口没有要求支付方式必须是线下方式；余额订单会跳过凭证检查，直接将订单标记已支付并调用 `settleOrder`，但没有扣买家余额。结果是卖家收到货款、商品转移，买家余额保持不变。

证据：[ListPage.vue:177](../admin/src/views/ListPage.vue#L177)、[admin/index.js:1201](../server/src/routes/admin/index.js#L1201)、[admin/index.js:1206](../server/src/routes/admin/index.js#L1206)、[admin/index.js:1231](../server/src/routes/admin/index.js#L1231)。

建议：余额支付只能走原子扣款流程；后台确认收款接口仅接受配置允许的线下支付方式，并同时校验订单状态。

### A-05 提现台账允许改会员和金额，拒绝后按修改值退款

通用提现保存接口把 `member_id`、`amount`、`fee`、`actual_amount`、`status` 当作可编辑字段。提现拒绝逻辑会把当前记录中的 `amount` 加回当前 `member_id`。拥有提现菜单权限的人可先更改对象或金额，再拒绝申请，从而给指定会员增加余额。

证据：[admin/index.js:251](../server/src/routes/admin/index.js#L251)、[admin/index.js:256](../server/src/routes/admin/index.js#L256)、[admin/index.js:926](../server/src/routes/admin/index.js#L926)、[admin/index.js:1291](../server/src/routes/admin/index.js#L1291)、[admin/index.js:1300](../server/src/routes/admin/index.js#L1300)。

建议：提现金额、会员、手续费、实付金额和账户信息创建后只读；仅允许审核专用接口变更状态，并确保审核与退款使用不可变的申请快照。

### A-06 H5 商城商品也被创建成“抢购单”

商品详情页支持商城商品回退查询，确认订单页也可以加载 `type=2` 商品，但下单接口始终写入 `orders.type=1`。普通商城商品因此进入抢购成交/转拍逻辑；非拆分库存没有在下单时扣减，预期的商城库存和履约流程无法保证。

证据：[GoodsDetail.vue:132](../h5/src/views/GoodsDetail.vue#L132)、[Submit.vue:156](../h5/src/views/Submit.vue#L156)、[Submit.vue:200](../h5/src/views/Submit.vue#L200)、[order.js:146](../server/src/routes/order.js#L146)、[schema.sql:190](../server/src/schema.sql#L190)、[schema.sql:208](../server/src/schema.sql#L208)。

建议：按商品类型走独立订单流程；商城单在服务端校验并原子扣库存，保存正确订单类型，再按商城履约状态流转。

### A-07 商品管理权限可通过伪造 `type` 跨到另一类商品

后台权限检查优先使用客户端提交的 `type`，而不是目标商品数据库中的真实类型。只拥有抢购商品权限的管理员可在编辑/删除商城商品时附带 `type=1`，通过权限检查。类型缺省的列表请求还可能返回两类商品。

证据：[helper.js:104](../server/src/lib/helper.js#L104)、[helper.js:105](../server/src/lib/helper.js#L105)、[helper.js:120](../server/src/lib/helper.js#L120)、[admin/index.js:926](../server/src/routes/admin/index.js#L926)。

建议：对 detail/save/remove 逐条从数据库取类型并校验；列表始终按角色权限添加服务端类型过滤。

### A-08 实名资料和付款凭证所在上传目录可匿名访问

实名图片和付款凭证保存在统一 `/uploads` 目录。素材库会将实名资料标为 private 并从列表排除，但 Express 静态文件服务仍直接公开同一目录，没有按文件或用户做鉴权。任何拿到文件 URL 的人都能直接读取证件和付款凭证。

证据：[member.js:413](../server/src/routes/member.js#L413)、[media.js:30](../server/src/routes/admin/media.js#L30)、[app.js:185](../server/src/app.js#L185)。

建议：私密文件存入非公开目录，通过校验会员/管理员权限的下载接口读取；不要依赖“素材库隐藏”作为访问控制。

### A-09 已取消的订单仍可调用付款接口

会员取消订单只把 `status` 设为 40；付款接口只检查 `pay_status`，余额支付更新语句也没有要求 `status=0`。已取消订单仍能被付款并改回 `status=10`。拆分商品订单取消后已归还库存，再付款时不会重新扣库存，可能出现库存和已售数量不一致。

证据：[order.js:200](../server/src/routes/order.js#L200)、[order.js:205](../server/src/routes/order.js#L205)、[order.js:229](../server/src/routes/order.js#L229)、[order.js:303](../server/src/routes/order.js#L303)。

建议：所有支付方式都要求订单仍处于待支付状态；状态更新和库存占用在同一事务内完成，取消与支付使用条件更新确保只能有一方成功。

## 中

### A-10 停用场次仍可通过详情/下单接口购买

后台场次有 `is_open` 开关，但下单和商品详情只检查星期与时段，没有检查场次是否启用。直接访问商品详情或调用下单 API 可绕过 H5 场次列表的过滤。另当 `end_time=0` 时 `timeOk` 永远为 true，未开始的场次也可下单。

证据：[specialarea 配置字段](../server/src/routes/admin/index.js#L84)、[order.js:108](../server/src/routes/order.js#L108)、[sessionWindow.js:50](../server/src/lib/sessionWindow.js#L50)。

建议：服务端统一校验 `is_open`；无结束时间时也必须检查当前时间不早于开始时间。

### A-11 会员改登录密码时可以省略旧密码

会员密码接口只在提供 `oldPwd` 时验证旧密码。持有有效登录 token 的人可以省略旧密码直接修改登录密码；密码修改后已有 token 也没有撤销机制，最多可继续有效 7 天。

证据：[member.js:133](../server/src/routes/member.js#L133)、[member.js:136](../server/src/routes/member.js#L136)、[auth.js:109](../server/src/lib/auth.js#L109)。

建议：强制校验旧密码或近期重新认证；密码变更后撤销该会员的旧会话/token。

### A-12 登录和上传接口没有限流或存储配额

没有发现登录、注册、上传接口的请求频率限制。图片单文件限制为 10 MB，但会员可重复上传，没有用户/全站配额或自动清理。可被用于密码猜测、注册滥用和磁盘耗尽；全站 JSON 请求体上限 20 MB，也会放大高并发内存压力。

证据：[member.js:17](../server/src/routes/member.js#L17)、[admin/index.js:348](../server/src/routes/admin/index.js#L348)、[uploadStorage.js:35](../server/src/lib/uploadStorage.js#L35)、[app.js:181](../server/src/app.js#L181)。

建议：按 IP/账号设置登录失败退避与限速；上传按账号限速、配额和生命周期清理；按实际业务降低 JSON 请求体上限。

## 构建与测试

- H5 `npm run build`：通过。
- 管理后台 `npm run build`：通过；Vite 提示主 JS chunk 约 1.14 MB，建议后续拆分以改善首屏加载。
- 服务端既有 core 测试：隔离临时数据库运行，**281 passed / 0 failed**。
- `npm audit`：server、admin、h5 均为 **0 vulnerabilities**。
- 没有针对线上数据、实际支付渠道或生产代理配置执行测试；上述风险以当前源码和仓库默认部署配置为依据。

## 本轮已修复的 H5 订单下一步

订单详情的付款申报成功后会进入“我的店铺”；接口返回“订单已支付”时也会进入店铺，避免旧页面继续显示重复提交。待线下确认时提示平台审核后才会入店。H5 构建已验证通过。改动位于 [OrderDetail.vue](../h5/src/views/OrderDetail.vue)。
