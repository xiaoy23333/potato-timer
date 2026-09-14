'use strict';

/**
 * 把光效那层的渲染结果合成到中灰底上（否则 PNG 的透明区看不出来），
 * 缩到 720 宽存图，用来肉眼判断「光的形状」。
 *
 * 运行：npx electron scripts/diagnose-glow-shape.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, screen, nativeImage } = require('electron');
const { Store } = require('../src/main/store');
const { WindowManager } = require('../src/main/windows');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(__dirname, '..', 'screenshots', 'glow-scale');

/** 把带 alpha 的画面合成到中灰 (128) 上，并缩到指定宽度 */
function flatten(img, outWidth) {
  const { width: w, height: h } = img.getSize();
  const src = img.toBitmap(); // BGRA，非预乘
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const a = src[i * 4 + 3] / 255;
    const b = src[i * 4] * a + 128 * (1 - a);
    const g = src[i * 4 + 1] * a + 128 * (1 - a);
    const r = src[i * 4 + 2] * a + 128 * (1 - a);
    out[i * 4] = Math.round(b);
    out[i * 4 + 1] = Math.round(g);
    out[i * 4 + 2] = Math.round(r);
    out[i * 4 + 3] = 255;
  }
  return nativeImage
    .createFromBitmap(out, { width: w, height: h })
    .resize({ width: outWidth, quality: 'good' });
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
  // 拉长到 8 秒，方便在几个时刻各取一张（几何已证明恒定）
  await wm.glow.webContents.executeJavaScript(
    `document.documentElement.style.setProperty('--dur', '8000ms'); true`,
  );

  wm.showGlow();

  const t0 = Date.now();
  for (const mark of [150, 500, 1500, 3000, 5000]) {
    await wait(Math.max(0, mark - (Date.now() - t0)));
    const img = await wm.glow.webContents.capturePage();
    const flat = flatten(img, 720);
    fs.writeFileSync(path.join(OUT, `形状-${String(mark).padStart(4, '0')}ms.png`), flat.toPNG());
    console.log(`  已存 形状-${String(mark).padStart(4, '0')}ms.png`);
  }

  store._write = realWrite;
  app.exit(0);
});
