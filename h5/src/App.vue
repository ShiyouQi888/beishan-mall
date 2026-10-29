<template>
  <div class="app-root">
    <router-view v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
    <footer v-if="store.copyright || store.icp_number" class="site-footer">
      <span v-if="store.copyright">{{ store.copyright }}</span>
      <span v-if="store.icp_number">{{ store.icp_number }}</span>
    </footer>
    <TabBar v-if="showTab" />
  </div>
</template>

<script setup>
import { computed, onMounted, provide, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import TabBar from './components/TabBar.vue';
import { api } from './api.js';

const route = useRoute();
const showTab = computed(() => !route.meta.hideTab);
const store = ref({});
provide('storeInfo', store);

function applyBrand(info = {}) {
  if (info.name) document.title = info.name;
  if (info.logo) {
    let icon = document.querySelector('link[rel~="icon"]');
    if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.appendChild(icon); }
    icon.href = info.logo;
  }
}

onMounted(async () => {
  try {
    const r = await api.storeInfo();
    store.value = r.data || {};
    applyBrand(store.value);
  } catch {}
});
watch(() => route.fullPath, () => applyBrand(store.value));
</script>

<style>
.app-root { min-height: 100%; }
.site-footer { display:flex;flex-direction:column;align-items:center;gap:3px;padding:14px 16px calc(var(--tabbar-h, 54px) + 14px);color:#a5a8ae;font-size:10px;text-align:center;line-height:1.45; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.18s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
