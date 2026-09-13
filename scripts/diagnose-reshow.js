'use strict';

/**
 * 诊断脚本 11：复现「第一次提醒鼠标正常、第二次起整个弹窗收不到鼠标」。
 *
 * 需求方观察到的现象：
 *   - 第一次：鼠标放在滑块上是稳定手型
 *   - 第二次起：光标在「箭头 / 手型」之间来回闪，点击按钮和滑块都没反应
 *   - 但全局快捷键仍然有效（说明主进程没坏，是窗口层的输入问题）
 *
 * 这个脚本把「显示 → 隐藏 → 再显示」跑两轮，每轮都用真鼠标在滑块上晃一下，
 * 统计页面到底收到了多少 mouseenter / mouseleave / mousemove。
 *
 * 真鼠标坐标一律用**逻辑坐标**（getBounds 的值），不要乘 scaleFactor —— 见 计划.md 6.2。
 *
 * 运行：npx electron scripts/diagnose-reshow.js
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

/** 真鼠标：移动到 (x,y) 点一下（点击事件不会被合并，比单纯移动可靠得多） */
function realClick(x, y) {
  return ps(`${HEAD}
$b = New-Object 'M+POINT'
$null = [M]::GetCursorPos([ref]$b)
Write-Output "SAVED:$($b.X),$($b.Y)"
[M]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 220
[M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 90
[M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 250
`);
}

function restore(saved) {
  if (!saved) return;
  const [x, y] = saved.split(',');
  ps(`${HEAD}[M]::SetCursorPos(${x}, ${y})`);
}

const INSTRUMENT = `(() => {
  const s = document.getElementById('slider');
  const b = document.getElementById('btnSnooze');
  window.__probe = { stat: { btnDown: 0, btnClick: 0, sliderDown: 0, winDown: 0, enter: 0 } };
  b.addEventListener('pointerdown', () => { window.__probe.stat.btnDown += 1; }, true);
  b.addEventListener('click', () => { window.__probe.stat.btnClick += 1; }, true);
  s.addEventListener('pointerdown', () => { window.__probe.stat.sliderDown += 1; }, true);
  s.addEventListener('mouseenter', () => { window.__probe.stat.enter += 1; }, true);
  window.addEventListener('pointerdown', () => { window.__probe.stat.winDown += 1; }, true);
  return true;
})()`;

async function probeRound(label, wm) {
  await wm.popup.webContents.executeJavaScript(INSTRUMENT);

  const rects = await wm.popup.webContents.executeJavaScript(
    `(() => {
      const b = document.getElementById('btnSnooze').getBoundingClientRect();
      const s = document.getElementById('slider').getBoundingClientRect();
      return {
        btn: { x: b.left + b.width / 2, y: b.top + b.height / 2 },
        slider: { x: s.left + s.width / 2, y: s.top + s.height / 2 },
      };
    })()`,
  );

  const bounds = wm.popup.getBounds();
  // 逻辑坐标，不乘 scaleFactor
  const btnX = Math.round(bounds.x + rects.btn.x);
  const btnY = Math.round(bounds.y + rects.btn.y);
  const sldX = Math.round(bounds.x + rects.slider.x);
  const sldY = Math.round(bounds.y + rects.slider.y);

  const out1 = realClick(btnX, btnY);
  const saved = (out1.match(/SAVED:(\S+)/) || [])[1];
  await wait(250);
  realClick(sldX, sldY);
  await wait(250);

  const stat = await wm.popup.webContents.executeJavaScript('window.__probe.stat');

  console.log(`\n  ${label}`);
  console.log(`    弹窗可见=${wm.popup.isVisible()} bounds=${JSON.stringify(bounds)}`);
  console.log(`    点击「5 分钟后再提醒」(${btnX}, ${btnY})、滑块正中 (${sldX}, ${sldY})`);
  console.log(
    `    按钮 pointerdown=${stat.btnDown} click=${stat.btnClick}   滑块 pointerdown=${stat.sliderDown}   窗口级 pointerdown=${stat.winDown}`,
  );
  const ok = stat.btnDown > 0;
  console.log(`    判定: ${ok ? '✅ 点击能到达弹窗' : '❌ 点击完全到不了弹窗（复现了！）'}`);
  return { stat, ok, saved };
}

app.whenReady().then(async () => {
  const store = new Store();
  const wm = new WindowManager(store);

  // 统计 display-metrics-changed 触发次数，排查「反复重设窗口尺寸」
  let metricsChanged = 0;
  screen.on('display-metrics-changed', () => {
    metricsChanged += 1;
  });

  wm.createPopup();
  wm.createGlow();
  await wait(1000);

  const geo = await wm.popup.webContents.executeJavaScript(
    `(() => {
      const r = document.getElementById('slider').getBoundingClientRect();
      return { sliderLeft: r.left, sliderTop: r.top, sliderWidth: r.width, sliderHeight: r.height };
    })()`,
  );

  let lastSaved = null;

  // ——— 第 1 轮 ———
  wm.showReminder();
  await wait(1000);
  const r1 = await probeRound('【第 1 轮提醒】', wm);
  lastSaved = r1.saved;
  console.log(`    display-metrics-changed 累计触发: ${metricsChanged}`);

  // ——— 隐藏（模拟点延后 / 进入下一轮）———
  wm.hideReminder();
  await wait(1500);
  console.log(`\n  （已隐藏弹窗与光效，等待 1.5 秒）display-metrics-changed 累计: ${metricsChanged}`);

  // ——— 第 2 轮 ———
  wm.showReminder();
  await wait(1000);
  const r2 = await probeRound('【第 2 轮提醒】', wm);
  console.log(`    display-metrics-changed 累计触发: ${metricsChanged}`);

  // ——— 第 3 轮 ———
  wm.hideReminder();
  await wait(1500);
  wm.showReminder();
  await wait(1000);
  const r3 = await probeRound('【第 3 轮提醒】', wm);

  console.log('\n=========== 结论 ===========');
  console.log(`  第 1 轮: ${r1.ok ? '✅ 正常' : '❌ 异常'}`);
  console.log(`  第 2 轮: ${r2.ok ? '✅ 正常' : '❌ 异常'}`);
  console.log(`  第 3 轮: ${r3.ok ? '✅ 正常' : '❌ 异常'}`);
  if (r1.ok && !r2.ok) {
    console.log('  → 复现成功：第一次正常、重新显示之后整个弹窗收不到鼠标。');
  } else if (r1.ok && r2.ok && r3.ok) {
    console.log('  → 这一轮三轮都正常，没能复现。');
  }
  console.log(`  display-metrics-changed 共触发 ${metricsChanged} 次`);

  restore(lastSaved || r3.saved);
  app.exit(0);
});
