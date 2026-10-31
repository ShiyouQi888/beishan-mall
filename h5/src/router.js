// 只有首页和登录/注册页对游客开放，其余全部要求登录。
// 判据在 main.js 的守卫里：to.meta.auth !== false 就需要 token，
// 所以「公开」是一个要显式声明的例外，不写就是需要登录。
export default [
  { path: '/', name: 'home', component: () => import('./views/Home.vue'), meta: { auth: false, tab: true } },
  { path: '/loot', name: 'loot', component: () => import('./views/Loot.vue'), meta: { tab: true } },
  { path: '/category', name: 'category', component: () => import('./views/Category.vue'), meta: { tab: true } },
  { path: '/search', name: 'search', component: () => import('./views/Search.vue'), meta: { tab: true } },
  { path: '/goods/:id', name: 'goods', component: () => import('./views/GoodsDetail.vue'), meta: { hideTab: true } },
  { path: '/submit/:id', name: 'submit', component: () => import('./views/Submit.vue'), meta: { hideTab: true } },
  { path: '/order', name: 'order', component: () => import('./views/OrderList.vue') },
  { path: '/order/detail/:id', name: 'orderDetail', component: () => import('./views/OrderDetail.vue'), meta: { hideTab: true } },
  { path: '/mine', name: 'mine', component: () => import('./views/Mine.vue'), meta: { tab: true } },
  { path: '/my-shop', name: 'myShop', component: () => import('./views/MyShop.vue') },
  { path: '/login', name: 'login', component: () => import('./views/Login.vue'), meta: { auth: false, hideTab: true } },
  { path: '/register', name: 'register', component: () => import('./views/Register.vue'), meta: { auth: false, hideTab: true } },
  { path: '/invite', name: 'invite', component: () => import('./views/Invite.vue'), meta: { tab: true } },
  { path: '/team', name: 'team', component: () => import('./views/Team.vue') },
  { path: '/commission', name: 'commission', component: () => import('./views/Commission.vue') },
  { path: '/wallet', name: 'wallet', component: () => import('./views/Wallet.vue') },
  { path: '/address', name: 'address', component: () => import('./views/Address.vue'), meta: { hideTab: (route) => route.query.select === '1' } },
  { path: '/address/edit', name: 'addressEdit', component: () => import('./views/AddressEdit.vue'), meta: { hideTab: (route) => route.query.select === '1' } },
  { path: '/identify', name: 'identify', component: () => import('./views/Identify.vue') },
  { path: '/score', name: 'score', component: () => import('./views/ScoreShop.vue') },
  { path: '/score/records', name: 'scoreRecords', component: () => import('./views/ScoreRecords.vue') },
  { path: '/setting', name: 'setting', component: () => import('./views/Setting.vue') },
  { path: '/notice', name: 'notice', component: () => import('./views/Notice.vue') },
  // 兜底：没匹配上的地址（含已下线的 /withdraw）回首页，别留白屏
  { path: '/:pathMatch(.*)*', redirect: '/' },
];
