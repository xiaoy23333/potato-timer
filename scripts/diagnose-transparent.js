'use strict';

/**
 * 诊断脚本 7：验证「输入坐标映射错位」的根因是不是 transparent:true。
 *
 * 做法：并排建两个内容完全相同的窗口，只差 transparent 一个开关，
 * 各自用真鼠标点几个已知物理坐标，反解出「物理像素 → 页面坐标」的映射。
 * 正确映射的斜率应该是 1/scaleFactor = 0.8；错位时是 1.0。
 *
 * 运行：npx electron scripts/diagnose-transparent.js
 */

const { execFileSync } = require('node:child_process');
const { app, screen, BrowserWindow } = require('electron');
const path = require('node:path');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
const POPUP_HTML = path.join(__dirname, '..', 'src', 'renderer', 'popup.html');

function ps(script, timeout = 60000) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout,
    }).trim();
  } catch (err) {
    return `ERR:${err.message}`;
  }
}

function clickMany(points) {
  const body = points
    .map(
      (p) =>
        `[M]::SetCursorPos(${p.x}, ${p.y}); Start-Sleep -Milliseconds 160; [M]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 70; [M]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 200`,
    )
    .join('\n');
  return ps(`
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
$b = New-Object 'M+POINT'
$null = [M]::GetCursorPos([ref]$b)
Write-Output "SAVED:$($b.X),$($b.Y)"
${body}
`);
}

async function measureMapping(label, win, scale) {
  const b = win.getBounds();
  await win.webContents.executeJavaScript(
    `(() => { window.__log = []; window.addEventListener('pointerdown', (e) => window.__log.push({ x: e.clientX, y: e.clientY, t: (e.target && (e.target.id || e.target.className || e.target.tagName)) || '?' }), true); return true; })()`,
  );

  const y = Math.round((b.y + 80) * scale);
  const xs = [Math.round((b.x + 40) * scale), Math.round((b.x + 100) * scale), Math.round((b.x + 160) * scale)];
  clickMany(xs.map((x) => ({ x, y })));
  await wait(400);
  const log = await win.webContents.executeJavaScript('window.__log');

  const expectedSlope = 1 / scale;
  let verdict = '无法判定（没收到点击）';
  let measured = null;
  if (log.length >= 2) {
    measured = (log[1].x - log[0].x) / (xs[1] - xs[0]);
    verdict =
      Math.abs(measured - expectedSlope) < 0.05
        ? `✅ 映射正确（斜率 ${measured.toFixed(3)}，应为 ${expectedSlope.toFixed(3)}）`
        : `❌ 映射错位（斜率 ${measured.toFixed(3)}，应为 ${expectedSlope.toFixed(3)}）`;
  }

  console.log(`\n  ${label}`);
  console.log(`    getBounds=${JSON.stringify(b)}  页面 innerWidth=${await win.webContents.executeJavaScript('window.innerWidth')}`);
  console.log(`    点击物理 x = ${xs.join(', ')}（y=${y}）`);
  console.log(`    页面收到 ${log.length} 次 pointerdown：`);
  log.forEach((entry, i) => console.log(`      物理 ${xs[i]} → clientX ${entry.x.toFixed(1)}  命中 ${entry.t}`));
  console.log(`    ${verdict}`);
  return { measured, expected: expectedSlope, log };
}

app.whenReady().then(async () => {
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  console.log(`scaleFactor = ${scale}   正确斜率应为 ${(1 / scale).toFixed(3)}`);

  const make = (transparent, y, bg, extra = {}) => {
    const win = new BrowserWindow({
      x: 700,
      y,
      width: 484,
      height: 162,
      frame: false,
      transparent,
      backgroundColor: bg,
      show: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
      ...extra,
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(POPUP_HTML);
    return win;
  };

  const transparentWin = make(true, 120, '#00000000');
  const opaqueWin = make(false, 420, '#ffffff');

  await Promise.all([
    new Promise((r) => transparentWin.webContents.once('did-finish-load', r)),
    new Promise((r) => opaqueWin.webContents.once('did-finish-load', r)),
  ]);
  transparentWin.showInactive();
  opaqueWin.showInactive();
  await wait(1200);

  const r1 = await measureMapping('【A】transparent: true（当前正式弹窗的写法）', transparentWin, scale);
  const r2 = await measureMapping('【B】transparent: false（候选修复）', opaqueWin, scale);

  console.log('\n=========== 结论 ===========');
  if (r1.measured !== null && r2.measured !== null) {
    const aBad = Math.abs(r1.measured - 1 / scale) > 0.05;
    const bOk = Math.abs(r2.measured - 1 / scale) <= 0.05;
    if (aBad && bOk) {
      console.log('  ✅ 确认：transparent:true 导致输入坐标映射错位，改成不透明即可修复。');
    } else if (!aBad && !bOk) {
      console.log('  ⚠️ 反过来了，transparent:false 反而错位，需要换个方向排查。');
    } else if (aBad && !bOk) {
      console.log('  ⚠️ 两种写法都错位 → 根因不在 transparent，而在更外层（DPI 感知 / 进程级设置）。');
    } else {
      console.log('  ⚠️ 两种写法都正常 → 这一次没能复现，说明还与环境状态有关。');
    }
  } else if (r2.log.length === 0 && r1.log.length > 0) {
    console.log('  ⚠️ 不透明窗口一次点击都没收到，需要先确认它是否真的显示了。');
  } else {
    console.log('  ⚠️ 数据不足，见上面逐条。');
  }

  transparentWin.destroy();
  opaqueWin.destroy();
  app.exit(0);
});
