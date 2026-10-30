<template>
  <div class="page settle">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">结算待办</div>
    </div>

    <div class="settle__tabs">
      <div class="t" :class="{ on: tab === 'pay' }" @click="tab = 'pay'">
        待付款<span class="badge" v-if="payList.length">{{ payList.length }}</span>
      </div>
      <div class="t" :class="{ on: tab === 'receive' }" @click="tab = 'receive'">
        待收款<span class="badge" v-if="receiveList.length">{{ receiveList.length }}</span>
      </div>
    </div>

    <div class="section-pad" style="padding-top: 12px">
      <div class="settle__tip">
        场次结束后系统会按买入/卖出差额生成付款单，请线下转账后上传凭证，对方确认后完成。
      </div>

      <template v-if="tab === 'pay'">
        <div v-if="payList.length" class="cascade">
          <div class="mcard card" v-for="m in payList" :key="m.match_id">
            <div class="mcard__head">
              <span class="mcard__amount">¥{{ Number(m.amount).toFixed(2) }}</span>
              <span class="tag-status" :class="m.pay_status === 10 ? 'tag-blue' : 'tag-warn'">
                {{ m.pay_status === 10 ? '待对方确认' : '待付款' }}
              </span>
            </div>
            <div class="mcard__to">收款方：{{ m.payee_name }}（{{ maskPhone(m.payee_mobile) }}）</div>
            <div class="mcard__acct" v-if="payInfo(m)">
              <div class="row"><span>收款方式</span><b>{{ payInfo(m).label }}</b></div>
              <div class="row" v-if="payInfo(m).account"><span>账号</span><b>{{ payInfo(m).account }}</b></div>
              <div class="row" v-if="payInfo(m).name"><span>姓名</span><b>{{ payInfo(m).name }}</b></div>
            </div>
            <div class="mcard__foot" v-if="m.pay_status === 0">
              <ImageUploader :model-value="voucherImages[m.match_id] || ''" :upload="(file) => uploadVoucher(m, file)" @update:model-value="voucherImages[m.match_id] = $event" />
            </div>
            <div class="mcard__done" v-else>已提交凭证，等待对方确认收款</div>
          </div>
        </div>
        <div v-else class="empty">暂无待付款项</div>
      </template>

      <template v-else>
        <div v-if="receiveList.length" class="cascade">
          <div class="mcard card" v-for="m in receiveList" :key="m.match_id">
            <div class="mcard__head">
              <span class="mcard__amount plus">+¥{{ Number(m.amount).toFixed(2) }}</span>
              <span class="tag-status" :class="m.pay_status === 10 ? 'tag-blue' : 'tag-warn'">
                {{ m.pay_status === 10 ? '待确认' : '待对方付款' }}
              </span>
            </div>
            <div class="mcard__to">付款方：{{ m.payer_name }}（{{ maskPhone(m.payer_mobile) }}）</div>
            <div class="mcard__voucher" v-if="m.voucher">
              <span class="label">付款凭证</span>
              <img :src="m.voucher" @click="preview(m.voucher)" />
            </div>
            <div class="mcard__foot" v-if="m.pay_status === 10">
              <button class="mini-btn mini-btn--main" @click="confirmReceive(m)">确认收款</button>
            </div>
          </div>
        </div>
        <div v-else class="empty">暂无待收款项</div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { showImagePreview } from 'vant';
import { showToast, showConfirmDialog } from '../utils/feedback.js';
import { api } from '../api.js';
import ImageUploader from '../components/ImageUploader.vue';

const tab = ref('pay');
const payList = ref([]);
const receiveList = ref([]);
const voucherImages = reactive({});

const maskPhone = (p) => (p ? p.slice(0, 3) + '****' + p.slice(-4) : '');

const payInfo = (m) => {
  try {
    const s = m.pay_setting ? JSON.parse(m.pay_setting) : {};
    const bank = s.bank_account || s.zfb_account || s.wx_account;
    if (!bank) return null;
    return {
      label: s.bank_account ? '银行卡' : s.zfb_account ? '支付宝' : '微信',
      account: bank,
      name: s.bank_name || s.zfb_name || s.wx_name || '',
    };
  } catch {
    return null;
  }
};

function preview(url) {
  showImagePreview([url]);
}

async function load() {
  try {
    const r = await api.mySettle();
    payList.value = r.data?.pay || [];
    receiveList.value = r.data?.receive || [];
  } catch {}
}

async function uploadVoucher(m, file) {
  const up = await api.upload(file);
  await api.settleVoucher({ match_id: m.match_id, voucher: up.data.url });
  showToast('凭证已处理并提交');
  load();
  return up.data.url;
}

async function confirmReceive(m) {
  try {
    await showConfirmDialog({ title: '确认收款', message: `确认已收到 ¥${Number(m.amount).toFixed(2)}？` });
  } catch {
    return;
  }
  try {
    await api.settleConfirm({ match_id: m.match_id });
    showToast('已确认收款');
    load();
  } catch {}
}

onMounted(load);
</script>

<style scoped>
.settle { background: var(--bg); }
.settle__tabs {
  display: flex;
  background: #fff;
  border-bottom: 1px solid var(--line);
}
.settle__tabs .t {
  flex: 1;
  text-align: center;
  padding: 13px 0;
  font-size: 13.5px;
  color: var(--text-3);
  position: relative;
}
.settle__tabs .t.on { color: var(--text-1); font-weight: 650; }
.settle__tabs .t.on::after {
  content: '';
  position: absolute;
  left: 50%; bottom: 3px;
  transform: translateX(-50%);
  width: 20px; height: 3px;
  border-radius: 2px;
  background: var(--brand);
}
.badge {
  display: inline-block;
  min-width: 16px;
  height: 16px;
  line-height: 16px;
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--brand);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
}

.settle__tip {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.7;
  background: #fffaf0;
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

.cascade { display: flex; flex-direction: column; gap: 10px; }
.mcard { padding: 14px; }
.mcard__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.mcard__amount {
  font-size: 22px;
  font-weight: 700;
  color: var(--brand);
  font-variant-numeric: tabular-nums;
}
.mcard__amount.plus { color: #1f9d5f; }
.mcard__to { font-size: 13px; color: var(--text-2); }
.mcard__acct {
  margin-top: 10px;
  background: #fafbfc;
  border-radius: 10px;
  padding: 10px 12px;
}
.mcard__acct .row {
  display: flex;
  justify-content: space-between;
  font-size: 12.5px;
  color: var(--text-3);
  padding: 3px 0;
}
.mcard__acct .row b { color: var(--text-1); font-weight: 550; }
.mcard__voucher { margin-top: 10px; display: flex; align-items: center; gap: 10px; }
.mcard__voucher .label { font-size: 12px; color: var(--text-3); }
.mcard__voucher img { width: 62px; height: 62px; border-radius: 8px; object-fit: cover; background: #f6f7f9; }
.mcard__foot { margin-top: 12px; }
.mcard__done { margin-top: 10px; font-size: 12px; color: #1f9d5f; }
.mini-btn {
  height: 34px;
  padding: 0 16px;
  border-radius: 17px;
  border: 1px solid var(--brand);
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font);
}
</style>
