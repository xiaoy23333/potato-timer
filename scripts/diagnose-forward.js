'use strict';

/**
 * 诊断脚本 2：查清是什么在干扰提醒弹窗的鼠标命中测试。
 *
 * 怀疑对象：光效层用了 setIgnoreMouseEvents(true, { forward: true })。
 * 在 Windows 上 forward:true 会额外装一个全局低级鼠标钩子，用来把鼠标移动
 * 转发给页面；而我们的光效页**完全没有鼠标交互**，根本不需要它。
 * 这种全局钩子一旦行为异常，就会让鼠标点击落到别的窗口上。
 *
 * 实验设计（同一进程内依次做三组，每组都是「显示 → 扫描命中范围 → 对比 getBounds」）：
 *   A 对照组：只有提醒弹窗，不创建光效层
 *   B 现状组：光效层用 forward:true（当前正式代码的写法）
 *   C 候选修复：光效层用 setIgnoreMouseEvents(true)（不带 forward）
 *
 * 运行：npx electron scripts/diagnose-forward.js
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

/** 一次性问一批点的命中窗口，减少 PowerShell 启动次数 */
function hitBatch(points) {
  const pairs = points.map((p) => `@(${p.x},${p.y})`).join(',');
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DshHit3 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
}
'@
$pts = @(${pairs})
foreach ($pt in $pts) {
  $p = New-Object 'DshHit3+POINT'
  $p.X = $pt[0]
  $p.Y = $pt[1]
  $h = [DshHit3]::WindowFromPoint($p)
  $root = [DshHit3]::GetAncestor($h, 2)
  Write-Output $root.ToInt64()
}
`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 40000,
    });
    return out
      .trim()
      .split(/\r?\n/)
      .map((s) => s.trim());
  } catch (err) {
    return points.map(() => `ERR:${err.message}`);
  }
}

async function measure(label, wm, ids) {
  const b = wm.popup.getBounds();
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  const rowY = Math.round((b.y + b.height * 0.5) * scale);

  const points = [];
  for (let x = Math.round((b.x - 80) * scale); x <= Math.round((b.x + b.width + 80) * scale); x += 10) {
    points.push({ x, y: rowY });
  }

  const results = hitBatch(points);
  let line = '';
  let first = null;
  let last = null;
  points.forEach((p, i) => {
    const isPopup = results[i] === ids.popup;
    line += isPopup ? 'P' : '.';
    if (isPopup) {
      if (first === null) first = p.x;
      last = p.x;
    }
  });

  const expectedFirst = Math.round(b.x * scale);
  const expectedLast = Math.round((b.x + b.width) * scale);
  const ok = first !== null && Math.abs(first - expectedFirst) < 15 && Math.abs(last - expectedLast) < 15;

  console.log(`\n  ${label}`);
  console.log(`    getBounds=${JSON.stringify(b)}  期望命中物理范围 ${expectedFirst} ~ ${expectedLast}`);
  console.log(`    ${line}`);
  console.log(
    `    实测命中范围 ${first} ~ ${last}` +
      `   左偏差 ${first === null ? 'n/a' : first - expectedFirst}px  右偏差 ${last === null ? 'n/a' : last - expectedLast}px`,
  );
  console.log(`    ${ok ? '✅ 命中范围和窗口边界一致' : '❌ 命中范围和窗口边界对不上'}`);
  return ok;
}

app.whenReady().then(async () => {
  const store = new Store();
  const wm = new WindowManager(store);
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;

  console.log(`本进程 pid = ${process.pid}   scaleFactor = ${scale}`);
  console.log('\n=========== 三组对照实验 ===========');

  // —— A：只有弹窗，不创建光效层 ——
  wm.createPopup();
  await wait(900);
  wm.showPopup();
  await wait(900);
  const okA = await measure('【A】只有提醒弹窗（无光效层）', wm, { popup: hwndOf(wm.popup) });

  // —— B：光效层用当前正式写法 forward:true ——
  wm.createGlow(); // createGlow 内部就是 setIgnoreMouseEvents(true, {forward:true})
  await wait(900);
  wm.showGlow();
  await wait(900);
  const okB = await measure('【B】光效层 forward:true（当前正式代码）', wm, { popup: hwndOf(wm.popup) });

  // —— C：把 forward 去掉 ——
  wm.glow.setIgnoreMouseEvents(true); // 不带 forward
  await wait(700);
  const okC = await measure('【C】光效层 setIgnoreMouseEvents(true)（不带 forward）', wm, {
    popup: hwndOf(wm.popup),
  });

  // —— 再来一次反向确认：把 forward 加回去 ——
  wm.glow.setIgnoreMouseEvents(true, { forward: true });
  await wait(700);
  const okB2 = await measure('【B2】再把 forward:true 加回去（反向确认）', wm, { popup: hwndOf(wm.popup) });

  console.log('\n=========== 结论 ===========');
  console.log(`  A  只有弹窗、无光效层        : ${okA ? '✅ 正常' : '❌ 异常'}`);
  console.log(`  B  光效层 forward:true        : ${okB ? '✅ 正常' : '❌ 异常'}`);
  console.log(`  C  光效层 不带 forward        : ${okC ? '✅ 正常' : '❌ 异常'}`);
  console.log(`  B2 再加回 forward:true        : ${okB2 ? '✅ 正常' : '❌ 异常'}`);
  if (!okA) {
    console.log('\n  → 连光效层都不存在时命中就异常，说明问题不在 forward，而在弹窗窗口本身。');
  } else if (!okB && okC) {
    console.log('\n  → 去掉 forward 就恢复正常：根因是光效层的全局鼠标钩子干扰了命中测试。');
  } else if (!okB && !okC) {
    console.log('\n  → 带不带 forward 都异常，说明是光效层本身（全屏置顶窗口）在干扰。');
  } else {
    console.log('\n  → 这一轮三组都正常，说明问题与桌面当前状态有关、不是稳定复现的。');
  }

  app.exit(0);
});
