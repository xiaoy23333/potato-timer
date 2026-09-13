'use strict';

/**
 * 光效层：颜色 / 强度 / 速度三项都从配置里读，实时跟随设置变化。
 * 默认淡蓝 #4fc3f7、呼吸脉动。
 */

const root = document.documentElement;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const value = m ? parseInt(m[1], 16) : 0x4fc3f7;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgba([r, g, b], alpha) {
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

function apply(config) {
  const glow = (config && config.glow) || {};
  const rgb = hexToRgb(glow.color);
  const intensity = typeof glow.intensity === 'number' ? glow.intensity : 0.8;
  const flashSeconds = typeof glow.flashSeconds === 'number' ? glow.flashSeconds : 1.4;

  root.style.setProperty('--c-strong', rgba(rgb, 0.62 * intensity));
  root.style.setProperty('--c-mid', rgba(rgb, 0.3 * intensity));
  root.style.setProperty('--c-soft', rgba(rgb, 0.14 * intensity));
  // 光效只闪一次：这决定那一次闪光从亮起到完全消失的总时长
  root.style.setProperty('--dur', `${Math.round(flashSeconds * 1000)}ms`);
}

async function boot() {
  try {
    apply(await window.pomodoro.getConfig());
  } catch (err) {
    console.error('[glow] 读取配置失败', err);
  }
  window.pomodoro.onConfig(apply);

  // 每次提醒弹出时由主进程通知，重新播一次闪光。
  // 必须显式重播：窗口本身是一直存在的（只是隐藏/显示），
  // 光靠 CSS 动画不会自己重来，否则就只有第一次会闪。
  window.pomodoro.onGlowPlay(playOnce);
}

const glowEl = document.getElementById('glow');

/** 重播一次闪光：先摘掉 class、强制回流，再加回去 */
function playOnce() {
  glowEl.classList.remove('is-flashing');
  void glowEl.offsetWidth; // 强制回流，让动画能重新开始
  glowEl.classList.add('is-flashing');
}

boot();
