'use strict';

/**
 * 诊断脚本 13（历史，方法论有缺陷，别照着它下结论）：量「光效为什么先比屏幕小一圈」。
 *
 * ⚠ 这个脚本给出的「窗口尺寸是对的、没问题」是**误判**，原因有两层：
 *   1. 它量的是「差异像素的外接矩形」。只要最外圈有任何一个像素超过阈值，
 *      这个矩形就顶到屏幕边缘 —— 于是永远得出"铺满了、没变小"。
 *      而需求方看到的「小一圈」根本不是外接矩形，是**看得见的宽度**。
 *   2. 用亮度差（luminance diff）当判据，结果严重受壁纸底色影响，
 *      阈值 10 在这张壁纸上基本只捞得到零星几个像素。
 *
 * 正确的仪器是 scripts/verify-glow-flash.js：同样逐帧，但量的是
 * **alpha 剖面**（从边缘往里走，alpha 掉到眼睛阈值以下的位置＝"这圈光看上去有多宽"），
 * 并把结果和"不透明度 → 可见宽度"的理论曲线对起来。
 * 真正的根因与修法见 src/renderer/glow.css 里 @keyframes flash 上方的注释。
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
