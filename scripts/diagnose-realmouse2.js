'use strict';

/**
 * 诊断脚本 4：用真鼠标分别点三种窗口，定位「点击到底丢在哪一层」。
 *
 *   A 普通不透明窗口   → 如果连它都点不动，说明是整个环境在吃点击（与我们的窗口无关）
 *   B 不透明的弹窗副本 → 如果 A 能点、B 不能点，说明是「置顶 + 无边框」这类窗口设置的问题
 *   C 正式提醒弹窗     → 如果 A/B 能点、C 不能点，说明是 transparent:true 的问题
 *   D 正式弹窗的滑块   → 与 C 的按钮对比，看是整窗都点不到还是只有滑块点不到
 *
 * 会短暂接管鼠标指针（每次点击约 0.5 秒），结束后还原。
 * 运行：npx electron scripts/diagnose-realmouse2.js
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

/** 真鼠标：移动到 (x,y) 点一下 */
function realClick(x, y) {
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
[M]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 200
[M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 90
[M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 200
Write-Output "DONE"
`);
}

function restore(saved) {
  if (!saved) return;
  const [x, y] = saved.split(',');
  ps(`Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class M2 { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }
'@
[M2]::SetCursorPos(${x}, ${y})`);
}

function testPageHtml(bg, transparent) {
  return `<html><body style="margin:0;background:${transparent ? 'transparent' : bg};font-family:Segoe UI">
<button id="b" style="position:absolute;left:30px;top:30px;width:220px;height:70px;font-size:20px;cursor:pointer">点我</button>
<div id="out" style="position:absolute;left:30px;top:115px;font-size:14px;color:#333">clicks=0</div>
<script>
window.__clicks = 0; window.__down = 0;
var b = document.getElementById('b');
b.addEventListener('pointerdown', function(){ window.__down++; document.getElementById('out').textContent = 'down='+window.__down+' clicks='+window.__clicks; });
b.addEventListener('click', function(){ window.__clicks++; document.getElementById('out').textContent = 'down='+window.__down+' clicks='+window.__clicks; });
</script></body></html>`;
}

app.whenReady().then(async () => {
  const { BrowserWindow } = require('electron');
  const store = new Store();
  const wm = new WindowManager(store);
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;

  const make = (transparent, x, y, bg) => {
    const win = new BrowserWindow({
      x,
      y,
      width: 300,
      height: 160,
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
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(testPageHtml(bg, transparent))}`);
    return win;
  };

  const winA = make(false, 60, 700, '#ffffff'); // A 普通不透明
  const winB = make(true, 400, 700, '#00000000'); // B 透明（与正式弹窗同类）

  wm.createPopup();
  wm.createGlow();
  await wait(1100);
  winA.showInactive();
  winB.showInactive();
  wm.showReminder();
  await wait(1400);

  const clickTarget = async (win, offsetX, label) => {
    const b = win.getBounds();
    await wait(200);
    const x = Math.round((b.x + offsetX) * scale);
    const y = Math.round((b.y + 65) * scale);
    const out = realClick(x, y);
    const saved = (out.match(/SAVED:(\S+)/) || [])[1];
    await wait(350);
    let state;
    try {
      state = await win.webContents.executeJavaScript('({ clicks: window.__clicks, down: window.__down })');
    } catch (err) {
      state = { error: err.message };
    }
    const ok = state.clicks > 0;
    console.log(
      `  ${ok ? '✅' : '❌'} ${label.padEnd(34)} 物理点击(${x}, ${y})  →  pointerdown=${state.down} click=${state.clicks}`,
    );
    return { ok, saved };
  };

  console.log(`pid=${process.pid}  scaleFactor=${scale}\n`);
  console.log('真鼠标依次点击各组窗口（按钮中心）：');

  const rA = await clickTarget(winA, 140, 'A 普通不透明窗口');
  const rB = await clickTarget(winB, 140, 'B 透明窗口（同弹窗同类）');

  // C 正式弹窗的「5 分钟后再提醒」按钮
  const popupMeta = await wm.popup.webContents.executeJavaScript(
    `(() => {
      window.__sliderDown = 0;
      document.getElementById('slider').addEventListener('pointerdown', () => { window.__sliderDown++; }, true);
      const b = document.getElementById('btnSnooze').getBoundingClientRect();
      return { btnX: b.left + b.width / 2, btnY: b.top + b.height / 2, anyClick: 0 };
    })()`,
  );
  const rC = await clickTarget(wm.popup, popupMeta.btnX, 'C 正式弹窗的提醒按钮');

  // D 正式弹窗的滑块
  const sliderMeta = await wm.popup.webContents.executeJavaScript(
    `(() => { const r = document.getElementById('slider').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`,
  );
  const rD = await clickTarget(wm.popup, sliderMeta.x, 'D 正式弹窗的滑块');

  restore(rD.saved || rC.saved || rB.saved || rA.saved);

  console.log('\n=========== 结论 ===========');
  if (!rA.ok && !rB.ok && !rC.ok) {
    console.log('  连普通不透明窗口都点不动 → 是环境层面在吃鼠标点击，与番茄钟的窗口设置无关。');
  } else if (rA.ok && rB.ok && !rC.ok) {
    console.log('  普通窗口能点、正式弹窗不能点 → 问题出在正式弹窗的窗口参数上。');
  } else if (rA.ok && rB.ok && rC.ok && !rD.ok) {
    console.log('  按钮能点、滑块点不到 → 问题只在滑块那一块区域。');
  } else if (rA.ok && rB.ok && rC.ok && rD.ok) {
    console.log('  这一轮全部能点 → 之前那个「拖不动」可能是桌面状态相关的偶发，需要在你的真实使用场景里再看。');
  } else {
    console.log('  结果不整齐，见上面逐条。');
  }

  winA.destroy();
  winB.destroy();
  console.log('\n鼠标已还原。');
  app.exit(0);
});
