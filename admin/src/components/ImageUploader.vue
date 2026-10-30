<template>
  <div class="media-field">
    <SharedImageUploader
      :model-value="modelValue"
      :upload="upload"
      :cropper-class="Cropper"
      :multiple="multiple"
      :max="max"
      :disabled="disabled"
      @update:model-value="(v) => emit('update:modelValue', v)"
      @uploaded="(url, file) => emit('uploaded', url, file)"
    />
    <button type="button" class="media-field__pick" :disabled="disabled" @click="pickerVisible = true">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
        <path d="M3.5 7.2A2.2 2.2 0 0 1 5.7 5h3.4l1.8 2.2h7.4a2.2 2.2 0 0 1 2.2 2.2v7.4a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V7.2Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
        <path d="m7 15.6 3-3.2 2.3 2.3 1.7-1.6 3 2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      从文件管理选取
    </button>

    <MediaPicker v-model="pickerVisible" :multiple="multiple" :limit="pickerLimit" @pick="onPick" />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';
import SharedImageUploader from '../../../shared/ImageUploader.vue';
import MediaPicker from './MediaPicker.vue';

const props = defineProps({
  modelValue: { type: [String, Array], default: '' },
  upload: { type: Function, required: true },
  multiple: { type: Boolean, default: false },
  max: { type: Number, default: 9 },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'uploaded']);

const pickerVisible = ref(false);

const urls = computed(() => {
  if (Array.isArray(props.modelValue)) return props.modelValue.filter(Boolean);
  if (!props.modelValue) return [];
  if (!props.multiple) return [String(props.modelValue)];
  try { return JSON.parse(props.modelValue).filter(Boolean); } catch { return [String(props.modelValue)]; }
});
const pickerLimit = computed(() => (props.multiple ? Math.max(0, props.max - urls.value.length) : 1));

function onPick(picked) {
  if (!picked.length) return;
  const next = props.multiple
    ? [...urls.value, ...picked].slice(0, props.max)
    : [picked[0]];
  emit('update:modelValue', props.multiple ? JSON.stringify(next) : (next[0] || ''));
  next.forEach((u) => emit('uploaded', u, null));
}
</script>

<style scoped>
.media-field { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 6px; max-width: 100%; }
.media-field__pick {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #8c93a0;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: color 0.16s ease;
}
.media-field__pick:hover { color: #ff513a; }
.media-field__pick:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
