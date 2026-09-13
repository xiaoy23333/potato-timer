'use strict';

/**
 * 诊断脚本 5：先确认「我的真鼠标工具本身可靠吗」，再分别测按钮和滑块。
 *
 * 前一次实验里连普通不透明窗口都收不到点击，这可能是：
 *   (a) 屏幕被锁 / 会话不可交互 → 我的工具本身就不可靠
 *   (b) 对照窗口其实没显示出来
 *   (c) 环境真的在吃点击
 * 所以这次每一步都先断言「窗口确实可见」，并且同时统计 pointer 事件和 mouse 事件。
 *
 * 运行：npx electron scripts/diagnose-realmouse3.js
 */

const { execFileSync } = require('node:child_process');
const { app, screen } = require('electron');
const { Store } = require('../src/main/store');
const { WindowManager } = require('../src/main/windows');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ps(script, timeout = 30000) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout,
    }).trim();
  } catch (err) {
    return `ERR:${err.message}`;
  }
}

const MOUSE_HEAD = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
'@
`;

function realClick(x, y) {
  return ps(`${MOUSE_HEAD}
$b = New-Object 'M+POINT'
$null = [M]::GetCursorPos([ref]$b)
$okMove = [M]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 250
$c = New-Object 'M+POINT'
$null = [M]::GetCursorPos([ref]$c)
Write-Output "SAVED:$($b.X),$($b.Y)"
Write-Output "MOVED:$($c.X),$($c.Y) OK=$okMove"
[M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 100
[M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 250
Write-Output "FOREGROUND:$([M]::GetForegroundWindow().ToInt64())"
`);
}

function restore(saved) {
  if (!saved) return;
  const [x, y] = saved.split(',');
  ps(`${MOUSE_HEAD}[M]::SetCursorPos(${x}, ${y})`);
}

app.whenReady().then(async () => {
  const { BrowserWindow } = require('electron');
  const store = new Store();
  const wm = new WindowManager(store);
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;

  // —— 环境自检 ——
  const locked = ps(`$p = Get-Process LogonUI -ErrorAction SilentlyContinue; if ($p) { "LOCKED" } else { "UNLOCKED" }`);
  console.log(`环境自检：屏幕状态 = ${locked}`);

  // —— 对照组：一个普通不透明窗口 ——
  const control = new BrowserWindow({
    x: 60,
    y: 620,
    width: 320,
    height: 170,
    frame: false,
    transparent: false,
    backgroundColor: '#ffee88',
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  control.setAlwaysOnTop(true, 'screen-saver');
  control.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:#ffee88;font-family:Segoe UI">
<button id="b" style="position:absolute;left:30px;top:40px;width:240px;height:80px;font-size:22px">对照按钮</button>
<script>
window.__p=0; window.__m=0;
var b=document.getElementById('b');
b.addEventListener('pointerdown',function(){window.__p++;});
b.addEventListener('mousedown',function(){window.__m++;});
</script></body></html>`)}`,
  );

  wm.createPopup();
  wm.createGlow();
  await wait(1000);
  control.show();
  control.focus();
  await wait(600);
  wm.showReminder();
  await wait(1200);

  const ctrlBounds = control.getBounds();
  console.log(`对照窗口 可见=${control.isVisible()} 边界=${JSON.stringify(ctrlBounds)}`);
  console.log(`对照窗口 是否是焦点窗口=${control.isFocused()}`);

  // —— 在弹窗里同时统计 pointer 和 mouse 事件 ——
  await wm.popup.webContents.executeJavaScript(`(() => {
    window.__stat = { sliderPointer: 0, sliderMouse: 0, btnPointer: 0, btnMouse: 0, winPointer: 0, winMouse: 0, over: 0 };
    const s = document.getElementById('slider');
    const b = document.getElementById('btnSnooze');
    s.addEventListener('pointerdown', () => { window.__stat.sliderPointer += 1; }, true);
    s.addEventListener('mousedown', () => { window.__stat.sliderMouse += 1; }, true);
    s.addEventListener('pointerover', () => { window.__stat.over += 1; }, true);
    b.addEventListener('pointerdown', () => { window.__stat.btnPointer += 1; }, true);
    b.addEventListener('mousedown', () => { window.__stat.btnMouse += 1; }, true);
    window.addEventListener('pointerdown', () => { window.__stat.winPointer += 1; }, true);
    window.addEventListener('mousedown', () => { window.__stat.winMouse += 1; }, true);
    return true;
  })()`);

  const popupBounds = wm.popup.getBounds();
  const geo = await wm.popup.webContents.executeJavaScript(`(() => {
    const s = document.getElementById('slider').getBoundingClientRect();
    const b = document.getElementById('btnSnooze').getBoundingClientRect();
    return {
      slider: { cx: s.left + s.width / 2, cy: s.top + s.height / 2 },
      btn: { cx: b.left + b.width / 2, cy: b.top + b.height / 2 },
    };
  })()`);

  const clickAt = async (win, localX, localY, bounds, label) => {
    const x = Math.round((bounds.x + localX) * scale);
    const y = Math.round((bounds.y + localY) * scale);
    const out = realClick(x, y);
    const saved = (out.match(/SAVED:(\S+)/) || [])[1];
    const moved = (out.match(/MOVED:(\S+)/) || [])[1];
    await wait(400);
    let stat = null;
    try {
      stat = await win.webContents.executeJavaScript('window.__stat || window.__p !== undefined ? { p: window.__p, m: window.__m, ...(window.__stat||{}) } : null');
    } catch {
      stat = null;
    }
    console.log(`\n  ${label}`);
    console.log(`    目标物理坐标 (${x}, ${y})   光标实际到位: ${moved}`);
    console.log(`    事件统计: ${JSON.stringify(stat)}`);
    return { saved, stat };
  };

  console.log('\n=========== 真鼠标点击测试 ===========');
  const r1 = await clickAt(control, 150, 80, ctrlBounds, '① 对照窗口的按钮（普通不透明窗口）');
  const r2 = await clickAt(wm.popup, geo.btn.cx, geo.btn.cy, popupBounds, '② 提醒弹窗的「5 分钟后再提醒」按钮');
  const r3 = await clickAt(wm.popup, geo.slider.cx, geo.slider.cy, popupBounds, '③ 提醒弹窗的滑块正中');

  // —— 再对弹窗做一次完整拖动 ——
  console.log('\n=========== 真鼠标拖动滑块 ===========');
  await wm.popup.webContents.executeJavaScript(
    `window.__stat = { sliderPointer: 0, sliderMouse: 0, btnPointer: 0, btnMouse: 0, winPointer: 0, winMouse: 0, over: 0 }; true`,
  );
  const xStart = Math.round((popupBounds.x + geo.slider.cx - 80) * scale);
  const yDrag = Math.round((popupBounds.y + geo.slider.cy) * scale);
  const xEnd = Math.round((popupBounds.x + geo.slider.cx + 120) * scale);
  const dragOut = ps(`${MOUSE_HEAD}
$b = New-Object 'M+POINT'
$null = [M]::GetCursorPos([ref]$b)
Write-Output "SAVED:$($b.X),$($b.Y)"
[M]::SetCursorPos(${xStart}, ${yDrag}); Start-Sleep -Milliseconds 200
[M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 120
${Array.from({ length: 8 }, (_, i) => {
  const x = Math.round(xStart + ((xEnd - xStart) * (i + 1)) / 8);
  return `[M]::SetCursorPos(${x}, ${yDrag}); Start-Sleep -Milliseconds 30`;
}).join('\n')}
[M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 250
`);
  await wait(400);
  const dragStat = await wm.popup.webContents.executeJavaScript('window.__stat');
  const knob = await wm.popup.webContents.executeJavaScript(`document.getElementById('knob').style.left`);
  console.log(`  从 (${xStart}, ${yDrag}) 拖到 (${xEnd}, ${yDrag})`);
  console.log(`  事件统计: ${JSON.stringify(dragStat)}`);
  console.log(`  滑块最终位置: ${knob}`);

  restore((dragOut.match(/SAVED:(\S+)/) || [])[1] || r3.saved);

  console.log('\n=========== 判定 ===========');
  const ctrlClicked = r1.stat && (r1.stat.p > 0 || r1.stat.m > 0);
  console.log(`  对照窗口能收到真鼠标点击吗: ${ctrlClicked ? '✅ 能' : '❌ 不能 → 我的注入工具在当前环境下不可靠，本次结论作废'}`);
  if (ctrlClicked) {
    const btnOk = r2.stat && (r2.stat.btnPointer > 0 || r2.stat.btnMouse > 0);
    const sliderOk = dragStat && (dragStat.sliderPointer > 0 || dragStat.sliderMouse > 0);
    console.log(`  弹窗按钮能点到吗            : ${btnOk ? '✅ 能' : '❌ 不能'}`);
    console.log(`  弹窗滑块能点到吗            : ${sliderOk ? '✅ 能' : '❌ 不能'}`);
  }

  control.destroy();
  console.log('\n鼠标已还原。');
  app.exit(0);
});
