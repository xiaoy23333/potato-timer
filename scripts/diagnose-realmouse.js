'use strict';

/**
 * 诊断脚本 3：用**真实的操作系统鼠标**（SendInput）拖一次滑块，看页面到底收到了什么。
 *
 * 前面所有结论都来自 WindowFromPoint 这种「问系统谁在上面」的间接推断，
 * 而自检里的 sendInputEvent 又绕过了操作系统。这里用真鼠标做地面真相。
 *
 * 会短暂接管你的鼠标指针（约 2 秒），结束后还原到原位。
 *
 * 运行：npx electron scripts/diagnose-realmouse.js
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

/** 真实鼠标：移动到 (x1,y1) → 按下 → 分步移动到 (x2,y2) → 松开 */
function realDrag(x1, y1, x2, y2, steps = 10) {
  const moves = [];
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(x1 + ((x2 - x1) * i) / steps);
    const y = Math.round(y1 + ((y2 - y1) * i) / steps);
    moves.push(`[M]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 25`);
  }
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
$before = New-Object 'M+POINT'
$null = [M]::GetCursorPos([ref]$before)
Write-Output "SAVED:$($before.X),$($before.Y)"

[M]::SetCursorPos(${x1}, ${y1}); Start-Sleep -Milliseconds 150
[M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 120
${moves.join('\n')}
Start-Sleep -Milliseconds 120
[M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 200
Write-Output "DONE"
`);
}

function restoreCursor(saved) {
  if (!saved) return;
  const [x, y] = saved.split(',');
  ps(`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class M2 { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }
'@
[M2]::SetCursorPos(${x}, ${y})
`);
}

const INSTRUMENT = `(() => {
  if (!window.__evt) {
    window.__evt = { down: 0, move: 0, up: 0, cancel: 0, lastDownTarget: null, knobLeft: null };
    const slider = document.getElementById('slider');
    slider.addEventListener('pointerdown', (e) => { window.__evt.down += 1; window.__evt.lastDownTarget = e.target.id || e.target.className; }, true);
    slider.addEventListener('pointermove', () => { window.__evt.move += 1; }, true);
    window.addEventListener('pointerup', () => { window.__evt.up += 1; }, true);
    window.addEventListener('pointercancel', () => { window.__evt.cancel += 1; }, true);
  }
  window.__evt.down = 0; window.__evt.move = 0; window.__evt.up = 0; window.__evt.cancel = 0;
  return true;
})()`;

app.whenReady().then(async () => {
  const store = new Store();
  const wm = new WindowManager(store);

  wm.createPopup();
  wm.createGlow();
  await wait(1000);
  wm.showReminder();
  await wait(1200);

  const b = wm.popup.getBounds();
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;

  const geo = await wm.popup.webContents.executeJavaScript(
    `(() => {
      const s = document.getElementById('slider');
      const r = s.getBoundingClientRect();
      return { sliderLeft: r.left, sliderTop: r.top, sliderW: r.width, sliderH: r.height };
    })()`,
  );

  console.log(`pid=${process.pid}  scaleFactor=${scale}`);
  console.log(`popup.getBounds() = ${JSON.stringify(b)}`);
  console.log(`滑块在窗口内的位置: left=${geo.sliderLeft} top=${geo.sliderTop} ${geo.sliderW}x${geo.sliderH}`);

  // —— 试验 1：完全按 getBounds 推算的位置去拖（也就是「用户看到的」位置）——
  const y = Math.round((b.y + geo.sliderTop + geo.sliderH / 2) * scale);
  const xStart = Math.round((b.x + geo.sliderLeft + 20) * scale);
  const xEnd = Math.round((b.x + geo.sliderLeft + geo.sliderW - 20) * scale);

  console.log(`\n【试验 1】按 getBounds 推算的滑块位置拖：物理 (${xStart}, ${y}) → (${xEnd}, ${y})`);
  await wm.popup.webContents.executeJavaScript(INSTRUMENT);
  const out1 = realDrag(xStart, y, xEnd, y);
  const saved = (out1.match(/SAVED:(\S+)/) || [])[1];
  await wait(400);
  const evt1 = await wm.popup.webContents.executeJavaScript('window.__evt');
  const knob1 = await wm.popup.webContents.executeJavaScript(`document.getElementById('knob').style.left`);
  console.log(`  页面收到的事件: pointerdown=${evt1.down} pointermove=${evt1.move} pointerup=${evt1.up} pointercancel=${evt1.cancel}`);
  console.log(`  pointerdown 落在: ${evt1.lastDownTarget}`);
  console.log(`  拖动结束后滑块位置: ${knob1}`);
  console.log(
    `  判定: ${evt1.down > 0 ? '✅ 真鼠标能点到滑块' : '❌ 真鼠标点不到滑块 —— 这就能复现你说的「拖不动」'}`,
  );

  // —— 试验 2：改去「实测命中区域」的中心再试一次 ——
  const altX = Math.round(1068);
  console.log(`\n【试验 2】改到实测命中区域的中心 (${altX}, ${y}) 再拖一次`);
  await wm.popup.webContents.executeJavaScript(INSTRUMENT);
  realDrag(altX, y, altX + 180, y);
  await wait(400);
  const evt2 = await wm.popup.webContents.executeJavaScript('window.__evt');
  console.log(`  页面收到的事件: pointerdown=${evt2.down} pointermove=${evt2.move} pointerup=${evt2.up}`);
  console.log(`  判定: ${evt2.down > 0 ? '✅ 这个位置能点到滑块' : '❌ 这个位置也点不到'}`);

  restoreCursor(saved);
  console.log('\n鼠标已还原。');
  app.exit(0);
});
