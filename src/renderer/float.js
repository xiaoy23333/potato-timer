'use strict';

/** 小浮窗：只显示时间（专注/休息/延后/暂停都只显示时间），颜色随阶段变化 */

const el = {
  pill: document.getElementById('pill'),
  time: document.getElementById('time'),
};

function applyConfig(config) {
  document.body.classList.toggle('is-draggable', !!(config && config.floatWindow && config.floatWindow.draggable));
}

function onState(state) {
  if (!state) return;
  const ms = state.status === 'snoozed' ? state.snoozeRemainingMs : state.remainingMs;
  el.time.textContent = window.fmtTime(ms);
  el.pill.classList.toggle('is-break', state.phase !== 'focus');
  el.pill.classList.toggle('is-idle', state.status === 'idle');
}

async function boot() {
  applyConfig(await window.pomodoro.getConfig());
  window.pomodoro.onConfig(applyConfig);
  window.pomodoro.onState(onState);
  onState(await window.pomodoro.getState());
}

document.addEventListener('contextmenu', (event) => event.preventDefault());
boot();
