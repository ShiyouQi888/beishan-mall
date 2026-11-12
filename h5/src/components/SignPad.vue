<template>
  <div class="signpad">
    <canvas
      ref="cv"
      class="signpad__canvas"
      @pointerdown="start"
      @pointermove="move"
      @pointerup="end"
      @pointercancel="end"
    />
    <div v-if="!hasInk" class="signpad__ph">请在此处手写签名</div>
    <button type="button" class="signpad__clear" @click="clear">重签</button>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';

const cv = ref(null);
const hasInk = ref(false);
let ctx = null;
let drawing = false;
let last = null;
let ro = null;

/** 画布用 CSS 尺寸 × DPR 初始化，并铺白底（透明 PNG 在后台看不清） */
function setup() {
  const c = cv.value;
  if (!c) return;
  const rect = c.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(rect.width * dpr);
  c.height = Math.round(rect.height * dpr);
  ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#1f2937';
}

function pos(e) {
  const r = cv.value.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function start(e) {
  if (!ctx) return;
  drawing = true;
  last = pos(e);
  try { cv.value.setPointerCapture(e.pointerId); } catch {}
  // 点一下也留下一个点，避免"点按没画出来"
  ctx.beginPath();
  ctx.arc(last.x, last.y, 1.2, 0, Math.PI * 2);
  ctx.fillStyle = '#1f2937';
  ctx.fill();
  hasInk.value = true;
  e.preventDefault();
}

function move(e) {
  if (!drawing || !ctx) return;
  const p = pos(e);
  ctx.beginPath();
  ctx.moveTo(last.x, last.y);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
  last = p;
  e.preventDefault();
}

function end(e) {
  drawing = false;
  last = null;
  if (e) e.preventDefault();
}

function clear() {
  hasInk.value = false;
  setup();
}

/** 保留笔迹地重建画布：键盘弹出/横竖屏切换时尺寸会变 */
function onResize() {
  if (!cv.value) return;
  const prev = hasInk.value ? cv.value.toDataURL('image/png') : '';
  setup();
  if (!prev) return;
  const img = new Image();
  img.onload = () => {
    const r = cv.value?.getBoundingClientRect();
    if (ctx && r) ctx.drawImage(img, 0, 0, r.width, r.height);
  };
  img.src = prev;
}

function toDataURL() {
  return hasInk.value && cv.value ? cv.value.toDataURL('image/png') : '';
}

defineExpose({ toDataURL, clear, isEmpty: () => !hasInk.value });

onMounted(() => {
  setup();
  if (typeof ResizeObserver !== 'undefined' && cv.value) {
    ro = new ResizeObserver(onResize);
    ro.observe(cv.value);
  }
});
onBeforeUnmount(() => { try { ro?.disconnect(); } catch {} });
</script>

<style scoped>
.signpad { position:relative; }
.signpad__canvas {
  display:block;width:100%;height:150px;border:1px dashed #d6dbe3;border-radius:12px;
  background:#fff;touch-action:none;cursor:crosshair;
}
.signpad__ph { position:absolute;inset:0;display:grid;place-items:center;color:#b3bac4;font-size:12px;pointer-events:none; }
.signpad__clear {
  position:absolute;right:10px;bottom:10px;padding:4px 12px;border:1px solid #e3e7ee;border-radius:8px;
  background:rgba(255,255,255,.94);color:#6b7280;font-size:11.5px;cursor:pointer;
}
</style>
