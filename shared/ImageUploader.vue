<template>
  <div class="image-uploader">
    <div class="image-uploader__tiles">
      <div v-for="(url, index) in urls" :key="`${url}-${index}`" class="image-uploader__tile">
        <button class="image-uploader__preview" type="button" :aria-label="`放大查看第 ${index + 1} 张图片`" @click="previewUrl = url">
          <img :src="url" :alt="`已上传图片 ${index + 1}`" />
          <span class="image-uploader__zoom">放大查看</span>
        </button>
        <button class="image-uploader__remove" type="button" :aria-label="`移除第 ${index + 1} 张图片`" @click="removeAt(index)">×</button>
      </div>

      <button v-if="!multiple || urls.length < max" class="image-uploader__add" type="button" :disabled="disabled || busy" @click="inputEl?.click()">
        <span class="image-uploader__plus">+</span>
        <span>{{ busy ? '处理中' : '添加图片' }}</span>
      </button>
    </div>
    <input ref="inputEl" class="image-uploader__input" type="file" accept="image/*" :multiple="multiple" :disabled="disabled || busy" @change="onSelect" />
    <div v-if="busy" class="image-uploader__status">{{ status }}</div>
    <div v-if="errorText" class="image-uploader__error" role="status">{{ errorText }}</div>

    <ImageEditor :visible="editorVisible" :file="activeFile" :cropper-class="cropperClass" @close="cancelQueue" @processed="onProcessed" @error="errorText = $event" />

    <Teleport to="body">
      <div v-if="previewUrl" class="image-uploader__lightbox" role="dialog" aria-modal="true" aria-label="图片预览" @click.self="previewUrl = ''" @keydown.esc="previewUrl = ''">
        <button class="image-uploader__lightbox-close" type="button" aria-label="关闭图片预览" @click="previewUrl = ''">×</button>
        <img :src="previewUrl" alt="图片大图预览" @click="previewUrl = ''" />
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import ImageEditor from './ImageEditor.vue';

const props = defineProps({
  modelValue: { type: [String, Array], default: '' },
  upload: { type: Function, required: true },
  cropperClass: { type: Function, required: true },
  multiple: { type: Boolean, default: false },
  max: { type: Number, default: 9 },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'uploaded']);
const inputEl = ref(null);
const editorVisible = ref(false);
const activeFile = ref(null);
const queue = ref([]);
const busy = ref(false);
const status = ref('');
const errorText = ref('');
const previewUrl = ref('');
const urls = computed(() => {
  if (Array.isArray(props.modelValue)) return props.modelValue.filter(Boolean);
  if (!props.modelValue) return [];
  if (!props.multiple) return [String(props.modelValue)];
  try { return JSON.parse(props.modelValue).filter(Boolean); } catch { return [String(props.modelValue)]; }
});

function updateUrls(next) {
  emit('update:modelValue', props.multiple ? JSON.stringify(next) : (next[0] || ''));
}

function removeAt(index) {
  updateUrls(urls.value.filter((_, i) => i !== index));
}

function onSelect(event) {
  errorText.value = '';
  const selected = [...(event.target.files || [])];
  event.target.value = '';
  if (!selected.length) return;
  const remaining = props.multiple ? Math.max(0, props.max - urls.value.length) : 1;
  if (props.multiple && selected.length > remaining) errorText.value = `最多可上传 ${props.max} 张，已选图片将按剩余位置处理`;
  queue.value = selected.slice(0, remaining);
  if (!queue.value.length) return;
  busy.value = true;
  startNext();
}

function startNext() {
  const next = queue.value.shift();
  if (!next) {
    editorVisible.value = false;
    busy.value = false;
    status.value = '';
    return;
  }
  activeFile.value = next;
  status.value = props.multiple ? `待处理 ${queue.value.length + 1} 张` : '请完成图片裁剪与压缩';
  editorVisible.value = true;
}

function cancelQueue() {
  editorVisible.value = false;
  queue.value = [];
  busy.value = false;
  status.value = '';
}

async function onProcessed(file) {
  editorVisible.value = false;
  try {
    status.value = '正在上传处理后的图片…';
    const url = await props.upload(file);
    const next = props.multiple ? [...urls.value, url] : [url];
    updateUrls(next);
    emit('uploaded', url, file);
    errorText.value = '';
  } catch (error) {
    errorText.value = error?.message || '上传失败，请重试';
  }
  startNext();
}
</script>

<style>
.image-uploader { display:inline-flex;flex-direction:column;gap:7px;max-width:100%; }
.image-uploader__tiles { display:flex;align-items:flex-start;flex-wrap:wrap;gap:10px; }
.image-uploader__tile,.image-uploader__add { width:96px;height:96px;border-radius:10px;position:relative;overflow:hidden; }
.image-uploader__tile { border:1px solid #e6e9ee;background:#f7f8fa; }
.image-uploader__preview { width:100%;height:100%;padding:0;border:0;background:transparent;cursor:zoom-in;display:block; }
.image-uploader__preview img { width:100%;height:100%;object-fit:cover; }
.image-uploader__zoom { position:absolute;inset:auto 0 0;padding:5px 2px;background:rgba(20,24,32,.58);color:#fff;font-size:10px;opacity:0;transition:opacity .16s ease; }
.image-uploader__preview:hover .image-uploader__zoom,.image-uploader__preview:focus-visible .image-uploader__zoom { opacity:1; }
.image-uploader__remove { position:absolute;top:4px;right:4px;width:21px;height:21px;border:0;border-radius:50%;background:rgba(24,29,38,.64);color:#fff;font-size:17px;line-height:1;cursor:pointer; }
.image-uploader__add { display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:1px dashed #cbd1da;background:#fafbfc;color:#77818f;font:inherit;font-size:11px;cursor:pointer;transition:border-color .16s ease,background .16s ease,color .16s ease; }
.image-uploader__add:hover { border-color:#e77967;background:#fff8f6;color:#d7513b; }
.image-uploader__add:disabled { opacity:.6;cursor:wait; }
.image-uploader__plus { font-size:31px;font-weight:300;line-height:1;color:#a0a8b3; }
.image-uploader__input { display:none; }
.image-uploader__status,.image-uploader__error { color:#9299a3;font-size:11px;line-height:1.4; }
.image-uploader__error { color:#d94e40; }
.image-uploader__lightbox { position:fixed;inset:0;z-index:3100;display:grid;place-items:center;padding:5vh 5vw;background:rgba(9,12,18,.88);cursor:zoom-out; }
.image-uploader__lightbox img { max-width:90vw;max-height:88vh;object-fit:contain;border-radius:8px;box-shadow:0 18px 70px rgba(0,0,0,.35); }
.image-uploader__lightbox-close { position:absolute;top:18px;right:20px;width:42px;height:42px;border:1px solid rgba(255,255,255,.28);border-radius:50%;background:rgba(0,0,0,.25);color:white;font-size:30px;line-height:1;cursor:pointer; }
@media(max-width:600px) { .image-uploader__tile,.image-uploader__add { width:88px;height:88px; } }
</style>
