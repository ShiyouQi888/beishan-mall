// 后台菜单单一数据源：前端菜单、路由校验、权限节点都从这里派生
// 新增菜单：在此处加一项 + 在 admin/src/router.js 加对应路由即可

export const MENU = [
  {
    label: '概览',
    items: [
      {
        path: '/',
        title: '控制面板',
        icon: `<rect x="3" y="3" width="7.5" height="7.5" rx="1.6" stroke="currentColor" stroke-width="1.7"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" stroke="currentColor" stroke-width="1.7"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" stroke="currentColor" stroke-width="1.7"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" stroke="currentColor" stroke-width="1.7"/>`,
      },
    ],
  },
  {
    label: '产品管理',
    items: [
      {
        path: '/goods',
        title: '抢购商品',
        icon: `<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>`,
      },
      {
        path: '/shop-goods',
        title: '商城商品',
        icon: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none"><circle cx="9" cy="20" r="1.6" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="20" r="1.6" stroke="currentColor" stroke-width="1.7"/><path d="M3 4h2.5l2.2 10.4A1.6 1.6 0 0 0 9.4 16h8.3a1.6 1.6 0 0 0 1.6-1.2L21 8H7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
      },
      {
        path: '/category',
        title: '商品分类',
        icon: `<path d="M4 6h16M4 12h10M4 18h13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
      },
      {
        path: '/specialarea',
        title: '抢购场次',
        icon: `<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.7"/><path d="M12 7.5V12l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
      },
    ],
  },
  {
    label: '订单管理',
    items: [
      {
        path: '/orders',
        title: '全部订单',
        icon: `<rect x="4" y="3.5" width="16" height="17" rx="2.2" stroke="currentColor" stroke-width="1.7"/><path d="M8 9h8M8 13h8M8 17h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
      },
      {
        path: '/orders/consign',
        title: '寄卖订单',
        icon: `<path d="M3.5 8.5h17M6 8.5V19a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V8.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M9 8.5V6a3 3 0 0 1 6 0v2.5" stroke="currentColor" stroke-width="1.7"/>`,
      },
      {
        path: '/streambeat',
        title: '流拍订单',
        icon: `<path d="M12 3.5 3.5 8.5 12 13.5l8.5-5L12 3.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M4 15.5 12 20l8-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
      },
      {
        path: '/report',
        title: '举报处理',
        icon: `<path d="M12 3.5 21 20H3L12 3.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 10v4M12 17.2v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
      },
      {
        path: '/orders/shop',
        title: '商城订单',
        icon: `<circle cx="9" cy="20" r="1.6" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="20" r="1.6" stroke="currentColor" stroke-width="1.7"/><path d="M3 4h2.5l2.2 10.4A1.6 1.6 0 0 0 9.4 16h8.3a1.6 1.6 0 0 0 1.6-1.2L21 8H7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
      },
    ],
  },
  {
    label: '财务中心',
    items: [
      {
        path: '/settlement',
        title: '差价结算',
        icon: `<path d="M4 8h13l-3-3M20 16H7l3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
      },
      {
        path: '/settle',
        title: '结算账目',
        icon: `<rect x="3" y="5.5" width="18" height="13" rx="2.2" stroke="currentColor" stroke-width="1.7"/><path d="M3 10h18" stroke="currentColor" stroke-width="1.7"/><circle cx="7.5" cy="14.5" r="1.2" fill="currentColor"/>`,
      },
      {
        path: '/energy',
        title: '佣金记录',
        icon: `<path d="M4 19V9M9.5 19V5M15 19v-7M20.5 19v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
      },
      {
        path: '/withdraw',
        title: '提现审核',
        icon: `<path d="M12 4v11M7.8 11l4.2 4.2 4.2-4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 19.5h15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
      },
    ],
  },
  {
    label: '会员管理',
    items: [
      {
        path: '/member',
        title: '会员列表',
        icon: `<circle cx="12" cy="8" r="3.4" stroke="currentColor" stroke-width="1.7"/><path d="M4.8 20c.6-3.5 3.6-5.8 7.2-5.8s6.6 2.3 7.2 5.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
      },
      {
        path: '/member-grade',
        title: '会员等级',
        icon: `<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8L12 3.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>`,
      },
      {
        path: '/certification',
        title: '实名认证',
        icon: `<rect x="3" y="5" width="18" height="14" rx="2.2" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="11" r="2" stroke="currentColor" stroke-width="1.6"/><path d="M5.6 16.2c.4-1.5 1.7-2.4 3.4-2.4s3 .9 3.4 2.4" stroke="currentColor" stroke-width="1.6"/>`,
      },
    ],
  },
  {
    label: '运营管理',
    items: [
      {
        path: '/banner',
        title: '广告管理',
        icon: `<rect x="3" y="5" width="18" height="14" rx="2.2" stroke="currentColor" stroke-width="1.7"/><path d="m6 16 4-4.5 3 3 2.5-2.5L19 16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
      },
      {
        path: '/navigation',
        title: '菜单配置',
        icon: `<rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.7"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.7"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.7"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.7"/>`,
      },
      {
        path: '/notice',
        title: '公告管理',
        icon: `<path d="M4.5 9.5v5l11 4.5V5L4.5 9.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M18 9.5a3 3 0 0 1 0 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
      },
      {
        path: '/recharge',
        title: '充值套餐',
        icon: `<rect x="3" y="6" width="18" height="12" rx="2.2" stroke="currentColor" stroke-width="1.7"/><path d="M3 10h18M7 15h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
      },
    ],
  },
  {
    label: '系统设置',
    items: [
      {
        path: '/setting/store',
        title: '商城设置',
        icon: `<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7"/><path d="M12 3v2.4M12 18.6V21M4.2 12H1.8M22.2 12h-2.4M6.3 6.3 4.6 4.6M19.4 19.4l-1.7-1.7M6.3 17.7 4.6 19.4M19.4 4.6l-1.7 1.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
      },
      {
        path: '/setting/trade',
        title: '交易设置',
        icon: `<path d="M4 8h13l-3-3M20 16H7l3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
      },
      {
        path: '/setting/pay',
        title: '支付设置',
        icon: `<rect x="3" y="6" width="18" height="12" rx="2.2" stroke="currentColor" stroke-width="1.7"/><path d="M3 10.5h18" stroke="currentColor" stroke-width="1.7"/>`,
      },
      {
        path: '/delivery',
        title: '运费模板',
        icon: `<path d="M3 7h11v9H3V7Zm11 3h4l3 3v3h-7v-6Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="1.6" stroke="currentColor" stroke-width="1.7"/><circle cx="17" cy="18" r="1.6" stroke="currentColor" stroke-width="1.7"/>`,
      },
      {
        path: '/setting/auction',
        title: '竞拍设置',
        icon: `<path d="m5 19 4-4M9.5 5.5l9 9M14 4l6 6-2.5 2.5-6-6L14 4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>`,
      },
      {
        path: '/setting/storage',
        title: '上传配置',
        icon: `<path d="M12 16V4m0 0L7 9m5-5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
      },
      {
        path: '/setting/poster',
        title: '海报配置',
        icon: `<rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.7"/><circle cx="8.5" cy="9.5" r="1.6" stroke="currentColor" stroke-width="1.6"/><path d="m4 17 5-4 4 3 3-2 4 3" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>`,
      },
      {
        path: '/setting/prompt',
        title: '须知配置',
        icon: `<path d="M6 3.5h9l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8.5 12h7M8.5 16h4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
      },
      {
        path: '/setting/nav',
        title: '导航配置',
        icon: `<path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
      },
    ],
  },
  {
    label: '权限管理',
    items: [
      {
        path: '/storeuser',
        title: '管理员',
        icon: `<circle cx="12" cy="8" r="3.4" stroke="currentColor" stroke-width="1.7"/><path d="M4.8 20c.6-3.5 3.6-5.8 7.2-5.8s6.6 2.3 7.2 5.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
      },
      {
        path: '/node',
        title: '节点管理',
        icon: `<circle cx="6" cy="6" r="2.5" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="18" r="2.5" stroke="currentColor" stroke-width="1.7"/><path d="M8.5 6H14a4 4 0 0 1 4 4v5.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
      },
      {
        path: '/role',
        title: '角色管理',
        icon: `<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="currentColor" stroke-width="1.7"/><path d="M4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
      },
    ],
  },
];

/** 扁平化路径集合（供路由校验/权限比对） */
export const MENU_PATHS = MENU.flatMap((g) => g.items.map((i) => i.path));