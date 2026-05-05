/**
 * 梵森女神遊戲系統 — _shared.js
 * 共用工具：音效 / 紙花 / 分享 / 振動 / 點數
 */

// ═══════════════════════════════════════════════
// Web Audio 音效系統
// ═══════════════════════════════════════════════
let _audioCtx = null;
const getAudioCtx = () => {
  if (!_audioCtx) {
    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { return null; }
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  return _audioCtx;
};

// 音符序列表
const SOUND_MAP = {
  click:   { freqs: [440, 520],       dur: 0.06, type: 'sine',     vol: 0.08, gap: 0.06 },
  tick:    { freqs: [660],             dur: 0.04, type: 'triangle', vol: 0.06, gap: 0 },
  spin:    { freqs: [300, 350, 400],   dur: 0.05, type: 'sawtooth', vol: 0.04, gap: 0.04 },
  win:     { freqs: [523, 659, 784, 1047], dur: 0.18, type: 'sine', vol: 0.14, gap: 0.13 },
  win2:    { freqs: [784, 988, 1175, 1568], dur: 0.15, type: 'sine', vol: 0.12, gap: 0.12 },
  fail:    { freqs: [330, 277, 220],   dur: 0.15, type: 'sine',     vol: 0.08, gap: 0.12 },
  sparkle: { freqs: [1046, 1318, 1568, 2093], dur: 0.12, type: 'sine', vol: 0.1, gap: 0.09 },
  coin:    { freqs: [880, 1108],       dur: 0.1,  type: 'triangle', vol: 0.1,  gap: 0.08 },
  open:    { freqs: [440, 554, 659, 880, 1108], dur: 0.14, type: 'sine', vol: 0.11, gap: 0.11 },
};

export const playSound = (type = 'click') => {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const preset = SOUND_MAP[type] || SOUND_MAP.click;
  preset.freqs.forEach((freq, i) => {
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = preset.type;
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + i * preset.gap;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(preset.vol, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + preset.dur);
      osc.start(t0);
      osc.stop(t0 + preset.dur + 0.01);
    } catch {}
  });
};

// 舊版相容：cheerful / mystic
export const playWinSound = (soundEffect) => {
  if (!soundEffect || soundEffect === 'silent') return;
  if (soundEffect === 'cheerful') { playSound('win'); return; }
  if (soundEffect === 'mystic')   { playSound('sparkle'); return; }
  playSound('win');
};

// ═══════════════════════════════════════════════
// 紙花慶祝動畫（純 Canvas）
// ═══════════════════════════════════════════════
export const confetti = (duration = 3500) => {
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:500';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const COLORS = ['#D4AF37','#FFD700','#E8B4A2','#B76E79','#FFF0F5','#C0C0C0','#FF69B4','#FFFACD'];
  const particles = Array.from({ length: 130 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * 200,
    vx: (Math.random() - 0.5) * 5,
    vy: 2.5 + Math.random() * 4,
    size: 5 + Math.random() * 9,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    rot: Math.random() * Math.PI * 2,
    rotV: (Math.random() - 0.5) * 0.15,
    shape: Math.random() > 0.4 ? 'rect' : 'circle',
    alpha: 1,
  }));

  let start = null;
  const animate = (ts) => {
    if (!start) start = ts;
    const elapsed = ts - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.x  += p.vx;
      p.y  += p.vy;
      p.vy += 0.05;
      p.rot += p.rotV;
      if (elapsed > duration - 800) p.alpha = Math.max(0, p.alpha - 0.012);
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') {
        ctx.fillRect(-p.size/2, -p.size/4, p.size, p.size/2);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size/2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });
    if (elapsed < duration + 300) requestAnimationFrame(animate);
    else canvas.remove();
  };
  requestAnimationFrame(animate);
};

// ═══════════════════════════════════════════════
// 金色粒子爆炸（中心放射）
// ═══════════════════════════════════════════════
export const particleBurst = (x, y, count = 40) => {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:450';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const pts = Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 3 + Math.random() * 7;
    return {
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 3 + Math.random() * 5,
      color: ['#D4AF37','#FFD700','#E8B4A2','#FFF0F5'][Math.floor(Math.random() * 4)],
      alpha: 1,
    };
  });

  let frame = 0;
  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pts.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.2;
      p.alpha -= 0.022;
      if (p.alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
    frame++;
    if (frame < 70) requestAnimationFrame(draw);
    else canvas.remove();
  };
  requestAnimationFrame(draw);
};

// ═══════════════════════════════════════════════
// 分享到 LINE / IG / FB
// ═══════════════════════════════════════════════
export const shareWin = async (participationId, channel, channelUserId = null) => {
  try {
    const r = await fetch(`/api/play/${participationId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, channel_user_id: channelUserId }),
    });
    const data = await r.json();
    return data;
  } catch {
    return { ok: false };
  }
};

export const openShareLink = (channel, text = '我在梵森獲得了超棒的獎品！') => {
  const encoded = encodeURIComponent(text + ' ' + location.href);
  const urls = {
    line: `https://line.me/R/msg/text/?${encoded}`,
    ig:   `https://www.instagram.com/`,
    fb:   `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(location.href)}`,
  };
  if (urls[channel]) window.open(urls[channel], '_blank', 'noopener,noreferrer');
};

// ═══════════════════════════════════════════════
// 觸覺回饋
// ═══════════════════════════════════════════════
export const vibrate = (pattern = [50]) => {
  try { navigator.vibrate?.(pattern); } catch {}
};

// ═══════════════════════════════════════════════
// 共用 API helpers
// ═══════════════════════════════════════════════

// 載入活動資訊
export const loadActivityInfo = async (actId) => {
  if (!actId) return null;
  const r = await fetch(`/api/play/${actId}/info`);
  if (!r.ok) return null;
  return r.json();
};

// 抽獎 API
export const doDraw = async (actId, channelUserId) => {
  const r = await fetch(`/api/play/${actId}/draw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_user_id: channelUserId || null }),
  });
  return { ok: r.ok, data: await r.json(), status: r.status };
};

// ═══════════════════════════════════════════════
// 倒數計時 helper
// ═══════════════════════════════════════════════
export const startCountdown = (seconds, el, onExpire) => {
  if (!el || seconds == null) return null;
  const update = () => {
    if (seconds <= 0) {
      el.textContent = '活動已結束';
      onExpire?.();
      clearInterval(timer);
      return;
    }
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    el.textContent = `${h > 0 ? h + 'h ' : ''}${m > 0 ? m + 'm ' : ''}${String(s).padStart(2,'0')}s`;
    seconds--;
  };
  update();
  const timer = setInterval(update, 1000);
  return timer;
};

// ═══════════════════════════════════════════════
// 小工具
// ═══════════════════════════════════════════════
export const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// 動態產生星光背景裝飾
export const addStarDecor = (container, count = 12) => {
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'star';
    el.style.cssText = `
      left: ${Math.random() * 100}%;
      top:  ${Math.random() * 100}%;
      animation-delay: ${Math.random() * 3}s;
      animation-duration: ${1.5 + Math.random() * 2}s;
    `;
    container.appendChild(el);
  }
};
