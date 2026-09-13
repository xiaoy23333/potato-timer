'use strict';

/**
 * 诊断脚本 16：量出光效窗口「窗口矩形」和「客户区」差多少像素。
 *
 * 需求方的真实截图证明：光效在四条边都从约 7~13 物理像素处才开始，
 * 外面那一圈是没有光效的（是一条硬边界，不是渐变）。
 * 怀疑是 Electron 无边框窗口的 thickFrame（默认 true）带来的 DWM 隐形边框。
 *
 * 这里用 Win32 直接量：GetWindowRect（窗口矩形）vs ClientToScreen(0,0)（客户区左上角）。
 * 两者的差就是那圈看不见的边框。
 *
 * 运行：npx electron scripts/diagnose-client-inset.js
 */

const { execFileSync } = require('node:child_process');
const { app, screen, BrowserWindow } = require('electron');
const { Store } = require('../src/main/store');
const { WindowManager } = require('../src/main/windows');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hwndOf(win) {
  try {
    const buf = win.getNativeWindowHandle();
    const v = buf.length >= 8 ? buf.readBigInt64LE() : BigInt(buf.readInt32LE());
    return BigInt.asUintN(64, v).toString();
  } catch {
    return null;
  }
}

/** 量窗口矩形 vs 客户区矩形 */
function measureInsets(hwnd) {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DshRect {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
}
'@
$h = [IntPtr]${hwnd}
$wr = New-Object 'DshRect+RECT'
$cr = New-Object 'DshRect+RECT'
$null = [DshRect]::GetWindowRect($h, [ref]$wr)
$null = [DshRect]::GetClientRect($h, [ref]$cr)
$o = New-Object 'DshRect+POINT'
$o.X = 0; $o.Y = 0
$null = [DshRect]::ClientToScreen($h, [ref]$o)
Write-Output ("WINDOW={0},{1},{2},{3}" -f $wr.Left, $wr.Top, $wr.Right, $wr.Bottom)
Write-Output ("CLIENT_SCREEN={0},{1}" -f $o.X, $o.Y)
Write-Output ("CLIENT_SIZE={0},{1}" -f $cr.Right, $cr.Bottom)
`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
    });
    const info = {};
    for (const line of out.trim().split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) info[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    const [wl, wt, wrr, wb] = (info.WINDOW || '').split(',').map(Number);
    const [csx, csy] = (info.CLIENT_SCREEN || '').split(',').map(Number);
    const [cw, ch] = (info.CLIENT_SIZE || '').split(',').map(Number);
    return {
      window: { left: wl, top: wt, right: wrr, bottom: wb, w: wrr - wl, h: wb - wt },
      clientScreen: { x: csx, y: csy },
      clientSize: { w: cw, h: ch },
      inset: { left: csx - wl, top: csy - wt, right: wrr - (csx + cw), bottom: wb - (csy + ch) },
    };
  } catch (err) {
    return { error: err.message };
  }
}

function report(label, win) {
  const hwnd = hwndOf(win);
  const m = measureInsets(hwnd);
  console.log(`\n  ${label}`);
  console.log(`    Electron getBounds() = ${JSON.stringify(win.getBounds())}`);
  if (m.error) {
    console.log(`    查询失败: ${m.error}`);
    return m;
  }
  console.log(`    Win32 窗口矩形(物理) = ${m.window.w} x ${m.window.h} @ ${m.window.left},${m.window.top}`);
  console.log(`    Win32 客户区(物理)   = ${m.clientSize.w} x ${m.clientSize.h} @ ${m.clientScreen.x},${m.clientScreen.y}`);
  console.log(
    `    ★ 客户区相对窗口矩形的内缩 = 左 ${m.inset.left}  上 ${m.inset.top}  右 ${m.inset.right}  下 ${m.inset.bottom} （物理像素）`,
  );
  const total = m.inset.left + m.inset.top + m.inset.right + m.inset.bottom;
  console.log(`    ${total === 0 ? '✅ 没有内缩，客户区就是整个窗口' : `❌ 四周被吃掉了 ${total}px，这就是那一圈没有光效的原因`}`);
  return m;
}

app.whenReady().then(async () => {
  const store = new Store();
  const wm = new WindowManager(store);
  screen.getPrimaryDisplay();

  console.log('屏幕上实际是 2560 x 1440 物理像素（逻辑 2048 x 1152，scaleFactor 1.25）');

  // ——— A：当前正式写法（thickFrame 默认 true）———
  wm.createGlow();
  wm.showGlow();
  await wait(900);
  const a = report('【A】光效层 —— 当前正式写法（thickFrame 默认 true）', wm.glow);

  // ——— B：thickFrame: false ———
  const b = new BrowserWindow({
    x: 0,
    y: 0,
    width: screen.getPrimaryDisplay().bounds.width,
    height: screen.getPrimaryDisplay().bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    thickFrame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  b.setAlwaysOnTop(true, 'screen-saver');
  b.setIgnoreMouseEvents(true, { forward: true });
  b.loadFile(require('node:path').join(__dirname, '..', 'src', 'renderer', 'glow.html'));
  await new Promise((r) => b.webContents.once('did-finish-load', r));
  b.setBounds({ x: 0, y: 0, width: screen.getPrimaryDisplay().bounds.width, height: screen.getPrimaryDisplay().bounds.height });
  b.showInactive();
  await wait(900);
  const mb = report('【B】光效层 —— thickFrame: false', b);

  // ——— C：提醒弹窗（看它有没有同样问题）———
  wm.createPopup();
  wm.showPopup();
  await wait(900);
  const c = report('【C】提醒弹窗 —— 当前正式写法', wm.popup);

  console.log('\n=========== 结论 ===========');
  const aBad = a.inset && a.inset.left + a.inset.top + a.inset.right + a.inset.bottom > 0;
  const bBad = mb.inset && mb.inset.left + mb.inset.top + mb.inset.right + mb.inset.bottom > 0;
  console.log(`  光效层 thickFrame:true  → ${aBad ? '有内缩 ❌' : '无内缩 ✅'}`);
  console.log(`  光效层 thickFrame:false → ${bBad ? '有内缩 ❌' : '无内缩 ✅'}`);
  if (aBad && !bBad) {
    console.log('  → 确认：thickFrame 是元凶，设成 false 即可铺满整屏。');
  } else if (!aBad && !bBad) {
    console.log('  → 两者都没内缩，那圈"没有光效"得从别处找原因。');
  } else if (aBad && bBad) {
    console.log('  → 两种写法都内缩，不是 thickFrame 的问题。');
  }

  app.exit(0);
});
