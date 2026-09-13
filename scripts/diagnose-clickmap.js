'use strict';

/**
 * 诊断脚本 6（最后一击）：量出「屏幕物理坐标 → 页面内坐标」的真实映射。
 *
 * 已知：真鼠标点击确实到达了弹窗窗口，但落点不是按钮也不是滑块。
 * 只要在几个已知物理坐标上点一下，记下页面收到的 clientX/clientY 和命中的元素，
 * 就能反解出窗口真实的原点与缩放，从而判断 getBounds() 是否在说谎。
 *
 * 运行：npx electron scripts/diagnose-clickmap.js
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

function clickMany(points) {
  const body = points
    .map(
      (p) =>
        `[M]::SetCursorPos(${p.x}, ${p.y}); Start-Sleep -Milliseconds 180; [M]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 80; [M]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 220; Write-Output "CLICKED:${p.x},${p.y}"`,
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
Write-Output "DONE"
`);
}

app.whenReady().then(async () => {
  const store = new Store();
  const wm = new WindowManager(store);
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;

  wm.createPopup();
  await wait(1000);
  wm.showPopup();
  await wait(1200);

  const b = wm.popup.getBounds();
  const inner = await wm.popup.webContents.executeJavaScript(
    `({ iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio, sx: window.screenX, sy: window.screenY })`,
  );

  console.log(`scaleFactor=${scale}`);
  console.log(`getBounds() = ${JSON.stringify(b)}`);
  console.log(`页面自报: ${JSON.stringify(inner)}`);
  console.log(
    `按 getBounds 推算，页面左上角应该在物理 (${Math.round(b.x * scale)}, ${Math.round(b.y * scale)})`,
  );

  // 记录每一次 pointerdown 的页面坐标与命中元素
  await wm.popup.webContents.executeJavaScript(`(() => {
    window.__log = [];
    window.addEventListener('pointerdown', (e) => {
      const el = e.target;
      window.__log.push({
        clientX: e.clientX, clientY: e.clientY,
        target: el ? (el.id || el.className || el.tagName) : 'null',
      });
    }, true);
    return true;
  })()`);

  const y = Math.round((b.y + 80) * scale);
  const points = [1000, 1100, 1200, 1300, 1400].map((x) => ({ x, y }));
  console.log(`\n在物理 y=${y} 上依次点击 x = ${points.map((p) => p.x).join(', ')}`);

  const out = clickMany(points);
  const saved = (out.match(/SAVED:(\S+)/) || [])[1];
  await wait(500);

  const log = await wm.popup.webContents.executeJavaScript('window.__log');
  console.log(`\n页面收到 ${log.length} 次 pointerdown：`);
  log.forEach((entry, i) => {
    const clickedPhysical = points[i] ? points[i].x : null;
    console.log(
      `  第${i + 1}次: 物理点击 x=${clickedPhysical}  →  页面 clientX=${entry.clientX}, clientY=${entry.clientY}  命中元素=${entry.target}`,
    );
  });

  // 反解映射：clientX = (physicalX - originPhysicalX) / scale
  if (log.length >= 2) {
    const p1 = points[0].x;
    const p2 = points[1].x;
    const c1 = log[0].clientX;
    const c2 = log[1].clientX;
    const slope = (c2 - c1) / (p2 - p1);
    const originPhysicalX = p1 - c1 / slope;
    console.log('\n【反解结果】');
    console.log(`  页面坐标/物理像素 斜率 = ${slope.toFixed(5)}   （每物理像素对应的页面 px）`);
    console.log(`  反推窗口左上角的物理 x = ${originPhysicalX.toFixed(1)}`);
    console.log(`  反推窗口左上角的逻辑 x = ${(originPhysicalX / scale).toFixed(1)}`);
    console.log(`  getBounds().x        = ${b.x}`);
    console.log(
      `  结论: ${
        Math.abs(originPhysicalX / scale - b.x) < 8
          ? '✅ 窗口真实位置与 getBounds 一致'
          : `❌ 窗口真实位置比 getBounds 偏了 ${(originPhysicalX / scale - b.x).toFixed(0)} 逻辑像素`
      }`,
    );
    console.log(
      `  真实缩放: ${(slope * scale).toFixed(4)} （1 表示页面 px = 逻辑 px，正常应为 1）`,
    );
  } else {
    console.log('\n❌ 页面一次 pointerdown 都没收到，无法反解映射。');
  }

  if (saved) {
    ps(`Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class M2 { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }
'@
[M2]::SetCursorPos(${saved.split(',')[0]}, ${saved.split(',')[1]})`);
  }
  console.log('\n鼠标已还原。');
  app.exit(0);
});
