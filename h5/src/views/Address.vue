<template>
  <div class="page addrpage">
    <div class="navbar">
      <div class="navbar__back" @click="$router.back()">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div class="navbar__title">{{ tab === 'card' ? '收款账户' : '收货地址' }}</div>
    </div>

    <div class="addrpage__tabs">
      <div class="t" :class="{ on: tab === 'addr' }" @click="tab = 'addr'">收货地址</div>
      <div class="t" :class="{ on: tab === 'card' }" @click="tab = 'card'">收款账户</div>
    </div>

    <div class="section-pad" style="padding-top: 12px">
      <!-- 地址 -->
      <template v-if="tab === 'addr'">
        <div v-if="list.length" class="cascade">
          <div class="acard card" v-for="a in list" :key="a.address_id" @click="pick(a)">
            <div class="acard__main">
              <div class="acard__l1">
                <b>{{ a.name }}</b>
                <span class="muted">{{ a.mobile }}</span>
                <span class="def" v-if="a.is_default">默认</span>
              </div>
              <div class="acard__l2">{{ a.province }}{{ a.city }}{{ a.district }} {{ a.detail }}</div>
            </div>
            <div class="acard__ops" @click.stop>
              <span @click="$router.push(`/address/edit?id=${a.address_id}`)">编辑</span>
              <span class="del" @click="remove(a)">删除</span>
            </div>
          </div>
        </div>
        <div v-else class="empty">还没有收货地址</div>
        <button class="btn-main" style="margin-top: 16px" @click="$router.push('/address/edit')">新增收货地址</button>
      </template>

      <!-- 收款账户 -->
      <template v-else>
        <div class="card payform">
          <div class="form-row">
            <div class="form-row__label">账户类型</div>
            <div class="form-row__ctrl">
              <select v-model="cardForm.type">
                <option :value="1">微信</option>
                <option :value="2">支付宝</option>
                <option :value="3">银行卡</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-row__label">账号<span class="req">*</span></div>
            <div class="form-row__ctrl"><input v-model="cardForm.account" placeholder="收款账号 / 卡号" /></div>
          </div>
          <div class="form-row">
            <div class="form-row__label">姓名<span class="req">*</span></div>
            <div class="form-row__ctrl"><input v-model="cardForm.name" placeholder="收款人姓名" /></div>
          </div>
          <div class="form-row" v-if="cardForm.type === 3">
            <div class="form-row__label">开户银行</div>
            <div class="form-row__ctrl"><input v-model="cardForm.bank" placeholder="如：招商银行" /></div>
          </div>
        </div>
        <button class="btn-main" style="margin-top: 14px" @click="addCard">保存账户</button>

        <div class="sec-title"><span>已添加账户</span></div>
        <div v-if="cards.length" class="cascade">
          <div class="acard card" v-for="c in cards" :key="c.card_id">
            <div class="acard__main">
              <div class="acard__l1"><b>{{ typeText(c.type) }}</b><span class="muted">{{ c.name }}</span></div>
              <div class="acard__l2">{{ c.account }}<span v-if="c.bank"> · {{ c.bank }}</span></div>
            </div>
            <div class="acard__ops" @click.stop><span class="del" @click="removeCard(c)">删除</span></div>
          </div>
        </div>
        <div v-else class="empty">还没有收款账户</div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast, showConfirmDialog } from 'vant';
import { api } from '../api.js';

const route = useRoute();
const router = useRouter();
const tab = ref(route.query.tab === 'card' ? 'card' : 'addr');
const list = ref([]);
const cards = ref([]);
const cardForm = reactive({ type: 1, account: '', name: '', bank: '' });

const typeText = (t) => ({ 1: '微信', 2: '支付宝', 3: '银行卡' }[t] || '账户');

async function load() {
  try {
    const [a, c] = await Promise.allSettled([api.addressList(), api.cardList()]);
    if (a.status === 'fulfilled') list.value = a.value.data || [];
    if (c.status === 'fulfilled') cards.value = c.value.data || [];
  } catch {}
}

function pick(a) {
  if (route.query.select) {
    localStorage.setItem('PICK_ADDRESS', JSON.stringify(a));
    router.back();
  }
}

async function remove(a) {
  try {
    await showConfirmDialog({ title: '删除地址', message: '确定删除该收货地址？' });
  } catch {
    return;
  }
  await api.addressRemove({ address_id: a.address_id });
  showToast('已删除');
  load();
}

async function addCard() {
  if (!cardForm.account || !cardForm.name) return showToast('请填写账号和姓名');
  try {
    await api.cardAdd(cardForm);
    showToast('保存成功');
    cardForm.account = '';
    cardForm.name = '';
    cardForm.bank = '';
    load();
  } catch {}
}

async function removeCard(c) {
  try {
    await showConfirmDialog({ title: '删除账户', message: '确定删除该收款账户？' });
  } catch {
    return;
  }
  await api.cardRemove({ card_id: c.card_id });
  showToast('已删除');
  load();
}

onMounted(load);
</script>

<style scoped>
.addrpage { background: var(--bg); }
.addrpage__tabs {
  display: flex;
  background: #fff;
  border-bottom: 1px solid var(--line);
}
.addrpage__tabs .t {
  flex: 1;
  text-align: center;
  padding: 13px 0;
  font-size: 13.5px;
  color: var(--text-3);
  position: relative;
}
.addrpage__tabs .t.on { color: var(--text-1); font-weight: 650; }
.addrpage__tabs .t.on::after {
  content: '';
  position: absolute;
  left: 50%; bottom: 3px;
  transform: translateX(-50%);
  width: 20px; height: 3px;
  border-radius: 2px;
  background: var(--brand);
}

.cascade { display: flex; flex-direction: column; gap: 10px; }
.acard { display: flex; align-items: center; gap: 10px; padding: 14px; }
.acard__main { flex: 1; min-width: 0; }
.acard__l1 { display: flex; align-items: center; gap: 8px; font-size: 14.5px; }
.acard__l1 .def {
  font-size: 10px;
  color: var(--brand);
  background: var(--brand-soft);
  padding: 1px 6px;
  border-radius: 5px;
}
.acard__l2 { font-size: 12.5px; color: var(--text-3); margin-top: 5px; line-height: 1.45; }
.acard__ops { display: flex; gap: 12px; font-size: 12px; color: var(--text-3); flex: none; }
.acard__ops .del { color: #d14328; }

.payform { padding: 4px 14px; }
.payform select {
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font);
  font-size: 14px;
  padding: 12px 0;
  color: var(--text-1);
}
</style>
