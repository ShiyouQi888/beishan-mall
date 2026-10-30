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
    const d = res.data;
    if (d && d.code === 1) return d;
    if (d && d.code === -1) {
      localStorage.removeItem('ADMIN_TOKEN');
      if (location.hash !== '#/login') location.hash = '#/login';
      ElMessage.error(d.msg || '登录已失效');
      return Promise.reject(d);
    }
    ElMessage.error(d?.msg || '请求失败');
    return Promise.reject(d);
  },
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('ADMIN_TOKEN');
      location.hash = '#/login';
    }
    ElMessage.error(err.response?.data?.msg || '网络异常');
    return Promise.reject(err);
  },
);

export const adminApi = {
  storeInfo: () => axios.get('/api/index/getStoreInfo').then((r) => r.data?.data || {}),
  login: (d) => http.post('/login', d),
  me: () => http.get('/me'),
  myPaths: () => http.get('/my-paths'),
  dashboard: () => http.get('/dashboard'),
  financeOverview: () => http.get('/finance/overview'),
  modules: () => http.get('/modules'),
  options: (name) => http.get(`/options/${name}`),
  list: (mod, params) => http.get(`/${mod}/list`, { params }),
  detail: (mod, id) => http.get(`/${mod}/detail`, { params: { id } }),
  save: (mod, data) => http.post(`/${mod}/save`, data),
  remove: (mod, ids) => http.post(`/${mod}/remove`, { ids }),
  deliver: (d) => http.post('/orders/deliver', d),
  auditOrder: (d) => http.post('/orders/audit', d),
  importOrders: (rows) => http.post('/orders/import', { rows }),
  splitOrder: (d) => http.post('/orders/split', d),
  teamOrders: (memberId) => http.get('/member/team-orders', { params: { member_id: memberId } }),
  advanceMember: (d) => http.post('/member/advance', d),
  scanStreambeat: (d = {}) => http.post('/streambeat/scan', d),
  streambeatMembers: (keyword = '') => http.get('/streambeat/members', { params: { keyword } }),
  assignStreambeat: (d) => http.post('/streambeat/assign', d),
  grantAward: (d) => http.post('/award/grant', d),
  createShopOrder: (d) => http.post('/orders/set-goods-order', d),
  cancelOrder: (d) => http.post('/orders/cancel', d),
  confirmPay: (d) => http.post('/orders/confirm-pay', d),
  adjustMember: (d) => http.post('/member/adjust', d),
  auditWithdraw: (d) => http.post('/withdraw/audit', d),
  auditCert: (d) => http.post('/certification/audit', d),
  confirmSettle: (d) => http.post('/settle/confirm', d),
  setting: (g) => http.get(`/setting/${g}`),
  saveSetting: (d) => http.post('/setting/save', d),
  upload: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return axios.post('/api/upload/image', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((res) => res.data);
  },
};

export default http;
