<template>
  <svg v-if="icon" class="category-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" role="img" :aria-label="icon.label">
    <g v-html="icon.markup" />
  </svg>
</template>

<script setup>
import { computed } from 'vue';
import { categoryIconDefinition } from './category-icons.js';

const props = defineProps({ iconKey: { type: String, default: '' } });
const icon = computed(() => categoryIconDefinition(props.iconKey));
</script>

<style>
.category-icon { display:block;width:100%;height:100%; }
</style>
