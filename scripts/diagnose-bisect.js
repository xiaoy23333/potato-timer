'use strict';

/**
 * 诊断脚本 8（二分定位）：到底是哪个窗口参数让「输入坐标映射」丢掉了 1.25 的屏幕缩放。
 *
 * 做法：建 4 个内容完全相同的窗口，参数从最小开始逐项叠加，各自用真鼠标点 3 下，
 * 反解「物理像素 → 页面坐标」斜率。正确值应为 1/scaleFactor = 0.8；错位则为 1.0。
 *
 *   W1  仅 frame:false
 *   W2  + alwaysOnTop + skipTaskbar
 *   W3  + focusable:false
 *   W4  + transparent:true        （= 正式弹窗的完整参数）
 *
 * 运行：npx electron scripts/diagnose-bisect.js
 */

const { execFileSync } = require('node:child_process');
const { app, screen, BrowserWindow } = require('electron');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        `[M]::SetCursorPos(${p.x}, ${p.y}); Start-Sleep -Milliseconds 150; [M]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 70; [M]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 180`,
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

const PAGE = `<html><body style="margin:0;background:#ffffff;font-family:Segoe UI">
<div id="pad" style="position:absolute;inset:0"></div>
<script>
window.__log = [];
window.addEventListener('pointerdown', function(e){
  window.__log.push({ x: e.clientX, y: e.clientY, t: (e.target && (e.target.id || e.target.className || e.target.tagName)) || '?' });
}, true);
</script></body></html>`;

app.whenReady().then(async () => {
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  const expected = 1 / scale;
  console.log(`scaleFactor = ${scale}   正确斜率 = ${expected.toFixed(3)}   错位斜率 = 1.000\n`);

  const X = 700;
  const YS = [60, 200, 340, 480];
  const variants = [
    { name: 'W1 仅 frame:false', flags: {} },
    { name: 'W2 +alwaysOnTop +skipTaskbar', flags: { alwaysOnTop: true, skipTaskbar: true } },
    { name: 'W3 +focusable:false', flags: { alwaysOnTop: true, skipTaskbar: true, focusable: false } },
    {
      name: 'W4 +transparent:true（= 正式弹窗）',
      flags: { alwaysOnTop: true, skipTaskbar: true, focusable: false, transparent: true },
    },
  ];

  const wins = [];
  for (let i = 0; i < variants.length; i += 1) {
    const v = variants[i];
    const win = new BrowserWindow({
      x: X,
      y: YS[i],
      width: 484,
      height: 162,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      hasShadow: false,
      backgroundColor: v.flags.transparent ? '#00000000' : '#ffffff',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
      ...v.flags,
    });
    if (v.flags.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    wins.push({ win, v, y: YS[i] });
  }

  await Promise.all(
    wins.map(({ win }) => new Promise((r) => win.webContents.once('did-finish-load', r))),
  );
  for (const { win } of wins) win.showInactive();
  await wait(1500);

  const results = [];
  for (const { win, v, y } of wins) {
    const b = win.getBounds();
    await win.webContents.executeJavaScript('window.__log = []; true');

    // 这些点同时落在「视觉区域」和「错位后的可点区域」交集里，
    // 所以无论映射对不对都会被收到；映射对不对只看斜率。
    const clickY = Math.round(y * scale) + 45;
    const xs = [Math.round(X * scale) + 40, Math.round(X * scale) + 100, Math.round(X * scale) + 160];
    clickMany(xs.map((x) => ({ x, y: clickY })));
    await wait(350);

    const log = await win.webContents.executeJavaScript('window.__log');
    let slope = null;
    if (log.length >= 2) {
      slope = (log[2] ? log[2].x - log[1].x : log[1].x - log[0].x) / 60;
    }
    const ok = slope !== null && Math.abs(slope - expected) < 0.05;
    results.push({ name: v.name, slope, ok, received: log.length, bounds: b });

    console.log(`  ${v.name}`);
    console.log(`    getBounds=${JSON.stringify(b)}   收到 ${log.length}/3 次点击`);
    if (log.length) {
      log.forEach((e, i) => console.log(`      物理 x=${xs[i]} → clientX=${e.x.toFixed(1)}`));
    }
    console.log(
      `    斜率 = ${slope === null ? 'n/a' : slope.toFixed(3)}   ` +
        `${slope === null ? '（没收到点击，无法判定）' : ok ? '✅ 映射正确' : '❌ 映射错位'}\n`,
    );
  }

  console.log('=========== 二分结论 ===========');
  const firstBad = results.find((r) => r.slope !== null && !r.ok);
  if (!firstBad) {
    console.log('  四组全部映射正确 → 说明这次没能复现，问题与当时的桌面状态有关。');
  } else {
    const idx = results.indexOf(firstBad);
    console.log(`  从这一组开始出现错位：${firstBad.name}（斜率 ${firstBad.slope.toFixed(3)}）`);
    if (idx === 0) {
      console.log('  → 连最朴素的窗口都错位 ⇒ 是进程级 / 系统级的 DPI 问题，与窗口参数无关。');
    } else {
      console.log(`  → 触发参数就是相对上一组新增的那一项：${variants[idx].name}`);
    }
  }

  for (const { win } of wins) win.destroy();
  app.exit(0);
});
