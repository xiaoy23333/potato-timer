'use strict';

/**
 * 端到端自检（只在 POMODORO_E2E=1 时由 main.js 加载）。
 *
 * 做三件事：
 *   1. 用极短的时长把「专注结束 → 弹窗 + 光效」整条链路真跑一遍
 *   2. 对四个窗口做 DOM 断言，并把渲染进程的报错收集起来
 *   3. 截图存到 screenshots/，同时检查光效层「边缘有光、中心透明」
 *
 * 运行：$env:POMODORO_E2E=1; pnpm start
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, desktopCapturer, screen } = require('electron');

const { STATUS } = require('./timer');

const OUT_DIR = path.join(__dirname, '..', '..', 'screenshots');
const results = [];
const rendererErrors = [];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS ' : 'FAIL '} ${name}${detail ? `  →  ${detail}` : ''}`);
}

async function waitFor(predicate, timeout = 10000, interval = 60) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(interval);
  }
  return false;
}

async function js(win, code) {
  if (!win || win.isDestroyed()) throw new Error('目标窗口不存在');
  return win.webContents.executeJavaScript(code, true);
}

function loaded(win) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(false);
    if (!win.webContents.isLoading()) return resolve(true);
    win.webContents.once('did-finish-load', () => resolve(true));
    win.webContents.once('did-fail-load', () => resolve(false));
    return undefined;
  });
}

function watch(win, tag) {
  if (!win) return;
  win.webContents.on('console-message', (...args) => {
    const first = args[0];
    if (first && typeof first === 'object' && typeof first.message === 'string') {
      if (first.level === 'error' || first.level === 'warning') {
        rendererErrors.push(`[${tag}] ${first.level}: ${first.message}`);
      }
      return;
    }
    const [, level, message] = args;
    if (level >= 2) rendererErrors.push(`[${tag}] level${level}: ${message}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    rendererErrors.push(`[${tag}] 渲染进程崩溃: ${details.reason}`);
  });
}

async function shoot(win, fileName) {
  if (!win || win.isDestroyed()) return null;
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, fileName), image.toPNG());
  return image;
}

/** 统计一张图里「四周边缘」和「正中心」的平均不透明度，用来验证光效的形态 */
function alphaStats(image) {
  const { width, height } = image.getSize();
  const buf = image.toBitmap();
  const bandY = Math.max(1, Math.round(height * 0.07));
  const bandX = Math.max(1, Math.round(width * 0.07));
  let edgeSum = 0;
  let edgeN = 0;
  let centerSum = 0;
  let centerN = 0;

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const alpha = buf[(y * width + x) * 4 + 3];
      if (x < bandX || x >= width - bandX || y < bandY || y >= height - bandY) {
        edgeSum += alpha;
        edgeN += 1;
      } else if (x > width * 0.42 && x < width * 0.58 && y > height * 0.42 && y < height * 0.58) {
        centerSum += alpha;
        centerN += 1;
      }
    }
  }
  return {
    edge: edgeSum / Math.max(1, edgeN),
    center: centerSum / Math.max(1, centerN),
  };
}

/**
 * 桌面截图里左右两条竖带（避开顶部弹窗与底部任务栏）的平均颜色。
 * 用「提醒前 / 提醒中」两张图相减，就能证明光效真的合成到了屏幕上，
 * 而不只是在一个离屏窗口里渲染出来了。
 */
function sideStripMean(image) {
  const { width, height } = image.getSize();
  const buf = image.toBitmap();
  const strip = Math.max(1, Math.round(width * 0.04));
  const y0 = Math.round(height * 0.3);
  const y1 = Math.round(height * 0.7);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;

  for (let y = y0; y < y1; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (x >= strip && x < width - strip) continue;
      const i = (y * width + x) * 4; // BGRA
      b += buf[i];
      g += buf[i + 1];
      r += buf[i + 2];
      n += 1;
    }
  }
  n = Math.max(1, n);
  return { r: r / n, g: g / n, b: b / n };
}

/** 桌面截图里「顶部中央」区域的平均亮度 */
function topCenterLuma(image) {
  const { width, height } = image.getSize();
  const buf = image.toBitmap();
  const x0 = Math.round(width * 0.37);
  const x1 = Math.round(width * 0.63);
  const y0 = Math.round(height * 0.025);
  const y1 = Math.round(height * 0.14);
  let sum = 0;
  let n = 0;

  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * width + x) * 4; // BGRA
      sum += 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
      n += 1;
    }
  }
  return sum / Math.max(1, n);
}

/**
 * 两张桌面截图在「顶部中央」区域的平均像素差异。
 * 壁纸本身可能很亮，亮度对比不出来，所以直接看像素变了多少。
 */
function topCenterDiff(a, b) {
  const sizeA = a.getSize();
  const sizeB = b.getSize();
  if (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height) return null;

  const { width, height } = sizeA;
  const bufA = a.toBitmap();
  const bufB = b.toBitmap();
  const x0 = Math.round(width * 0.37);
  const x1 = Math.round(width * 0.63);
  const y0 = Math.round(height * 0.025);
  const y1 = Math.round(height * 0.14);
  let sum = 0;
  let n = 0;

  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * width + x) * 4;
      sum += Math.abs(bufA[i] - bufB[i]) + Math.abs(bufA[i + 1] - bufB[i + 1]) + Math.abs(bufA[i + 2] - bufB[i + 2]);
      n += 3;
    }
  }
  return sum / Math.max(1, n);
}

/** 用真实鼠标点一下某个元素，返回页面收到的 pointerdown 次数 */
async function osRealClick(win, selector) {
  const rect = await js(
    win,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
  if (!rect) return null;

  await js(win, `window.__osClicks = 0; document.querySelector(${JSON.stringify(selector)}).addEventListener('pointerdown', () => { window.__osClicks += 1; }, true); true`);

  // 真鼠标坐标一律用**逻辑坐标**（getBounds 的值），不要乘 scaleFactor：
  // 注入用的 PowerShell 进程是 DPI-unaware 的，乘了就会偏 1.25 倍。见 计划.md 6.2 节。
  const bounds = win.getBounds();
  const px = Math.round(bounds.x + rect.x);
  const py = Math.round(bounds.y + rect.y);

  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DshOsClick {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
}
'@
[DshOsClick]::SetCursorPos(${px}, ${py}); Start-Sleep -Milliseconds 220
[DshOsClick]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 90
[DshOsClick]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 220
`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 30000,
    });
  } catch (err) {
    return { error: err.message };
  }

  await wait(300);
  const count = await js(win, 'window.__osClicks');
  return { count, px, py };
}

async function captureDesktop(fileName) {
  try {
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      },
    });
    if (!sources.length) return null;
    fs.writeFileSync(path.join(OUT_DIR, fileName), sources[0].thumbnail.toPNG());
    return sources[0].thumbnail;
  } catch (err) {
    console.error('[e2e] 抓取桌面截图失败：', err.message);
    return null;
  }
}

/**
 * 用 Electron 的真实输入管线（webContents.sendInputEvent）操作控件。
 *
 * 这比在页面里 dispatch 合成 PointerEvent 更接近真实鼠标：
 * 事件走的是 Chromium 自己的输入流水线，因此会真正触发 pointer capture、
 * 鼠标按键状态跟踪等机制 —— 也就是提醒弹窗那种 focusable:false 窗口上
 * 真正会发生的事。
 */
/** 取滑块「按下点」与「最右端」的坐标（窗口内容坐标系，单位 DIP） */
function sliderGeometry(popup, ratio) {
  return js(
    popup,
    `(() => {
      const slider = document.getElementById('slider');
      const knob = document.getElementById('knob');
      const rect = slider.getBoundingClientRect();
      const inset = 4;
      const maxLeft = Math.max(inset, slider.clientWidth - knob.offsetWidth - inset);
      const startX = rect.left + inset + knob.offsetWidth / 2;
      const span = maxLeft - inset;
      return {
        y: Math.round(rect.top + rect.height / 2),
        startX: Math.round(startX),
        endX: Math.round(startX + span * ${ratio}),
        maxLeft,
      };
    })()`,
  );
}

/** 用真实鼠标把滑块拖到指定进度（ratio 0~1）或指定的起止坐标，并在松手前读一次滑块位置 */
async function realDragSlider(popup, ratioOrGeometry) {
  const geometry =
    typeof ratioOrGeometry === 'number' ? await sliderGeometry(popup, ratioOrGeometry) : ratioOrGeometry;
  const wc = popup.webContents;

  wc.sendInputEvent({ type: 'mouseMove', x: geometry.startX, y: geometry.y });
  await wait(30);
  wc.sendInputEvent({ type: 'mouseDown', x: geometry.startX, y: geometry.y, button: 'left', clickCount: 1 });
  await wait(30);

  for (let i = 1; i <= 10; i += 1) {
    const x = Math.round(geometry.startX + ((geometry.endX - geometry.startX) * i) / 10);
    wc.sendInputEvent({ type: 'mouseMove', x, y: geometry.y, button: 'left' });
    await wait(16);
  }

  // 松手前先看一眼：滑块真的动了，才说明「按下」被收到了（而不是压根没触发）
  const knobLeft = await js(popup, `document.getElementById('knob').style.left`);
  const ready = await js(popup, `document.getElementById('knob').classList.contains('is-ready')`);

  wc.sendInputEvent({ type: 'mouseUp', x: geometry.endX, y: geometry.y, button: 'left', clickCount: 1 });
  return { ...geometry, knobLeft, ready };
}

/** 用真实鼠标点一下某个元素 */
async function realClick(win, selector) {
  const point = await js(
    win,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`,
  );
  if (!point) throw new Error(`找不到元素 ${selector}`);

  const wc = win.webContents;
  wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  await wait(40);
  wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await wait(40);
  wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return point;
}

async function run(ctx) {
  const { store, timer, wm, onHotkeyPressed } = ctx;

  // 自检会把时长改成极短值（2.5 秒专注等），绝不能落盘污染用户配置。
  // 这里直接停掉持久化，并在收尾时把内存里的配置也还原回去。
  const originalWrite = store._write;
  const originalSet = store.set;
  const originalConfig = JSON.parse(JSON.stringify(store.get()));
  store._write = () => {};

  // 自检用的极短时长。注意这些值超出了设置项的合法范围（最短 1 分钟），
  // 因此任何一次 store.set（例如窗口位置记忆的防抖落盘）都会把它们规范化回去。
  // 所以这里包一层：走完真实的 set 流程后，再把测试用的短时长盖回去。
  const FAST = {
    focusSeconds: 2.5,
    shortBreakSeconds: 3,
    longBreakSeconds: 3,
    snoozeSeconds: 2,
  };
  const applyFast = (extra) => Object.assign(store.get(), FAST, extra);
  store.set = (patch) => {
    const result = originalSet.call(store, patch);
    applyFast();
    return result;
  };

  // 超时兜底
  const guard = setTimeout(() => {
    console.error('FAIL  自检超时，强制结束');
    app.exit(1);
  }, 90000);
  guard.unref?.();

  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // ————— 1. 等窗口就绪 —————
    await waitFor(() => !!wm.main && !!wm.popup && !!wm.float && !!wm.glow, 8000);
    watch(wm.main, 'main');
    watch(wm.popup, 'popup');
    watch(wm.glow, 'glow');
    watch(wm.float, 'float');

    await loaded(wm.main);
    await loaded(wm.popup);
    await loaded(wm.glow);
    await loaded(wm.float);
    await wait(400);

    check('四个窗口全部创建成功', !!wm.main && !!wm.popup && !!wm.glow && !!wm.float);
    check('主窗口可见', wm.main.isVisible());
    check('提醒弹窗初始隐藏', !wm.popup.isVisible());
    check('光效层初始隐藏', !wm.glow.isVisible());
    check('小浮窗初始可见（默认开启）', wm.float.isVisible());
    check('弹窗不抢焦点（focusable=false）', wm.popup.isFocusable() === false);
    check('光效层不抢焦点（focusable=false）', wm.glow.isFocusable() === false);

    const glowBounds = wm.glow.getBounds();
    const display = screen.getPrimaryDisplay();
    check(
      '光效层铺满整块屏幕',
      glowBounds.width === display.bounds.width && glowBounds.height === display.bounds.height,
      `${glowBounds.width}x${glowBounds.height}`,
    );

    const popupBounds = wm.popup.getBounds();
    const expectedX = Math.round(display.bounds.x + (display.bounds.width - popupBounds.width) / 2);
    check('弹窗水平居中于屏幕上方', popupBounds.x === expectedX && popupBounds.y < 80, `x=${popupBounds.x}, y=${popupBounds.y}`);

    // ————— 2. 主窗口 DOM —————
    const mainDom = await js(
      wm.main,
      `(() => ({
        time: document.getElementById('time').textContent,
        badge: document.getElementById('phaseBadge').textContent,
        primary: document.getElementById('btnPrimary').textContent,
        hint: document.getElementById('hint').textContent,
        dots: document.getElementById('dots').childElementCount,
        dasharray: getComputedStyle(document.getElementById('ringProgress')).strokeDasharray,
      }))()`,
    );
    check('主窗口倒计时按 MM:SS 渲染', /^\d{2}:\d{2}$/.test(mainDom.time), mainDom.time);
    check('主窗口阶段徽章为「专注」', mainDom.badge === '专注', mainDom.badge);
    check('主窗口主按钮为「开始专注」', mainDom.primary === '开始专注', mainDom.primary);
    check('主窗口轮次圆点数量 = 长休间隔', mainDom.dots === 4, String(mainDom.dots));
    check('主窗口提示里带出快捷键', /Ctrl\s*\+\s*Alt\s*\+\s*P/.test(mainDom.hint), mainDom.hint);

    // ————— 设置面板的两个状态机 —————

    // 清空数字输入框 / 输入非法内容，都不能被当成 0 提交
    // （提交 0 会把专注夹成 1 分钟、把休息变成 0=跳过休息，甚至让正在跑的这一轮立刻结束）
    const numberGuard = await js(
      wm.main,
      `(async () => {
        const input = document.getElementById('focusMin');
        const inputValueBefore = input.value;
        const before = (await window.pomodoro.getConfig()).focusSeconds;

        input.value = '';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 320));
        const afterEmpty = (await window.pomodoro.getConfig()).focusSeconds;
        const restored = input.value;

        input.value = '-';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 320));
        const afterBad = (await window.pomodoro.getConfig()).focusSeconds;

        return { before, afterEmpty, afterBad, restored, inputValueBefore };
      })()`,
    );
    check(
      '清空「专注时长」的分钟框不会被提交成 0',
      numberGuard.afterEmpty === numberGuard.before,
      `原值 ${numberGuard.before} 秒 → 清空后 ${numberGuard.afterEmpty} 秒`,
    );
    check('输入非法内容也不会改坏配置', numberGuard.afterBad === numberGuard.before, String(numberGuard.afterBad));
    // 注意：跟输入框「自己原来的值」比。自检给自己注入了极短时长（见 applyFast），
    // 主进程配置和渲染层缓存可能不同步，拿主进程的值比会误判。
    check(
      '输入框会被回填成原值',
      numberGuard.restored === numberGuard.inputValueBefore,
      `回填后 "${numberGuard.restored}"，原本 "${numberGuard.inputValueBefore}"`,
    );

    // 快捷键录制必须随「离开设置页」结束
    const recGuard = await js(
      wm.main,
      `(async () => {
        const btn = document.getElementById('hotkeyBtn');
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        document.getElementById('btnSettings').click();
        await sleep(150);
        btn.click();
        await sleep(150);
        const recordingText = btn.textContent;

        document.getElementById('btnBack').click();   // 返回主视图
        await sleep(200);
        const afterText = btn.textContent;
        const stillRecording = btn.classList.contains('is-recording');

        document.getElementById('btnSettings').click(); // 再进设置页确认已复位
        await sleep(150);
        const reopened = !btn.classList.contains('is-recording');

        document.getElementById('btnBack').click();
        await sleep(100);
        return { recordingText, afterText, stillRecording, reopened };
      })()`,
    );
    check('点快捷键按钮会进入录制状态', /请按下组合键/.test(recGuard.recordingText), recGuard.recordingText);
    check(
      '离开设置页会自动结束快捷键录制',
      recGuard.stillRecording === false && recGuard.reopened === true,
      JSON.stringify(recGuard),
    );
    check('录制结束后按钮文案复位', /Ctrl/.test(recGuard.afterText), recGuard.afterText);

    const floatDom = await js(
      wm.float,
      `(() => {
        const t = document.getElementById('time');
        return {
          text: t.textContent,
          color: getComputedStyle(t).color,
          cssVar: getComputedStyle(document.documentElement).getPropertyValue('--float-color').trim(),
        };
      })()`,
    );
    // 颜色要跟「配置里写的」一致 —— 不能写死默认值，因为用户可能自己改过颜色
    const hexToRgbCss = (hex) => {
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
      return m ? `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})` : null;
    };
    const floatCfgColor = await js(wm.main, `window.pomodoro.getConfig().then((c) => c.floatWindow.color)`);

    check('小浮窗只显示时间', /^\d{2}:\d{2}$/.test(floatDom.text), floatDom.text);
    check(
      '小浮窗倒计时颜色跟随配置',
      floatDom.color === hexToRgbCss(floatCfgColor),
      `配置 ${floatCfgColor} → 实际渲染 ${floatDom.color}`,
    );

    // 改颜色要立刻生效到小浮窗
    await js(wm.main, `window.pomodoro.setConfig({ floatWindow: { color: '#00ff88' } })`);
    await wait(500);
    const recolored = await js(wm.float, `getComputedStyle(document.getElementById('time')).color`);
    check('改小浮窗颜色会立刻生效', recolored === 'rgb(0, 255, 136)', recolored);

    // 恢复成用户原本的颜色，免得影响后面的截图与断言
    await js(
      wm.main,
      `window.pomodoro.setConfig({ floatWindow: { color: ${JSON.stringify(floatCfgColor)} } })`,
    );
    await wait(400);
    const restoredColor = await js(wm.float, `getComputedStyle(document.getElementById('time')).color`);
    check('颜色改回去也立刻生效', restoredColor === hexToRgbCss(floatCfgColor), restoredColor);

    const glowDom = await js(
      wm.glow,
      `(() => {
        const style = getComputedStyle(document.documentElement);
        const el = document.getElementById('glow');
        const anim = getComputedStyle(el);
        return {
          strong: style.getPropertyValue('--c-strong').trim(),
          dur: style.getPropertyValue('--dur').trim(),
          edges: document.querySelectorAll('.edge').length,
          iterations: anim.animationIterationCount,
          name: anim.animationName,
          flashing: el.classList.contains('is-flashing'),
        };
      })()`,
    );
    check('光效层四条边都已挂载', glowDom.edges === 4, String(glowDom.edges));
    check(
      '光效默认颜色为淡蓝 #4fc3f7',
      /79,\s*195,\s*247/.test(glowDom.strong),
      glowDom.strong,
    );
    check('光效带闪光时长', /ms$/.test(glowDom.dur), glowDom.dur);
    // 「只闪一次」的具体断言放到第 6 节：那时候提醒已经弹出来，闪光正在播放

    // ————— 3. 快捷键 —————
    const { globalShortcut } = require('electron');
    check('全局快捷键已注册', globalShortcut.isRegistered(store.get().hotkey), store.get().hotkey);

    // ————— 4. 先抓一张「提醒前」的桌面，后面用来做差分比对 —————
    const desktopBefore = await captureDesktop('00-桌面-提醒前.png');

    // ————— 5. 把时长改短，真跑一轮「专注结束」 —————
    applyFast();

    // 先把键盘焦点交给主窗口，稍后用它验证「提醒弹出时不抢焦点」
    wm.showMain();
    await wait(500);
    const focusBefore = await js(wm.main, 'document.hasFocus()');

    timer.reset();
    await wait(250);
    timer.start();
    check('计时已启动', timer.status === STATUS.RUNNING, timer.status);

    const finished = await waitFor(() => timer.status === STATUS.FINISHED, 12000);
    check('专注到点后进入「待处理」状态', finished, timer.status);

    await waitFor(() => wm.popup.isVisible(), 3000);
    await wait(500); // 等光效和弹窗画完
    check('到点后提醒弹窗自动出现', wm.popup.isVisible());
    check('到点后光效层亮起', wm.glow.isVisible());
    check('弹窗出现时小浮窗让位', !wm.float.isVisible());

    // 「不抢焦点」的真实行为验证（不只是断言 focusable 属性）
    const focusAfter = await js(wm.main, 'document.hasFocus()');
    check(
      '提醒弹出没有抢走键盘焦点（主窗口仍持有焦点）',
      focusBefore === true && focusAfter === true,
      `弹出前 ${focusBefore} → 弹出后 ${focusAfter}`,
    );
    check('提醒弹窗自身没有获得焦点', wm.popup.isFocused() === false, String(wm.popup.isFocused()));

    const popupDom = await js(
      wm.popup,
      `(() => ({
        title: document.getElementById('title').textContent,
        snooze: document.getElementById('snoozeText').textContent,
        kbd: document.getElementById('hotkeyHint').textContent,
        label: document.getElementById('sliderLabel').textContent,
        knobLeft: document.getElementById('knob').style.left,
      }))()`,
    );
    check('弹窗标题为「专注结束」', popupDom.title === '专注结束', popupDom.title);
    check('弹窗按钮文案正确', /后再提醒/.test(popupDom.snooze), popupDom.snooze);
    check('弹窗按钮带快捷键提示', /Ctrl\s*\+\s*Alt\s*\+\s*P/.test(popupDom.kbd), popupDom.kbd);
    check('滑块文案为「滑动开始下一轮」', popupDom.label === '滑动开始下一轮', popupDom.label);
    check('滑块初始在左端', popupDom.knobLeft === '4px', popupDom.knobLeft);

    // ————— 6. 截图 —————
    // 截图和像素差分要在**确定的设置**下做：用户可能把光效调暗或调短，
    // 那会让「边缘变蓝」这类阈值失准。这里先钉住一套已知设置，做完再还原。
    const glowBackup = await js(wm.main, `window.pomodoro.getConfig().then((c) => c.glow)`);
    await js(
      wm.main,
      `window.pomodoro.setConfig({ glow: { color: '#4fc3f7', intensity: 1, flashSeconds: 1.6 } })`,
    );
    await wait(400);

    // 光效现在只闪一次、闪完自己消失，所以每次要抓光效的图都要先重播一次闪光
    const playGlow = async () => {
      if (!wm.glow.webContents.isDestroyed()) wm.glow.webContents.send('glow:play');
      await wait(240); // 停在亮度峰值附近
    };

    const popupShot = await shoot(wm.popup, '01-提醒弹窗.png');
    await shoot(wm.main, '03-主窗口.png');

    await playGlow();
    const glowState = await js(
      wm.glow,
      `(() => {
        const el = document.getElementById('glow');
        const anim = getComputedStyle(el);
        return { flashing: el.classList.contains('is-flashing'), iterations: anim.animationIterationCount, name: anim.animationName };
      })()`,
    );
    check(
      '光效只闪一次（不是无限循环）',
      glowState.flashing === true && glowState.iterations === '1' && glowState.name === 'flash',
      `flashing=${glowState.flashing}, ${glowState.name} × ${glowState.iterations}`,
    );

    const glowShot = await shoot(wm.glow, '02-四周光效.png');
    await playGlow();
    const desktopShot = await captureDesktop('04-桌面实际效果-提醒中.png');

    if (glowShot) {
      const stats = alphaStats(glowShot);
      check(
        '光效「四周亮、中间透明」',
        stats.edge > 8 && stats.center < 4,
        `边缘平均不透明度 ${stats.edge.toFixed(1)}，中心 ${stats.center.toFixed(1)}`,
      );
    }

    // 闪光结束后必须自己消失，不能留一圈常亮
    await wait(2000);
    const glowOpacity = await js(wm.glow, `getComputedStyle(document.getElementById('glow')).opacity`);
    check(
      '光效闪完会自己消失（不会一直亮着）',
      Number(glowOpacity) === 0,
      `闪光结束后 opacity=${glowOpacity}`,
    );

    // 还原用户原本的光效设置
    await js(
      wm.main,
      `window.pomodoro.setConfig({ glow: ${JSON.stringify(glowBackup)} })`,
    );
    await wait(300);
    if (popupShot) {
      const stats = alphaStats(popupShot);
      check('弹窗卡片确实画出来了（不透明像素）', stats.edge > 0 || stats.center > 0, JSON.stringify(stats));
    }
    check('桌面截图已保存（能看到真实叠加效果）', !!desktopShot);

    // 用「提醒前 vs 提醒中」两张真实桌面截图做差分，证明叠加层真的显示在屏幕上
    if (desktopBefore && desktopShot) {
      const before = sideStripMean(desktopBefore);
      const after = sideStripMean(desktopShot);
      // 光效色是 rgb(79,195,247)：红分量很低，叠上去主要是把红压下去、把整体推向蓝。
      // 所以判据是「红明显下降」+「蓝红差明显拉大」，而不是绝对蓝通道变大
      //（亮色壁纸的蓝通道本来就接近 255，加不上去了）。
      const redShift = after.r - before.r;
      const greenShift = after.g - before.g;
      const tintShift = (after.b - after.r) - (before.b - before.r);
      check(
        '真实桌面左右边缘确实被染上淡蓝（光效显示在屏幕上）',
        tintShift > 8 && redShift < -3,
        `Δ红=${redShift.toFixed(1)}，Δ绿=${greenShift.toFixed(1)}，Δ(蓝-红)=${tintShift.toFixed(1)}`,
      );

      const lumaBefore = topCenterLuma(desktopBefore);
      const lumaAfter = topCenterLuma(desktopShot);
      const diff = topCenterDiff(desktopBefore, desktopShot);
      check(
        '真实桌面顶部中央确实出现了提醒卡片',
        diff !== null && diff > 10,
        `区域平均像素差 ${diff === null ? 'n/a' : diff.toFixed(1)}，亮度 ${lumaBefore.toFixed(1)} → ${lumaAfter.toFixed(1)}`,
      );
    }

    // ————— 拖到一半不该触发（走真实输入管线）—————
    const halfDrag = await realDragSlider(wm.popup, 0.45);
    check(
      '真实鼠标按下能被滑块收到（拖到 45% 时滑块确实移动了）',
      halfDrag.knobLeft !== '4px' && halfDrag.knobLeft !== '',
      `knob.left=${halfDrag.knobLeft}`,
    );
    await wait(450);
    check('滑块只拖一半不会进入下一轮', timer.status === STATUS.FINISHED, timer.status);
    const afterHalf = await js(wm.popup, `document.getElementById('knob').style.left`);
    check('没拖到底的滑块会自动弹回原位', afterHalf === '4px', afterHalf);

    // ————— 从轨道「中间」按下、拖到轨道最右端 → 应该触发 —————
    // 这条路径以前从没覆盖过：如果滑块是纯相对拖动，用户把指针拖到轨道最右端时
    // 滑块只会走到一半，看起来像坏了。
    const trackDragGeometry = await js(
      wm.popup,
      `(() => {
        const slider = document.getElementById('slider');
        const knob = document.getElementById('knob');
        const r = slider.getBoundingClientRect();
        return {
          y: Math.round(r.top + r.height / 2),
          startX: Math.round(r.left + r.width * 0.5),
          endX: Math.round(r.left + r.width - 8),
          maxLeft: Math.max(4, slider.clientWidth - knob.offsetWidth - 4),
        };
      })()`,
    );
    const fullDrag = await realDragSlider(wm.popup, trackDragGeometry);
    check(
      '从轨道中间按下、拖到最右端，滑块也能真正到底',
      fullDrag.knobLeft !== '' && parseFloat(fullDrag.knobLeft) >= fullDrag.maxLeft - 3,
      `knob.left=${fullDrag.knobLeft}, maxLeft=${fullDrag.maxLeft}`,
    );
    check('拖到最右端时滑块会变色提示可以松手', fullDrag.ready === true, String(fullDrag.ready));
    await wait(700);
    check('滑块拖到底后进入休息段', timer.phase === 'short' && timer.status === STATUS.RUNNING, `${timer.phase}/${timer.status}`);
    check('进入下一轮后弹窗收起', !wm.popup.isVisible());
    check('进入下一轮后光效熄灭', !wm.glow.isVisible());
    check('弹窗收起后小浮窗回来', wm.float.isVisible());

    // ————— 8. 休息结束自动开始下一轮专注 —————
    const backToFocus = await waitFor(() => timer.phase === 'focus' && timer.status === STATUS.RUNNING, 12000);
    check('休息结束自动开始下一轮专注', backToFocus, `${timer.phase}/${timer.status}`);

    // ————— 9. 延后 5 分钟（这里压成 2 秒）————
    timer.reset();
    await wait(200);
    applyFast({ focusSeconds: 2 });
    timer.start();
    await waitFor(() => timer.status === STATUS.FINISHED, 12000);
    await waitFor(() => wm.popup.isVisible(), 3000);

    await realClick(wm.popup, '#btnSnooze'); // 真实鼠标点击，不是 el.click()
    await wait(500);
    check('真实鼠标点击「5 分钟后再提醒」后进入延后状态', timer.status === STATUS.SNOOZED, timer.status);
    check('延后后弹窗收起', !wm.popup.isVisible());
    check('延后后光效熄灭', !wm.glow.isVisible());

    const mainSnooze = await js(wm.main, `document.getElementById('status').textContent`);
    check('主窗口显示「延后中」', /延后中/.test(mainSnooze), mainSnooze);

    const reminded = await waitFor(() => timer.status === STATUS.FINISHED && wm.popup.isVisible(), 8000);
    check('延后到点后重新弹出提醒', reminded, `${timer.status}/${wm.popup.isVisible()}`);
    await wait(400);
    await shoot(wm.popup, '05-延后到点重新弹窗.png');

    // ————— 第二次提醒时滑块必须还能拖 —————
    // 需求方反馈过「第一次能拖、后面就拖不动」，这里专门守住这个回归。
    const preDrag = await js(
      wm.popup,
      `({ left: document.getElementById('knob').style.left, label: document.getElementById('sliderLabel').textContent })`,
    );
    check(
      '重新弹出时滑块已彻底复位',
      preDrag.left === '4px' && preDrag.label === '滑动开始下一轮',
      JSON.stringify(preDrag),
    );

    // ★ 关键回归：用**操作系统真鼠标**点一下滑块。
    // 这是唯一能抓到「重新显示后窗口丢掉鼠标输入区域」的手段 ——
    // sendInputEvent 是直接注入渲染进程的，会绕过系统命中测试，抓不到这类问题。
    const osClick = await osRealClick(wm.popup, '#slider');
    check(
      '第二次提醒时操作系统的真鼠标能点到弹窗（关键回归）',
      !!osClick && osClick.count > 0,
      osClick ? `逻辑坐标(${osClick.px}, ${osClick.py}) → pointerdown=${osClick.count}` : '没找到元素',
    );

    const secondDrag = await realDragSlider(wm.popup, 1);
    await wait(700);
    check(
      '第二次提醒时真鼠标依然能拖到底并触发',
      timer.status === STATUS.RUNNING,
      `拖动后状态=${timer.status}/${timer.phase}，knob.left=${secondDrag.knobLeft}`,
    );
    // ————— 10. 全局快捷键的处理器也走一遍 —————
    const backToFinished = await waitFor(() => timer.status === STATUS.FINISHED, 8000);
    check('延后到点后回到「待处理」状态', backToFinished, timer.status);
    onHotkeyPressed(); // 这就是绑定在 Ctrl+Alt+P 上的那个函数
    await wait(200);
    check('全局快捷键触发的延后同样生效', timer.status === STATUS.SNOOZED, timer.status);

    // ————— 11. 跳过 / 重置 —————
    timer.reset();
    await wait(150);
    timer.start();
    await wait(150);
    timer.skip();
    check('跳过专注会直接进入休息', timer.phase === 'short' && timer.status === STATUS.RUNNING, `${timer.phase}/${timer.status}`);
    timer.reset();
    check('重置回到待开始', timer.status === STATUS.IDLE && timer.completedFocus === 0, `${timer.status}/${timer.completedFocus}`);

    // ————— 12. 渲染进程有没有报错 —————
    const realErrors = rendererErrors.filter((line) => !/Autofill|DevTools/.test(line));
    check('渲染进程无报错', realErrors.length === 0, realErrors.slice(0, 4).join(' | '));
  } catch (err) {
    check('自检执行未抛异常', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
    console.error(err);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n———————————————————————————————');
  console.log(`自检结果：${results.length - failed.length} / ${results.length} 通过`);
  if (failed.length) {
    console.log('未通过：');
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `  →  ${f.detail}` : ''}`);
  }
  console.log(`截图目录：${OUT_DIR}`);
  console.log('———————————————————————————————');

  try {
    fs.writeFileSync(
      path.join(OUT_DIR, 'e2e-report.json'),
      JSON.stringify({ passed: results.length - failed.length, total: results.length, results, rendererErrors }, null, 2),
      'utf8',
    );
  } catch (err) {
    console.error('[e2e] 写报告失败：', err.message);
  }

  // 还原配置与持久化
  store.set = originalSet;
  Object.assign(store.get(), originalConfig);
  store._write = originalWrite;

  clearTimeout(guard);

  // 用真实的退出路径（等价于用户点 ✕ 或托盘退出），顺带验证退出流程干净、
  // 不会留下孤儿进程（外部脚本会检查）。
  app.quit();
  setTimeout(() => app.exit(failed.length ? 1 : 0), 6000);
}

module.exports = { run };
