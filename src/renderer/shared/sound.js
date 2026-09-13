'use strict';

/**
 * 提示音：用 Web Audio 现场合成，不依赖任何外部音频文件。
 *
 * 2026-09-13 调音：原来的版本「有点刺耳」，原因是基频偏高（E6 = 1318 Hz）
 * 而且带了 3 倍泛音（接近 4 kHz），起音也太陡。现在改成：
 *   - 整体降一个八度左右：A5(880) → E5(659)，声音更暖
 *   - 去掉 3 倍泛音，2 倍泛音也压到很轻
 *   - 过一个 1.5 kHz 低通，把高频毛刺磨掉
 *   - 起音从 14ms 放宽到 45ms，变成「敲一下木琴」而不是「电子蜂鸣」
 *
 * 只在两个时机响（对应 计划.md 1.7）：
 *   1. 专注结束、提醒弹窗出现
 *   2. 延后到点、再次弹窗
 */

let audioCtx = null;

function getCtx() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

/** 一个柔和的钟音：正弦基音 + 很轻的 2 倍泛音，指数衰减 */
function playNote(ac, destination, frequency, startAt, duration, level) {
  const env = ac.createGain();
  env.gain.setValueAtTime(0.0001, startAt);
  // 45ms 的起音：够软，不会「啪」一下
  env.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), startAt + 0.045);
  env.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  env.connect(destination);

  const partials = [
    { ratio: 1, gain: 1, type: 'sine' },
    { ratio: 2, gain: 0.12, type: 'sine' }, // 原来 0.3；砍掉大半，去掉金属味
  ];

  for (const p of partials) {
    const g = ac.createGain();
    g.gain.value = p.gain;
    const osc = ac.createOscillator();
    osc.type = p.type;
    osc.frequency.value = frequency * p.ratio;
    osc.connect(g);
    g.connect(env);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.06);
  }
}

/**
 * 播放提示音
 * @param {number} volume 0..1
 */
function playChime(volume) {
  const ac = getCtx();
  if (!ac) return;

  const vol = Math.max(0, Math.min(1, typeof volume === 'number' ? volume : 0.6));
  if (vol <= 0) return;

  // 低通：把 1.5 kHz 以上全部磨掉，这是「不刺耳」最关键的一步
  const lowpass = ac.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 1500;
  lowpass.Q.value = 0.6;

  const master = ac.createGain();
  master.gain.value = vol * 0.38; // 原来 0.5，整体也压低一点

  master.connect(lowpass);
  lowpass.connect(ac.destination);

  const t0 = ac.currentTime + 0.02;
  playNote(ac, master, 880.0, t0, 1.1, 0.5); // A5
  playNote(ac, master, 659.25, t0 + 0.2, 1.5, 0.45); // E5

  setTimeout(() => {
    try {
      master.disconnect();
      lowpass.disconnect();
    } catch {
      /* 忽略 */
    }
  }, 3000);
}

window.playChime = playChime;
