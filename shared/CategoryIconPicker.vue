<template>
  <div class="category-icon-picker">
    <button
      v-for="icon in icons"
      :key="icon.key"
      type="button"
      class="category-icon-picker__item"
      :class="{ active: selectedKey === icon.key }"
      :aria-pressed="selectedKey === icon.key"
      @click="$emit('update:modelValue', categoryIconValue(icon.key))"
    >
      <span class="category-icon-picker__glyph"><CategoryIcon :icon-key="icon.key" /></span>
      <span>{{ icon.label }}</span>
    </button>
    <button v-if="selectedKey" type="button" class="category-icon-picker__clear" @click="$emit('update:modelValue', '')">清除图标</button>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import CategoryIcon from './CategoryIcon.vue';
import { CATEGORY_ICONS, categoryIconKey, categoryIconValue } from './category-icons.js';

const props = defineProps({ modelValue: { type: String, default: '' } });
defineEmits(['update:modelValue']);
const icons = CATEGORY_ICONS;
const selectedKey = computed(() => categoryIconKey(props.modelValue));
</script>

<style scoped>
.category-icon-picker { display:flex;flex-wrap:wrap;gap:8px;max-width:440px; }
.category-icon-picker__item { width:76px;min-height:76px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:8px 4px;border:1px solid #e8ebf0;border-radius:11px;background:#fff;color:#737b87;font:inherit;font-size:10px;cursor:pointer;transition:border-color .16s,background .16s,color .16s,box-shadow .16s; }
.category-icon-picker__item:hover { border-color:#f2b3a8;color:#cf4935; }
.category-icon-picker__item.active { border-color:#ed7968;background:#fff5f2;color:#cb4936;box-shadow:0 0 0 2px rgba(255,81,58,.08); }
.category-icon-picker__glyph { width:30px;height:30px;display:grid;place-items:center; }
.category-icon-picker__clear { align-self:flex-end;height:28px;padding:0 9px;border:0;border-radius:7px;background:#f4f5f7;color:#7c8490;font:inherit;font-size:11px;cursor:pointer; }
</style>
