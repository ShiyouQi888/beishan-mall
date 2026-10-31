import Layout from './layout/Layout.vue';

const list = (path, name, module, title, extra = {}) => ({
  path,
  name,
  component: () => import('./views/ListPage.vue'),
  meta: { title, module, permissionPath: path, ...extra },
});

export default [
  { path: '/login', name: 'login', component: () => import('./views/Login.vue'), meta: { title: '登录' } },
  {
    path: '/',
    component: Layout,
    children: [
      { path: '', name: 'dashboard', component: () => import('./views/Dashboard.vue'), meta: { title: '控制面板', permissionPath: '/' } },
      // 抢购商品与商城商品已合并为统一的「商品管理」：商品不再自带场次，
      // 归属哪个场次由「抢购场次 → 关联商品」决定。旧地址仍可访问，避免收藏夹失效。
      list('/goods', 'goods', 'goods', '商品管理'),
      { path: '/shop-goods', redirect: '/goods' },
      list('/category', 'category', 'category', '商品分类'),
      list('/specialarea', 'specialarea', 'specialarea', '抢购场次'),
      list('/score-goods', 'scoreGoods', 'scoreItem', '积分商品'),
      { path: '/specialarea/:id', name: 'specialareaConfig', component: () => import('./views/SpecialareaConfig.vue'), meta: { title: '抢购专场配置', permissionPath: '/specialarea' } },
      list('/orders', 'orders', 'orders', '全部订单'),
      // 转拍订单是专门页面（要按今日/昨日/周/月/自定义筛选），不走通用 ListPage
      { path: '/transpose', name: 'transpose', component: () => import('./views/TransposeOrders.vue'), meta: { title: '转拍订单', permissionPath: '/transpose' } },
      list('/orders/shop', 'ordersShop', 'orders', '商城订单', { fixed: { type: 3 }, title: '商城订单' }),
      list('/score-exchange', 'scoreExchange', 'scoreExchange', '积分兑换'),
      list('/recycle', 'recycle', 'recycle', '系统回收'),
      list('/delivery', 'delivery', 'delivery', '运费模板'),
      { path: '/finance-board', name: 'financeBoard', component: () => import('./views/FinanceBoard.vue'), meta: { title: '财务大盘', permissionPath: '/finance-board' } },
      { path: '/media', name: 'media', component: () => import('./views/MediaLibrary.vue'), meta: { title: '文件管理', permissionPath: '/media' } },
      list('/energy', 'energy', 'energy', '佣金记录'),
      list('/member', 'member', 'member', '会员列表'),
      list('/certification', 'certification', 'certification', '实名认证'),
      list('/banner', 'banner', 'banner', '广告管理'),
      list('/navigation', 'navigation', 'navigation', '菜单配置'),
      list('/notice', 'notice', 'notice', '公告管理'),
      list('/storeuser', 'storeuser', 'storeuser', '管理员'),
      list('/role', 'role', 'role', '角色管理'),
      { path: '/setting/danger', name: 'dangerZone', component: () => import('./views/DangerZone.vue'), meta: { title: '数据清除', permissionPath: '/setting/danger' } },
      { path: '/setting/:group', name: 'setting', component: () => import('./views/SettingPage.vue'), meta: { title: '系统设置' } },
    ],
  },
  { path: '/forbidden', name: 'forbidden', component: () => import('./views/AccessDenied.vue'), meta: { title: '无权访问' } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];
