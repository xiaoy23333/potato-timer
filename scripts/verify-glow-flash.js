'use strict';

/**
 * 验收「光效看上去会不会先小一圈再放大」。
 *
 * 判据：逐帧量**可见宽度** —— 从边缘往里走，alpha 掉到眼睛阈值以下的位置。
 * 修之前实测：不透明度 0→1 的过程中可见宽度变化 2.31 倍（0.418L → 0.967L），
 * 那正是需求方看到的"先比屏幕小一圈、再放大"。
 * 修之后（不透明度抬了下限 + 渐变收尾）应该从第一帧可见起就基本恒定。
 *
 * 用真实时长（默认 1.6s），不做任何拉伸 —— 拉伸会让"起始那几帧"被采样到，
 * 但也会掩盖真实的节奏。
 *
 * 运行：npx electron scripts/verify-glow-flash.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, screen } = require('electron');
const { Store } = require('../src/main/store');
const { WindowManager } = require('../src/main/windows');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(__dirname, '..', 'screenshots', 'glow-scale');

/** 眼睛阈值：alpha < 3/255（约 1.2%）就算看不见了 */
const EYE = 3;

function analyse(img) {
  const { width: w, height: h } = img.getSize();
  const buf = img.toBitmap();
  const a = (x, y) => buf[(y * w + x) * 4 + 3];
  const midY = Math.floor(h / 2);
  const midX = Math.floor(w / 2);

  let reachX = 0;
  for (let x = 0; x < w; x += 1) {
    if (a(x, midY) > EYE) reachX = x;
    else if (x > 8) break;
  }
  let reachY = 0;
  for (let y = 0; y < h; y += 1) {
    if (a(midX, y) > EYE) reachY = y;
    else if (y > 8) break;
  }
  return { w, h, peak: a(0, midY), reachX, reachY };
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const display = screen.getPrimaryDisplay();
  const store = new Store();
  const realWrite = store._write.bind(store);
  store._write = () => {};
  const wm = new WindowManager(store);

  wm.createGlow();
  await wait(1200);
  console.log(`光效窗口 ${wm.glow.getBounds().width}x${wm.glow.getBounds().height}`);
  console.log(`闪光时长 ${store.get().glow.flashSeconds}s\n`);

  wm.showGlow();

  const rows = [];
  const t0 = Date.now();
  // 采样到整段结束（默认 1.6s 的 1.15 倍）
  const until = store.get().glow.flashSeconds * 1000 * 1.15;
  while (Date.now() - t0 < until) {
    const t = Date.now() - t0;
    const img = await wm.glow.webContents.capturePage();
    if (!img.isEmpty()) {
      const r = analyse(img);
      if (r.peak > 0) rows.push({ t, ...r });
    }
    await wait(10);
  }

  console.log('时刻     边缘alpha   可见宽度(横)   可见宽度(纵)');
  for (const r of rows) {
    console.log(
      `  ${String(r.t).padStart(5)}ms  ${String(r.peak).padStart(6)}   ${String(r.reachX).padStart(8)}px   ${String(r.reachY).padStart(8)}px`,
    );
  }

  if (rows.length >= 3) {
    // 判定只用"确实看得见"的那些帧：边缘 alpha 太低的时候，人本来也分辨不出形状，
    // 把那些帧算进来只会污染结论（渐变淡到接近透明时宽度必然收一点，那是淡出本身）。
    const VISIBLE = 100; // /255，约 39%
    const seen = rows.filter((r) => r.peak >= VISIBLE);
    console.log(`\n判定（只取边缘 alpha ≥ ${VISIBLE}/255、即确实看得见的帧）:`);
    if (seen.length < 2) {
      console.log('  看得见的帧不足，无法判定。');
    } else {
      const early = seen[0];
      const last = seen[seen.length - 1];
      console.log(`  ${String(early.t).padStart(5)}ms  alpha ${early.peak}  横 ${early.reachX}px / 纵 ${early.reachY}px`);
      console.log(`  ${String(last.t).padStart(5)}ms  alpha ${last.peak}  横 ${last.reachX}px / 纵 ${last.reachY}px`);
      const growth = last.reachX / Math.max(1, early.reachX);
      console.log(`  ⇒ 可见宽度变化 ${growth.toFixed(3)} 倍（修之前是 2.31 倍）`);
      console.log(
        growth < 1.08
          ? '  ⇒ 形状恒定，不会再被看成"先小一圈、再放大到屏幕大小"。✅'
          : '  ⇒ 仍有可见的"长大"感，需要继续收紧。❌',
      );
    }
  } else {
    console.log('\n采样帧数不足，无法判定。');
  }

  store._write = realWrite;
  app.exit(0);
});
