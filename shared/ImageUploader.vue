<template>
  <div class="image-uploader">
    <div class="image-uploader__tiles">
      <div v-for="(url, index) in urls" :key="`${url}-${index}`" class="image-uploader__tile">
        <button class="image-uploader__preview" type="button" :aria-label="`放大查看第 ${index + 1} 张图片`" @click="previewUrl = url">
          <img :src="url" :alt="`已上传图片 ${index + 1}`" />
          <span class="image-uploader__zoom">放大查看</span>
        </button>
        <button class="image-uploader__crop" type="button" :aria-label="`裁剪第 ${index + 1} 张图片`" :disabled="disabled || busy" @click.stop="recropAt(index)">裁剪</button>
        <button class="image-uploader__remove" type="button" :aria-label="`移除第 ${index + 1} 张图片`" @click="removeAt(index)">×</button>
      </div>

      <button v-if="!multiple || urls.length < max" class="image-uploader__add" type="button" :disabled="disabled || busy" @click="openSourcePicker">
        <span class="image-uploader__plus">+</span>
        <span>{{ busy ? '处理中' : '添加图片' }}</span>
      </button>
    </div>
    <input ref="inputEl" class="image-uploader__input" type="file" accept="image/*" :multiple="multiple" :disabled="disabled || busy" @change="onSelect" />
    <div v-if="busy" class="image-uploader__status">{{ status }}</div>
    <div v-if="errorText" class="image-uploader__error" role="status">{{ errorText }}</div>

    <ImageEditor :visible="editorVisible" :file="activeFile" :cropper-class="cropperClass" :presets="presets" :auto-crop-area="crop === 'required' ? 0.88 : 1" @close="cancelQueue" @processed="onProcessed" @error="errorText = $event" />

    <Teleport to="body">
      <div v-if="sourcePickerVisible" class="image-uploader__source-overlay" role="dialog" aria-modal="true" aria-labelledby="image-uploader-source-title" @click.self="sourcePickerVisible = false" @keydown.esc="sourcePickerVisible = false">
        <section class="image-uploader__source-panel">
          <header class="image-uploader__source-head">
            <div>
              <h2 id="image-uploader-source-title">选择图片来源</h2>
              <p>{{ crop === 'required' ? '图片会先裁剪和压缩，再上传使用' : '选好即可直接上传，需要时再单独裁剪' }}</p>
            </div>
            <button class="image-uploader__source-close" type="button" aria-label="关闭" @click="sourcePickerVisible = false">×</button>
          </header>
          <div class="image-uploader__source-options">
            <button class="image-uploader__source-option" type="button" @click="chooseLocal">
              <span class="image-uploader__source-icon">↑</span>
              <span><strong>本地上传</strong><small>{{ crop === 'required' ? '从电脑或手机选择图片' : '从电脑或手机选择，不强制裁剪' }}</small></span>
              <span class="image-uploader__source-arrow">›</span>
            </button>
            <button v-if="libraryPicker" class="image-uploader__source-option" type="button" @click="chooseLibrary">
              <span class="image-uploader__source-icon image-uploader__source-icon--library">▧</span>
              <span><strong>文件管理</strong><small>从已上传的图片中选择</small></span>
              <span class="image-uploader__source-arrow">›</span>
            </button>
          </div>
        </section>
      </div>
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
import { prepareImage } from './imagePrepare.js';

const props = defineProps({
  modelValue: { type: [String, Array], default: '' },
  upload: { type: Function, required: true },
  cropperClass: { type: Function, required: true },
  libraryPicker: { type: Function, default: null },
  presets: { type: Array, default: () => [] },
  multiple: { type: Boolean, default: false },
  max: { type: Number, default: 9 },
  disabled: { type: Boolean, default: false },
  // required：选完必须裁剪（老行为）；optional：直接上传原图，裁剪改成可选入口
  crop: { type: String, default: 'required' },
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
const sourcePickerVisible = ref(false);
const activeUploadOptions = ref({});
// 编辑器当前处理的是「新增」还是「替换第 N 张」
const activeReplaceIndex = ref(-1);
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

function openSourcePicker() {
  errorText.value = '';
  sourcePickerVisible.value = true;
}

function chooseLocal() {
  sourcePickerVisible.value = false;
  inputEl.value?.click();
}

async function chooseLibrary() {
  sourcePickerVisible.value = false;
  try {
    const result = await props.libraryPicker();
    if (!result || result.type === 'cancel') return;
    if (result.type === 'files') {
      processFiles(result.files || [], result.group_id ? { group_id: result.group_id } : {});
      return;
    }
    const selected = result.type === 'select' ? (result.urls || []) : (Array.isArray(result) ? result : []);
    if (!selected.length) return;
    busy.value = true;
    errorText.value = '';
    const files = [];
    for (let index = 0; index < selected.length; index += 1) {
      status.value = `正在读取文件管理图片 ${index + 1}/${selected.length}…`;
      files.push(await fetchImageFile(selected[index]));
    }
    busy.value = false;
    processFiles(files);
  } catch (error) {
    busy.value = false;
    status.value = '';
    errorText.value = error?.message || '读取文件管理图片失败，请重试';
  }
}

async function fetchImageFile(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('无法读取所选图片，请检查图片地址后重试');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('所选文件不是可处理的图片');
  const pathname = new URL(url, location.href).pathname;
  let name = pathname.split('/').pop() || `media-${Date.now()}.jpg`;
  try { name = decodeURIComponent(name); } catch {}
  return new File([blob], name, { type: blob.type, lastModified: Date.now() });
}

function onSelect(event) {
  errorText.value = '';
  const selected = [...(event.target.files || [])];
  event.target.value = '';
  processFiles(selected);
}

function processFiles(selected, uploadOptions = {}) {
  if (!selected.length) return;
  const remaining = props.multiple ? Math.max(0, props.max - urls.value.length) : 1;
  if (props.multiple && selected.length > remaining) errorText.value = `最多可上传 ${props.max} 张，已选图片将按剩余位置处理`;
  const picked = selected.slice(0, remaining);
  if (!picked.length) return;
  if (props.crop === 'required') {
    queue.value = picked.map((file) => ({ file, uploadOptions, replaceIndex: -1 }));
    busy.value = true;
    startNext();
    return;
  }
  uploadDirect(picked, uploadOptions);
}

// 不裁剪模式：等比压缩后直接上传，不进裁剪器
async function uploadDirect(files, uploadOptions) {
  busy.value = true;
  errorText.value = '';
  let acc = props.multiple ? [...urls.value] : [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      if (files.length > 1) status.value = `正在处理第 ${index + 1}/${files.length} 张图片…`;
      else status.value = '正在处理图片…';
      const ready = await prepareImage(files[index]);
      status.value = '正在上传图片…';
      const url = await props.upload(ready, uploadOptions);
      acc = props.multiple ? [...acc, url] : [url];
      updateUrls(acc);
      emit('uploaded', url, ready);
    }
  } catch (error) {
    errorText.value = error?.message || '上传失败，请重试';
  } finally {
    busy.value = false;
    status.value = '';
  }
}

// 已上传的图片想改裁剪：读回文件 → 进编辑器 → 处理完替换原位置
async function recropAt(index) {
  if (props.disabled || busy.value) return;
  const url = urls.value[index];
  if (!url) return;
  errorText.value = '';
  busy.value = true;
  status.value = '正在读取图片…';
  try {
    const file = await fetchImageFile(url);
    queue.value = [{ file, uploadOptions: {}, replaceIndex: index }];
    startNext();
  } catch (error) {
    busy.value = false;
    status.value = '';
    errorText.value = error?.message || '无法读取这张图片，请重试';
  }
}

function startNext() {
  const next = queue.value.shift();
  if (!next) {
    editorVisible.value = false;
    busy.value = false;
    status.value = '';
    activeReplaceIndex.value = -1;
    return;
  }
  activeFile.value = next.file;
  activeUploadOptions.value = next.uploadOptions;
  activeReplaceIndex.value = next.replaceIndex ?? -1;
  status.value = props.multiple ? `待处理 ${queue.value.length + 1} 张` : '请完成图片裁剪与压缩';
  editorVisible.value = true;
}

function cancelQueue() {
  editorVisible.value = false;
  queue.value = [];
  busy.value = false;
  status.value = '';
  activeUploadOptions.value = {};
  activeReplaceIndex.value = -1;
}

async function onProcessed(file) {
  const replaceIndex = activeReplaceIndex.value;
  editorVisible.value = false;
  try {
    status.value = '正在上传处理后的图片…';
    const url = await props.upload(file, activeUploadOptions.value);
    if (replaceIndex >= 0 && replaceIndex < urls.value.length) {
      const next = [...urls.value];
      next[replaceIndex] = url;
      updateUrls(next);
    } else {
      const next = props.multiple ? [...urls.value, url] : [url];
      updateUrls(next);
    }
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
.image-uploader__crop { position:absolute;top:4px;left:4px;padding:2px 8px;border:0;border-radius:9px;background:rgba(24,29,38,.64);color:#fff;font:inherit;font-size:10px;line-height:1.6;cursor:pointer;transition:background .16s ease; }
.image-uploader__crop:hover { background:rgba(223,89,67,.92); }
.image-uploader__crop:disabled { cursor:wait;opacity:.4; }
.image-uploader__add { display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:1px dashed #cbd1da;background:#fafbfc;color:#77818f;font:inherit;font-size:11px;cursor:pointer;transition:border-color .16s ease,background .16s ease,color .16s ease; }
.image-uploader__add:hover { border-color:#e77967;background:#fff8f6;color:#d7513b; }
.image-uploader__add:disabled { opacity:.6;cursor:wait; }
.image-uploader__plus { font-size:31px;font-weight:300;line-height:1;color:#a0a8b3; }
.image-uploader__input { display:none; }
.image-uploader__source-overlay { position:fixed;inset:0;z-index:2990;display:grid;place-items:center;padding:18px;background:rgba(18,23,32,.48);backdrop-filter:blur(3px); }
.image-uploader__source-panel { width:min(420px,100%);overflow:hidden;border:1px solid #edf0f4;border-radius:16px;background:#fff;box-shadow:0 20px 70px rgba(18,27,42,.22);color:#252b35; }
.image-uploader__source-head { display:flex;align-items:flex-start;justify-content:space-between;padding:20px 20px 15px;border-bottom:1px solid #f0f2f5; }
.image-uploader__source-head h2 { margin:0;font-size:16px;font-weight:650; }
.image-uploader__source-head p { margin:5px 0 0;color:#929aa6;font-size:11px; }
.image-uploader__source-close { width:28px;height:28px;border:0;border-radius:50%;background:#f3f5f7;color:#747d89;font-size:21px;line-height:1;cursor:pointer; }
.image-uploader__source-options { display:grid;gap:8px;padding:14px; }
.image-uploader__source-option { display:flex;align-items:center;gap:12px;width:100%;padding:13px;border:1px solid #e9edf2;border-radius:11px;background:#fff;color:#303743;font:inherit;text-align:left;cursor:pointer;transition:border-color .16s ease,background .16s ease,transform .16s ease; }
.image-uploader__source-option:hover,.image-uploader__source-option:focus-visible { border-color:#f1b5aa;background:#fff9f7;outline:none; }
.image-uploader__source-option:active { transform:scale(.99); }
.image-uploader__source-icon { width:38px;height:38px;display:grid;place-items:center;border-radius:10px;background:#fff0ec;color:#df5943;font-size:22px;font-weight:500; }
.image-uploader__source-icon--library { background:#eef3ff;color:#5375c8;font-size:20px; }
.image-uploader__source-option strong,.image-uploader__source-option small { display:block; }
.image-uploader__source-option strong { font-size:12px;font-weight:650; }
.image-uploader__source-option small { margin-top:3px;color:#9098a4;font-size:10px; }
.image-uploader__source-arrow { margin-left:auto;color:#a0a7b1;font-size:23px;font-weight:300; }
.image-uploader__status,.image-uploader__error { color:#9299a3;font-size:11px;line-height:1.4; }
.image-uploader__error { color:#d94e40; }
.image-uploader__lightbox { position:fixed;inset:0;z-index:3100;display:grid;place-items:center;padding:5vh 5vw;background:rgba(9,12,18,.88);cursor:zoom-out; }
.image-uploader__lightbox img { max-width:90vw;max-height:88vh;object-fit:contain;border-radius:8px;box-shadow:0 18px 70px rgba(0,0,0,.35); }
.image-uploader__lightbox-close { position:absolute;top:18px;right:20px;width:42px;height:42px;border:1px solid rgba(255,255,255,.28);border-radius:50%;background:rgba(0,0,0,.25);color:white;font-size:30px;line-height:1;cursor:pointer; }
@media(max-width:600px) { .image-uploader__tile,.image-uploader__add { width:88px;height:88px; } }
</style>
