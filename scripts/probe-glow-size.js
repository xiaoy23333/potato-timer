'use strict';

/**
 * 一次性探针：查清 Windows 会不会把全屏透明覆盖层的高度限制在工作区内。
 * 运行：npx electron scripts/probe-glow-size.js
 */

const { app, BrowserWindow, screen } = require('electron');

let attempts = [];

function collect(name, win) {
  const b = win.getBounds();
  attempts.push(`${name.padEnd(34)} → ${b.width}x${b.height} @ ${b.x},${b.y}`);
}

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  console.log(`display.bounds   ${JSON.stringify(d.bounds)}`);
  console.log(`display.workArea ${JSON.stringify(d.workArea)}`);
  console.log(`scaleFactor      ${d.scaleFactor}`);
  console.log('');

  const full = { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height };

  // 1. 现状复现
  const win = new BrowserWindow({
    ...full,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
  });
  collect('创建时给定全屏尺寸', win);

  win.showInactive();
  await new Promise((r) => setTimeout(r, 300));
  collect('showInactive 之后', win);

  win.setBounds(full);
  collect('setBounds(全屏)', win);

  win.setSize(d.bounds.width, d.bounds.height, false);
  collect('setSize(全屏)', win);

  win.setResizable(true);
  win.setBounds(full);
  collect('setResizable(true)+setBounds', win);

  win.setMaximumSize(d.bounds.width, d.bounds.height);
  win.setBounds(full);
  collect('setMaximumSize(全屏)+setBounds', win);

  win.setResizable(false);
  win.hide();

  // 2. 全屏窗口方案
  const fullscreenWin = new BrowserWindow({
    ...full,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    fullscreen: true,
  });
  collect('创建时 fullscreen:true', fullscreenWin);
  fullscreenWin.showInactive();
  await new Promise((r) => setTimeout(r, 300));
  collect('fullscreen showInactive 之后', fullscreenWin);
  fullscreenWin.hide();

  console.log(attempts.join('\n'));
  console.log('');
  console.log(attempts.some((line) => /→ (\d+)x(\d+)/.test(line) && line.includes(`${d.bounds.width}x${d.bounds.height}`))
    ? '有方案能覆盖整块屏幕 ✅'
    : '所有方案都被限制住了 ❌');

  app.exit(0);
});
