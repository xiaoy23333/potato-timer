'use strict';

/**
 * 诊断脚本 10（修正版）：用**正确的坐标**做真鼠标拖动。
 *
 * 之前的诊断搞错了一件事：调用 PowerShell 的进程是 DPI-unaware 的，
 * SetCursorPos 吃的是「虚拟化坐标」（= 逻辑 DIP），不是物理像素。
 * 之前所有点击都乘了 1.25，于是全部偏到了 1.25 倍远的地方。
 *
 * 这次直接用 getBounds() 的逻辑坐标（不乘缩放）来驱动真鼠标。
 *
 * 运行：npx electron scripts/diagnose-realmouse-final.js
 */

const { execFileSync } = require('node:child_process');
const { app, screen } = require('electron');
const { Store } = require('../src/main/store');
const { WindowManager } = require('../src/main/windows');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ps(script, timeout = 40000) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout,
    }).trim();
  } catch (err) {
    return `ERR:${err.message}`;
  }
}

const HEAD = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
'@
`;

function realDrag(x1, y1, x2, y2, steps = 10) {
  const moves = [];
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(x1 + ((x2 - x1) * i) / steps);
    const y = Math.round(y1 + ((y2 - y1) * i) / steps);
    moves.push(`[M]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 30`);
  }
  return ps(`${HEAD}
$b = New-Object 'M+POINT'
$null = [M]::GetCursorPos([ref]$b)
Write-Output "SAVED:$($b.X),$($b.Y)"
[M]::SetCursorPos(${x1}, ${y1}); Start-Sleep -Milliseconds 200
[M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 120
${moves.join('\n')}
Start-Sleep -Milliseconds 100
[M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 250
Write-Output "DONE"
`);
}

function restore(saved) {
  if (!saved) return;
  const [x, y] = saved.split(',');
  ps(`${HEAD}[M]::SetCursorPos(${x}, ${y})`);
}

const INSTRUMENT = `(() => {
  window.__s = { down: 0, move: 0, up: 0, target: null };
  const s = document.getElementById('slider');
  s.addEventListener('pointerdown', (e) => { window.__s.down++; window.__s.target = e.target.id || e.target.className; }, true);
  s.addEventListener('pointermove', () => { window.__s.move++; }, true);
  window.addEventListener('pointerup', () => { window.__s.up++; }, true);
  return true;
})()`;

app.whenReady().then(async () => {
  const store = new Store();
  const wm = new WindowManager(store);
  const display = screen.getPrimaryDisplay();

  wm.createPopup();
  wm.createGlow();
  await wait(1000);
  wm.showReminder();
  await wait(1300);

  const b = wm.popup.getBounds();
  const geo = await wm.popup.webContents.executeJavaScript(
    `(() => { const r = document.getElementById('slider').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`,
  );

  console.log(`Electron 报的 scaleFactor = ${display.scaleFactor}（注意：PowerShell 的 SetCursorPos 用的是逻辑坐标，这里不乘它）`);
  console.log(`弹窗 getBounds = ${JSON.stringify(b)}`);
  console.log(`滑块局部矩形 = left ${geo.l.toFixed(1)} top ${geo.t.toFixed(1)} ${geo.w.toFixed(1)}x${geo.h.toFixed(1)}`);

  // 逻辑坐标：直接 getBounds + 局部偏移，不乘 scaleFactor
  const yDrag = Math.round(b.y + geo.t + geo.h / 2);
  const xStart = Math.round(b.x + geo.l + 12);
  const xEnd = Math.round(b.x + geo.l + geo.w - 12);

  console.log(`\n【真鼠标拖动】逻辑坐标 (${xStart}, ${yDrag}) → (${xEnd}, ${yDrag})`);
  await wm.popup.webContents.executeJavaScript(INSTRUMENT);
  const out = realDrag(xStart, yDrag, xEnd, yDrag);
  const saved = (out.match(/SAVED:(\S+)/) || [])[1];
  await wait(500);

  const stat = await wm.popup.webContents.executeJavaScript('window.__s');
  const knob = await wm.popup.webContents.executeJavaScript(`document.getElementById('knob').style.left`);
  const label = await wm.popup.webContents.executeJavaScript(
    `document.getElementById('sliderLabel').textContent`,
  );

  console.log(`  页面收到: pointerdown=${stat.down} pointermove=${stat.move} pointerup=${stat.up}  落点=${stat.target}`);
  console.log(`  滑块最终位置: ${knob}   滑块文案: 「${label}」`);
  console.log(`\n  判定: ${stat.down > 0 ? '✅ 真鼠标能按住并拖动滑块' : '❌ 真鼠标仍然按不到滑块'}`);
  console.log(
    `  ${label === '开始下一轮' ? '✅ 拖到底后确实触发了「进入下一轮」' : '（滑块文案未变成「开始下一轮」，说明没触发）'}`,
  );

  // 再补一次「从轨道正中按下」的拖动，验证之前修的 B1 缺陷
  console.log('\n【真鼠标：从轨道正中按下 → 拖到最右端】');
  wm.popup.setAlwaysOnTop(true, 'screen-saver');
  await wm.popup.webContents.executeJavaScript(INSTRUMENT);
  const midX = Math.round(b.x + geo.l + geo.w / 2);
  const rightX = Math.round(b.x + b.width - 20);
  realDrag(midX, yDrag, rightX, yDrag);
  await wait(500);
  const stat2 = await wm.popup.webContents.executeJavaScript('window.__s');
  const knob2 = await wm.popup.webContents.executeJavaScript(`document.getElementById('knob').style.left`);
  const maxLeft = await wm.popup.webContents.executeJavaScript(
    `Math.max(4, document.getElementById('slider').clientWidth - document.getElementById('knob').offsetWidth - 4)`,
  );
  console.log(`  页面收到: pointerdown=${stat2.down} pointermove=${stat2.move}`);
  console.log(`  滑块最终位置: ${knob2}   （最右端是 ${maxLeft}px）`);
  console.log(
    `  判定: ${parseFloat(knob2) >= maxLeft - 3 ? '✅ 从轨道中间按下也能一路拖到底' : '❌ 从轨道中间按下拖不到底'}`,
  );

  restore(saved);
  console.log('\n鼠标已还原。');
  app.exit(0);
});
