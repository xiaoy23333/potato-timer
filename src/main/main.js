'use strict';

/**
 * 主进程入口：把 store / timer / 窗口 / 托盘 / 快捷键 串起来。
 */

const { app, BrowserWindow, ipcMain, powerMonitor, screen } = require('electron');

const { Store } = require('./store');
const { PomodoroTimer, STATUS } = require('./timer');
const { WindowManager } = require('./windows');
const { createTray } = require('./tray');
const shortcuts = require('./shortcuts');

// 提醒音由渲染进程用 Web Audio 合成，需要允许无用户手势播放
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setAppUserModelId('com.pomodoro.timer');

const START_HIDDEN = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  const store = new Store();
  const timer = new PomodoroTimer(store);
  const wm = new WindowManager(store);

  let tray = null;
  let quitting = false;
  let hotkeyOk = true;

  // ————————————————————— 工具函数 —————————————————————

  const broadcastState = () => wm.broadcast('state:update', timer.snapshot());

  const playSound = () => {
    const cfg = store.get();
    if (!cfg.soundEnabled) return;
    const win = wm.main;
    if (win && !win.isDestroyed()) {
      win.webContents.send('sound:play', { volume: cfg.soundVolume });
    }
  };

  const onHotkeyPressed = () => {
    // 全局快捷键 = 「5 分钟后再提醒」，只在提醒弹窗展示时有意义
    if (timer.status === STATUS.FINISHED) timer.snooze();
  };

  const applyHotkey = () => {
    hotkeyOk = shortcuts.set(store.get().hotkey, onHotkeyPressed);
    if (!hotkeyOk) console.warn('[hotkey] 注册失败（可能被其它软件占用）：', store.get().hotkey);
    return hotkeyOk;
  };

  const applyAutoLaunch = () => {
    const enabled = store.get().autoLaunch;
    try {
      // 开发模式（未打包）下必须把应用目录作为参数带上，否则开机项指向 electron.exe
      // 却不知道要启动哪个项目，开机后等于没启动。
      const args = ['--hidden'];
      if (!app.isPackaged) args.push(app.getAppPath());
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args,
      });
    } catch (err) {
      console.error('[autoLaunch] 设置失败：', err);
    }
  };

  // ————————————————————— 生命周期 —————————————————————

  app.on('second-instance', () => wm.showMain());

  app.whenReady().then(() => {
    // 主窗口每次创建（含重建）都要挂上初始化推送与「关闭 = 退出程序」
    wm.onMainReady = (win) => {
      win.webContents.on('did-finish-load', () => {
        if (win.webContents.isDestroyed()) return;
        win.webContents.send('config:update', store.get());
        win.webContents.send('state:update', timer.snapshot());
        if (!hotkeyOk) win.webContents.send('hotkey:error', { hotkey: store.get().hotkey });
      });
      win.on('closed', () => app.quit());
    };

    wm.createMain({ hidden: START_HIDDEN });
    wm.createPopup();

    // 光效层是全屏透明窗口，稍等片刻再创建，避免和启动争资源
    setTimeout(() => {
      if (!quitting) wm.createGlow();
    }, 1200);

    if (store.get().floatWindow.enabled) wm.createFloat();

    // —— 托盘 ——
    tray = createTray({
      onToggle: () => {
        // 待处理 / 延后中时，托盘上那一项实际是「进入下一轮」，不是开始/暂停
        if (timer.status === STATUS.FINISHED || timer.status === STATUS.SNOOZED) timer.nextCycle();
        else timer.togglePause();
      },
      onSkip: () => timer.skip(),
      onReset: () => timer.reset(),
      onShow: () => wm.showMain(),
      onSettings: () => {
        wm.showMain();
        wm.broadcast('ui:navigate', 'settings');
      },
      onQuit: () => {
        quitting = true;
        app.quit();
      },
    });

    applyHotkey();
    applyAutoLaunch();

    // —— 休眠 / 睡眠 / 锁屏：暂停计时，回来接着跑 ——
    powerMonitor.on('suspend', () => timer.onSystemSuspend());
    powerMonitor.on('lock-screen', () => timer.onSystemSuspend());
    powerMonitor.on('resume', () => timer.onSystemResume());
    powerMonitor.on('unlock-screen', () => timer.onSystemResume());

    screen.on('display-metrics-changed', () => wm.repositionAll());
    screen.on('display-added', () => wm.repositionAll());
    screen.on('display-removed', () => wm.repositionAll());

    // —— 计时事件 ——
    timer.on('change', (snap) => {
      wm.broadcast('state:update', snap);
      if (tray) tray.render(snap);
      // 只有「待处理」才留着弹窗；一旦延后（snoozed）就收起弹窗和光效，
      // 等 5 分钟到点由 remind 事件重新弹出。
      const reminding = snap.status === STATUS.FINISHED;
      if (!reminding && wm.popup && wm.popup.isVisible()) wm.hideReminder();
    });

    // 专注结束 → 弹窗 + 光效 + 响铃
    timer.on('focusFinished', () => {
      wm.showReminder();
      playSound();
    });

    // 延后到点 → 重新弹窗 + 再次响铃
    timer.on('remind', () => {
      wm.showReminder();
      playSound();
    });

    registerIpc();
    broadcastState();
    tray.render(timer.snapshot());

    // 端到端自检（仅 POMODORO_E2E=1 时启用，不影响正常使用）
    if (process.env.POMODORO_E2E === '1') {
      require('./e2e').run({ store, timer, wm, onHotkeyPressed });
    }
  });

  // 托盘常驻，所有窗口关闭才退出
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    shortcuts.unregisterAll();
    timer.dispose();
  });

  // ————————————————————— IPC —————————————————————

  function registerIpc() {
    ipcMain.handle('config:get', () => store.get());
    ipcMain.handle('state:get', () => timer.snapshot());

    ipcMain.handle('config:set', (_e, patch) => {
      const before = store.get();
      const after = store.set(patch || {});

      if (before.autoLaunch !== after.autoLaunch) applyAutoLaunch();
      if (before.floatWindow.enabled !== after.floatWindow.enabled ||
          before.floatWindow.draggable !== after.floatWindow.draggable) {
        wm.syncFloatVisibility();
      }
      if (before.snoozeSeconds !== after.snoozeSeconds) timer.onSnoozeDurationChanged();

      timer.onConfigChanged(after);
      wm.broadcast('config:update', after);
      broadcastState();
      return after;
    });

    ipcMain.handle('config:reset', () => {
      const after = store.reset();
      applyAutoLaunch();
      wm.syncFloatVisibility();
      timer.onConfigChanged(after);
      wm.broadcast('config:update', after);
      broadcastState();
      return after;
    });

    // 设置里录制快捷键：注册失败（被占用）就保持原键不变
    ipcMain.handle('hotkey:set', (_e, accelerator) => {
      // 渲染层传来的值不可信：先做类型与空白校验，别让非法输入一路走到
      // 「换键」逻辑里，把本来可用的快捷键搞丢。
      if (typeof accelerator !== 'string') return { ok: false, hotkey: store.get().hotkey };
      const next = accelerator.trim();
      if (!next || next.length > 64) return { ok: false, hotkey: store.get().hotkey };

      const ok = shortcuts.set(next, onHotkeyPressed);
      if (ok) {
        store.set({ hotkey: next });
        hotkeyOk = true;
        wm.broadcast('config:update', store.get());
      }
      return { ok, hotkey: store.get().hotkey };
    });

    ipcMain.on('sound:preview', () => playSound());

    ipcMain.on('timer:start', () => timer.start());
    ipcMain.on('timer:pause', () => timer.pause());
    ipcMain.on('timer:toggle', () => timer.togglePause());
    ipcMain.on('timer:skip', () => timer.skip());
    ipcMain.on('timer:reset', () => timer.reset());
    ipcMain.on('timer:snooze', () => timer.snooze());
    ipcMain.on('timer:nextCycle', () => timer.nextCycle());

    ipcMain.on('win:minimizeToTray', () => wm.hideMain());
    ipcMain.on('win:quit', () => {
      quitting = true;
      app.quit();
    });
  }
}
