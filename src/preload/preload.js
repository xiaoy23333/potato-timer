'use strict';

/**
 * 预加载脚本：向四个渲染窗口暴露同一套受限 API（contextIsolation 打开，渲染层拿不到 Node）。
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);
const send = (channel, payload) => ipcRenderer.send(channel, payload);

function on(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('pomodoro', {
  // —— 数据 ——
  getState: () => invoke('state:get'),
  getConfig: () => invoke('config:get'),
  setConfig: (patch) => invoke('config:set', patch),
  resetConfig: () => invoke('config:reset'),

  // —— 计时控制 ——
  start: () => send('timer:start'),
  pause: () => send('timer:pause'),
  toggle: () => send('timer:toggle'),
  skip: () => send('timer:skip'),
  reset: () => send('timer:reset'),

  // —— 提醒弹窗的两个动作 ——
  snooze: () => send('timer:snooze'),
  nextCycle: () => send('timer:nextCycle'),

  // —— 快捷键 ——
  setHotkey: (accelerator) => invoke('hotkey:set', accelerator),

  // —— 声音 ——
  previewSound: () => send('sound:preview'),

  // —— 窗口 ——
  minimizeToTray: () => send('win:minimizeToTray'),
  quit: () => send('win:quit'),

  // —— 订阅 ——
  onState: (cb) => on('state:update', cb),
  onConfig: (cb) => on('config:update', cb),
  onSound: (cb) => on('sound:play', cb),
  onGlowPlay: (cb) => on('glow:play', cb),
  onHotkeyError: (cb) => on('hotkey:error', cb),
  onNavigate: (cb) => on('ui:navigate', cb),
});
