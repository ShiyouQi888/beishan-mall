<template>
  <div class="media-field">
    <SharedImageUploader
      :model-value="modelValue"
      :upload="upload"
      :cropper-class="Cropper"
      :library-picker="openMediaPicker"
      :presets="presets"
      :multiple="multiple"
      :max="max"
      :disabled="disabled"
      :crop="crop"
      @update:model-value="(v) => emit('update:modelValue', v)"
      @uploaded="(url, file) => emit('uploaded', url, file)"
    />

    <MediaPicker :model-value="pickerVisible" :multiple="multiple" :limit="pickerLimit" @update:model-value="onPickerVisibility" @pick="onPick" @upload-files="onUploadFiles" />
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
  presets: { type: Array, default: () => [] },
  // 后台默认「选好就传」，不再强制进裁剪器；需要时必须自己点缩略图上的「裁剪」
  crop: { type: String, default: 'optional' },
});
const emit = defineEmits(['update:modelValue', 'uploaded']);

const pickerVisible = ref(false);
let resolvePicker;

const urls = computed(() => {
  if (Array.isArray(props.modelValue)) return props.modelValue.filter(Boolean);
  if (!props.modelValue) return [];
  if (!props.multiple) return [String(props.modelValue)];
  try { return JSON.parse(props.modelValue).filter(Boolean); } catch { return [String(props.modelValue)]; }
});
const pickerLimit = computed(() => (props.multiple ? Math.max(0, props.max - urls.value.length) : 1));

function openMediaPicker() {
  return new Promise((resolve) => {
    resolvePicker = resolve;
    pickerVisible.value = true;
  });
}

function settlePicker(result) {
  const resolve = resolvePicker;
  resolvePicker = undefined;
  resolve?.(result);
}

function onPickerVisibility(value) {
  pickerVisible.value = value;
  if (!value) settlePicker({ type: 'cancel' });
}

function onPick(picked) {
  settlePicker({ type: 'select', urls: picked });
}

function onUploadFiles(files, groupId) {
  settlePicker({ type: 'files', files, group_id: groupId });
}
</script>

<style scoped>
.media-field { display: inline-flex; max-width: 100%; }
</style>
