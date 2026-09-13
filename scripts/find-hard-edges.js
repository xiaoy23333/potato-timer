'use strict';

/**
 * 在需求方的截图里找出所有「颜色突变」的位置（硬边界）。
 * 如果真有一个「比屏幕小一圈的长方形」光效，它的四条边会在这里现形。
 *
 * 用法：npx electron scripts/find-hard-edges.js <图片路径>
 */

const { app, nativeImage } = require('electron');
const path = require('node:path');

const file = process.argv[2];
const img = nativeImage.createFromPath(file);
const { width: W, height: H } = img.getSize();
const buf = img.toBitmap();

function px(x, y) {
  const i = (y * W + x) * 4;
  return { b: buf[i], g: buf[i + 1], r: buf[i + 2] };
}
function d(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

/** 沿一条横线找突变点（相邻像素差超过阈值的位置） */
function stepsAlongRow(y, threshold) {
  const hits = [];
  for (let x = 1; x < W; x += 1) {
    const v = d(px(x - 1, y), px(x, y));
    if (v >= threshold) hits.push({ x, v });
  }
  // 合并相邻的（同一条边界会有好几个像素）
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.x - last.x <= 3) {
      if (h.v > last.v) {
        last.x = h.x;
        last.v = h.v;
      }
    } else {
      merged.push({ ...h });
    }
  }
  return merged;
}

function stepsAlongCol(x, threshold) {
  const hits = [];
  for (let y = 1; y < H; y += 1) {
    const v = d(px(x, y - 1), px(x, y));
    if (v >= threshold) hits.push({ y, v });
  }
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.y - last.y <= 3) {
      if (h.v > last.v) {
        last.y = h.y;
        last.v = h.v;
      }
    } else {
      merged.push({ ...h });
    }
  }
  return merged;
}

app.whenReady().then(() => {
  console.log(`图片 ${W} x ${H}（屏幕应是 2560 x 1440 物理像素）`);
  console.log(`关注的位置：x≈2048（=2048*1.0，若窗口按物理像素摆放会在这里）`);
  console.log(`            x≈1584（=2048*1.25-976，另一种可能的错位）\n`);

  const TH = 60;
  console.log(`=== 横向扫描（阈值 ${TH}）===`);
  for (const y of [200, 400, 720, 1000, 1300]) {
    const s = stepsAlongRow(y, TH);
    const near2048 = s.filter((h) => Math.abs(h.x - 2048) < 30);
    const nearEdge = s.filter((h) => h.x < 60 || h.x > W - 60);
    console.log(
      `  y=${String(y).padStart(4)}: 共 ${s.length} 处突变` +
        `  |  最左 ${s.length ? s[0].x : '-'}` +
        `  最右 ${s.length ? s[s.length - 1].x : '-'}` +
        `  |  x≈2048 附近: ${near2048.length ? near2048.map((h) => `${h.x}(强度${h.v})`).join(' ') : '无'}` +
        `  |  贴边(<60 或 >${W - 60}): ${nearEdge.length ? nearEdge.map((h) => `${h.x}(${h.v})`).join(' ') : '无'}`,
    );
  }

  console.log(`\n=== 纵向扫描（阈值 ${TH}）===`);
  for (const x of [200, 640, 1280, 1920, 2400]) {
    const s = stepsAlongCol(x, TH);
    const near1152 = s.filter((h) => Math.abs(h.y - 1152) < 30);
    const nearEdge = s.filter((h) => h.y < 60 || h.y > H - 60);
    console.log(
      `  x=${String(x).padStart(4)}: 共 ${s.length} 处突变` +
        `  |  最上 ${s.length ? s[0].y : '-'}` +
        `  最下 ${s.length ? s[s.length - 1].y : '-'}` +
        `  |  y≈1152 附近: ${near1152.length ? near1152.map((h) => `${h.y}(${h.v})`).join(' ') : '无'}` +
        `  |  贴边(<60 或 >${H - 60}): ${nearEdge.length ? nearEdge.map((h) => `${h.y}(${h.v})`).join(' ') : '无'}`,
    );
  }

  // 重点：逐像素打印最左边 30px 和最上边 30px 的色值，看边界究竟在第几像素
  console.log('\n=== 最左侧 0~30px 的逐像素色值（取 y=720 那行）===');
  for (let x = 0; x <= 30; x += 1) {
    const p = px(x, 720);
    const step = x > 0 ? d(px(x - 1, 720), p) : 0;
    console.log(`  x=${String(x).padStart(2)}  rgb(${p.r},${p.g},${p.b})  与前一像素差=${step}`);
  }
  console.log('\n=== 最上侧 0~20px 的逐像素色值（取 x=1280 那列）===');
  for (let y = 0; y <= 20; y += 1) {
    const p = px(1280, y);
    const step = y > 0 ? d(px(1280, y - 1), p) : 0;
    console.log(`  y=${String(y).padStart(2)}  rgb(${p.r},${p.g},${p.b})  与前一像素差=${step}`);
  }

  app.exit(0);
});
