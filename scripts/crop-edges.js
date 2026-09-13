'use strict';

/**
 * 把需求方截图里的四条边裁出来并放大，方便肉眼确认「最外圈到底有没有光效」。
 *
 * 用法：npx electron scripts/crop-edges.js <图片路径>
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

const file = process.argv[2];
const outDir = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

const img = nativeImage.createFromPath(file);
const { width: W, height: H } = img.getSize();
console.log(`原图 ${W} x ${H}`);

/** 裁一块再放大，存成 png */
function cut(name, rect, scale) {
  const c = img.crop(rect);
  const s = c.getSize();
  const up = c.resize({ width: Math.round(s.width * scale), height: Math.round(s.height * scale), quality: 'best' });
  const p = path.join(outDir, name);
  fs.writeFileSync(p, up.toPNG());
  console.log(`  ${name}  ← 裁 (${rect.x},${rect.y}) ${rect.width}x${rect.height}，放大 ${scale}x → ${up.getSize().width}x${up.getSize().height}`);
}

app.whenReady().then(() => {
  // 左边一条：横向 0~150，纵向取屏幕中间 300 高
  cut('边缘-左.png', { x: 0, y: Math.round(H / 2) - 150, width: 150, height: 300 }, 3);
  // 上边一条：纵向 0~150，横向取屏幕中间 400 宽
  cut('边缘-上.png', { x: Math.round(W / 2) - 200, y: 0, width: 400, height: 150 }, 3);
  // 左上角
  cut('边缘-左上角.png', { x: 0, y: 0, width: 260, height: 160 }, 3);
  // 右下角（注意任务栏）
  cut('边缘-右下角.png', { x: W - 260, y: H - 160, width: 260, height: 160 }, 3);

  app.exit(0);
});
