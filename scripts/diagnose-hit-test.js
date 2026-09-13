'use strict';

/**
 * 诊断脚本：查清「提醒弹窗上的滑块为什么拖不动」。
 *
 * 做法：
 *   1. 用和正式程序**完全相同的窗口参数**（直接复用 WindowManager）把提醒显示出来
 *   2. 算出滑块在屏幕上的物理像素坐标
 *   3. 用 Win32 的 WindowFromPoint 问一句：这个像素点当前归哪个窗口？
 *      - 答案是光效层  → 光效层没做到点击穿透，它把鼠标点击全吃掉了
 *      - 答案是提醒弹窗 → 窗口这一层没问题，问题出在拖动逻辑里
 *   4. 顺带对比「弹窗卡片正中」和「屏幕边缘」两个点，看得更清楚
 *
 * 运行：npx electron scripts/diagnose-hit-test.js
 */

const { execFileSync } = require('node:child_process');
const { app, screen } = require('electron');
const { Store } = require('../src/main/store');
const { WindowManager } = require('../src/main/windows');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hwndOf(win) {
  try {
    const buf = win.getNativeWindowHandle();
    const value = buf.length >= 8 ? buf.readBigInt64LE() : BigInt(buf.readInt32LE());
    return BigInt.asUintN(64, value).toString();
  } catch {
    return null;
  }
}

/** 问 Win32：屏幕物理像素点 (x, y) 归哪个窗口，并把这个窗口的身份挖出来 */
function windowFromPoint(x, y) {
  const script = `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshHitTest {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
}
'@
$p = New-Object 'DshHitTest+POINT'
$p.X = ${x}
$p.Y = ${y}
$h = [DshHitTest]::WindowFromPoint($p)
$root = [DshHitTest]::GetAncestor($h, 2)

$sb = New-Object System.Text.StringBuilder 512
$pid_ = 0
$null = [DshHitTest]::GetWindowThreadProcessId($root, [ref]$pid_)
$r = New-Object 'DshHitTest+RECT'
$null = [DshHitTest]::GetWindowRect($root, [ref]$r)

# 从命中窗口一路往上走，把整条窗口链打出来
$chain = @()
$cur = $h
for ($i = 0; $i -lt 6 -and $cur -ne [IntPtr]::Zero; $i++) {
  $chain += ("{0}:{1}" -f $cur.ToInt64(), [DshHitTest]::ClassOf($cur))
  $cur = [DshHitTest]::GetParent($cur)
}

Write-Output ("HWND={0}" -f $h.ToInt64())
Write-Output ("ROOT={0}" -f $root.ToInt64())
Write-Output ("ROOT_CLASS={0}" -f [DshHitTest]::ClassOf($root))
Write-Output ("ROOT_PID={0}" -f $pid_)
Write-Output ("ROOT_RECT={0},{1},{2},{3}" -f $r.Left, $r.Top, $r.Right, $r.Bottom)
Write-Output ("ROOT_EXSTYLE=0x{0:X}" -f [DshHitTest]::GetWindowLong($root, -20))
Write-Output ("CHAIN={0}" -f ($chain -join ' <- '))
`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
    });
    const info = {};
    for (const line of out.trim().split(/\r?\n/)) {
      const idx = line.indexOf('=');
      if (idx > 0) info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return info;
  } catch (err) {
    return { error: err.message };
  }
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  const store = new Store();
  const wm = new WindowManager(store);

  wm.createPopup();
  wm.createGlow();
  await wait(900);

  wm.showReminder();
  await wait(900);

  const ids = {
    popup: hwndOf(wm.popup),
    glow: hwndOf(wm.glow),
    float: wm.float ? hwndOf(wm.float) : null,
  };

  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  const popupBounds = wm.popup.getBounds();

  // 滑块内部一点的相对坐标（取滑块左侧 1/3 处、垂直居中）
  const geometry = await wm.popup.webContents.executeJavaScript(
    `(() => {
      const s = document.getElementById('slider');
      const r = s.getBoundingClientRect();
      const knob = document.getElementById('knob').getBoundingClientRect();
      return {
        sliderLeft: r.left, sliderTop: r.top, sliderWidth: r.width, sliderHeight: r.height,
        knobLeft: knob.left, knobWidth: knob.offsetWidth,
      };
    })()`,
  );

  const points = [
    {
      name: '滑块左 1/3 处（想拖动的起点）',
      x: popupBounds.x + geometry.sliderLeft + geometry.sliderWidth * 0.33,
      y: popupBounds.y + geometry.sliderTop + geometry.sliderHeight / 2,
    },
    {
      name: '滑块正中间',
      x: popupBounds.x + geometry.sliderLeft + geometry.sliderWidth * 0.5,
      y: popupBounds.y + geometry.sliderTop + geometry.sliderHeight / 2,
    },
    {
      name: '「5 分钟后再提醒」按钮中心',
      x: popupBounds.x + geometry.sliderLeft - 110,
      y: popupBounds.y + geometry.sliderTop + geometry.sliderHeight / 2,
    },
    {
      name: '屏幕正中央（光效层的中心，应该完全穿透）',
      x: screen.getPrimaryDisplay().bounds.width / 2,
      y: screen.getPrimaryDisplay().bounds.height / 2,
    },
  ];

  console.log('窗口句柄：');
  console.log(`  本进程 pid = ${process.pid}`);
  console.log(`  提醒弹窗 popup = ${ids.popup}`);
  console.log(`  光效层   glow  = ${ids.glow}`);
  console.log(`  小浮窗   float = ${ids.float ?? '(未创建)'}`);

  // 顺带把弹窗自己渲染出来的像素 alpha 量一遍：
  // 透明窗口在 Windows 上可能按像素 alpha 做命中测试，alpha≈0 的地方点击会漏下去
  const shot = await wm.popup.webContents.capturePage();
  const bmp = shot.toBitmap();
  const shotSize = shot.getSize();
  const alphaAt = (cssX, cssY) => {
    const px = Math.round((cssX / popupBounds.width) * shotSize.width);
    const py = Math.round((cssY / popupBounds.height) * shotSize.height);
    if (px < 0 || py < 0 || px >= shotSize.width || py >= shotSize.height) return null;
    return bmp[(py * shotSize.width + px) * 4 + 3];
  };
  const sliderCenterX = geometry.sliderLeft + geometry.sliderWidth / 2;
  const sliderCenterY = geometry.sliderTop + geometry.sliderHeight / 2;
  console.log(
    `\n弹窗自身渲染出的 alpha：滑块中心 = ${alphaAt(sliderCenterX, sliderCenterY)}` +
      `，按钮区域 = ${alphaAt(geometry.sliderLeft - 110, sliderCenterY)}` +
      `，卡片正中 = ${alphaAt(popupBounds.width / 2, popupBounds.height / 2)}` +
      `（255 = 完全不透明，0 = 完全透明）`,
  );

  // 从弹窗页面自己的视角确认真实位置
  const winInfo = await wm.popup.webContents.executeJavaScript(
    `({
      screenX: window.screenX, screenY: window.screenY,
      outerWidth: window.outerWidth, outerHeight: window.outerHeight,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
    })`,
  );
  console.log(`\n弹窗页面自报的位置：${JSON.stringify(winInfo)}`);

  console.log(`\nscaleFactor = ${scale}, popupBounds = ${JSON.stringify(popupBounds)}`);

  // 把每个元素的真实矩形打出来
  const rects = await wm.popup.webContents.executeJavaScript(
    `(() => {
      const out = {};
      for (const [name, sel] of [['body','body'],['card','.card'],['row','.row'],['btn','#btnSnooze'],['slider','#slider'],['knob','#knob']]) {
        const el = document.querySelector(sel);
        if (!el) { out[name] = null; continue; }
        const r = el.getBoundingClientRect();
        out[name] = { left: +r.left.toFixed(1), top: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
      }
      return out;
    })()`,
  );
  console.log('\n元素真实矩形（CSS px，相对弹窗左上角）：');
  for (const [name, r] of Object.entries(rects)) console.log(`  ${name.padEnd(8)} ${r ? JSON.stringify(r) : '(不存在)'}`);

  const sliderY = Math.round((popupBounds.y + rects.slider.top + rects.slider.h / 2) * scale);
  const scanStart = Math.round((popupBounds.x - 80) * scale);
  const scanEnd = Math.round((popupBounds.x + popupBounds.width + 80) * scale);

  console.log(`\n【横向扫描】y = ${sliderY}（滑块所在行），x 从 ${scanStart} 到 ${scanEnd}，步长 10`);
  console.log('  每个字符 = 10 物理像素：P=提醒弹窗  G=光效层  .=漏到别的窗口');
  let line = '';
  let firstP = null;
  let lastP = null;
  for (let x = scanStart; x <= scanEnd; x += 10) {
    const info = windowFromPoint(x, sliderY);
    const isP = !info.error && info.ROOT === ids.popup;
    const isG = !info.error && info.ROOT === ids.glow;
    line += isP ? 'P' : isG ? 'G' : '.';
    if (isP) {
      if (firstP === null) firstP = x;
      lastP = x;
    }
  }
  console.log(`  ${line}`);
  console.log(
    `  弹窗可点击范围（物理）: ${firstP} ~ ${lastP}` +
      `  → 逻辑 ${firstP === null ? '?' : (firstP / scale).toFixed(0)} ~ ${lastP === null ? '?' : (lastP / scale).toFixed(0)}`,
  );
  console.log(
    `  getBounds() 声称的范围（逻辑）: ${popupBounds.x} ~ ${popupBounds.x + popupBounds.width}` +
      `  → 物理 ${Math.round(popupBounds.x * scale)} ~ ${Math.round((popupBounds.x + popupBounds.width) * scale)}`,
  );

  console.log('\n各关键点的命中窗口：\n');

  const nameOf = (info) => {
    if (info.error) return `查询失败: ${info.error}`;
    const root = info.ROOT;
    if (!root || root === '0') return '（桌面 / 没有窗口）';
    if (root === ids.popup) return '✅ 提醒弹窗 popup';
    if (root === ids.glow) return '❌ 光效层 glow（把点击吃掉了）';
    if (root === ids.float) return '小浮窗 float';
    return `⚠️ 外来窗口 class=${info.ROOT_CLASS} pid=${info.ROOT_PID} rect=(${info.ROOT_RECT}) exstyle=${info.ROOT_EXSTYLE}`;
  };

  // ————————————— A/B 对照实验 —————————————
  // 同样尺寸、同样元素内容，只差一个 transparent 开关，看谁的命中范围和 getBounds 对得上。
  const { BrowserWindow } = require('electron');
  const path = require('node:path');
  const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
  const POPUP_HTML = path.join(__dirname, '..', 'src', 'renderer', 'popup.html');

  const makeTwin = (transparent, y, bg) =>
    new BrowserWindow({
      x: popupBounds.x,
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
    });

  const ghostOf = (win) => {
    const b = win.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  };

  const opaqueTwin = makeTwin(false, 300, '#ff00ff');
  opaqueTwin.setAlwaysOnTop(true, 'screen-saver');
  opaqueTwin.loadFile(POPUP_HTML);
  opaqueTwin.webContents.once('did-finish-load', () => opaqueTwin.showInactive());

  const transparentTwin = makeTwin(true, 520, '#00000000');
  transparentTwin.setAlwaysOnTop(true, 'screen-saver');
  transparentTwin.loadFile(POPUP_HTML);
  transparentTwin.webContents.once('did-finish-load', () => transparentTwin.showInactive());

  await wait(1400);

  const scanRow = (label, win) => {
    const b = win.getBounds();
    const id = hwndOf(win);
    const rowY = Math.round((b.y + b.height / 2) * scale);
    let first = null;
    let last = null;
    for (let x = Math.round((b.x - 150) * scale); x <= Math.round((b.x + b.width + 150) * scale); x += 10) {
      const info = windowFromPoint(x, rowY);
      if (!info.error && info.ROOT === id) {
        if (first === null) first = x;
        last = x;
      }
    }
    const expectedFirst = Math.round(b.x * scale);
    const expectedLast = Math.round((b.x + b.width) * scale);
    const hitClass = windowFromPoint(Math.round((b.x + b.width * 0.75) * scale), rowY);

    console.log(`\n  ${label}`);
    console.log(`    句柄=${id}  getBounds=${JSON.stringify(ghostOf(win))}  扫描行 y=${rowY}`);
    console.log(
      `    实测可点击（物理）: ${first} ~ ${last}    应该: ${expectedFirst} ~ ${expectedLast}` +
        `    误差: 左 ${first === null ? '?' : first - expectedFirst}px / 右 ${last === null ? '?' : last - expectedLast}px`,
    );
    console.log(
      `    结论: ${first !== null && Math.abs(first - expectedFirst) < 15 && Math.abs(last - expectedLast) < 15 ? '✅ 命中范围和 getBounds 一致' : '❌ 命中范围和 getBounds 对不上'}`,
    );
    console.log(
      `    窗口右侧 3/4 处的命中者: ${hitClass.error ? hitClass.error : `${hitClass.ROOT_CLASS} pid=${hitClass.ROOT_PID}`}`,
    );
  };

  console.log('\n\n========== A/B 对照：只差一个 transparent 开关 ==========');
  console.log('（这两个是诊断脚本临时建的对照窗口，用完即销毁，不参与正式功能）');
  scanRow('【A】不透明窗口 transparent:false', opaqueTwin);
  scanRow('【B】透明窗口   transparent:true（和正式弹窗一致）', transparentTwin);

  opaqueTwin.destroy();
  transparentTwin.destroy();

  app.exit(0);
});
