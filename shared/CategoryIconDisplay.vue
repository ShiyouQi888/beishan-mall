<template>
  <span class="category-icon-display">
    <CategoryIcon v-if="builtinKey" :icon-key="builtinKey" :style="iconStyle" />
    <img v-else-if="image && !imageFailed" :src="image" :alt="`${name}分类图标`" @error="imageFailed = true" />
    <CategoryIcon v-else :icon-key="fallbackKey" :style="iconStyle" />
  </span>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import CategoryIcon from './CategoryIcon.vue';
import { categoryIconKey, defaultCategoryIconKey } from './category-icons.js';

const props = defineProps({
  image: { type: String, default: '' },
  name: { type: String, default: '' },
  size: { type: String, default: '100%' },
});
const imageFailed = ref(false);
const builtinKey = computed(() => categoryIconKey(props.image));
const fallbackKey = computed(() => defaultCategoryIconKey(props.name));
const iconStyle = computed(() => ({ width: props.size, height: props.size }));
watch(() => props.image, () => { imageFailed.value = false; });
</script>

<style>
.category-icon-display { display:grid;width:100%;height:100%;place-items:center; }
.category-icon-display > img { width:100%;height:100%;object-fit:contain; }
</style>
