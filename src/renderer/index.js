'use strict';

/** 主窗口逻辑：环形进度、大号倒计时、控制按钮、设置面板 */

const $ = (id) => document.getElementById(id);
const RING_RADIUS = 96;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;

const el = {
  pageMain: $('pageMain'),
  pageSettings: $('pageSettings'),
  phaseBadge: $('phaseBadge'),
  dots: $('dots'),
  ringProgress: $('ringProgress'),
  time: $('time'),
  status: $('status'),
  btnPrimary: $('btnPrimary'),
  btnSkip: $('btnSkip'),
  btnReset: $('btnReset'),
  hint: $('hint'),
  btnSettings: $('btnSettings'),
  btnBack: $('btnBack'),
  btnMin: $('btnMin'),
  btnClose: $('btnClose'),
  toast: $('toast'),
  // 设置项
  focusMin: $('focusMin'),
  focusSec: $('focusSec'),
  shortBreakMin: $('shortBreakMin'),
  shortBreakSec: $('shortBreakSec'),
  longBreakMin: $('longBreakMin'),
  longBreakSec: $('longBreakSec'),
  longBreakEvery: $('longBreakEvery'),
  snoozeMin: $('snoozeMin'),
  snoozeSec: $('snoozeSec'),
  hotkeyBtn: $('hotkeyBtn'),
  hotkeyNote: $('hotkeyNote'),
  soundEnabled: $('soundEnabled'),
  soundVolume: $('soundVolume'),
  soundVolumeText: $('soundVolumeText'),
  btnPreview: $('btnPreview'),
  glowColor: $('glowColor'),
  glowIntensity: $('glowIntensity'),
  glowIntensityText: $('glowIntensityText'),
  glowFlash: $('glowFlash'),
  glowFlashText: $('glowFlashText'),
  floatEnabled: $('floatEnabled'),
  floatDraggable: $('floatDraggable'),
  autoLaunch: $('autoLaunch'),
  btnResetConfig: $('btnResetConfig'),
};

let config = null;
let state = null;
let recording = false;
let toastTimer = null;

// ————————————————————— 小工具 —————————————————————

function toast(message, kind) {
  el.toast.textContent = message;
  el.toast.classList.toggle('is-warn', kind === 'warn');
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2800);
}

function prettyHotkey(accel) {
  return String(accel || '')
    .replace(/CommandOrControl|CmdOrCtrl|Control/gi, 'Ctrl')
    .replace(/\+/g, ' + ');
}

/** 把 KeyboardEvent 转成 Electron accelerator；必须带 Ctrl / Alt / Super 才接受 */
function codeToAccelKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;

  const map = {
    Space: 'Space',
    Tab: 'Tab',
    Enter: 'Return',
    NumpadEnter: 'Return',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
  };
  return map[code] || null;
}

function accelFromEvent(event) {
  const mods = [];
  if (event.ctrlKey) mods.push('Control');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (event.metaKey) mods.push('Super');

  const key = codeToAccelKey(event.code);
  if (!key) return null;

  const strong = mods.filter((m) => m !== 'Shift');
  if (strong.length === 0) return null; // 只按 Shift / 不带修饰键的裸键不接受

  return [...mods, key].join('+');
}

// ————————————————————— 主视图渲染 —————————————————————

function renderDots(count, done) {
  if (el.dots.childElementCount !== count) {
    el.dots.replaceChildren(
      ...Array.from({ length: count }, () => document.createElement('i')),
    );
  }
  Array.from(el.dots.children).forEach((dot, index) => {
    dot.classList.toggle('is-done', index < done);
  });
}

function statusText(s) {
  switch (s.status) {
    case 'idle':
      return `准备开始 · 本轮 ${window.formatDuration(s.focusSeconds)}`;
    case 'paused':
      return '已暂停';
    case 'snoozed':
      return `延后中 · ${window.fmtTime(s.snoozeRemainingMs)} 后再次提醒`;
    case 'finished':
      return '专注结束 · 等你在提醒弹窗里处理';
    default:
      return s.phase === 'focus'
        ? `第 ${s.cycleDone + 1} / ${s.longBreakEvery} 轮`
        : s.phase === 'short'
          ? '短休一下'
          : '长休一下';
  }
}

function primaryLabel(s) {
  switch (s.status) {
    case 'running':
      return '暂停';
    case 'paused':
      return '继续';
    case 'finished':
    case 'snoozed':
      return '进入下一轮';
    default:
      return s.phase === 'focus' ? '开始专注' : '开始休息';
  }
}

function renderState(s) {
  state = s;
  const isFocus = s.phase === 'focus';

  el.phaseBadge.textContent = s.phaseLabel;
  el.phaseBadge.classList.toggle('is-break', !isFocus);
  // 刚好跑满一轮循环（第 4 轮）时 cycleDone 会回到 0，但那一刻应该显示「全亮」，
  // 否则用户刚完成一整轮却看到进度点全灭
  const cycleDone = s.completedFocus > 0 && s.cycleDone === 0 ? s.longBreakEvery : s.cycleDone;
  renderDots(s.longBreakEvery, cycleDone);

  el.ringProgress.style.stroke = isFocus ? 'var(--focus)' : 'var(--break)';
  const total = s.totalMs > 0 ? s.totalMs : 1;
  const progress = Math.min(1, Math.max(0, 1 - s.remainingMs / total));
  el.ringProgress.style.strokeDasharray = String(RING_CIRC);
  el.ringProgress.style.strokeDashoffset = String(RING_CIRC * (1 - progress));

  const snoozing = s.status === 'snoozed';
  el.time.textContent = window.fmtTime(snoozing ? s.snoozeRemainingMs : s.remainingMs);
  el.time.classList.toggle('is-snooze', snoozing);

  el.status.textContent = statusText(s);
  el.btnPrimary.textContent = primaryLabel(s);
  // 待开始时没有「当前段」可跳过，按钮直接置灰（计时器里也有同样的守卫）
  el.btnSkip.disabled = s.status === 'idle';
  el.hint.textContent = `提醒时的延后快捷键 ${prettyHotkey(config ? config.hotkey : 'Control+Alt+P')}`;
}

// ————————————————————— 设置面板渲染 —————————————————————

function applyConfig(next) {
  config = next;
  fillForm(next);
  if (state) renderState(state);
}

function fillForm(c) {
  const setValue = (node, value) => {
    if (document.activeElement !== node) node.value = value;
  };

  setValue(el.longBreakEvery, c.longBreakEvery);
  writeDuration([el.focusMin, el.focusSec], c.focusSeconds);
  writeDuration([el.shortBreakMin, el.shortBreakSec], c.shortBreakSeconds);
  writeDuration([el.longBreakMin, el.longBreakSec], c.longBreakSeconds);
  writeDuration([el.snoozeMin, el.snoozeSec], c.snoozeSeconds);

  if (!recording) el.hotkeyBtn.textContent = prettyHotkey(c.hotkey);

  el.soundEnabled.checked = c.soundEnabled;
  setValue(el.soundVolume, c.soundVolume);
  el.soundVolumeText.textContent = `${Math.round(c.soundVolume * 100)}%`;

  setValue(el.glowColor, c.glow.color);
  setValue(el.glowIntensity, c.glow.intensity);
  el.glowIntensityText.textContent = `${Math.round(c.glow.intensity * 100)}%`;
  setValue(el.glowFlash, c.glow.flashSeconds);
  el.glowFlashText.textContent = `${c.glow.flashSeconds.toFixed(1)}s`;

  el.floatEnabled.checked = c.floatWindow.enabled;
  el.floatDraggable.checked = c.floatWindow.draggable;
  el.autoLaunch.checked = c.autoLaunch;
}

async function patch(patchObject) {
  config = await window.pomodoro.setConfig(patchObject);
  fillForm(config);
  return config;
}

// ————————————————————— 设置项事件 —————————————————————

function bindNumber(node, key) {
  node.addEventListener('change', async () => {
    // 注意：<input type="number"> 在空值或非法内容（'-'、'.'、'e' 等）时 value 返回 ''，
    // 而 Number('') === 0 是个有限数，光判 isFinite 是拦不住的。
    // 一旦真的提交 0：专注会被夹成 1 分钟、休息会变成 0（= 跳过休息），
    // 更糟的是正在跑的这一轮可能因此立刻结束并弹出提醒 —— 用户只是清空了一下输入框。
    if (node.value.trim() === '' || node.validity.badInput) {
      node.value = config[key]; // 直接回填原值（此时 activeElement 守卫不可靠）
      toast('请输入一个有效的数字', 'warn');
      return;
    }

    const raw = Number(node.value);
    if (!Number.isFinite(raw)) {
      node.value = config[key];
      return;
    }
    await patch({ [key]: Math.round(raw) });
  });
}

/** 「分 + 秒」两个输入框的组合值写回去 */
function writeDuration(nodes, seconds) {
  const [minNode, secNode] = nodes;
  const parts = window.splitDuration(seconds);
  if (document.activeElement !== minNode) minNode.value = parts.minutes;
  if (document.activeElement !== secNode) secNode.value = parts.seconds;
}

/** 绑定一组「分 + 秒」输入框，两个框任意一个改了都会提交 */
function bindDuration(nodes, key) {
  const [minNode, secNode] = nodes;

  const commit = async () => {
    const rawMin = minNode.value.trim();
    const rawSec = secNode.value.trim();

    // 空值 / 非法内容一律不接受：Number('') 是 0，会把时长悄悄改成 0
    if (rawMin === '' || rawSec === '' || minNode.validity.badInput || secNode.validity.badInput) {
      writeDuration(nodes, config[key]);
      toast('时长需要填写有效的分和秒', 'warn');
      return;
    }

    const total = Math.max(0, Math.round(Number(rawMin)) * 60 + Math.round(Number(rawSec)));
    if (!Number.isFinite(total)) {
      writeDuration(nodes, config[key]);
      return;
    }
    await patch({ [key]: total });
  };

  minNode.addEventListener('change', commit);
  secNode.addEventListener('change', commit);
}

bindDuration([el.focusMin, el.focusSec], 'focusSeconds');
bindDuration([el.shortBreakMin, el.shortBreakSec], 'shortBreakSeconds');
bindDuration([el.longBreakMin, el.longBreakSec], 'longBreakSeconds');
bindDuration([el.snoozeMin, el.snoozeSec], 'snoozeSeconds');
bindNumber(el.longBreakEvery, 'longBreakEvery');

// 滑块：拖动时实时更新右侧文字，松手才写配置
el.glowIntensity.addEventListener('input', () => {
  el.glowIntensityText.textContent = `${Math.round(Number(el.glowIntensity.value) * 100)}%`;
});
el.glowIntensity.addEventListener('change', async () => {
  await patch({ glow: { ...config.glow, intensity: Number(el.glowIntensity.value) } });
});

el.glowFlash.addEventListener('input', () => {
  el.glowFlashText.textContent = `${Number(el.glowFlash.value).toFixed(1)}s`;
});
el.glowFlash.addEventListener('change', async () => {
  await patch({ glow: { ...config.glow, flashSeconds: Number(el.glowFlash.value) } });
});

el.glowColor.addEventListener('change', async () => {
  await patch({ glow: { ...config.glow, color: el.glowColor.value } });
});

el.soundVolume.addEventListener('input', () => {
  el.soundVolumeText.textContent = `${Math.round(Number(el.soundVolume.value) * 100)}%`;
});
el.soundVolume.addEventListener('change', async () => {
  await patch({ soundVolume: Number(el.soundVolume.value) });
});

el.soundEnabled.addEventListener('change', () => patch({ soundEnabled: el.soundEnabled.checked }));
el.floatEnabled.addEventListener('change', async () => {
  await patch({ floatWindow: { ...config.floatWindow, enabled: el.floatEnabled.checked } });
});
el.floatDraggable.addEventListener('change', async () => {
  await patch({ floatWindow: { ...config.floatWindow, draggable: el.floatDraggable.checked } });
});
el.autoLaunch.addEventListener('change', () => patch({ autoLaunch: el.autoLaunch.checked }));

el.btnPreview.addEventListener('click', () => {
  window.playChime(config ? config.soundVolume : 0.6);
});

el.btnResetConfig.addEventListener('click', async () => {
  config = await window.pomodoro.resetConfig();
  fillForm(config);
  toast('已恢复默认设置');
});

// ————————— 快捷键录制 —————————

function stopRecording() {
  recording = false;
  el.hotkeyBtn.classList.remove('is-recording');
  el.hotkeyBtn.textContent = prettyHotkey(config ? config.hotkey : '');
  el.hotkeyNote.textContent = '点击上面的按钮，然后按下新的组合键（需包含 Ctrl 或 Alt）。';
}

el.hotkeyBtn.addEventListener('click', () => {
  recording = !recording;
  el.hotkeyBtn.classList.toggle('is-recording', recording);
  if (recording) {
    el.hotkeyBtn.textContent = '请按下组合键…';
    el.hotkeyNote.textContent = '按下你想要的组合键，Esc 取消。';
  } else {
    stopRecording();
  }
});

window.addEventListener('keydown', async (event) => {
  if (!recording) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    stopRecording();
    return;
  }

  const accelerator = accelFromEvent(event);
  if (!accelerator) {
    el.hotkeyNote.textContent = '这个组合不能作为全局快捷键，请至少加上 Ctrl 或 Alt。';
    return;
  }

  const result = await window.pomodoro.setHotkey(accelerator);
  if (result.ok) {
    config = await window.pomodoro.getConfig();
    stopRecording();
    toast(`延后快捷键已更新为 ${prettyHotkey(accelerator)}`);
  } else {
    el.hotkeyNote.textContent = `「${prettyHotkey(accelerator)}」注册失败，可能被其它软件占用了，换一个试试。`;
  }
});

// ————————————————————— 控制按钮 —————————————————————

el.btnPrimary.addEventListener('click', () => {
  const st = state ? state.status : 'idle';
  if (st === 'running') window.pomodoro.pause();
  else if (st === 'finished' || st === 'snoozed') window.pomodoro.nextCycle();
  else window.pomodoro.start();
});

el.btnSkip.addEventListener('click', () => window.pomodoro.skip());
el.btnReset.addEventListener('click', () => window.pomodoro.reset());

// ————————————————————— 窗口按钮与页面切换 —————————————————————

function openSettings(show) {
  // 离开设置页就结束录制：否则键盘会被一直吞掉，而且之后在主视图随手按的
  // 组合键会被当成新快捷键静默注册掉。
  if (!show) stopRecording();
  el.pageSettings.hidden = !show;
  el.pageMain.hidden = show;
}

el.btnSettings.addEventListener('click', () => openSettings(true));
el.btnBack.addEventListener('click', () => openSettings(false));
el.btnMin.addEventListener('click', () => {
  stopRecording();
  window.pomodoro.minimizeToTray();
});
el.btnClose.addEventListener('click', () => window.pomodoro.quit());

// 窗口失焦 / 被隐藏时也要结束录制
window.addEventListener('blur', stopRecording);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopRecording();
});

// ————————————————————— 订阅 —————————————————————

window.pomodoro.onState(renderState);
window.pomodoro.onConfig(applyConfig);
window.pomodoro.onSound(({ volume }) => window.playChime(volume));
window.pomodoro.onHotkeyError(({ hotkey }) => {
  toast(`全局快捷键 ${prettyHotkey(hotkey)} 注册失败，可能被其它软件占用，请在设置里换一个。`, 'warn');
});
window.pomodoro.onNavigate((target) => {
  if (target === 'settings') openSettings(true);
});

document.addEventListener('contextmenu', (event) => event.preventDefault());

async function boot() {
  applyConfig(await window.pomodoro.getConfig());
  renderState(await window.pomodoro.getState());
}

boot();
