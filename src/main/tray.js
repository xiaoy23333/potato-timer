'use strict';

/**
 * 托盘：最小化到托盘后计时继续跑；菜单里能直接控制计时。
 */

const path = require('node:path');
const { Tray, Menu, nativeImage } = require('electron');
const { STATUS } = require('./timer');

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'tray.png');

function createTray({ onToggle, onSkip, onReset, onShow, onSettings, onQuit }) {
  let image = nativeImage.createFromPath(ICON_PATH);
  if (image.isEmpty()) {
    // 兜底：图标文件缺失时用一个 16x16 的纯色块，保证托盘仍然可用
    image = nativeImage.createEmpty();
  }
  image = image.resize({ width: 16, height: 16 });

  const tray = new Tray(image);
  tray.setToolTip('番茄钟');

  let lastMenuKey = '';

  const render = (snapshot) => {
    const running = snapshot && snapshot.status === STATUS.RUNNING;
    const pending = snapshot && (snapshot.status === STATUS.FINISHED || snapshot.status === STATUS.SNOOZED);

    // 提示气泡（鼠标悬停可见）里的文字每秒都在跳，这个很便宜，随便更新
    const tip = !snapshot
      ? '番茄钟'
      : snapshot.status === STATUS.FINISHED
        ? '专注结束 — 待处理'
        : snapshot.status === STATUS.SNOOZED
          ? `延后中 ${fmt(snapshot.snoozeRemainingMs)}`
          : `${snapshot.phaseLabel} ${fmt(snapshot.remainingMs)}${running ? '' : '（已暂停）'}`;
    tray.setToolTip(`番茄钟 · ${tip}`);

    // 菜单文字不带秒数，因此只有「粗状态」变化时才重建菜单，免得每秒重建一次
    const statusLabel = !snapshot
      ? '番茄钟'
      : snapshot.status === STATUS.FINISHED
        ? '专注结束 — 待处理'
        : snapshot.status === STATUS.SNOOZED
          ? '延后中'
          : `${snapshot.phaseLabel} ${snapshot.status === STATUS.PAUSED ? '（已暂停）' : '进行中'}`;
    // 待处理 / 延后中时这个按钮实际是「进入下一轮」，文案必须跟着变，不能写成「开始 / 继续」
    const actionLabel = pending ? '进入下一轮' : running ? '暂停' : '开始 / 继续';
    const menuKey = `${statusLabel}|${actionLabel}`;
    if (menuKey === lastMenuKey) return;
    lastMenuKey = menuKey;

    const menu = Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
      { type: 'separator' },
      { label: actionLabel, click: onToggle },
      { label: '跳过当前段', click: onSkip },
      { label: '重置', click: onReset },
      { type: 'separator' },
      { label: '显示主窗口', click: onShow },
      { label: '设置…', click: onSettings },
      { type: 'separator' },
      { label: '退出番茄钟', click: onQuit },
    ]);
    tray.setContextMenu(menu);
  };

  tray.on('double-click', onShow);
  tray.on('click', onShow);

  return { tray, render };
}

function fmt(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

module.exports = { createTray };
