'use strict';

/**
 * 光效**刚出现的那几帧**，最外圈到底有没有光 —— 高频采样，专治"起手缩在里面"。
 *
 * 之前的仪器都在闪光开始之后才开始采（desktopCapturer 一帧要 350ms+），
 * 有可能整个"缩着"的阶段都被跳过去了。这次：
 *   · 用 capturePage 的**细条裁切**（只取中心行最左 400px），一次几十毫秒
 *   · 在 showGlow() **之前**就开始采，一路采到闪光结束
 *   · 逐帧记录：画面尺寸 + 最外圈那几列的 alpha
 *
 * 判据：如果某一帧出现 alpha[0]==0 而 alpha[32]>0，那就是"光缩在屏幕里面"，
 * 需求方的描述成立。如果 alpha[0] 从头到尾都是全场最高，那就是几何没问题。
 *
 * 运行：npx electron scripts/measure-glow-firstframes.js
 */

const { app, screen } = require('electron');
const { Store } = require('../src/main/store');
const { WindowManager } = require('../src/main/windows');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** 从最左边往里取的列（逻辑像素） */
const COLS = [0, 1, 2, 3, 5, 8, 12, 16, 24, 32, 48, 64, 96, 128, 160, 200, 260, 340];

function readStrip(img, scale) {
  const { width: w } = img.getSize();
  const buf = img.toBitmap();
  // 条带只有 1px 高
  return COLS.map((c) => {
    const x = Math.min(w - 1, Math.round(c * scale));
    return buf[x * 4 + 3];
  });
}

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const store = new Store();
  const realWrite = store._write.bind(store);
  store._write = () => {};
  const wm = new WindowManager(store);

  wm.createGlow();
  await wait(1200);
  console.log(`光效窗口 ${JSON.stringify(wm.glow.getBounds())}`);
  console.log(`屏幕 ${display.bounds.width}x${display.bounds.height}\n`);

  const midY = Math.round((display.bounds.height / 2) * scale);
  const rect = { x: 0, y: midY, width: Math.round(400 * scale), height: Math.max(1, Math.round(scale)) };

  const rows = [];
  let running = true;
  const t0 = Date.now();
  const sampler = (async () => {
    while (running) {
      const t = Date.now() - t0;
      try {
        const img = await wm.glow.webContents.capturePage(rect);
        if (!img.isEmpty()) rows.push({ t, size: img.getSize().width, a: readStrip(img, scale) });
      } catch { /* 窗口正在切换状态时会短暂失败，忽略 */ }
    }
  })();

  wm.showGlow();
  await wait(900);
  running = false;
  await sampler;

  console.log(`采样 ${rows.length} 帧。表头是从屏幕最左边缘往里的列位置（逻辑像素，值为 alpha 0-255）:`);
  console.log(`  时刻    宽  ${COLS.map((c) => String(c).padStart(4)).join('')}`);
  for (const r of rows) {
    console.log(`  ${String(r.t).padStart(5)}ms ${String(r.size).padStart(4)}  ${r.a.map((v) => String(v).padStart(4)).join('')}`);
  }

  // ————————————————— 判定 —————————————————
  const lit = rows.filter((r) => Math.max(...r.a) > 3);
  console.log('\n判定:');
  if (!lit.length) {
    console.log('  一帧都没采到光。');
  } else {
    console.log(`  有光的帧：${lit.length} / ${rows.length}`);
    const inset = lit.filter((r) => r.a[0] <= 2 && Math.max(...r.a.slice(2)) > 6);
    console.log(`  其中"最外圈没光、里面才有光"的帧：${inset.length}`);
    if (inset.length) {
      console.log('  ⇒ **确实存在"光缩在屏幕里面"的帧**，需求方的描述成立 ❌');
      for (const r of inset.slice(0, 6)) {
        console.log(`     t=${r.t}ms  ${r.a.map((v) => String(v).padStart(4)).join('')}`);
      }
    } else {
      const first = lit[0];
      const last = lit[lit.length - 1];
      console.log(`  首帧 t=${first.t}ms：${first.a.map((v) => String(v).padStart(4)).join('')}`);
      console.log(`  末帧 t=${last.t}ms：${last.a.map((v) => String(v).padStart(4)).join('')}`);
      console.log('  ⇒ 每一帧的最外圈都有光，没有"缩在里面"的阶段 ✅');
    }
  }

  store._write = realWrite;
  app.exit(0);
});
