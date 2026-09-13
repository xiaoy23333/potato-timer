'use strict';

/**
 * 诊断脚本 13：量出「光效为什么先比屏幕小一圈、再扩大到屏幕四周」。
 *
 * 做法：把闪光时长临时调长（6 秒），然后在整个闪光过程中反复截全屏，
 * 每一帧都和「光效关闭时」的基准帧做差分，算出「被光效影响到的像素范围」有多大。
 * 这样就能看出这个范围是不是从小变大、以及它是从哪一边开始扩的。
 *
 * 同时记录光效窗口的 bounds，判断到底是窗口尺寸在变、还是纯视觉动画。
 *
 * 运行：npx electron scripts/diagnose-glow-grow.js
 */

const { app, screen, desktopCapturer } = require('electron');
const { Store } = require('../src/main/store');
const { WindowManager } = require('../src/main/windows');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function grabScreen(display) {
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  return sources.length ? sources[0].thumbnail : null;
}

/** 对比两帧，返回「差异明显的像素」的外接矩形 */
function diffBox(base, frame, threshold = 10) {
  const sizeA = base.getSize();
  const sizeB = frame.getSize();
  if (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height) return null;

  const { width, height } = sizeA;
  const a = base.toBitmap();
  const b = frame.toBitmap();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * 4;
      const d =
        Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > threshold) {
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!count) return null;
  return { left: minX, top: minY, right: maxX, bottom: maxY, count };
}

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const store = new Store();
  const wm = new WindowManager(store);

  // 把闪光拉长到 6 秒，方便逐帧观察（只改内存，不落盘）
  store.get().glow.flashSeconds = 6;

  const wantW = Math.round(display.bounds.width);
  const wantH = Math.round(display.bounds.height);
  console.log(`屏幕逻辑尺寸 = ${wantW} x ${wantH}   scaleFactor = ${scale}`);
  console.log(`屏幕物理尺寸 = ${Math.round(wantW * scale)} x ${Math.round(wantH * scale)}`);
  console.log(`（截图尺寸 ${Math.round(display.size.width * scale)} x ${Math.round(display.size.height * scale)}）\n`);

  wm.createGlow();
  await wait(1200);

  console.log(`创建后 glow.getBounds() = ${JSON.stringify(wm.glow.getBounds())}`);

  // 基准帧：光效还没显示
  const base = await grabScreen(display);
  console.log('已抓取基准帧（光效关闭时）\n');

  wm.showGlow();
  console.log(`showGlow 之后 glow.getBounds() = ${JSON.stringify(wm.glow.getBounds())}\n`);

  console.log('帧号  时间(ms)  差异区域（物理像素）                            宽度 x 高度    与屏幕四边的距离');
  const t0 = Date.now();
  for (let i = 0; i < 14; i += 1) {
    const frame = await grabScreen(display);
    const t = Date.now() - t0;
    const box = frame ? diffBox(base, frame) : null;
    if (!box) {
      console.log(`  ${String(i).padStart(2)}  ${String(t).padStart(7)}  （这一帧没检测到差异）`);
    } else {
      const w = box.right - box.left;
      const h = box.bottom - box.top;
      console.log(
        `  ${String(i).padStart(2)}  ${String(t).padStart(7)}  x ${String(box.left).padStart(4)}~${String(box.right).padStart(4)}` +
          `  y ${String(box.top).padStart(4)}~${String(box.bottom).padStart(4)}` +
          `      ${String(w).padStart(4)} x ${String(h).padStart(4)}` +
          `     左${String(box.left).padStart(4)} 上${String(box.top).padStart(4)}` +
          ` 右${String(Math.round(display.size.width * scale) - box.right).padStart(4)}` +
          ` 下${String(Math.round(display.size.height * scale) - box.bottom).padStart(4)}`,
      );
    }
    await wait(150);
  }

  console.log(`\n光效窗口最终 bounds = ${JSON.stringify(wm.glow.getBounds())}`);
  console.log(`预期应该铺满: ${wantW} x ${wantH}（逻辑像素）`);
  const b = wm.glow.getBounds();
  console.log(
    b.width === wantW && b.height === wantH
      ? '→ 窗口尺寸是对的，铺满整屏 ✅'
      : `→ 窗口尺寸不对 ❌（宽差 ${wantW - b.width}，高差 ${wantH - b.height}）`,
  );

  app.exit(0);
});
