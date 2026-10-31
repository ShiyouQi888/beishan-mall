import axios from 'axios';
import { ElMessage } from 'element-plus';

const http = axios.create({ baseURL: '/admin/api', timeout: 20000 });
http.interceptors.request.use((cfg) => {
  const t = localStorage.getItem('ADMIN_TOKEN');
  if (t) cfg.headers.token = t;
  return cfg;
});

http.interceptors.response.use(
  (res) => {
    // 二进制下载（订单导出）没有 { code } 外壳，直接返回整个响应
    if (res.config?.responseType === 'blob') return res;
    const d = res.data;
    if (d && d.code === 1) return d;
    if (d && d.code === -1) {
      localStorage.removeItem('ADMIN_TOKEN');
      if (location.hash !== '#/login') location.hash = '#/login';
      ElMessage.error(d.msg || '登录已失效');
      return Promise.reject(d);
    }
    if (!res.config?.silent) ElMessage.error(d?.msg || '请求失败');
    return Promise.reject(d);
  },
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('ADMIN_TOKEN');
      location.hash = '#/login';
    }
    if (!err.config?.silent) ElMessage.error(err.response?.data?.msg || '网络异常');
    return Promise.reject(err);
  },
);

/** 上传图片到素材库（带登录态，落库后可改名/分组） */
const adminUpload = (file, extra = {}) => {
  const fd = new FormData();
  fd.append('file', file);
  if (extra.group_id) fd.append('group_id', String(extra.group_id));
  if (extra.name) fd.append('name', extra.name);
  return http.post('/media/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
};

export const adminApi = {
  storeInfo: () => axios.get('/api/index/getStoreInfo').then((r) => r.data?.data || {}),
  login: (d) => http.post('/login', d),
  me: () => http.get('/me'),
  changePassword: (d) => http.post('/me/password', d),

  // ---- 数据清除 ----
  resetPlan: (scopes) => http.get('/system/reset/plan', { params: { scopes: (scopes || []).join(',') } }),
  resetData: (d) => http.post('/system/reset', d),
  // 转拍订单：正在挂牌等下一手买走的单子，支持今日/昨日/周/月/自定义
  transposeList: (params) => http.get('/transpose/list', { params }),
  transposeDetail: (id) => http.get('/transpose/detail', { params: { id } }),
  myPaths: () => http.get('/my-paths'),
  dashboard: () => http.get('/dashboard'),
  orderNotifications: (params) => http.get('/notifications/orders', { params, silent: true }),
  withdrawalNotifications: (params) => http.get('/notifications/withdrawals', { params, silent: true }),
  recycleNotifications: (params) => http.get('/notifications/recycles', { params, silent: true }),
  financeOverview: () => http.get('/finance/overview'),
  modules: () => http.get('/modules'),
  options: (name) => http.get(`/options/${name}`),
  batchCategoryHomeShow: (d) => http.post('/category/home-show-all', d),
  themes: () => http.get('/themes'),
  list: (mod, params) => http.get(`/${mod}/list`, { params }),
  detail: (mod, id) => http.get(`/${mod}/detail`, { params: { id } }),
  save: (mod, data) => http.post(`/${mod}/save`, data),
  remove: (mod, ids) => http.post(`/${mod}/remove`, { ids }),
  scoreDeliver: (d) => http.post('/score-exchange/deliver', d),
  cancelScoreExchange: (d) => http.post('/score-exchange/cancel', d),
  importOrders: (rows) => http.post('/orders/import', { rows }),
  exportOrders: (params) => http.get('/orders/export', { params, responseType: 'blob', timeout: 60000 }),
  duplicateGoods: (goods_id) => http.post('/goods/duplicate', { goods_id }),
  teamOrders: (memberId) => http.get('/member/team-orders', { params: { member_id: memberId } }),
  advanceMember: (d) => http.post('/member/advance', d),
  cancelOrder: (d) => http.post('/orders/cancel', d),
  cancelOrderBatch: (d) => http.post('/orders/cancel-batch', d),
  confirmPay: (d) => http.post('/orders/confirm-pay', d),
  confirmPayBatch: (d) => http.post('/orders/confirm-pay-batch', d),
  adjustMember: (d) => http.post('/member/adjust', d),
  auditWithdraw: (d) => http.post('/withdraw/audit', d),
  auditWithdrawBatch: (d) => http.post('/withdraw/audit-batch', d),
  auditCert: (d) => http.post('/certification/audit', d),
  confirmSettle: (d) => http.post('/settle/confirm', d),
  setting: (g) => http.get(`/setting/${g}`),
  saveSetting: (d) => http.post('/setting/save', d),

  // ---- 文件管理（素材库）----
  mediaList: (p) => http.get('/media/list', { params: p }),
  mediaGroups: () => http.get('/media/groups'),
  mediaSaveGroup: (d) => http.post('/media/group/save', d),
  mediaRemoveGroup: (d) => http.post('/media/group/remove', d),
  mediaRename: (d) => http.post('/media/rename', d),
  mediaMove: (d) => http.post('/media/move', d),
  mediaRemove: (d) => http.post('/media/remove', d),
  mediaRefs: (fileId) => http.get('/media/refs', { params: { file_id: fileId } }),
  mediaUpload: (file, extra = {}) => adminUpload(file, extra),

  // 表单里的图片上传统一走素材库接口：上传即入库，名字用原始文件名，用户不用再手动改
  upload: (file, extra = {}) => adminUpload(file, extra),
};

export default http;
