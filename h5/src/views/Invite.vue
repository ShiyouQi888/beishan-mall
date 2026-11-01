<template>
  <div class="page page--tab invite">
    <div class="invite__hero">
      <div class="hero-badge">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
          <circle cx="12" cy="12" r="9" stroke="#fff" stroke-width="1.6" opacity=".8" />
          <path d="M12 7.5v5l3 2" stroke="#fff" stroke-width="1.8" stroke-linecap="round" />
        </svg>
        <span>邀请好友 · 共享收益</span>
      </div>
      <h1>邀请好友加入<br />一起分享好物与佣金</h1>
      <div class="hero-code">
        <div class="code-label">我的邀请码</div>
        <div class="code-value">{{ me.invitation_code || '------' }}</div>
        <button class="code-copy" @click="copyCode">复制邀请码</button>
      </div>
    </div>

    <div class="section-pad">
      <div class="invite__stats card">
        <div class="s"><b>{{ stats.child }}</b><span>直推好友</span></div>
        <div class="s-div" />
        <div class="s"><b>{{ stats.team }}</b><span>团队人数</span></div>
        <div class="s-div" />
        <div class="s"><b>{{ me.distribution_amount || '0.00' }}</b><span>累计收益</span></div>
      </div>

      <div class="card invite__how">
        <div class="sec-title" style="padding: 15px 0 8px"><span>如何邀请</span></div>
        <div class="step" v-for="(s, i) in steps" :key="i">
          <span class="step-no">{{ i + 1 }}</span>
          <div class="step-body">
            <div class="step-t">{{ s.t }}</div>
            <div class="step-d">{{ s.d }}</div>
          </div>
        </div>
      </div>

      <div class="card invite__rules">
        <div class="sec-title" style="padding: 15px 0 4px"><span>奖励规则</span></div>
        <div class="rule-richtext" v-html="safeNotice" />
      </div>

      <div class="invite__actions">
        <button class="btn-plain invite__poster-button" @click="openPoster">生成邀请海报</button>
        <button class="btn-main" @click="share">分享邀请链接</button>
        <button class="btn-plain" @click="$router.push('/team')">查看我的团队</button>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="posterVisible" class="invite-poster" role="dialog" aria-modal="true" aria-label="邀请海报预览" @click.self="posterVisible = false">
        <div class="invite-poster__panel">
          <header class="invite-poster__header"><div><strong>邀请海报</strong><span>保存图片后分享给好友</span></div><button aria-label="关闭" @click="posterVisible = false">×</button></header>
          <div class="invite-poster__preview"><img v-if="posterPreview" :src="posterPreview" alt="我的邀请海报" /><div v-else class="invite-poster__loading">海报生成中…</div></div>
          <button class="btn-main invite-poster__download" :disabled="!posterPreview" @click="downloadPoster">保存邀请海报</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted, computed } from 'vue';
import { showToast } from '../utils/feedback.js';
import QRCode from 'qrcode';
import { api } from '../api.js';
import { sanitizeHtml } from '../../../shared/sanitize.js';

const me = ref({});
const stats = reactive({ child: 0, team: 0 });
const posterConfig = ref({});
const posterVisible = ref(false);
const posterPreview = ref('');
const noticeHtml = ref('<p>· 好友通过您的邀请码注册后成为您的直推会员。</p><p>· 好友完成交易后，您可获得对应比例的佣金奖励。</p><p>· 佣金实时结算至您的佣金账户，可申请提现。</p>');

// 邀请规则来自后台富文本配置，渲染前净化
const safeNotice = computed(() => sanitizeHtml(noticeHtml.value));
const steps = [
  { t: '复制邀请码', d: '点击上方按钮复制您的专属邀请码' },
  { t: '分享给好友', d: '好友注册时填写该邀请码即可绑定关系' },
  { t: '获得奖励', d: '好友完成交易，您即可获得佣金' },
];

async function load() {
  const [config, notice] = await Promise.allSettled([api.invitePoster(), api.invitationNotice()]);
  if (config.status === 'fulfilled') posterConfig.value = config.value.data || {};
  if (notice.status === 'fulfilled' && notice.value.data?.prompt_values) noticeHtml.value = notice.value.data.prompt_values;
  if (!localStorage.getItem('TOKEN')) return;
  const [m, c, team] = await Promise.allSettled([api.me(), api.indirection(), api.teamStats()]);
  if (m.status === 'fulfilled') me.value = m.value.data || {};
  if (c.status === 'fulfilled') stats.child = (c.value.data || []).length;
  if (team.status === 'fulfilled') stats.team = Number(team.value.data?.team_count || 0);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) return resolve(null);
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 2) {
  let line = '';
  let lines = 0;
  for (const char of String(text || '')) {
    const next = line + char;
    if (ctx.measureText(next).width > maxWidth && line) {
      ctx.fillText(line, x, y + lines * lineHeight);
      lines += 1;
      line = char;
      if (lines >= maxLines) break;
    } else line = next;
  }
  if (line && lines < maxLines) ctx.fillText(line, x, y + lines * lineHeight);
}

function drawPosterText(ctx, text, config, kind, defaults, weight = 500, maxLines = 2) {
  const content = String(text ?? '').trim();
  if (!content) return;
  const posterWidth = 750;
  const posterHeight = 1334;
  const readNumber = (key) => {
    const raw = config[`${kind}_${key}`];
    const value = raw === '' || raw === null || raw === undefined ? defaults[key] : Number(raw);
    return Number.isFinite(value) ? value : defaults[key];
  };
  const size = Math.max(14, Math.min(100, readNumber('size')));
  const x = Math.max(0, Math.min(posterWidth - 30, readNumber('x')));
  const y = Math.max(0, Math.min(posterHeight - size, readNumber('y')));
  const maxWidth = Math.max(1, posterWidth - x - 30);
  const alignValue = config[`${kind}_align`] || defaults.align;
  const align = ['left', 'center', 'right'].includes(alignValue) ? alignValue : defaults.align;
  const anchorX = x + (align === 'center' ? maxWidth / 2 : align === 'right' ? maxWidth : 0);
  ctx.save();
  ctx.fillStyle = config[`${kind}_color`] || '#ffffff';
  // 文字投影强度（后台「海报配置 → 文字投影」）：0 无 / 1 轻微 / 2 适中 / 3 明显。
  // 数值与后台预览共用同一套档位，否则预览看着清楚、导出的图却糊成一团。
  const shadowRaw = config.text_shadow;
  const level = shadowRaw === '' || shadowRaw === null || shadowRaw === undefined
    ? 2 : Math.min(3, Math.max(0, Math.round(Number(shadowRaw)) || 0));
  const shadow = [[0, 0, 0], [6, 0.3, 1], [10, 0.42, 2], [18, 0.6, 3]][level];
  if (shadow[0] > 0) {
    ctx.shadowColor = `rgba(0,0,0,${shadow[1]})`;
    ctx.shadowBlur = shadow[0];
    ctx.shadowOffsetY = shadow[2];
  }
  ctx.textAlign = align;
  ctx.font = `${weight} ${size}px sans-serif`;
  drawWrappedText(ctx, content, anchorX, y + size, maxWidth, size * 1.35, maxLines);
  ctx.restore();
}

async function makePoster() {
  const width = 750;
  const height = 1334;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建海报画布');
  const config = posterConfig.value;
  const background = config.background ? await loadImage(config.background).catch(() => null) : null;
  if (background) ctx.drawImage(background, 0, 0, width, height);
  else {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#ff8463'); gradient.addColorStop(1, '#a92129');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
  }
  const shade = ctx.createLinearGradient(0, 0, 0, height);
  shade.addColorStop(0, 'rgba(24,12,15,.16)'); shade.addColorStop(.55, 'rgba(24,12,15,0)'); shade.addColorStop(1, 'rgba(24,12,15,.5)');
  ctx.fillStyle = shade; ctx.fillRect(0, 0, width, height);

  const logo = config.logo ? await loadImage(config.logo).catch(() => null) : null;
  if (logo) {
    const logoSize = Math.max(48, Math.min(260, Number(config.logo_size ?? 116)));
    const logoX = Math.max(0, Math.min(width - logoSize, Number(config.logo_x ?? 54)));
    const logoY = Math.max(0, Math.min(height - logoSize, Number(config.logo_y ?? 60)));
    const scale = Math.min(logoSize / logo.width, logoSize / logo.height);
    const lw = logo.width * scale; const lh = logo.height * scale;
    ctx.drawImage(logo, logoX + (logoSize - lw) / 2, logoY + (logoSize - lh) / 2, lw, lh);
  }

  if (Number(config.title_show ?? 10) === 10) {
    drawPosterText(ctx, config.title, config, 'title', { x: 60, y: 240, size: 54, align: 'left' }, 700);
  }
  if (Number(config.subtitle_show ?? 10) === 10) {
    drawPosterText(ctx, config.subtitle, config, 'subtitle', { x: 60, y: 315, size: 30, align: 'left' }, 400);
  }

  const inviteUrl = `${location.origin}${location.pathname}#/register?code=${encodeURIComponent(me.value.invitation_code || '')}`;
  const qrDataUrl = await QRCode.toDataURL(inviteUrl, { width: 512, margin: 1, errorCorrectionLevel: 'H', color: { dark: '#15191f', light: '#ffffff' } });
  const qr = await loadImage(qrDataUrl);
  const qrSize = Math.max(120, Math.min(320, Number(config.qr_size) || 220));
  const x = Math.max(0, Math.min(width - qrSize, Number(config.qr_x ?? 265)));
  const y = Math.max(0, Math.min(height - qrSize, Number(config.qr_y ?? 850)));
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.24)'; ctx.shadowBlur = 20; ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.roundRect(x - 14, y - 14, qrSize + 28, qrSize + 28, 20); ctx.fill(); ctx.restore();
  ctx.drawImage(qr, x, y, qrSize, qrSize);

  if (Number(config.content_show ?? 10) === 10) {
    drawPosterText(ctx, config.content, config, 'content', { x: 60, y: 1190, size: 25, align: 'center' }, 500);
  }
  if (Number(config.code_show ?? 10) === 10 && me.value.invitation_code) {
    const label = config.code_label ?? '邀请码：';
    drawPosterText(ctx, `${label}${me.value.invitation_code}`, config, 'code', { x: 60, y: 1280, size: 22, align: 'center' }, 600, 1);
  }
  return canvas.toDataURL('image/png');
}

async function openPoster() {
  if (!me.value.invitation_code) return showToast('请先登录后生成个人邀请海报');
  posterVisible.value = true;
  posterPreview.value = '';
  try { posterPreview.value = await makePoster(); } catch { showToast('海报生成失败，请检查背景图片后重试'); }
}

function downloadPoster() {
  if (!posterPreview.value) return;
  const link = document.createElement('a');
  link.href = posterPreview.value;
  link.download = `邀请海报-${me.value.invitation_code || 'invite'}.png`;
  link.click();
}

async function copyCode() {
  if (!me.value.invitation_code) return showToast('请先登录');
  try {
    await navigator.clipboard.writeText(me.value.invitation_code);
    showToast('邀请码已复制');
  } catch {
    showToast(`邀请码：${me.value.invitation_code}`);
  }
}

function share() {
  const url = `${location.origin}${location.pathname}#/register?code=${me.value.invitation_code || ''}`;
  if (navigator.share) {
    navigator.share({ title: '邀请你加入北山商城', url }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(url);
    showToast('邀请链接已复制');
  }
}

onMounted(load);
</script>

<style scoped>
.invite { background: var(--bg); }

.invite__hero {
  padding: 26px 20px 30px;
  background: linear-gradient(160deg, var(--brand-hero-1) 0%, var(--brand-hero-2) 60%, var(--brand-hero-3) 100%);
  border-radius: 0 0 28px 28px;
  color: #fff;
  position: relative;
}
.invite__hero::after {
  content: '';
  position: absolute;
  right: -40px; top: -30px;
  width: 160px; height: 160px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
}
.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  background: rgba(255, 255, 255, 0.18);
  padding: 5px 11px;
  border-radius: 12px;
  backdrop-filter: blur(4px);
}
.invite__hero h1 {
  font-size: 22px;
  line-height: 1.42;
  font-weight: 700;
  margin: 14px 0 0;
  letter-spacing: 0.5px;
}
.hero-code {
  margin-top: 22px;
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 14px;
  padding: 14px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  backdrop-filter: blur(6px);
}
.code-label { font-size: 11.5px; opacity: 0.86; }
.code-value {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 3px;
  font-variant-numeric: tabular-nums;
}
.code-copy {
  margin-left: auto;
  height: 30px;
  padding: 0 14px;
  border-radius: 15px;
  border: none;
  background: #fff;
  color: var(--brand);
  font-size: 12px;
  font-weight: 650;
  font-family: var(--font);
}

.invite__stats {
  margin-top: -18px;
  display: flex;
  align-items: center;
  padding: 16px 0;
  position: relative;
  z-index: 2;
}
.invite__stats .s { flex: 1; text-align: center; }
.invite__stats .s b {
  display: block;
  font-size: 17px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.invite__stats .s span { font-size: 11.5px; color: var(--text-3); }
.s-div { width: 1px; height: 24px; background: var(--line); }

.invite__how, .invite__rules { margin-top: 12px; padding: 0 14px 14px; }
.step { display: flex; gap: 12px; padding: 11px 0; }
.step-no {
  width: 22px; height: 22px;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 12px;
  font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  flex: none;
}
.step-t { font-size: 13.5px; font-weight: 600; }
.step-d { font-size: 12px; color: var(--text-3); margin-top: 3px; line-height: 1.5; }

.rule-richtext {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.75;
  padding-bottom: 4px;
}
.rule-richtext :deep(p) { margin: 0 0 4px; }

.invite__actions { display: flex; flex-direction: column; gap: 10px; margin: 16px 0 4px; }
.invite__poster-button{border:1px solid #f2b7aa!important;color:#dc5039!important;background:#fff!important;}
.invite-poster{position:fixed;inset:0;z-index:4000;display:grid;place-items:center;padding:18px;background:rgba(18,22,30,.72);backdrop-filter:blur(5px)}
.invite-poster__panel{width:min(440px,100%);max-height:92dvh;display:flex;flex-direction:column;gap:14px;padding:16px;border-radius:20px;background:#fff;box-shadow:0 20px 70px #0004}
.invite-poster__header{display:flex;align-items:center;justify-content:space-between}.invite-poster__header div{display:flex;flex-direction:column;gap:4px}.invite-poster__header strong{font-size:16px}.invite-poster__header span{font-size:11px;color:#87909c}.invite-poster__header button{border:0;border-radius:50%;width:32px;height:32px;background:#f3f4f6;color:#707985;font-size:22px;line-height:1}
.invite-poster__preview{min-height:180px;overflow:auto;display:flex;justify-content:center;align-items:flex-start;border-radius:12px;background:#f3f4f6}.invite-poster__preview img{display:block;width:min(100%,340px);height:auto;border-radius:8px}.invite-poster__loading{padding:40px 0;color:#8c95a1;font-size:13px}.invite-poster__download{width:100%;flex:none}
</style>
