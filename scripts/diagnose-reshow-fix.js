'use strict';

/**
 * 诊断脚本 12：找出「重新显示后弹窗收不到鼠标」的修法。
 *
 * 已确认的根因：popup 窗口（transparent + focusable:false + alwaysOnTop）
 * 在 hide() → showInactive() 之后会丢掉鼠标输入区域，第二次起整个窗口点不动。
 *
 * 这里逐个试候选修法，每种都跑「显示 → 真鼠标点按钮 → 隐藏 → 再显示 → 再点」，
 * 看哪几种能让第二轮也正常。
 *
 * 运行：npx electron scripts/diagnose-reshow-fix.js
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

function realClick(x, y) {
  return ps(`${HEAD}
[M]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 200
[M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 90
[M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 220
`);
}

const INSTRUMENT = `(() => {
  window.__n = 0;
  document.getElementById('btnSnooze').addEventListener('pointerdown', () => { window.__n += 1; }, true);
  return true;
})()`;

/** 真鼠标点一下弹窗里的按钮，返回页面收到的 pointerdown 次数 */
async function clickTest(wm) {
  await wm.popup.webContents.executeJavaScript(INSTRUMENT);
  const rect = await wm.popup.webContents.executeJavaScript(
    `(() => { const b = document.getElementById('btnSnooze').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
  );
  const bounds = wm.popup.getBounds();
  realClick(Math.round(bounds.x + rect.x), Math.round(bounds.y + rect.y));
  await wait(300);
  return wm.popup.webContents.executeJavaScript('window.__n');
}

/** 候选修法：在 showPopup 之后额外做点什么 */
const FIXES = [
  { name: '① 什么都不做（基准）', apply: async () => {} },
  {
    name: '② setIgnoreMouseEvents(false)',
    apply: async (wm) => {
      wm.popup.setIgnoreMouseEvents(false);
    },
  },
  {
    name: '③ 显示后再 setBounds 一次',
    apply: async (wm) => {
      const b = wm.popup.getBounds();
      wm.popup.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    },
  },
  {
    name: '④ 重新 setAlwaysOnTop',
    apply: async (wm) => {
      wm.popup.setAlwaysOnTop(true, 'screen-saver');
    },
  },
  {
    name: '⑤ moveTop()',
    apply: async (wm) => {
      wm.popup.moveTop();
    },
  },
  {
    name: '⑥ setOpacity(0.999) 再改回 1',
    apply: async (wm) => {
      wm.popup.setOpacity(0.999);
      wm.popup.setOpacity(1);
    },
  },
  {
    name: '⑦ 先移开 1px 再移回来',
    apply: async (wm) => {
      const b = wm.popup.getBounds();
      wm.popup.setBounds({ x: b.x + 1, y: b.y, width: b.width, height: b.height });
      await wait(60);
      wm.popup.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    },
  },
  {
    name: '⑧ 每次销毁重建窗口',
    apply: async (wm) => {
      const bounds = wm.popup.getBounds();
      wm.popup.destroy();
      wm.createPopup();
      await wait(500);
      wm.popup.setBounds(bounds);
      wm.popup.showInactive();
      await wait(500);
    },
  },
];

app.whenReady().then(async () => {
  const store = new Store();
  const wm = new WindowManager(store);
  wm.createPopup();
  wm.createGlow();
  await wait(1100);

  console.log('每项都是：显示 → 点按钮（第1轮）→ 隐藏 → 再显示 → 点按钮（第2轮）\n');

  for (const fix of FIXES) {
    // 先彻底重建，保证每一项的起点一致
    if (wm.popup && !wm.popup.isDestroyed()) wm.popup.destroy();
    wm.createPopup();
    await wait(500);

    // 第 1 轮
    wm.showPopup();
    await wait(900);
    const round1 = await clickTest(wm);

    // 隐藏 → 再显示，并应用候选修法
    wm.hidePopup();
    await wait(900);
    wm.showPopup();
    await wait(120);
    await fix.apply(wm);
    await wait(900);
    const round2 = await clickTest(wm);

    const verdict =
      round1 > 0 && round2 > 0
        ? '✅ 修好了'
        : round1 > 0 && round2 === 0
          ? '❌ 仍然失效'
          : `⚠️ 第1轮就不对（${round1}）`;
    console.log(`  ${fix.name.padEnd(30)} 第1轮=${round1}  第2轮=${round2}   ${verdict}`);
  }

  app.exit(0);
});
