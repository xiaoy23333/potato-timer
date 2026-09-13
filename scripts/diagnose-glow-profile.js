'use strict';

/**
 * 诊断脚本 14：量出光效层的「alpha 剖面」随时间的形状。
 *
 * 直接抓光效窗口自己渲染出来的帧（带 alpha 通道），量离屏幕左边/上边
 * 不同距离处的透明度。这样就能判断：
 *   - 光效是不是「先在内侧出现、边缘是空的」（= 真的内缩一圈）
 *   - 还是「一直在边缘、只是整体亮度在变」（= 纯视觉错觉）
 *
 * 运行：npx electron scripts/diagnose-glow-profile.js
 */

const { app, screen } = require('electron');
const { Store } = require('../src/main/store');
const { WindowManager } = require('../src/main/windows');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 从一张带 alpha 的图里，量某一条水平线上的 alpha 剖面（从左边缘往里） */
function leftProfile(image, yRatio, distances) {
  const { width, height } = image.getSize();
  const buf = image.toBitmap();
  const y = Math.round(height * yRatio);
  return distances.map((d) => {
    const x = Math.min(width - 1, d);
    return buf[(y * width + x) * 4 + 3];
  });
}

/** 量某一条垂直线上的 alpha 剖面（从上边缘往下） */
function topProfile(image, xRatio, distances) {
  const { width, height } = image.getSize();
  const buf = image.toBitmap();
  const x = Math.round(width * xRatio);
  return distances.map((d) => {
    const y = Math.min(height - 1, d);
    return buf[(y * width + x) * 4 + 3];
  });
}

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const store = new Store();
  const wm = new WindowManager(store);

  // 拉长闪光，方便逐帧观察
  store.get().glow.flashSeconds = 6;

  wm.createGlow();
  await wait(1200);

  const b = wm.glow.getBounds();
  console.log(`光效窗口 bounds = ${JSON.stringify(b)}`);
  console.log(`屏幕逻辑 = ${display.bounds.width} x ${display.bounds.height}\n`);

  const DIST = [0, 1, 4, 10, 25, 50, 100, 150, 200, 300];
  console.log('离左边界的物理像素距离 →  ' + DIST.map((d) => String(d).padStart(5)).join(''));
  console.log('（中间那条竖线取屏幕高度的 50%）\n');

  wm.showGlow();
  const t0 = Date.now();
  for (let i = 0; i < 14; i += 1) {
    const shot = await wm.glow.webContents.capturePage();
    const size = shot.getSize();
    const scale = size.width / b.width;
    const phys = DIST.map((d) => Math.round(d * scale));

    const left = leftProfile(shot, 0.5, phys);
    const top = topProfile(shot, 0.5, phys);
    const t = Date.now() - t0;

    console.log(`t=${String(t).padStart(5)}ms  左: ${left.map((v) => String(v).padStart(5)).join('')}`);
    console.log(`             上: ${top.map((v) => String(v).padStart(5)).join('')}`);
    await wait(140);
  }

  app.exit(0);
});
