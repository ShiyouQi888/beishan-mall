<template>
  <div class="page wd">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">申请提现</div>
    </div>

    <div class="section-pad" style="padding-top: 12px">
      <div class="card wd__amount">
        <div class="wd__label">可提现余额</div>
        <div class="wd__avail">¥{{ avail }}</div>
        <div class="wd__input-row">
          <span class="sym">¥</span>
          <input v-model="amount" type="number" placeholder="请输入提现金额" />
          <span class="all" @click="amount = avail">全部</span>
        </div>
        <div class="muted" style="margin-top: 8px">最低提现 {{ sys.withdraw_min || 10 }} 元，手续费 {{ sys.withdraw_fee || 0 }}%</div>
      </div>

      <div class="card wd__acct">
        <div class="sec-title" style="padding: 14px 0 6px"><span>收款账户</span></div>
        <div v-if="availableCards.length">
          <div
            v-for="c in availableCards"
            :key="c.card_id"
            class="acct"
            :class="{ on: selected === c.card_id }"
            @click="selected = c.card_id"
          >
            <span class="radio" :class="{ on: selected === c.card_id }" />
            <div class="acct__body">
              <div class="acct__t">{{ typeText(c.type) }} · {{ c.name }}</div>
              <div class="acct__d">{{ c.account }}<span v-if="c.bank"> · {{ c.bank }}</span></div>
            </div>
          </div>
        </div>
        <div v-if="!availableCards.length" class="acct__empty">
          {{ offlineEnabled ? '暂无可用收款账户，也可以选择线下打款' : '暂无可用收款账户，请添加已开放类型的收款账户' }}
          <span class="link" @click="$router.push('/address?tab=card')">去添加</span>
        </div>
        <div
          v-if="offlineEnabled"
          class="acct"
          :class="{ on: selected === 'offline' }"
          role="button"
          tabindex="0"
          :aria-pressed="selected === 'offline'"
          @click="selected = 'offline'"
          @keyup.enter="selected = 'offline'"
          @keyup.space.prevent="selected = 'offline'"
        >
          <span class="radio" :class="{ on: selected === 'offline' }" />
          <div class="acct__body">
            <div class="acct__t">线下打款 · 平台审核</div>
            <div class="acct__d">提交后由平台审核并安排线下转账</div>
          </div>
        </div>
      </div>

      <div class="card wd__rule">
        <div class="sec-title" style="padding: 14px 0 4px"><span>提现说明</span></div>
        <div class="rule-text">{{ sys.prompt_withdraw || '提现申请提交后由平台审核，审核通过后 T+1 个工作日到账。' }}</div>
      </div>

      <div class="card" v-if="records.length" style="margin-top: 12px">
        <div class="sec-title" style="padding: 14px 0 6px"><span>申请记录</span></div>
        <div class="wrec" v-for="r in records" :key="r.withdraw_id">
          <div class="wrec__main">
            <div class="wrec__amt">¥{{ Number(r.amount).toFixed(2) }}</div>
            <div class="wrec__time">{{ (r.create_time || '').slice(0, 16) }}</div>
          </div>
          <span class="wrec__st" :class="`st-${r.status}`">{{ statusText(r.status) }}</span>
        </div>
      </div>

      <button class="btn-main" style="margin-top: 18px" :disabled="loading || !selected" @click="submit">
        {{ loading ? '提交中…' : '提交申请' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { showToast } from 'vant';
import { api } from '../api.js';

const router = useRouter();
const amount = ref('');
const avail = ref('0.00');
const sys = ref({});
const cards = ref([]);
const selected = ref('offline');
const loading = ref(false);
const records = ref([]);
const typeText = (t) => ({ 1: '微信', 2: '支付宝', 3: '银行卡' }[t] || '账户');
const methodKey = (t) => ({ 1: 'wx', 2: 'zfb', 3: 'bank' }[Number(t)] || '');
const withdrawMethods = computed(() => ({ wx: true, zfb: true, bank: true, offline: true, ...(sys.value.withdraw_methods || {}) }));
const availableCards = computed(() => cards.value.filter((card) => withdrawMethods.value[methodKey(card.type)]));
const offlineEnabled = computed(() => Boolean(withdrawMethods.value.offline));
const statusText = (s) => ({ 0: '待审核', 10: '已通过', 20: '已驳回' }[Number(s)] || '—');

async function loadRecords() {
  try {
    const r = await api.withdrawList();
    records.value = (r.data || []).slice(0, 10);
  } catch {}
}

onMounted(async () => {
  try {
    const [a, s, c] = await Promise.allSettled([api.amountInfo(), api.systemInfo(), api.cardList()]);
    if (a.status === 'fulfilled') avail.value = a.value.data?.amount?.member_amount || '0.00';
    if (s.status === 'fulfilled') sys.value = s.value.data || {};
    if (c.status === 'fulfilled') {
      cards.value = c.value.data || [];
    }
    selected.value = availableCards.value[0]?.card_id ?? (offlineEnabled.value ? 'offline' : '');
  } catch {}
  loadRecords();
});

async function submit() {
  const amt = Number(amount.value);
  if (!amt || amt <= 0) return showToast('请输入提现金额');
  if (amt > Number(avail.value)) return showToast('可提现余额不足');
  if (!selected.value) return showToast('请选择收款方式');
  loading.value = true;
  try {
    const isOffline = selected.value === 'offline';
    const c = isOffline ? null : cards.value.find((x) => x.card_id === selected.value);
    if (!isOffline && !c) return showToast('收款账户无效，请重新选择');
    await api.withdraw({
      amount: amt,
      account_type: isOffline ? 4 : Number(c.type),
      account_info: isOffline ? '线下打款' : `${typeText(c.type)} ${c.account} ${c.name || ''}`,
    });
    showToast('申请已提交，等待审核');
    setTimeout(() => router.back(), 800);
  } catch {
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.wd { background: var(--bg); }
.card { margin-bottom: 10px; padding: 14px; }
.wd__label { font-size: 12px; color: var(--text-3); }
.wd__avail { font-size: 24px; font-weight: 700; margin-top: 3px; font-variant-numeric: tabular-nums; }
.wd__input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.wd__input-row .sym { font-size: 20px; font-weight: 700; color: var(--text-1); }
.wd__input-row input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 22px;
  font-weight: 650;
  font-family: var(--font);
  background: transparent;
  color: var(--text-1);
}
.wd__input-row .all { font-size: 12.5px; color: var(--brand); font-weight: 600; }

.acct {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-top: 1px solid var(--line);
  cursor: pointer;
}
.acct:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.radio {
  width: 17px; height: 17px; border-radius: 50%;
  border: 1.6px solid #d3d7de; flex: none; position: relative;
}
.radio.on { border-color: var(--brand); }
.radio.on::after { content: ''; position: absolute; inset: 3px; border-radius: 50%; background: var(--brand); }
.acct__t { font-size: 13.5px; font-weight: 550; }
.acct__d { font-size: 11.5px; color: var(--text-3); margin-top: 2px; }
.acct__empty { font-size: 13px; color: var(--text-3); padding: 10px 0 6px; }
.acct__empty .link { color: var(--brand); margin-left: 6px; }
.rule-text { font-size: 12.5px; color: var(--text-3); line-height: 1.7; }

.wrec { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--line); }
.wrec:last-child { border-bottom: none; }
.wrec__amt { font-size: 14px; font-weight: 550; font-variant-numeric: tabular-nums; }
.wrec__time { font-size: 11px; color: var(--text-4); margin-top: 2px; }
.wrec__st { font-size: 11.5px; padding: 2px 8px; border-radius: 20px; }
.wrec__st.st-0 { background: #fff6e8; color: #c47a16; }
.wrec__st.st-10 { background: #eaf7ef; color: #1a9c56; }
.wrec__st.st-20 { background: #f2f4f7; color: var(--text-3); }
</style>
