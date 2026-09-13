'use strict';

/**
 * 诊断脚本 2：用「截屏找卡片」的方式，量出提醒弹窗在屏幕上的**真实位置**。
 *
 * 命中测试（WindowFromPoint）的结论太绕，这里换一条最直接的证据链：
 *   1. 用和正式程序完全相同的参数把提醒显示出来
 *   2. 全屏截图，在像素里找那张白色卡片，量出它的真实边界
 *   3. 和 getBounds() 对比 —— 对不上就说明窗口的真实位置和它自己声称的不一样
 *   4. 再对「卡片真实中心」做一次命中测试，看谁在上面
 *
 * 运行：npx electron scripts/diagnose-position.js
 */

const { execFileSync } = require('node:child_process');
const { app, screen, desktopCapturer } = require('electron');
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

function windowFromPoint(x, y) {
  const script = `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshHit2 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
}
'@
$p = New-Object 'DshHit2+POINT'
$p.X = ${x}
$p.Y = ${y}
$h = [DshHit2]::WindowFromPoint($p)
$root = [DshHit2]::GetAncestor($h, 2)
$pid_ = 0
$null = [DshHit2]::GetWindowThreadProcessId($root, [ref]$pid_)
$r = New-Object 'DshHit2+RECT'
$null = [DshHit2]::GetWindowRect($root, [ref]$r)
Write-Output ("ROOT={0}" -f $root.ToInt64())
Write-Output ("ROOT_CLASS={0}" -f [DshHit2]::ClassOf($root))
Write-Output ("ROOT_PID={0}" -f $pid_)
Write-Output ("ROOT_RECT={0},{1},{2},{3}" -f $r.Left, $r.Top, $r.Right, $r.Bottom)
Write-Output ("ROOT_EXSTYLE=0x{0:X}" -f [DshHit2]::GetWindowLong($root, -20))
`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
    });
    const info = {};
    for (const line of out.trim().split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) info[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return info;
  } catch (err) {
    return { error: err.message };
  }
}

/** 在截图里找那张白色卡片，返回它的物理像素边界 */
function findWhiteCard(image) {
  const { width, height } = image.getSize();
  const buf = image.toBitmap();
  const limitY = Math.min(height, Math.round(height * 0.35)); // 卡片只会在屏幕上方
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let y = 0; y < limitY; y += 2) {
    let runStart = -1;
    let bestStart = -1;
    let bestLen = 0;
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4; // BGRA
      const b = buf[i];
      const g = buf[i + 1];
      const r = buf[i + 2];
      const isWhite = r > 242 && g > 244 && b > 246;
      if (isWhite) {
        if (runStart < 0) runStart = x;
      } else if (runStart >= 0) {
        if (x - runStart > bestLen) {
          bestLen = x - runStart;
          bestStart = runStart;
        }
        runStart = -1;
      }
    }
    if (runStart >= 0 && width - runStart > bestLen) {
      bestLen = width - runStart;
      bestStart = runStart;
    }
    // 卡片宽度在物理像素下大约 600，这里要求一段足够长的连续白
    if (bestLen > 300) {
      if (bestStart < minX) minX = bestStart;
      if (bestStart + bestLen > maxX) maxX = bestStart + bestLen;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (minX === Infinity) return null;
  return { left: minX, top: minY, right: maxX, bottom: maxY, width: maxX - minX, height: maxY - minY };
}

app.whenReady().then(async () => {
  const store = new Store();
  const wm = new WindowManager(store);

  wm.createPopup();
  wm.createGlow();
  await wait(900);

  wm.showReminder();
  await wait(1200);

  const ids = { popup: hwndOf(wm.popup), glow: hwndOf(wm.glow) };
  const b = wm.popup.getBounds();
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  const display = screen.getPrimaryDisplay();

  console.log(`本进程 pid = ${process.pid}`);
  console.log(`popup 句柄 = ${ids.popup}   glow 句柄 = ${ids.glow}`);
  console.log(`popup.getBounds() = ${JSON.stringify(b)}  (逻辑像素, scale=${scale})`);
  console.log(
    `  → 换算成物理像素应该是: x ${Math.round(b.x * scale)} ~ ${Math.round((b.x + b.width) * scale)}` +
      `, y ${Math.round(b.y * scale)} ~ ${Math.round((b.y + b.height) * scale)}`,
  );

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  const shot = sources[0].thumbnail;
  const size = shot.getSize();
  console.log(`\n桌面截图尺寸 = ${size.width}x${size.height}`);

  const card = findWhiteCard(shot);
  console.log('\n【截屏找卡片】');
  if (!card) {
    console.log('  ❌ 没在截图里找到白色卡片 —— 说明弹窗根本没显示出来！');
  } else {
    console.log(`  找到的白色区域（物理像素）: left=${card.left} top=${card.top} right=${card.right} bottom=${card.bottom}`);
    console.log(`  尺寸: ${card.width} x ${card.height}`);
    console.log(
      `  换算成逻辑像素: x ${(card.left / scale).toFixed(0)} ~ ${(card.right / scale).toFixed(0)}` +
        `, y ${(card.top / scale).toFixed(0)} ~ ${(card.bottom / scale).toFixed(0)}`,
    );
    console.log(
      `  与 getBounds 的偏差: 左 ${(card.left / scale - b.x).toFixed(0)}px, 上 ${(card.top / scale - b.y).toFixed(0)}px`,
    );

    const cx = Math.round((card.left + card.right) / 2);
    const cy = Math.round((card.top + card.bottom) / 2);
    const hit = windowFromPoint(cx, cy);
    console.log(`\n  卡片真实中心 (${cx}, ${cy}) 的命中窗口：`);
    if (hit.error) {
      console.log(`    查询失败: ${hit.error}`);
    } else {
      const who =
        hit.ROOT === ids.popup
          ? '✅ 就是提醒弹窗'
          : hit.ROOT === ids.glow
            ? '光效层'
            : `⚠️ 别的窗口 class=${hit.ROOT_CLASS} pid=${hit.ROOT_PID} rect=(${hit.ROOT_RECT}) exstyle=${hit.ROOT_EXSTYLE}`;
      console.log(`    ${who}`);
      if (hit.ROOT !== ids.popup && hit.ROOT_PID && hit.ROOT_PID !== String(process.pid)) {
        try {
          const name = execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `$p = Get-Process -Id ${hit.ROOT_PID} -ErrorAction SilentlyContinue; if ($p) { "$($p.ProcessName)" } else { '(已退出)' }`,
            ],
            { encoding: 'utf8', timeout: 15000 },
          );
          console.log(`    该窗口属于进程: pid=${hit.ROOT_PID} ${name.trim()}`);
        } catch {
          /* 忽略 */
        }
      }
    }

    // 沿着卡片真实中线横向扫一遍，看哪一段归弹窗
    const rowY = Math.round(card.top + card.height / 2);
    let line = '';
    let first = null;
    let last = null;
    for (let x = card.left - 100; x <= card.right + 100; x += 12) {
      const info = windowFromPoint(x, rowY);
      const isP = !info.error && info.ROOT === ids.popup;
      line += isP ? 'P' : '.';
      if (isP) {
        if (first === null) first = x;
        last = x;
      }
    }
    console.log(`\n  沿卡片真实中线（y=${rowY}）的命中情况：`);
    console.log(`    ${line}`);
    console.log(`    归弹窗的区间（物理）: ${first} ~ ${last}   → 逻辑 ${(first / scale).toFixed(0)} ~ ${(last / scale).toFixed(0)}`);
    console.log(`    卡片真实区间（物理）: ${card.left} ~ ${card.right}`);
  }

  app.exit(0);
});
