'use strict';

/**
 * 主窗口布局截图：用真的 PomodoroTimer 驱动，不是手工摆 DOM。
 *
 * 运行：npx electron scripts/shot-main.js [输出目录]
 *
 * 之所以要"真的计时器"：手工 script 那套（见 shot-palette.js）只能证明
 * 某个 DOM 长什么样，证明不了 renderState() 真正会渲染成什么。
 * 这里 store.set 被临时改成不落盘，跑完恢复，不污染用户配置。
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { Store } = require('../src/main/store');
const { PomodoroTimer, PHASE, STATUS } = require('../src/main/timer');
const { WindowManager } = require('../src/main/windows');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const OUT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'screenshots');

// 一份干净的默认配置：截图不要受用户当前设置影响
const PINNED = {
  focusSeconds: 40 * 60,
  shortBreakSeconds: 5 * 60,
  longBreakSeconds: 10 * 60,
  longBreakEvery: 4,
  snoozeSeconds: 5 * 60,
  glow: { color: '#4fc3f7', intensity: 0.8, flashSeconds: 1.6 },
  floatWindow: { enabled: false, draggable: false, color: '#d42c22' },
  soundEnabled: false,
  autoLaunch: false,
};

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const store = new Store();
  const realWrite = store._write.bind(store);
  let writes = 0;
  store._write = () => {
    writes += 1;
  };

  const timer = new PomodoroTimer(store);
  const wm = new WindowManager(store);

  store.set(PINNED);
  timer.onConfigChanged(store.get());

  const push = () => {
    if (wm.main && !wm.main.isDestroyed()) {
      wm.main.webContents.send('config:update', store.get());
      wm.main.webContents.send('state:update', timer.snapshot());
    }
  };
  timer.on('change', push);

  wm.createMain({ hidden: false });
  await wait(1400);
  push();

  const js = (code) => wm.main.webContents.executeJavaScript(code, true);

  async function shoot(name) {
    await wait(520);
    const img = await wm.main.webContents.capturePage();
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    const s = img.getSize();
    console.log(`  ${name}.png  ${s.width}x${s.height}`);
  }

  // —— 1. 待开始 ——
  console.log('主窗口状态：');
  await shoot('主界面-01-待开始');

  // —— 2. 专注跑到一半 ——
  timer.beginPhase(PHASE.FOCUS);
  timer.endAt = Date.now() + 0.42 * timer.totalMs; // 假装已经跑了 58%
  timer.remainingMs = timer.endAt - Date.now();
  timer.completedFocus = 1;
  timer._emitChange(true);
  await shoot('主界面-02-专注进行中');

  // —— 3. 专注暂停 ——
  timer.pause();
  await shoot('主界面-03-已暂停');

  // —— 4. 短休进行中 ——
  timer.beginPhase(PHASE.SHORT);
  timer.endAt = Date.now() + 0.55 * timer.totalMs;
  timer.remainingMs = timer.endAt - Date.now();
  timer.completedFocus = 2;
  timer._emitChange(true);
  await shoot('主界面-04-短休进行中');

  // —— 5. 长休（第 4 轮后）——
  timer.completedFocus = 4;
  timer.beginPhase(PHASE.LONG);
  timer.endAt = Date.now() + 0.3 * timer.totalMs;
  timer.remainingMs = timer.endAt - Date.now();
  timer._emitChange(true);
  await shoot('主界面-05-长休进行中');

  // —— 6. 专注结束、等待处理（弹窗展示中）——
  timer.beginPhase(PHASE.FOCUS);
  timer.completedFocus = 1;
  timer._finishPhase();
  await shoot('主界面-06-待处理');

  // —— 7. 已延后 ——
  timer.snooze();
  timer.snoozeEndAt = Date.now() + 3 * 60 * 1000 + 20 * 1000;
  timer.remainingMs = timer.snoozeEndAt - Date.now();
  timer._emitChange(true);
  await shoot('主界面-07-延后中');

  // —— 8. 设置面板（顶部 + 滚到底）——
  await js(`document.getElementById('pageMain').hidden = true; document.getElementById('pageSettings').hidden = false; true`);
  await shoot('主界面-08-设置面板');
  await js(`document.querySelector('.settings-body').scrollTop = 9999; true`);
  await shoot('主界面-08b-设置面板底部');
  await js(
    `document.querySelector('.settings-body').scrollTop = 0;` +
      `document.getElementById('pageMain').hidden = false;` +
      `document.getElementById('pageSettings').hidden = true; true`,
  );

  // —— 9. 最小尺寸 360x500，看小窗口下会不会挤爆 ——
  const b = wm.main.getBounds();
  wm.main.setBounds({ x: b.x, y: b.y, width: 360, height: 500 });
  timer.reset();
  await wait(400);
  await shoot('主界面-09-最小尺寸');
  wm.main.setBounds(b);

  // —— 10. 大尺寸 520x820，看拉伸后是不是散架 ——
  timer.beginPhase(PHASE.FOCUS);
  timer.endAt = Date.now() + 0.42 * timer.totalMs;
  timer.remainingMs = timer.endAt - Date.now();
  timer._emitChange(true);
  await wait(300);
  wm.main.setBounds({ x: b.x, y: b.y, width: 520, height: 820 });
  await shoot('主界面-10-放大尺寸');

  // —— 11. 几何体检：一眼看不出"数字会不会溢出环内圈""空档是不是对称"，
  //        这里直接量。数字用的是 tabular-nums，实测宽度比估算可靠得多。 ——
  console.log('\n几何体检（单位：逻辑像素）:');
  const SIZES = [
    [360, 500],
    [384, 548],
    [440, 640],
    [560, 860],
  ];
  for (const [w, h] of SIZES) {
    wm.main.setBounds({ x: b.x, y: b.y, width: w, height: h });
    await wait(420);
    const g = await js(`(() => {
      const box = (n) => { const r = n.getBoundingClientRect(); return { t: r.top, b: r.bottom, w: r.width }; };
      const dial = box(document.querySelector('.dial'));
      const ring = box(document.querySelector('.ring-wrap'));
      const time = box(document.getElementById('time'));
      const bar  = box(document.querySelector('.statusbar'));
      const ctl  = box(document.querySelector('.controls'));
      // 环内圈的可用直径：环外径 × (1 - 描边宽 / viewBox 宽)
      const inner = ring.w * (1 - 9 / 220);
      return {
        win: [window.innerWidth, window.innerHeight],
        ring: Math.round(ring.w),
        barH: Math.round(bar.b - bar.t),
        ctlH: Math.round(ctl.b - ctl.t),
        gapTop: Math.round(ring.t - bar.b),
        gapBottom: Math.round(ctl.t - ring.b),
        font: Math.round(parseFloat(getComputedStyle(document.getElementById('time')).fontSize)),
        timeW: Math.round(time.w),
        inner: Math.round(inner),
      };
    })()`);
    const overflow = g.timeW > g.inner ? '  ✗ 数字超出环内圈' : '';
    console.log(
      `  ${String(w).padStart(3)}x${String(h).padStart(3)}  环=${String(g.ring).padStart(3)}` +
        `  字号=${String(g.font).padStart(3)}  数字宽=${String(g.timeW).padStart(3)}/内圈${String(g.inner).padStart(3)}` +
        `  上留白=${String(g.gapTop).padStart(3)}  下留白=${String(g.gapBottom).padStart(3)}` +
        `  (状态条${g.barH} 控制区${g.ctlH})${overflow}`,
    );
  }

  store._write = realWrite;
  console.log(`\n（拦下的写入次数：${writes}，已在内存里改回默认值，用户配置未被改动）`);
  app.exit(0);
});
