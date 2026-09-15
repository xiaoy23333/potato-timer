'use strict';

/**
 * 光效的**四个角**在真实屏幕上到底有没有被切掉。
 *
 * 之前的仪器全都在量"每条边的正中"（中心行 / 中心列），从来没看过角。
 * 而 Windows 11 的 DWM 会给无边框窗口做**圆角裁切**（约 8px 半径），
 * Electron 在 Windows 11 上也确实会带上这个行为 —— 一旦发生：
 *   · 客户区矩形不变（所以 diagnose-client-inset 量不出来）
 *   · capturePage 只抓客户区，也看不出来
 *   · 只有**屏幕上的合成结果**在四个角会被啃掉一块
 * 那正好就是"外圈切口是整齐的" + "光效缩在里面"的观感来源。
 *
 * 做法：对每个角，取一块 60x60 逻辑像素的小图，比较"光效最亮时"与"光效关闭时"
 * 的 Δ(蓝−红)。如果角上的最外圈没有变化、而往里一点有变化，就是被裁了。
 *
 * 运行：npx electron scripts/measure-glow-corners.js
 */

const { app, screen, desktopCapturer } = require('electron');
const { Store } = require('../src/main/store');
const { WindowManager } = require('../src/main/windows');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function grab(display) {
  const sf = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * sf),
      height: Math.round(display.size.height * sf),
    },
  });
  return sources.length ? sources[0].thumbnail : null;
}

const toBitmap = (img) => ({ buf: img.toBitmap(), ...img.getSize() });

/** 某个角：从角尖往里取一串格子的 Δ */
function cornerDelta(base, cur, corner, w, h, scale) {
  const N = 8; // 8x8 网格覆盖 60x60 逻辑像素
  const span = Math.round(60 * scale);
  const step = Math.max(1, Math.floor(span / N));
  const out = [];
  const originX = corner.includes('r') ? w - span : 0;
  const originY = corner.includes('b') ? h - span : 0;
  for (let gy = 0; gy < N; gy += 1) {
    const rowVals = [];
    for (let gx = 0; gx < N; gx += 1) {
      const x = Math.min(w - 1, originX + gx * step + Math.floor(step / 2));
      const y = Math.min(h - 1, originY + gy * step + Math.floor(step / 2));
      const i = (y * w + x) * 4;
      rowVals.push(Math.round((cur.buf[i] - cur.buf[i + 2]) - (base.buf[i] - base.buf[i + 2])));
    }
    out.push(rowVals);
  }
  return out;
}

const GLYPH = ' .:-=+*#%@';
const draw = (grid) =>
  grid
    .map((row) => '    ' + row.map((v) => GLYPH[Math.min(GLYPH.length - 1, Math.max(0, Math.floor((v / 90) * GLYPH.length)))]).join(''))
    .join('\n');

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const store = new Store();
  const realWrite = store._write.bind(store);
  store._write = () => {};
  const wm = new WindowManager(store);

  wm.createGlow();
  await wait(1200);

  // 拉长到 60 秒并拉满强度，量的是"稳定态的形状"
  await wm.glow.webContents.executeJavaScript(
    `(() => { const r = document.documentElement;
       r.style.setProperty('--c-strong', 'rgba(79,195,247,0.62)');
       r.style.setProperty('--c-mid', 'rgba(79,195,247,0.30)');
       r.style.setProperty('--c-soft', 'rgba(79,195,247,0.14)');
       r.style.setProperty('--dur', '60000ms');
       return true; })()`,
  );

  const baseImg = await grab(display);
  if (!baseImg) { console.error('抓不到屏幕'); app.exit(1); return; }
  const base = toBitmap(baseImg);
  console.log(`基准帧 ${base.width}x${base.height}（光效未显示）\n`);

  wm.showGlow();
  await wait(1600);
  const cur = toBitmap(await grab(display));
  console.log(`取景帧 ${cur.width}x${cur.height}（光效最亮附近）\n`);

  const corners = ['tl', 'tr', 'bl', 'br'];
  const name = { tl: '左上角', tr: '右上角', bl: '左下角', br: '右下角' };
  const grids = {};
  for (const c of corners) {
    grids[c] = cornerDelta(base, cur, c, cur.width, cur.height, scale);
  }

  for (const c of corners) {
    const g = grids[c];
    console.log(`${name[c]}（每格 = 7.5 逻辑像素，' '≈0  '.'≈9  ':'≈18  '-'≈27  '='≈36  '+'≈45  '*'≈54  '#'≈63  '%'≈72  '@'≈81+）`);
    console.log(draw(g));
    console.log('');
  }

  // ————————————————— 判定 —————————————————
  console.log('判定（把每个角的 8x8 网格按"离角尖的距离"分层，看最外那层有没有光）:');
  let cutCorners = 0;
  for (const c of corners) {
    const g = grids[c];
    // 角尖那一格 + 紧邻的两格
    const tip = [g[0][0], g[0][1], g[1][0]];
    // 往里第 3~5 层
    const inner = [g[4][4], g[4][5], g[5][4], g[5][5]];
    const avg = (a) => Math.round(a.reduce((s, v) => s + v, 0) / a.length);
    const tipAvg = avg(tip);
    const innerAvg = avg(inner);
    const cut = tipAvg < 3 && innerAvg > 10;
    if (cut) cutCorners += 1;
    console.log(
      `  ${name[c]}：角尖平均 Δ=${tipAvg}，往内平均 Δ=${innerAvg}  → ${cut ? '角尖没光、里面才有 ❌ 被裁了' : '角尖有光 ✅'}`,
    );
  }
  console.log(
    cutCorners
      ? `\n⇒ ${cutCorners} 个角被裁。这就是"外圈切口整齐、光效缩在里面"的来源。`
      : '\n⇒ 四个角都没被裁，光效一直铺到角尖 ✅',
  );

  store._write = realWrite;
  app.exit(0);
});
