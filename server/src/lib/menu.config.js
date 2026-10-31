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
        title: '商品管理',
        icon: `<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>`,
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
      {
        path: '/score-goods',
        title: '积分商品',
        icon: `<path d="m12 3.2 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.7l6.1-.9L12 3.2Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>`,
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
        path: '/transpose',
        title: '转拍订单',
        icon: `<path d="M4 8h13l-3.2-3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 16H7l3.2 3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
      },
      {
        path: '/recycle',
        title: '系统回收',
        icon: `<path d="M20 12a8 8 0 1 1-2.3-5.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M20.5 4.5V9H16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 12a8 8 0 0 0 2.3 5.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M3.5 19.5V15H8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
      },
      {
        path: '/orders/shop',
        title: '商城订单',
        icon: `<circle cx="9" cy="20" r="1.6" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="20" r="1.6" stroke="currentColor" stroke-width="1.7"/><path d="M3 4h2.5l2.2 10.4A1.6 1.6 0 0 0 9.4 16h8.3a1.6 1.6 0 0 0 1.6-1.2L21 8H7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
      },
      {
        path: '/score-exchange',
        title: '积分兑换',
        icon: `<path d="M4 9h11l-3-3m3 3-3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 15H9l3 3m-3-3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
      },
    ],
  },
  {
    label: '财务中心',
    items: [
      {
        path: '/finance-board',
        title: '财务大盘',
        icon: `<path d="M3.5 20.5h17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M6.5 20V13M12 20V6.5M17.5 20v-4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="m4.5 9.5 5-4 4 2.5 5.5-4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
      },
      {
        path: '/energy',
        title: '资金流水',
        icon: `<path d="M4 19V9M9.5 19V5M15 19v-7M20.5 19v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
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
        path: '/media',
        title: '文件管理',
        icon: `<path d="M3.5 7.2A2.2 2.2 0 0 1 5.7 5h3.4l1.8 2.2h7.4a2.2 2.2 0 0 1 2.2 2.2v7.4a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V7.2Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m7 15.6 3-3.2 2.3 2.3 1.7-1.6 3 2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
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
      {
        path: '/setting/danger',
        title: '数据清除',
        icon: `<path d="M12 3.8 21 19.5H3L12 3.8Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 9.6v4.2M12 16.7v.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>`,
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
        path: '/role',
        title: '角色管理',
        icon: `<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="currentColor" stroke-width="1.7"/><path d="M4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
      },
    ],
  },
];

