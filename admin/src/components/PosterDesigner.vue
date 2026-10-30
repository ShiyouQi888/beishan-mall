<template>
  <div class="poster-designer">
    <section class="poster-designer__preview-panel">
      <div class="poster-designer__panel-head">
        <div>
          <h3>海报预览</h3>
          <p>拖动任意元素调整位置，拖动右下角可缩放</p>
        </div>
        <el-tag size="small" effect="plain">750 × 1334</el-tag>
      </div>
      <div class="poster-designer__stage-wrap">
        <div class="poster-designer__stage" :style="stageStyle">
          <img v-if="values.poster_bg" class="poster-designer__background" :src="values.poster_bg" alt="海报背景" />
          <div v-else class="poster-designer__empty">
            <span class="poster-designer__empty-icon">▧</span>
            <strong>上传海报背景</strong>
            <span>建议 750 × 1334 px 竖版图片</span>
          </div>
          <div class="poster-designer__safe-area" aria-hidden="true" />
          <div class="poster-designer__crosshair poster-designer__crosshair--h" aria-hidden="true" />
          <div class="poster-designer__crosshair poster-designer__crosshair--v" aria-hidden="true" />
          <div v-if="values.poster_logo" class="poster-designer__item poster-designer__item--logo" :style="itemStyle('logo')" role="button" tabindex="0" aria-label="拖动或缩放商城 Logo" @pointerdown.prevent="startManipulate('logo', 'move', $event)" @keydown="nudge('logo', $event)">
            <img :src="values.poster_logo" alt="商城 Logo" />
            <span class="poster-designer__resize" title="拖动缩放" @pointerdown.stop.prevent="startManipulate('logo', 'resize', $event)">↘</span>
          </div>
          <div class="poster-designer__item poster-designer__item--text" :style="itemStyle('title')" role="button" tabindex="0" aria-label="拖动或缩放海报主标题" @pointerdown.prevent="startManipulate('title', 'move', $event)" @keydown="nudge('title', $event)">
            <strong>{{ values.poster_title || '邀请好友加入' }}</strong>
            <span class="poster-designer__resize" title="拖动缩放" @pointerdown.stop.prevent="startManipulate('title', 'resize', $event)">↘</span>
          </div>
          <div class="poster-designer__item poster-designer__item--text poster-designer__item--subtitle" :style="itemStyle('subtitle')" role="button" tabindex="0" aria-label="拖动或缩放海报副标题" @pointerdown.prevent="startManipulate('subtitle', 'move', $event)" @keydown="nudge('subtitle', $event)">
            <span>{{ values.poster_subtitle || '一起分享好物与收益' }}</span>
            <span class="poster-designer__resize" title="拖动缩放" @pointerdown.stop.prevent="startManipulate('subtitle', 'resize', $event)">↘</span>
          </div>
          <div class="poster-designer__item poster-designer__item--qr" :style="itemStyle('qr')" role="button" tabindex="0" aria-label="拖动或缩放海报二维码" @pointerdown.prevent="startManipulate('qr', 'move', $event)" @keydown="nudge('qr', $event)">
            <img :src="qrImage" alt="二维码预览" draggable="false" />
            <span class="poster-designer__resize" title="拖动缩放" @pointerdown.stop.prevent="startManipulate('qr', 'resize', $event)">↘</span>
          </div>
          <div class="poster-designer__item poster-designer__item--text poster-designer__item--caption" :style="itemStyle('content')" role="button" tabindex="0" aria-label="拖动或缩放海报说明文字" @pointerdown.prevent="startManipulate('content', 'move', $event)" @keydown="nudge('content', $event)">
            <span>{{ values.poster_content || '长按识别二维码，立即加入' }}</span>
            <span class="poster-designer__resize" title="拖动缩放" @pointerdown.stop.prevent="startManipulate('content', 'resize', $event)">↘</span>
          </div>
          <div class="poster-designer__item poster-designer__item--text poster-designer__item--code" :style="itemStyle('code')" role="button" tabindex="0" aria-label="拖动或缩放海报邀请码" @pointerdown.prevent="startManipulate('code', 'move', $event)" @keydown="nudge('code', $event)">
            <span>邀请码：A12345</span>
            <span class="poster-designer__resize" title="拖动缩放" @pointerdown.stop.prevent="startManipulate('code', 'resize', $event)">↘</span>
          </div>
        </div>
      </div>
      <div class="poster-designer__legend"><i /> 画布中心参考线 <span>二维码位置及尺寸会同步用于邀请海报</span></div>
    </section>

    <section class="poster-designer__controls">
      <div class="poster-designer__section">
        <div class="poster-designer__section-title"><span class="poster-designer__step">01</span><div><h3>海报素材</h3><p>上传背景和商城标识</p></div></div>
        <el-form label-position="top" class="poster-designer__form">
          <el-form-item label="海报背景">
            <ImageUploader v-model="values.poster_bg" :upload="upload" />
            <small>推荐 750 × 1334 px，竖版比例更适合手机分享。</small>
          </el-form-item>
          <el-form-item label="商城 Logo">
            <ImageUploader v-model="values.poster_logo" :upload="upload" />
            <small>透明 PNG 或 WebP 效果更好，将显示在海报左上方。</small>
          </el-form-item>
        </el-form>
      </div>

      <div class="poster-designer__section">
        <div class="poster-designer__section-title"><span class="poster-designer__step">02</span><div><h3>邀请文案</h3><p>实时显示在海报预览中</p></div></div>
        <el-form label-position="top" class="poster-designer__form">
          <el-form-item label="主标题"><el-input v-model="values.poster_title" maxlength="24" show-word-limit placeholder="邀请好友加入" /></el-form-item>
          <el-form-item label="副标题"><el-input v-model="values.poster_subtitle" maxlength="32" show-word-limit placeholder="一起分享好物与收益" /></el-form-item>
          <el-form-item label="说明文字"><el-input v-model="values.poster_content" type="textarea" :rows="2" maxlength="80" show-word-limit placeholder="长按识别二维码，立即加入" /></el-form-item>
        </el-form>
      </div>

      <div class="poster-designer__section poster-designer__qr-controls">
        <div class="poster-designer__section-title"><span class="poster-designer__step">03</span><div><h3>二维码位置</h3><p>拖动预览中的二维码或使用精确数值</p></div></div>
        <div class="poster-designer__coords">
          <label>X 坐标 <el-input-number v-model="values.poster_qr_x" :min="0" :max="750 - qrSize" :step="5" controls-position="right" /></label>
          <label>Y 坐标 <el-input-number v-model="values.poster_qr_y" :min="0" :max="1334 - qrSize" :step="5" controls-position="right" /></label>
        </div>
        <label class="poster-designer__slider-label"><span>二维码尺寸</span><strong>{{ qrSize }} px</strong></label>
        <el-slider v-model="values.poster_qr_size" :min="120" :max="320" :step="4" @input="clampPosition" />
        <p class="poster-designer__tip">中心参考线帮助快速对齐。拖动二维码即可自由调整位置，二维码始终保持正方形。</p>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import QRCode from 'qrcode';
import ImageUploader from './ImageUploader.vue';

const props = defineProps({ values: { type: Object, required: true }, upload: { type: Function, required: true } });
const qrImage = ref('');
const dragging = ref('');
const start = ref(null);
const qrSize = computed(() => Number(props.values.poster_qr_size) || 220);
const stageScale = computed(() => Math.min(0.5, 320 / 750));
const stageStyle = computed(() => ({ width: `${750 * stageScale.value}px`, height: `${1334 * stageScale.value}px`, backgroundImage: props.values.poster_bg ? `url("${props.values.poster_bg}")` : '' }));
const itemDefaults = {
  logo: { x: 54, y: 60, size: 116 }, qr: { x: 265, y: 850, size: 220 },
  title: { x: 60, y: 240, size: 54 }, subtitle: { x: 60, y: 315, size: 30 },
  content: { x: 60, y: 1190, size: 25 }, code: { x: 60, y: 1280, size: 22 },
};
function itemValue(kind, key) {
  const raw = props.values[`poster_${kind}_${key}`];
  if (raw === '' || raw === null || raw === undefined) return itemDefaults[kind][key];
  const value = Number(raw);
  return Number.isFinite(value) && (key !== 'size' || value > 0) ? value : itemDefaults[kind][key];
}
function itemStyle(kind) {
  const x = itemValue(kind, 'x');
  const y = itemValue(kind, 'y');
  const size = itemValue(kind, 'size');
  const style = { left: `${x * stageScale.value}px`, top: `${y * stageScale.value}px` };
  if (kind === 'qr' || kind === 'logo') {
    style.width = `${size * stageScale.value}px`;
    style.height = `${size * stageScale.value}px`;
  } else {
    style.fontSize = `${size * stageScale.value}px`;
    style.maxWidth = `${650 * stageScale.value}px`;
  }
  return style;
}

async function makeQr() {
  try { qrImage.value = await QRCode.toDataURL('https://example.com/register?code=INVITE', { width: 256, margin: 1, errorCorrectionLevel: 'H', color: { dark: '#18212b', light: '#ffffff' } }); } catch { qrImage.value = ''; }
}
function clampPosition() {
  props.values.poster_qr_x = Math.max(0, Math.min(750 - qrSize.value, itemValue('qr', 'x')));
  props.values.poster_qr_y = Math.max(0, Math.min(1334 - qrSize.value, itemValue('qr', 'y')));
}
function startManipulate(kind, mode, event) {
  const target = mode === 'resize' ? event.currentTarget.parentElement : event.currentTarget;
  const prefix = `poster_${kind}`;
  dragging.value = mode;
  start.value = {
    kind, prefix, x: event.clientX, y: event.clientY,
    left: itemValue(kind, 'x'),
    top: itemValue(kind, 'y'),
    size: itemValue(kind, 'size'),
  };
  target.setPointerCapture(event.pointerId);
  target.addEventListener('pointermove', movePointer);
  target.addEventListener('pointerup', endPointer, { once: true });
}
function movePointer(event) {
  if (!start.value) return;
  const dx = (event.clientX - start.value.x) / stageScale.value;
  const dy = (event.clientY - start.value.y) / stageScale.value;
  if (dragging.value === 'move') {
    props.values[`${start.value.prefix}_x`] = Math.round(Math.max(0, Math.min(750, start.value.left + dx)));
    props.values[`${start.value.prefix}_y`] = Math.round(Math.max(0, Math.min(1334, start.value.top + dy)));
  } else {
    const min = start.value.kind === 'qr' ? 120 : start.value.kind === 'logo' ? 48 : 14;
    const max = start.value.kind === 'qr' ? 320 : start.value.kind === 'logo' ? 260 : 100;
    props.values[`${start.value.prefix}_size`] = Math.round(Math.max(min, Math.min(max, start.value.size + Math.max(dx, dy))));
  }
}
function nudge(kind, event) {
  const directions = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] };
  const delta = directions[event.key];
  if (!delta) return;
  event.preventDefault();
  const prefix = `poster_${kind}`;
  props.values[`${prefix}_x`] = Math.max(0, Math.min(750, itemValue(kind, 'x') + delta[0]));
  props.values[`${prefix}_y`] = Math.max(0, Math.min(1334, itemValue(kind, 'y') + delta[1]));
}
function endPointer(event) {
  event.currentTarget?.removeEventListener('pointermove', movePointer);
  dragging.value = '';
  start.value = null;
}
watch(() => props.values.poster_qr_size, clampPosition);
onMounted(makeQr);
</script>

<style scoped>
.poster-designer{display:grid;grid-template-columns:minmax(300px,390px) minmax(360px,1fr);gap:24px;align-items:start}.poster-designer__preview-panel,.poster-designer__section{border:1px solid #e9edf2;border-radius:14px;background:#fff}.poster-designer__preview-panel{padding:18px;position:sticky;top:16px}.poster-designer__panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}.poster-designer h3{margin:0;color:#252b35;font-size:14px;font-weight:650}.poster-designer__panel-head p,.poster-designer__section-title p{margin:5px 0 0;color:#9299a5;font-size:11px}.poster-designer__stage-wrap{display:flex;justify-content:center;max-height:70vh;overflow:auto;background:#f3f5f8;padding:12px;border-radius:10px}.poster-designer__stage{position:relative;flex:none;overflow:hidden;background-color:#ede9e3;background-size:100% 100%;background-position:center;border-radius:5px;box-shadow:0 6px 20px #2433481c;color:white}.poster-designer__background{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.poster-designer__empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;color:#78818e;background:linear-gradient(145deg,#f5f2ec,#d7d0c3);text-align:center}.poster-designer__empty strong{font-size:14px}.poster-designer__empty span:last-child{font-size:10px}.poster-designer__empty-icon{font-size:34px;color:#a0a7b1}.poster-designer__safe-area{position:absolute;inset:7%;border:1px dashed #ffffff8c;pointer-events:none}.poster-designer__crosshair{position:absolute;z-index:1;pointer-events:none;opacity:.65}.poster-designer__crosshair--h{left:0;right:0;top:50%;border-top:1px dashed #fff}.poster-designer__crosshair--v{top:0;bottom:0;left:50%;border-left:1px dashed #fff}.poster-designer__logo{position:absolute;z-index:2;top:7%;left:8%;width:17%;aspect-ratio:1;border-radius:12px;overflow:hidden;background:#ffffffdf;padding:3px;box-shadow:0 2px 10px #0002}.poster-designer__logo img{width:100%;height:100%;object-fit:contain}.poster-designer__headline{position:absolute;z-index:2;top:12%;left:8%;right:8%;display:flex;flex-direction:column;gap:8px;text-shadow:0 1px 8px #0008;pointer-events:none}.poster-designer__headline strong{font-size:clamp(16px,5vw,28px);line-height:1.3}.poster-designer__headline span{font-size:clamp(10px,2.5vw,14px)}.poster-designer__qr{position:absolute;z-index:3;box-sizing:border-box;background:white;padding:4px;cursor:move;touch-action:none;box-shadow:0 2px 9px #10182838;border:1px solid #fff}.poster-designer__qr img{width:100%;height:100%;display:block;pointer-events:none}.poster-designer__resize{position:absolute;right:-1px;bottom:-1px;width:16px;height:16px;display:grid;place-items:center;background:#fff;color:#e3553b;border-radius:5px 0 0 0;font-size:14px;line-height:1;cursor:nwse-resize}.poster-designer__hint{position:absolute;z-index:2;bottom:7%;left:0;right:0;text-align:center;font-size:clamp(9px,2.2vw,13px);text-shadow:0 1px 6px #0008;pointer-events:none}.poster-designer__legend{display:flex;align-items:center;gap:7px;margin-top:12px;font-size:10px;color:#717b89}.poster-designer__legend i{width:9px;height:1px;border-top:1px dashed #e3553b}.poster-designer__legend span{margin-left:auto;color:#a1a7b0}.poster-designer__controls{display:flex;flex-direction:column;gap:14px}.poster-designer__section{padding:18px}.poster-designer__section-title{display:flex;gap:11px;align-items:center;margin-bottom:17px}.poster-designer__section-title p{margin-top:4px}.poster-designer__step{width:30px;height:30px;display:grid;place-items:center;border-radius:9px;background:#fff1ed;color:#e45d44;font-size:10px;font-weight:700}.poster-designer__form :deep(.el-form-item){margin-bottom:14px}.poster-designer__form :deep(.el-form-item__label){height:auto;margin:0 0 7px;color:#505966;font-size:12px;line-height:1.4}.poster-designer__form small{display:block;margin-top:7px;color:#969da7;font-size:10px;line-height:1.5}.poster-designer__coords{display:grid;grid-template-columns:1fr 1fr;gap:12px}.poster-designer__coords label,.poster-designer__slider-label{display:flex;flex-direction:column;gap:7px;color:#666e79;font-size:11px}.poster-designer__coords :deep(.el-input-number){width:100%}.poster-designer__slider-label{flex-direction:row;justify-content:space-between;align-items:center;margin-top:20px}.poster-designer__slider-label strong{color:#e3553b;font-size:12px}.poster-designer__qr-controls :deep(.el-slider){margin:4px 7px 0}.poster-designer__tip{margin:8px 0 0;color:#9098a3;font-size:10px;line-height:1.6}@media(max-width:980px){.poster-designer{grid-template-columns:1fr}.poster-designer__preview-panel{position:static;max-width:480px;width:100%;justify-self:center}.poster-designer__stage-wrap{max-height:60vh}}@media(max-width:600px){.poster-designer{grid-template-columns:minmax(0,1fr);gap:12px}.poster-designer__preview-panel,.poster-designer__section{padding:14px}.poster-designer__stage-wrap{padding:8px}}
.poster-designer__item{position:absolute;z-index:3;box-sizing:border-box;touch-action:none;user-select:none;cursor:move;outline:1px dashed transparent;outline-offset:2px;text-shadow:0 1px 8px #0008}.poster-designer__item:hover,.poster-designer__item:focus-visible{outline-color:#fff;box-shadow:0 0 0 1px #e3553b}.poster-designer__item--logo{display:grid;place-items:center;overflow:visible;border-radius:12px;background:#ffffffdf;padding:4px;box-shadow:0 2px 10px #0002;text-shadow:none}.poster-designer__item--logo img{width:100%;height:100%;object-fit:contain;pointer-events:none}.poster-designer__item--text{line-height:1.3;font-weight:700;color:#fff;white-space:normal}.poster-designer__item--text strong{display:block}.poster-designer__item--subtitle{font-weight:500}.poster-designer__item--caption,.poster-designer__item--code{font-weight:500;text-align:center}.poster-designer__item--qr{box-sizing:border-box;background:#fff;padding:4px;box-shadow:0 2px 9px #10182838;border:1px solid #fff;text-shadow:none}.poster-designer__item--qr img{width:100%;height:100%;display:block;pointer-events:none}.poster-designer__resize{position:absolute;right:-1px;bottom:-1px;width:16px;height:16px;display:grid;place-items:center;background:#fff;color:#e3553b;border-radius:5px 0 0 0;font-size:14px;line-height:1;cursor:nwse-resize;text-shadow:none;opacity:.92;transition:opacity .12s ease}
</style>
