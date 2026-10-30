import axios from 'axios';
import { showToast } from 'vant';

const http = axios.create({
  baseURL: '/api',
  timeout: 20000,
  headers: { Version: '102' },
});

http.interceptors.request.use((cfg) => {
  const token = localStorage.getItem('TOKEN');
  if (token) cfg.headers.token = token;
  return cfg;
});

http.interceptors.response.use(
  (res) => {
    const d = res.data;
    if (d && d.code === 1) return d;
    if (d && d.code === -1) {
      localStorage.removeItem('TOKEN');
      showToast(d.msg || '请先登录');
      if (location.hash !== '#/login') {
        setTimeout(() => (location.hash = '#/login'), 600);
      }
      return Promise.reject(d);
    }
    showToast(d?.msg || '请求失败');
    return Promise.reject(d);
  },
  (err) => {
    showToast('网络异常，请稍后重试');
    return Promise.reject(err);
  },
);

export const api = {
  // 首页
  banner: (type_id = 1) => http.get('/index/getBannerList', { params: { type_id } }),
  navs: () => http.get('/index/getNavLists'),
  storeInfo: () => http.get('/index/getStoreInfo'),
  shareInfo: () => http.get('/index/getShareInfo'),
  invitePoster: () => http.get('/index/getInvitePoster'),
  invitationNotice: () => http.get('/index/getInvitationNotice'),
  registerAgreements: () => http.get('/index/getRegisterAgreements'),
  openNav: () => http.get('/index/getOpenNavigation'),
  notices: () => http.get('/notice/getNotice'),
  tradeConfig: () => http.get('/index/getTradeConfig'),

  // 商品
  categories: () => http.get('/goods/getCategory'),
  lootList: () => http.get('/goods/getLootList'),
  lootGoods: (p) => http.get('/goods/getLootGoodsList', { params: p }),
  lootDetail: (id) => http.get('/goods/getLootDetails', { params: { goods_id: id } }),
  categoryGoods: (p) => http.get('/goods/category/getCategoryGoodsList', { params: p }),
  searchShop: (p) => http.get('/goods/searchShop', { params: p }),
  shopDetail: (id) => http.get('/goods/shopgoods/getDetails', { params: { goods_id: id } }),
  scoreShop: (p) => http.get('/score/getScoreShopList', { params: p }),
  scoreExchange: (goodsId) => http.post('/score/exchange', { goods_id: goodsId }),
  myShop: () => http.get('/member/myShop'),

  // 会员
  login: (d) => http.post('/member/accountLogin', d),
  register: (d) => http.post('/member/registerAnAccount', d),
  me: () => http.get('/member/getMemberDetails'),
  editMember: (d) => http.post('/member/editMember', d),
  editPwd: (d) => http.post('/member/editPwd', d),
  indirection: () => http.get('/member/getMyIndirection'),
  teamStats: () => http.get('/member/getMyTeamStats'),
  eCardList: () => http.get('/member/getECardList'),
  financial: () => http.get('/member/financialData'),
  personProfit: () => http.get('/member/personProfit'),
  payPwdStatus: () => http.get('/member/getIsPayPassword'),
  setPay: (d) => http.post('/member/setPay', d),

  // 订单
  addOrder: (d) => http.post('/order/toAddOrder', d),
  payOrder: (d) => http.post('/order/toPay', d),
  orders: (p) => http.get('/order/getOrder', { params: p }),
  orderDetail: (id) => http.get('/order/detail', { params: { order_id: id } }),
  cancelOrder: (d) => http.post('/order/cancel', d),
  receipt: (d) => http.post('/order/receipt', d),
  express: (id) => http.get('/order/express', { params: { order_id: id } }),
  consignment: (d) => http.post('/order/consignment', d),
  consignmentQuote: (order_id) => http.get('/order/getConsignmentQuote', { params: { order_id } }),
  serviceCharge: (id) => http.get('/order/getServiceCharge', { params: { goods_id: id } }),
  mySettle: () => http.get('/order/mySettle'),
  settleVoucher: (d) => http.post('/order/settleVoucher', d),
  settleConfirm: (d) => http.post('/order/settleConfirm', d),

  // 财务
  amountInfo: () => http.get('/finance/getAmountInfo'),
  systemInfo: () => http.get('/finance/getSystemInfo'),
  withdraw: (d) => http.post('/finance/withdraw/apply', d),
  withdrawList: () => http.get('/finance/withdraw/list'),

  // 地址
  addressList: () => http.get('/member/address/list'),
  addressDetail: (id) => http.get('/member/address/detail', { params: { address_id: id } }),
  addressAdd: (d) => http.post('/member/address/add', d),
  addressEdit: (d) => http.post('/member/address/edit', d),
  addressRemove: (d) => http.post('/member/address/remove', d),

  // 卡
  cardList: () => http.get('/member/card/cardList'),
  cardAdd: (d) => http.post('/member/card/add', d),
  cardRemove: (d) => http.post('/member/card/remove', d),

  // 实名
  certify: (d) => http.post('/member/certification/addRealName', d),
  certifyStatus: () => http.get('/member/certification/getIsRealName'),

  // 地区
  regions: () => http.get('/region/getAllList'),

  upload: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post('/upload/image', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
};

export default http;
