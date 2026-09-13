'use strict';

/**
 * 诊断脚本 15：量一张**真实截图**里光效的实际范围。
 *
 * 之前的教训：`capturePage()` 抓的是「页面自己以为的画面」，不等于「屏幕上真实的样子」。
 * 这里直接分析需求方提供的真实截图，看光效到底铺到屏幕边缘没有。
 *
 * 用法：npx electron scripts/analyze-screenshot.js <图片路径>
 */

const { app, nativeImage } = require('electron');
const path = require('node:path');

const file = process.argv[2] || process.env.SHOT;
if (!file) {
  console.error('用法: npx electron scripts/analyze-screenshot.js <图片路径>');
  process.exit(1);
}

const img = nativeImage.createFromPath(file);
const size = img.getSize();
const buf = img.toBitmap(); // BGRA

function px(x, y) {
  const i = (y * size.width + x) * 4;
  return { b: buf[i], g: buf[i + 1], r: buf[i + 2] };
}

/** 青色程度：光效色是 rgb(79,195,247)，特征是「蓝绿高、红低」 */
function cyanScore({ r, g, b }) {
  return (g + b) / 2 - r;
}

function profile(label, getter, distances) {
  const parts = distances.map((d) => {
    const { r, g, b } = getter(d);
    return `${String(d).padStart(4)}:${String(r).padStart(3)},${String(g).padStart(3)},${String(b).padStart(3)}(${String(Math.round(cyanScore({ r, g, b }))).padStart(4)})`;
  });
  console.log(`  ${label}`);
  console.log(`    ${parts.join('  ')}`);
}

app.whenReady().then(() => {
  console.log(`图片: ${path.basename(file)}`);
  console.log(`尺寸: ${size.width} x ${size.height}   （需求方屏幕物理分辨率应为 2560x1440）\n`);

  const D = [0, 1, 2, 3, 5, 8, 12, 18, 25, 35, 50, 70, 100, 140, 200];
  console.log('格式：距离:R,G,B(青色程度)   青色程度越高越像有蓝色光效\n');

  const midY = Math.round(size.height / 2);
  const midX = Math.round(size.width / 2);

  console.log('■ 左边缘（从 x=0 往右，取屏幕垂直中点那行）');
  profile('左', (d) => px(d, midY), D);

  console.log('\n■ 右边缘（从最右边往左）');
  profile('右', (d) => px(size.width - 1 - d, midY), D);

  console.log('\n■ 上边缘（从 y=0 往下，取屏幕水平中点那列）');
  profile('上', (d) => px(midX, d), D);

  console.log('\n■ 下边缘（从最下边往上）注意底部有任务栏');
  profile('下', (d) => px(midX, size.height - 1 - d), D);

  // 多行平均，避免恰好采到壁纸的深色/浅色区
  console.log('\n■ 左边缘（在 30%~70% 高度的 9 行上取平均，抹掉壁纸干扰）');
  const avg = (dist) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let k = 30; k <= 70; k += 5) {
      const y = Math.round((size.height * k) / 100);
      const p = px(dist, y);
      r += p.r;
      g += p.g;
      b += p.b;
      n += 1;
    }
    return { r: r / n, g: g / n, b: b / n };
  };
  profile('左avg', avg, [0, 1, 2, 3, 5, 8, 12, 18, 25, 35, 50, 70, 100]);

  // 找「青色程度」的拐点：从最外往内扫，看它什么时候明显抬起来
  console.log('\n■ 从边缘往内扫，找光效的起始位置（青色程度首次明显高于边缘值的距离）');
  for (const [name, get, limit] of [
    ['左', (d) => px(d, midY), 400],
    ['右', (d) => px(size.width - 1 - d, midY), 400],
    ['上', (d) => px(midX, d), 400],
  ]) {
    const base = cyanScore(get(0));
    let first = null;
    for (let d = 0; d <= limit; d += 1) {
      if (cyanScore(get(d)) > base + 15) {
        first = d;
        break;
      }
    }
    console.log(
      `  ${name}边缘：d=0 的青色程度=${Math.round(base)}，` +
        (first === null ? '往内 400px 都没有明显升高' : `在 d=${first}px 处首次明显升高（高 ${15}+）`),
    );
  }

  app.exit(0);
});
