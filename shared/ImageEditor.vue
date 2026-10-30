<template>
  <Teleport to="body">
    <div v-if="visible" class="image-editor" role="dialog" aria-modal="true" aria-labelledby="image-editor-title" @click.self="close">
      <section class="image-editor__panel">
        <header class="image-editor__header">
          <div>
            <h2 id="image-editor-title">图片裁剪与压缩</h2>
            <p>调整取景范围，确认后再上传</p>
          </div>
          <button class="image-editor__close" aria-label="关闭" @click="close">×</button>
        </header>

        <div class="image-editor__crop-area">
          <img v-if="imageUrl" ref="imageEl" :src="imageUrl" alt="待裁剪图片" />
        </div>

        <div class="image-editor__controls">
          <div class="image-editor__row image-editor__ratios">
            <span class="image-editor__label">裁剪比例</span>
            <div class="image-editor__options">
              <button v-for="ratio in ratios" :key="ratio.label" type="button" :class="{ active: selectedRatio === ratio.value && !selectedPreset }" @click="setRatio(ratio.value)">{{ ratio.label }}</button>
            </div>
            <button class="image-editor__rotate" type="button" title="向左旋转" @click="cropper?.rotate(-90)">↶ 旋转</button>
          </div>

          <div v-if="presets.length" class="image-editor__row image-editor__preset-row">
            <span class="image-editor__label">尺寸预设</span>
            <div class="image-editor__options">
              <button v-for="preset in presets" :key="presetKey(preset)" type="button" :class="{ active: selectedPreset === presetKey(preset) }" @click="setPreset(preset)">
                {{ preset.label || `${preset.width} × ${preset.height}` }}
              </button>
            </div>
            <span v-if="selectedPresetData" class="image-editor__preset-size">输出 {{ selectedPresetData.width }} × {{ selectedPresetData.height }} px</span>
          </div>

          <div class="image-editor__quality">
            <div class="image-editor__quality-head">
              <span class="image-editor__label">压缩质量</span>
              <strong>{{ quality }}%</strong>
            </div>
            <input v-model.number="quality" type="range" min="35" max="95" step="1" aria-label="压缩质量" />
            <div class="image-editor__range-labels"><span>文件更小</span><span>画质更高</span></div>
          </div>

          <div class="image-editor__bottom">
            <label class="image-editor__format"><input v-model="webp" type="checkbox" /> 转为 WebP</label>
            <span class="image-editor__source">原图 {{ sourceSize }}</span>
            <div class="image-editor__actions">
              <button class="image-editor__cancel" @click="close">取消</button>
              <button class="image-editor__confirm" :disabled="processing || !cropper" @click="confirm">{{ processing ? '处理中…' : '处理并上传' }}</button>
            </div>
          </div>
          <p class="image-editor__note">图片将在浏览器本地裁剪、缩放和压缩，处理完成后只上传成品。</p>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
const props = defineProps({
  visible: { type: Boolean, default: false },
  file: { type: File, default: null },
  cropperClass: { type: Function, required: true },
  presets: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'processed', 'error']);
const imageEl = ref(null);
const imageUrl = ref('');
const quality = ref(82);
const webp = ref(true);
const processing = ref(false);
const selectedRatio = ref('free');
const selectedPreset = ref('');
const selectedPresetData = computed(() => props.presets.find((preset) => presetKey(preset) === selectedPreset.value) || null);
const sourceSize = computed(() => formatSize(props.file?.size || 0));
const ratios = [
  { label: '自由', value: 'free' },
  { label: '横幅 3:1', value: 3 },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '16:9', value: 16 / 9 },
  { label: '3:2', value: 3 / 2 },
  { label: '3:4', value: 3 / 4 },
  { label: '9:16', value: 9 / 16 },
];
let cropper;
let objectUrl = '';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function disposeCropper() {
  cropper?.destroy();
  cropper = undefined;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = '';
  imageUrl.value = '';
}

async function initialize() {
  disposeCropper();
  if (!props.visible || !props.file) return;
  objectUrl = URL.createObjectURL(props.file);
  imageUrl.value = objectUrl;
  selectedRatio.value = 'free';
  selectedPreset.value = '';
  quality.value = 82;
  webp.value = true;
  await nextTick();
  if (!imageEl.value) return;
  cropper = new props.cropperClass(imageEl.value, {
    viewMode: 1,
    dragMode: 'move',
    autoCropArea: 0.88,
    responsive: true,
    restore: false,
    guides: true,
    center: true,
    highlight: false,
    background: false,
    movable: true,
    zoomable: true,
    zoomOnWheel: true,
    cropBoxMovable: true,
    cropBoxResizable: true,
    toggleDragModeOnDblclick: false,
  });
}

function setRatio(value) {
  selectedRatio.value = value;
  selectedPreset.value = '';
  cropper?.setAspectRatio(value === 'free' ? NaN : value);
}

function presetKey(preset) {
  return `${Number(preset.width)}x${Number(preset.height)}`;
}

function setPreset(preset) {
  const width = Number(preset.width);
  const height = Number(preset.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return;
  selectedPreset.value = presetKey(preset);
  cropper?.setAspectRatio(width / height);
}

function close() {
  disposeCropper();
  emit('close');
}

function toBlob(canvas, type, q) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片处理失败，请换一种格式重试')), type, q);
  });
}

async function confirm() {
  if (!cropper || !props.file || processing.value) return;
  processing.value = true;
  try {
    const canvasOptions = {
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
      fillColor: webp.value ? undefined : '#fff',
    };
    if (selectedPresetData.value) {
      canvasOptions.width = Number(selectedPresetData.value.width);
      canvasOptions.height = Number(selectedPresetData.value.height);
    } else {
      canvasOptions.maxWidth = 2400;
      canvasOptions.maxHeight = 2400;
    }
    const canvas = cropper.getCroppedCanvas(canvasOptions);
    if (!canvas) throw new Error('无法生成裁剪图片');
    const requestedType = webp.value ? 'image/webp' : 'image/jpeg';
    const blob = await toBlob(canvas, requestedType, quality.value / 100);
    const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/png' ? 'png' : 'jpg';
    const name = (props.file.name || 'image').replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fff-]+/g, '_');
    const result = new File([blob], `${name}.${ext}`, { type: blob.type || requestedType, lastModified: Date.now() });
    emit('processed', result);
    disposeCropper();
  } catch (error) {
    emit('error', error instanceof Error ? error.message : '图片处理失败');
  } finally {
    processing.value = false;
  }
}

watch(() => [props.visible, props.file], initialize, { flush: 'post' });
onUnmounted(disposeCropper);
</script>

<style>
.image-editor { position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:20px;background:var(--app-overlay,rgba(15,19,28,.62));backdrop-filter:blur(4px); }
.image-editor__panel { width:min(720px,100%);max-height:min(94dvh,900px);overflow:auto;background:#fff;border-radius:var(--app-modal-radius,18px);box-shadow:var(--app-modal-shadow,0 24px 80px rgba(0,0,0,.28));color:#22252b; }
.image-editor__header { display:flex;align-items:flex-start;justify-content:space-between;padding:20px 22px 15px;border-bottom:1px solid #eef0f3; }
.image-editor__header h2 { margin:0;font-size:18px;font-weight:700; }
.image-editor__header p { margin:4px 0 0;font-size:12px;color:#8c93a0; }
.image-editor__close { border:0;background:#f4f5f7;border-radius:50%;width:30px;height:30px;font-size:22px;line-height:1;color:#747b86;cursor:pointer; }
.image-editor__crop-area { height:min(44vh,390px);min-height:210px;margin:16px 22px;background:#f0f2f5;overflow:hidden; }
.image-editor__crop-area img { display:block;max-width:100%; }
.image-editor__controls { padding:0 22px 18px; }
.image-editor__row { display:flex;align-items:center;gap:12px; }
.image-editor__label { color:#555d68;font-size:12px;font-weight:600;white-space:nowrap; }
.image-editor__options { display:flex;gap:6px;flex-wrap:wrap; }
.image-editor__options button,.image-editor__rotate { border:1px solid #e7e9ed;background:#fff;color:#68707c;border-radius:7px;padding:6px 10px;font:inherit;font-size:11px;cursor:pointer; }
.image-editor__options button.active { color:#cf4935;border-color:#f3b5aa;background:#fff3f0; }
.image-editor__rotate { margin-left:auto; }
.image-editor__preset-row { margin-top:10px; }
.image-editor__preset-size { margin-left:auto;color:#8e96a1;font-size:10px;white-space:nowrap; }
.image-editor__quality { margin-top:16px;padding:13px 14px 10px;border-radius:11px;background:#f7f8fa; }
.image-editor__quality-head { display:flex;justify-content:space-between;align-items:center; }
.image-editor__quality-head strong { color:#cf4935;font-size:13px;font-variant-numeric:tabular-nums; }
.image-editor__quality input { width:100%;height:4px;margin:14px 0 5px;accent-color:#e4553d;cursor:pointer; }
.image-editor__range-labels { display:flex;justify-content:space-between;color:#9ba1aa;font-size:10px; }
.image-editor__bottom { display:flex;align-items:center;gap:14px;margin-top:15px; }
.image-editor__format { display:flex;align-items:center;gap:6px;color:#444b55;font-size:12px;font-weight:550;white-space:nowrap; }
.image-editor__format input { accent-color:#df5038; }
.image-editor__source { color:#9aa0aa;font-size:11px;white-space:nowrap; }
.image-editor__actions { display:flex;gap:8px;margin-left:auto; }
.image-editor__actions button { border-radius:8px;padding:9px 14px;font:inherit;font-size:12px;font-weight:600;cursor:pointer; }
.image-editor__cancel { border:1px solid #e5e8ed;background:#fff;color:#66707d; }
.image-editor__confirm { border:1px solid #df5038;background:linear-gradient(135deg,#f46c52,#df4932);color:#fff;box-shadow:0 4px 10px rgba(223,73,50,.2); }
.image-editor__confirm:disabled { opacity:.55;cursor:wait; }
.image-editor__note { margin:12px 0 0;color:#9aa0aa;font-size:10px; }
@media (max-width:600px) {
  .image-editor { padding:10px;align-items:end; }
  .image-editor__panel { max-height:94dvh;border-radius:18px 18px 12px 12px; }
  .image-editor__header { padding:16px 16px 12px; }
  .image-editor__crop-area { height:36vh;min-height:190px;margin:12px 16px; }
  .image-editor__controls { padding:0 16px 16px; }
  .image-editor__row { gap:7px;flex-wrap:wrap; }
  .image-editor__preset-size { margin-left:0; }
  .image-editor__options { gap:4px; }
  .image-editor__options button { padding:6px 8px; }
  .image-editor__bottom { gap:9px;flex-wrap:wrap; }
  .image-editor__actions { width:100%;margin:3px 0 0; }
  .image-editor__actions button { flex:1; }
}
</style>
