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
        <div v-if="cards.length">
          <div
            v-for="c in cards"
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
        <div v-else class="acct__empty">
          还没有收款账户
          <span class="link" @click="$router.push('/address?tab=card')">去添加</span>
        </div>
      </div>

      <div class="card wd__rule">
        <div class="sec-title" style="padding: 14px 0 4px"><span>提现说明</span></div>
        <div class="rule-text">{{ sys.prompt_withdraw || '提现申请提交后由平台审核，审核通过后 T+1 个工作日到账。' }}</div>
      </div>

      <button class="btn-main" style="margin-top: 18px" :disabled="loading" @click="submit">
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
const selected = ref(0);
const loading = ref(false);
const typeText = (t) => ({ 1: '微信', 2: '支付宝', 3: '银行卡' }[t] || '账户');

onMounted(async () => {
  try {
    const [a, s, c] = await Promise.allSettled([api.amountInfo(), api.systemInfo(), api.cardList()]);
    if (a.status === 'fulfilled') avail.value = a.value.data?.amount?.member_amount || '0.00';
    if (s.status === 'fulfilled') sys.value = s.value.data || {};
    if (c.status === 'fulfilled') {
      cards.value = c.value.data || [];
      if (cards.value.length) selected.value = cards.value[0].card_id;
    }
  } catch {}
});

async function submit() {
  const amt = Number(amount.value);
  if (!amt || amt <= 0) return showToast('请输入提现金额');
  if (amt > Number(avail.value)) return showToast('可提现余额不足');
  if (!selected.value) return showToast('请先添加收款账户');
  loading.value = true;
  try {
    const c = cards.value.find((x) => x.card_id === selected.value);
    await api.withdraw({
      amount: amt,
      account_type: c?.type || 1,
      account_info: `${typeText(c?.type)} ${c?.account} ${c?.name || ''}`,
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
}
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
</style>
