'use strict';

/**
 * 配色验收截图：一次性把主窗口的几个代表状态、设置面板、提醒弹窗、小浮窗都拍下来。
 *
 * 目的：一轮批量检查，而不是来回跑好几次截图。
 *
 * 运行：npx electron scripts/shot-palette.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { Store } = require('../src/main/store');
const { WindowManager } = require('../src/main/windows');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(__dirname, '..', 'screenshots');

async function shoot(win, name) {
  if (!win || win.isDestroyed()) return;
  await wait(450);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  console.log(`  ${name}  ${img.getSize().width}x${img.getSize().height}`);
}

const js = (win, code) => win.webContents.executeJavaScript(code, true);

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const store = new Store();
  const wm = new WindowManager(store);

  wm.createMain({ hidden: false });
  await wait(1200);

  // 让主窗口显示一个"进行到一半"的进度：把专注压到 12 秒，跑 7 秒
  const cfg = store.get();
  const savedFocus = cfg.focusSeconds;
  const savedShort = cfg.shortBreakSeconds;
  cfg.focusSeconds = 12;
  cfg.shortBreakSeconds = 8;

  console.log('拍主窗口的几个状态：');

  // —— 1. 待开始（能看到完整的浅色轨道）——
  await js(wm.main, `document.getElementById('pageMain').hidden = false; document.getElementById('pageSettings').hidden = true; true`);
  await wait(600);
  await shoot(wm.main, '配色-01-待开始.png');

  // —— 2. 进行到一半（番茄红圆弧 + 浅色轨道同时可见）——
  wm.main.webContents.send('state:update', {});
  const timer = global.__dshTimer;
  void timer;
  await wait(100);

  // 通过 IPC 正常启动（这个诊断没注册 handler，所以直接驱动渲染层）
  await js(
    wm.main,
    `(() => {
      // 直接调渲染层的私有函数不可行，这里改成用 DOM 手工摆一个"进行到一半"的状态
      const ring = document.getElementById('ringProgress');
      const C = 2 * Math.PI * 96;
      ring.style.strokeDasharray = String(C);
      ring.style.strokeDashoffset = String(C * (1 - 0.42));
      ring.style.stroke = 'var(--focus)';
      document.getElementById('time').textContent = '06:58';
      document.getElementById('status').textContent = '第 1 / 4 轮';
      document.getElementById('btnPrimary').textContent = '暂停';
      document.getElementById('phaseBadge').textContent = '专注';
      document.getElementById('phaseBadge').classList.remove('is-break');
      const dots = document.getElementById('dots').children;
      for (let i = 0; i < dots.length; i += 1) dots[i].classList.toggle('is-done', i < 0);
      return true;
    })()`,
  );
  await shoot(wm.main, '配色-02-专注进行中.png');

  // —— 3. 休息态（青蓝圆弧）——
  await js(
    wm.main,
    `(() => {
      const ring = document.getElementById('ringProgress');
      const C = 2 * Math.PI * 96;
      ring.style.strokeDashoffset = String(C * (1 - 0.55));
      ring.style.stroke = 'var(--rest)';
      document.getElementById('time').textContent = '02:15';
      document.getElementById('status').textContent = '短休一下';
      document.getElementById('phaseBadge').textContent = '短休';
      document.getElementById('phaseBadge').classList.add('is-break');
      document.getElementById('btnPrimary').textContent = '暂停';
      const dots = document.getElementById('dots').children;
      for (let i = 0; i < dots.length; i += 1) dots[i].classList.toggle('is-done', i < 1);
      return true;
    })()`,
  );
  await shoot(wm.main, '配色-03-短休中.png');

  // —— 4. 设置面板 ——
  await js(wm.main, `document.getElementById('pageMain').hidden = true; document.getElementById('pageSettings').hidden = false; true`);
  await shoot(wm.main, '配色-04-设置面板.png');

  // —— 5. 提醒弹窗 ——
  wm.createPopup();
  wm.createGlow();
  await wait(900);
  wm.showPopup();
  // 让弹窗拿到一份配置和状态
  wm.popup.webContents.send('config:update', cfg);
  wm.popup.webContents.send('state:update', {
    phase: 'focus',
    phaseLabel: '专注',
    status: 'finished',
    remainingMs: 0,
    totalMs: 12000,
    completedFocus: 1,
    longBreakEvery: 4,
    cycleDone: 1,
    isSnoozing: false,
    snoozeSeconds: 60,
    snoozeRemainingMs: 0,
    nextPhaseLabel: '短休',
  });
  await shoot(wm.popup, '配色-05-提醒弹窗.png');

  // —— 6. 小浮窗（压在一张纯色底上才看得出透明与阴影）——
  if (!wm.float) wm.createFloat();
  await wait(600);
  await shoot(wm.float, '配色-06-小浮窗.png');

  cfg.focusSeconds = savedFocus;
  cfg.shortBreakSeconds = savedShort;

  app.exit(0);
});
