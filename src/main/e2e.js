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

// 截图输出目录。
//
// 开发时落在项目的 screenshots/（已被 .gitignore 忽略）。
// **打包之后 __dirname 在 app.asar 里，是只读的** —— 直接往那儿写会让
// mkdirSync 抛异常、把整段自检带崩。所以打包后改落到系统的临时目录，
// 这样"装完之后还能对着安装版自己跑一遍自检"这件事才成立。
const OUT_DIR = app.isPackaged
  ? path.join(app.getPath('temp'), 'pomodoro-e2e')
  : path.join(__dirname, '..', '..', 'screenshots');

/** 存图。存不下就只警告，不能因为一张截图把整段自检带崩。 */
function saveShot(fileName, png) {
  try {
    fs.writeFileSync(path.join(OUT_DIR, fileName), png);
  } catch (err) {
    console.warn(`[e2e] 截图 ${fileName} 写入失败（不影响断言）：${err.message}`);
  }
}
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
  saveShot(fileName, image.toPNG());
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
/**
 * 用**操作系统真鼠标**点一下某个元素，返回点到的次数。
 *
 * 为什么必须真鼠标：`sendInputEvent` 是直接注入渲染进程的，会绕过 Windows 的
 * 窗口命中测试，因此**抓不到「窗口收不到鼠标」这类系统层问题**——那个 bug 让
 * 自检一路全绿却是坏的（见 计划.md 6.4 节）。
 *
 * 为什么带重试：注入本身偶尔会打空（光标刚移过去、系统还没把这次点击投递下来），
 * 三次里大约栽一次。**重试不会削弱这道防线**——真正的那个 bug 是"窗口永远收不到
 * 鼠标"，每一次都会失败，重试三次照样红；而偶发的打空重试一次就过了。
 */
async function osRealClick(win, selector, attempts = 3) {
  let last = null;
  for (let i = 1; i <= attempts; i += 1) {
    last = await osRealClickOnce(win, selector);
    if (last && last.count > 0) return { ...last, attempts: i };
    if (last && last.error) return { ...last, attempts: i };
    await wait(200);
  }
  return { ...(last || { count: 0, px: 0, py: 0 }), attempts };
}

async function osRealClickOnce(win, selector) {
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
  // 落点诊断：真鼠标没点到时，要能一眼分清是"坐标算错了/被别的窗口挡了"
  // 还是"窗口收到了鼠标但没投递给这个元素"
  let hit = '';
  try {
    hit = await js(
      win,
      `(() => {
        const el = document.elementFromPoint(${Math.round(rect.x)}, ${Math.round(rect.y)});
        return el ? (el.id || el.className || el.tagName) : 'null';
      })()`,
    );
  } catch {
    hit = '(取不到)';
  }
  return { count, px, py, hit, visible: win.isVisible() };
}

/**
 * 沿四条边量「差分强度随离边缘距离的变化」。
 * 用来回答：光效到底有没有缺最外圈？（需求方截图里看起来缺了一圈）
 */
function edgeDiffProfile(before, after) {
  const sa = before.getSize();
  const sb = after.getSize();
  if (sa.width !== sb.width || sa.height !== sb.height) return null;
  const W = sa.width;
  const H = sa.height;
  const a = before.toBitmap();
  const b = after.toBitmap();

  const diff = (x, y) => {
    const i = (y * W + x) * 4;
    return Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  };

  const rows = [30, 40, 50, 60, 70].map((k) => Math.round((H * k) / 100));
  const cols = [30, 40, 50, 60, 70].map((k) => Math.round((W * k) / 100));

  return [0, 2, 4, 8, 14, 22, 32, 48, 70].map((dist) => {
    const dl = Math.min(dist, W - 1);
    const dh = Math.min(dist, H - 1);
    return {
      dist,
      left: rows.reduce((s, r) => s + diff(dl, r), 0) / rows.length,
      right: rows.reduce((s, r) => s + diff(W - 1 - dl, r), 0) / rows.length,
      top: cols.reduce((s, c) => s + diff(c, dh), 0) / cols.length,
      bottom: cols.reduce((s, c) => s + diff(c, H - 1 - dh), 0) / cols.length,
    };
  });
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
    saveShot(fileName, sources[0].thumbnail.toPNG());
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
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
    } catch (err) {
      // 建不出目录也不能让整段自检归零：截图只是副产品，断言才是正事
      console.warn(`[e2e] 截图目录建不出来（不影响断言）：${err.message}`);
    }

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

    // 配置文件必须锚在 %APPDATA%\pomodoro-timer\config.json，**不能**跟着 productName 走。
    // 回归背景：store 原本用 app.getPath('userData')，而那个路径由 app.getName() 决定；
    // 打包时一旦把 productName 设成「番茄钟」，设置目录就会变成 %APPDATA%\番茄钟，
    // 老用户存在旧目录里的全部设置被无声忽略、一切回到默认值。
    const cfgPath = String(store.filePath || '').replace(/\\/g, '/');
    check(
      '设置目录锚定在 pomodoro-timer，不跟随产品名',
      cfgPath.endsWith('/pomodoro-timer/config.json'),
      store.filePath,
    );
    check(
      '设置目录就在 %APPDATA% 下（不是别的地方）',
      cfgPath.startsWith(String(app.getPath('appData')).replace(/\\/g, '/')),
      store.filePath,
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
        primarySolid: document.getElementById('btnPrimary').classList.contains('is-solid'),
        round: document.getElementById('roundText').textContent,
        hint: document.getElementById('hint').textContent,
        dots: document.getElementById('dots').childElementCount,
        dasharray: getComputedStyle(document.getElementById('ringProgress')).strokeDasharray,
        ringStroke: getComputedStyle(document.getElementById('ringProgress')).stroke,
      }))()`,
    );
    check('主窗口倒计时按 MM:SS 渲染', /^\d{2}:\d{2}$/.test(mainDom.time), mainDom.time);
    check('主窗口阶段徽章为「专注」', mainDom.badge === '专注', mainDom.badge);
    check('主窗口主按钮为「开始专注」', mainDom.primary === '开始专注', mainDom.primary);
    check('待开始时主按钮是实心红（全屏唯一需要被找到的东西）', mainDom.primarySolid, String(mainDom.primarySolid));
    check('主窗口轮次刻度数量 = 长休间隔', mainDom.dots === 4, String(mainDom.dots));
    check('主窗口轮次文字为「第 1 / 4 轮」', mainDom.round === '第 1 / 4 轮', mainDom.round);
    check('主窗口提示里带出快捷键', /Ctrl\s*\+\s*Alt\s*\+\s*P/.test(mainDom.hint), mainDom.hint);
    // 回归：曾写成不存在的 var(--break)，未定义的 var() 让 stroke 退回 none
    check(
      '待开始时进度环描边色可解析（不是 none）',
      mainDom.ringStroke !== 'none' && mainDom.ringStroke !== '',
      mainDom.ringStroke,
    );

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
    // 断言「没有被提交成 0」—— 提交 0 会被 store 夹到下限 1 秒，那才是要防的事故。
    // 不能用「前后完全相等」来判：自检期间窗口位置记忆会触发 store.set，
    // 而自检的 store.set 包装层会重新盖上极短时长（见 applyFast），值本来就会跳。
    const SECONDS_FLOOR = 1;
    check(
      '清空「专注时长」的分钟框不会被提交成 0',
      numberGuard.afterEmpty > SECONDS_FLOOR,
      `原值 ${numberGuard.before} 秒 → 清空后 ${numberGuard.afterEmpty} 秒（下限 ${SECONDS_FLOOR}）`,
    );
    check(
      '输入非法内容也不会改坏配置',
      numberGuard.afterBad > SECONDS_FLOOR,
      `${numberGuard.afterBad} 秒（下限 ${SECONDS_FLOOR}）`,
    );
    check(
      '输入框会被回填成有效数字',
      numberGuard.restored !== '' && Number.isFinite(Number(numberGuard.restored)),
      `回填后 "${numberGuard.restored}"`,
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

    // ————— 6b. 光效的"形状"在整段闪光里必须恒定 —————
    // 回归：需求方连续三次反馈「光效先比屏幕小一圈、然后才放大到屏幕大小，
    // 外圈切口是整齐的，像是整张图被等比缩小过」。
    //
    // 逐帧实测的结论是：**几何从头到尾一个像素都没变**，变的是亮度。
    // 而柔光渐变整体调暗时，"看得见的宽度"会跟着缩水 —— 因为可见边界画在
    // 「alpha × 不透明度 = 眼睛阈值」那条线上，越暗这条线越往边缘缩。
    // 实测 alpha 剖面后算出来：不透明度 0 → 1 会让可见宽度变化 2.31 倍，
    // 看上去就是"先小一圈再放大"。修法是把不透明度下限抬到 0.62、
    // 并让渐变在 84% 处落零（见 glow.css）。
    //
    // 这里守住的是那条不变的底线：整段闪光里视口和四条边的尺寸不能变。
    // 逐帧挂 rAF 探针，闪光跑完再读回来。
    await js(
      wm.glow,
      `(() => {
        window.__geom = [];
        window.__geomStop = false;
        const tick = () => {
          if (window.__geomStop) return;
          const e = document.querySelector('.edge-left');
          const g = document.getElementById('glow');
          const r = e ? e.getBoundingClientRect() : null;
          window.__geom.push([
            innerWidth, innerHeight,
            r ? Math.round(r.width) : -1, r ? Math.round(r.height) : -1,
            getComputedStyle(g).opacity,
          ]);
          // 只采够覆盖这段闪光就行：采太久会让这个满屏置顶窗口的合成器一直忙，
          // 后面那些真鼠标断言会被它拖累（实测出现过连续三次点不中）。
          if (window.__geom.length < 150) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return true;
      })()`,
    );
    await playGlow();
    await wait(1700); // 跑完整段 1.6 秒的闪光
    const geom = await js(
      wm.glow,
      `window.__geomStop = true; JSON.stringify(window.__geom)`,
    );
    const geomRows = JSON.parse(geom || '[]');
    const viewports = new Set(geomRows.map((r) => `${r[0]}x${r[1]}`));
    const edges = new Set(geomRows.map((r) => `${r[2]}x${r[3]}`));
    check(
      // 帧数只要够多就行，不卡具体数字：rAF 的帧率跟着机器负载跑
      '闪光全程视口尺寸恒定（采到帧数 > 10）',
      geomRows.length > 10 && viewports.size === 1,
      `${geomRows.length} 帧，视口出现过 ${viewports.size} 种：${[...viewports].slice(0, 3).join(' / ')}`,
    );
    check(
      '闪光全程光效层尺寸恒定（不会"先小一圈再放大"）',
      edges.size === 1,
      `四边尺寸出现过 ${edges.size} 种：${[...edges].slice(0, 3).join(' / ')}`,
    );
    // 不透明度下限：别从 0 慢慢爬上来，那样一定又会看出"长大"。
    //
    // ⚠ 这里**不能**按 rAF 帧数断言。第一版写的是"前 8 帧内要到 0.5"，
    // 结果同一份代码跑三次红两次 —— 因为 rAF 的帧率跟着机器负载跑，
    // 采到的是"第几帧"而不是"什么时刻"。下面改成把动画暂停、
    // 直接把它拨到指定的进度上读计算值：与帧率、与机器快慢都无关。
    const glowCurve = await js(
      wm.glow,
      `(() => {
        const el = document.getElementById('glow');
        const anims = el.getAnimations();
        if (!anims.length) return null;
        const a = anims[0];
        a.pause();
        const dur = a.effect.getTiming().duration;
        const at = (pct) => {
          a.currentTime = dur * pct;
          return Number(getComputedStyle(el).opacity);
        };
        const out = { dur, p3: at(0.03), p12: at(0.12), p44: at(0.44), p90: at(0.9) };
        a.cancel(); // 复原：cancel 之后回到基础态（opacity: 0）
        return out;
      })()`,
    );
    check(
      '闪光曲线：3% 处亮度就要过 0.5（不从 0 慢慢爬，否则会被看成"长大"）',
      !!glowCurve && glowCurve.p3 >= 0.5,
      glowCurve ? `时长 ${glowCurve.dur}ms，3% 处 opacity=${glowCurve.p3}` : '拿不到动画',
    );
    check(
      '闪光曲线：中段保持全亮、末尾回到 0',
      !!glowCurve && glowCurve.p12 === 1 && glowCurve.p44 === 1 && glowCurve.p90 < 0.5,
      glowCurve ? `12%=${glowCurve.p12}，44%=${glowCurve.p44}，90%=${glowCurve.p90}` : '拿不到动画',
    );

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

      // 光效有没有缺最外圈：逐像素量离四条边的距离 → 差分强度
      const profile = edgeDiffProfile(desktopBefore, desktopShot);
      if (profile) {
        const line = profile
          .map(
            (p) =>
              `${p.dist}px: 左${Math.round(p.left)} 右${Math.round(p.right)} 上${Math.round(p.top)} 下${Math.round(p.bottom)}`,
          )
          .join('  |  ');
        console.log(`  [光效边缘剖面] ${line}`);
        const at0 = Math.min(profile[0].left, profile[0].right, profile[0].top, profile[0].bottom);
        const inner = Math.max(...profile.slice(2).map((p) => Math.min(p.left, p.right, p.top, p.bottom)));
        check(
          '光效铺到了屏幕最外圈（没有缺一圈）',
          at0 >= inner * 0.5,
          `最外圈差分=${Math.round(at0)}，往内峰值=${Math.round(inner)}`,
        );
      }
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

    // ————— 7b. 休息段的进度环必须真的画出来 —————
    // 回归：index.js 里曾经写的是 var(--break)，而主题里只有 --rest。
    // 未定义的 var() 会让 stroke 退回初始值 none —— 休息时整条进度弧凭空消失，
    // 而当时所有断言都只查了 stroke-dasharray，谁都没发现。
    // 注意要等一会儿再量：休息刚开始的瞬间进度就是 0，弧长为 0 是对的。
    await wait(1200);
    const breakRing = await js(
      wm.main,
      `(() => {
        const p = document.getElementById('ringProgress');
        return {
          stroke: getComputedStyle(p).stroke,
          offset: parseFloat(p.style.strokeDashoffset),
          circ: parseFloat(p.style.strokeDasharray),
        };
      })()`,
    );
    check(
      '休息时进度环有颜色（不是 none / 透明）',
      breakRing.stroke !== 'none' && !/rgba?\([^)]*,\s*0\s*\)/.test(breakRing.stroke),
      breakRing.stroke,
    );
    check(
      '休息中途进度环画出了可见的弧长',
      breakRing.offset < breakRing.circ * 0.95,
      `offset=${breakRing.offset.toFixed(1)} / ${breakRing.circ.toFixed(1)}`,
    );

    // 休息时轮次刻度也得跟着换成配角色，不能还是专注红
    const breakCycle = await js(
      wm.main,
      `(() => {
        const dots = document.getElementById('dots');
        const done = dots.querySelector('i.is-done');
        return {
          isBreak: dots.classList.contains('is-break'),
          color: done ? getComputedStyle(done).backgroundColor : '',
        };
      })()`,
    );
    check('休息时轮次刻度切到配角色', breakCycle.isBreak, String(breakCycle.isBreak));
    check(
      '休息时已完成的刻度不再是专注红',
      breakCycle.color !== '' && !/212,\s*44,\s*34/.test(breakCycle.color),
      breakCycle.color,
    );

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
      osClick
        ? `逻辑坐标(${osClick.px}, ${osClick.py}) → pointerdown=${osClick.count}，` +
          `尝试 ${osClick.attempts} 次，窗口可见=${osClick.visible}，该点命中 <${osClick.hit}>`
        : '没找到元素',
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

    // ————— 10b. 延后中的进度弧要按「延后的总时长」算 —————
    // 回归：index.js 曾经拿 snoozeRemainingMs 去除以 s.totalMs（专注总时长），
    // 5 分钟的延后配上 40 分钟的专注，画出来是一条几乎满圈的弧，
    // 和屏幕上那个 3:20 完全对不上。这里用"走到一半就该画一半"来守。
    applyFast({ snoozeSeconds: 6 });
    timer.reset();
    await wait(120);
    timer.start();
    await waitFor(() => timer.status === STATUS.FINISHED, 12000);
    timer.snooze();

    const arcAt = () =>
      js(
        wm.main,
        `(() => {
          const p = document.getElementById('ringProgress');
          return {
            offset: parseFloat(p.style.strokeDashoffset),
            circ: parseFloat(p.style.strokeDasharray),
            text: document.getElementById('time').textContent,
          };
        })()`,
      );
    await wait(120);
    const arcStart = await arcAt();
    await wait(2900);
    const arcMid = await arcAt();

    check(
      '延后刚开始时进度弧几乎全空',
      arcStart.offset > arcStart.circ * 0.9,
      `offset=${arcStart.offset.toFixed(1)} / ${arcStart.circ.toFixed(1)}，屏幕=${arcStart.text}`,
    );

    // 这里不对着挂钟断言，而是对着"屏幕自己说的话"断言：
    // 环上的弧长和环里的数字是 renderState() 同一次调用写进去的，两者必须自洽。
    // 按挂钟算会不稳 —— 状态每秒才广播一次，机器一忙就会差出去一秒。
    // 关系是 offset ＝ 周长 × 剩余 / 总时长（offset 是"被藏起来"的那段，
    // 藏得越多弧越长）。fmtTime 把毫秒四舍五入到秒，所以留 ±500ms 的余量。
    const snoozeTotalMs = timer.snapshot().snoozeSeconds * 1000;
    const shownSec = (() => {
      const [m, s] = String(arcMid.text).split(':').map(Number);
      return m * 60 + s;
    })();
    const offsetAt = (ms) => arcMid.circ * (Math.min(snoozeTotalMs, Math.max(0, ms)) / snoozeTotalMs);
    const lo = offsetAt(shownSec * 1000 - 500);
    const hi = offsetAt(shownSec * 1000 + 500);
    check(
      '延后中进度弧与环里的数字自洽（关键回归）',
      arcMid.offset >= lo - arcMid.circ * 0.03 && arcMid.offset <= hi + arcMid.circ * 0.03,
      `offset=${arcMid.offset.toFixed(1)}，屏幕 ${arcMid.text} ⇒ 期望 ${lo.toFixed(1)}~${hi.toFixed(1)}` +
        `（旧版拿专注总时长当分母会画成 ${arcMid.circ.toFixed(1)}）`,
    );

    // ————— 11. 跳过 / 重置 —————
    applyFast();
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
