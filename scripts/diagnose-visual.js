'use strict';

/**
 * 诊断脚本 9（最终确认）：窗口到底被画在屏幕的哪个位置？
 *
 * 用一个独特颜色（洋红 #FF00FF）填满窗口，然后全屏截图找这个颜色的像素范围，
 * 就能得到窗口的**真实视觉矩形**，和 getBounds()*scaleFactor 对比。
 *
 *   若洋红出现在物理 x = getBounds().x * scale  → 窗口按 DIP 摆放，是「输入映射」丢了缩放
 *   若洋红出现在物理 x = getBounds().x          → 窗口本身就在物理坐标上，scaleFactor 另有所指
 *
 * 运行：npx electron scripts/diagnose-visual.js
 */

const { app, screen, desktopCapturer, BrowserWindow } = require('electron');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 找洋红像素的范围（BGRA，洋红 = R255 G0 B255） */
function findMagenta(image) {
  const { width, height } = image.getSize();
  const buf = image.toBitmap();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const b = buf[i];
      const g = buf[i + 1];
      const r = buf[i + 2];
      if (r > 230 && g < 40 && b > 230) {
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!count) return null;
  return { left: minX, top: minY, right: maxX, bottom: maxY, width: maxX - minX, height: maxY - minY, count };
}

app.whenReady().then(async () => {
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  const display = screen.getPrimaryDisplay();

  const X = 600;
  const Y = 300;
  const W = 400;
  const H = 150;

  const win = new BrowserWindow({
    x: X,
    y: Y,
    width: W,
    height: H,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    backgroundColor: '#ff00ff',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      `<html><body style="margin:0;background:#ff00ff"><div style="position:absolute;inset:0"></div></body></html>`,
    )}`,
  );
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  win.showInactive();
  win.moveTop();
  await wait(1500);

  const b = win.getBounds();
  console.log(`scaleFactor = ${scale}`);
  console.log(`窗口屏幕逻辑尺寸 = ${display.size.width}x${display.size.height}`);
  console.log(`WindowFromPoint 之前测得的物理分辨率 = 2560x1440（由截图尺寸确认）`);
  console.log(`\n请求参数: x=${X} y=${Y} ${W}x${H}`);
  console.log(`getBounds() = ${JSON.stringify(b)}`);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  const shot = sources[0].thumbnail;
  const size = shot.getSize();
  console.log(`\n截图尺寸 = ${size.width}x${size.height}`);

  const mag = findMagenta(shot);
  console.log('\n【截屏找洋红窗口】');
  if (!mag) {
    console.log('  ❌ 没找到洋红像素 —— 窗口没显示出来？');
  } else {
    console.log(`  洋红区域（物理像素）: x ${mag.left} ~ ${mag.right}, y ${mag.top} ~ ${mag.bottom}`);
    console.log(`  尺寸: ${mag.width} x ${mag.height}（采样步长 2，所以略有误差）`);
    console.log(`\n  getBounds().x * scale = ${(b.x * scale).toFixed(0)}   （若窗口按 DIP 摆放，应该在这里）`);
    console.log(`  getBounds().x         = ${b.x}            （若窗口按物理坐标摆放，应该在这里）`);
    console.log(`  实测左边 = ${mag.left}`);
    console.log(
      `\n  ⇒ 判定: 窗口被画在物理 x=${mag.left}，` +
        `${Math.abs(mag.left - b.x * scale) < 25 ? '符合「按 DIP 摆放」' : Math.abs(mag.left - b.x) < 25 ? '符合「按物理坐标摆放」' : '两个都不符合'}`,
    );
    console.log(
      `  ⇒ 宽度: 实测 ${mag.width}，按 DIP 摆放应为 ${(b.width * scale).toFixed(0)}，按物理摆放应为 ${b.width}`,
    );
  }

  win.destroy();
  app.exit(0);
});
