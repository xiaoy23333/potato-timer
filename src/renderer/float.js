'use strict';

/** 小浮窗：只显示时间（专注/休息/延后/暂停都只显示时间），颜色可在设置里自定义 */

const el = {
  time: document.getElementById('time'),
};

function applyConfig(config) {
  const fw = (config && config.floatWindow) || {};
  document.body.classList.toggle('is-draggable', !!fw.draggable);
  // 倒计时文字颜色：一个颜色管全部状态。store 已经做过合法性校验，这里再兜一层
  const color = /^#[0-9a-fA-F]{6}$/.test(String(fw.color || '')) ? fw.color : '#f4664f';
  document.documentElement.style.setProperty('--float-color', color);
}

function onState(state) {
  if (!state) return;
  const ms = state.status === 'snoozed' ? state.snoozeRemainingMs : state.remainingMs;
  el.time.textContent = window.fmtTime(ms);
}

async function boot() {
  applyConfig(await window.pomodoro.getConfig());
  window.pomodoro.onConfig(applyConfig);
  window.pomodoro.onState(onState);
  onState(await window.pomodoro.getState());
}

document.addEventListener('contextmenu', (event) => event.preventDefault());
boot();
