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
      list('/goods', 'goods', 'goods', '抢购商品', { fixed: { type: 1 } }),
      list('/shop-goods', 'shopGoods', 'goods', '商城商品', { fixed: { type: 2 } }),
      list('/category', 'category', 'category', '商品分类'),
      list('/specialarea', 'specialarea', 'specialarea', '抢购场次'),
      { path: '/specialarea/:id', name: 'specialareaConfig', component: () => import('./views/SpecialareaConfig.vue'), meta: { title: '抢购专场配置', permissionPath: '/specialarea' } },
      list('/orders', 'orders', 'orders', '全部订单'),
      list('/orders/shop', 'ordersShop', 'orders', '商城订单', { fixed: { type: 3 }, title: '商城订单' }),
      list('/streambeat', 'streambeat', 'orders', '流拍订单', { fixed: { type: 5 }, title: '流拍订单' }),
      list('/report', 'report', 'report', '举报处理'),
      list('/delivery', 'delivery', 'delivery', '运费模板'),
      list('/settle', 'settle', 'settle', '结算账目'),
      { path: '/settlement', name: 'settlement', component: () => import('./views/Settlement.vue'), meta: { title: '差价结算', permissionPath: '/settlement' } },
      list('/energy', 'energy', 'energy', '佣金记录'),
      list('/withdraw', 'withdraw', 'withdraw', '提现审核'),
      list('/member', 'member', 'member', '会员列表'),
      list('/member-grade', 'memberGrade', 'grade', '会员等级'),
      list('/certification', 'certification', 'certification', '实名认证'),
      list('/banner', 'banner', 'banner', '广告管理'),
      list('/navigation', 'navigation', 'navigation', '菜单配置'),
      list('/notice', 'notice', 'notice', '公告管理'),
      list('/recharge', 'recharge', 'recharge', '充值套餐'),
      list('/storeuser', 'storeuser', 'storeuser', '管理员'),
      list('/role', 'role', 'role', '角色管理'),
      { path: '/node', name: 'node', component: () => import('./views/NodeManage.vue'), meta: { title: '节点管理' } },
      { path: '/setting/:group', name: 'setting', component: () => import('./views/SettingPage.vue'), meta: { title: '系统设置' } },
    ],
  },
  { path: '/forbidden', name: 'forbidden', component: () => import('./views/AccessDenied.vue'), meta: { title: '无权访问' } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];
