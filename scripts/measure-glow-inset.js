'use strict';

/**
 * 用「提醒前 / 提醒中」两张**同一场自检里拍的**真实桌面截图做差，
 * 精确量出光效在最外圈那几十个像素上的剖面。
 *
 * 为什么这次一定准：
 *   · 两张图相隔一分钟、同一张壁纸、同一批窗口 → 差分把壁纸和窗口全消掉，
 *     剩下的**只有光效**，不再有"壁纸自己的 B−R 把结论带跑"的问题
 *   · 看的是真实屏幕上合成出来的画面，不是光效层自己的 capturePage
 *
 * 运行：npx electron scripts/measure-glow-inset.js
 */

const path = require('node:path');
const { app, nativeImage } = require('electron');

const DIR = path.join(__dirname, '..', 'screenshots');
const BEFORE = path.join(DIR, '00-桌面-提醒前.png');
const AFTER = path.join(DIR, '04-桌面实际效果-提醒中.png');

const bitmap = (file) => {
  const img = nativeImage.createFromPath(file);
  return { buf: img.toBitmap(), ...img.getSize() };
};

app.whenReady().then(() => {
  const a = bitmap(BEFORE);
  const b = bitmap(AFTER);
  if (a.width !== b.width || a.height !== b.height) {
    console.error(`尺寸不一致：${a.width}x${a.height} vs ${b.width}x${b.height}`);
    app.exit(1);
    return;
  }
  console.log(`两张图 ${a.width}x${a.height}，做差\n`);

  // 沿横向：每一列在"纵向中间 40% 区域"上的平均 Δ(蓝−红)
  const colDelta = (x) => {
    let s = 0;
    let n = 0;
    for (let y = Math.round(a.height * 0.3); y < a.height * 0.7; y += 4) {
      const i = (y * a.width + x) * 4;
      s += (b.buf[i] - b.buf[i + 2]) - (a.buf[i] - a.buf[i + 2]);
      n += 1;
    }
    return s / n;
  };
  const rowDelta = (y) => {
    let s = 0;
    let n = 0;
    for (let x = Math.round(a.width * 0.3); x < a.width * 0.7; x += 4) {
      const i = (y * a.width + x) * 4;
      s += (b.buf[i] - b.buf[i + 2]) - (a.buf[i] - a.buf[i + 2]);
      n += 1;
    }
    return s / n;
  };

  const PROBE = [0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80, 100, 140, 200, 300];

  console.log('从左边缘往里（物理像素 → Δ(蓝−红)，光效应该 ≥0）：');
  console.log('  x    :  ' + PROBE.map((x) => String(x).padStart(6)).join(''));
  console.log('  Δ    :  ' + PROBE.map((x) => colDelta(x).toFixed(1).padStart(6)).join(''));

  console.log('\n从上边缘往下：');
  console.log('  y    :  ' + PROBE.map((y) => String(y).padStart(6)).join(''));
  console.log('  Δ    :  ' + PROBE.map((y) => rowDelta(y).toFixed(1).padStart(6)).join(''));

  console.log('\n从右 / 下边缘往里：');
  console.log('  距右边:  ' + PROBE.map((x) => String(x).padStart(6)).join(''));
  console.log('  Δ     :  ' + PROBE.map((x) => colDelta(a.width - 1 - x).toFixed(1).padStart(6)).join(''));
  console.log('  距下边:  ' + PROBE.map((y) => String(y).padStart(6)).join(''));
  console.log('  Δ     :  ' + PROBE.map((y) => rowDelta(a.height - 1 - y).toFixed(1).padStart(6)).join(''));

  // ————————————————— 判定 —————————————————
  console.log('\n判定:');
  const edges = [
    ['左', (n) => colDelta(n), a.width],
    ['右', (n) => colDelta(a.width - 1 - n), a.width],
    ['上', (n) => rowDelta(n), a.height],
    ['下', (n) => rowDelta(a.height - 1 - n), a.height],
  ];
  let insetCount = 0;
  for (const [name, f, len] of edges) {
    // 外边界：从最外圈往里，Δ 第一次超过"峰值的一半"的位置
    let peak = 0;
    for (let n = 0; n < Math.min(400, len); n += 1) peak = Math.max(peak, f(n));
    let outer = -1;
    for (let n = 0; n < Math.min(400, len); n += 1) {
      if (f(n) >= peak * 0.5) { outer = n; break; }
    }
    const at0 = f(0);
    const inset = outer > 6;
    if (inset) insetCount += 1;
    console.log(
      `  ${name}边：最外圈 Δ=${at0.toFixed(1)}，峰值 Δ=${peak.toFixed(1)}，` +
        `可见段外边界在 ${outer}px 处  → ${inset ? `缩在里面 ${outer}px ❌` : '贴着屏幕边 ✅'}`,
    );
  }
  console.log(
    insetCount
      ? `\n⇒ ${insetCount} 条边缩在里面 —— **需求方是对的**，光效确实是从屏幕里一圈的位置开始的。`
      : '\n⇒ 四条边都贴着屏幕，没有内缩。',
  );

  app.exit(0);
});
