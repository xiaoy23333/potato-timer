'use strict';

/**
 * 提醒弹窗的交互（对应 计划.md 1.3）：
 *   - 按钮 / 全局快捷键 → 延后 N 分钟再提醒
 *   - 滑块必须拖到最右端才触发 → 进入下一轮循环
 * 弹窗不抢焦点，所以键盘只能靠主进程的全局快捷键；这里只处理鼠标。
 */

const el = {
  dot: document.getElementById('dot'),
  title: document.getElementById('title'),
  snooze: document.getElementById('btnSnooze'),
  snoozeText: document.getElementById('snoozeText'),
  hotkeyHint: document.getElementById('hotkeyHint'),
  slider: document.getElementById('slider'),
  fill: document.getElementById('fill'),
  label: document.getElementById('sliderLabel'),
  knob: document.getElementById('knob'),
};

const KNOB_INSET = 4; // 滑块与卡片的间距，也就是滑块的起始位置
const TRIGGER_TOLERANCE = 3; // 距离最右端这么多像素以内松手也算拖到底
const MIN_DRAG_PX = 8; // 指针至少要真的移动这么多像素才允许触发，防误触

let config = { snoozeSeconds: 300, hotkey: 'Control+Alt+P' };
let dragging = false;
let pointerId = null;
let startPointerX = 0;
let startLeft = KNOB_INSET;
let currentLeft = KNOB_INSET;
let maxLeft = KNOB_INSET;
let travelled = 0;
let fired = false;
let lastStatus = null;

function prettyHotkey(accel) {
  return String(accel || '')
    .replace(/CommandOrControl|CmdOrCtrl|Control/gi, 'Ctrl')
    .replace(/\+/g, ' + ');
}

function measure() {
  maxLeft = Math.max(KNOB_INSET, el.slider.clientWidth - el.knob.offsetWidth - KNOB_INSET);
}

function setKnob(left) {
  currentLeft = Math.min(maxLeft, Math.max(KNOB_INSET, left));
  el.knob.style.left = `${currentLeft}px`;

  const span = maxLeft - KNOB_INSET;
  const progress = span > 0 ? (currentLeft - KNOB_INSET) / span : 0;

  el.fill.style.width = `${currentLeft + el.knob.offsetWidth}px`;
  el.label.style.opacity = String(Math.max(0, 1 - progress * 1.7));
  el.knob.classList.toggle('is-ready', progress > 0.98);
  el.slider.setAttribute('aria-valuenow', progress.toFixed(2));
}

function resetSlider() {
  el.label.textContent = '滑动开始下一轮';
  fired = false;
  measure();
  setKnob(KNOB_INSET);
}

// ————————————————————— 拖动 —————————————————————

el.slider.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || fired) return;

  // 上一次拖动没收到 pointerup 时留下的残局，先收干净
  if (dragging) cancelDrag();

  const rect = el.slider.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const knobWidth = el.knob.offsetWidth;

  measure();

  // 接着「动画中途的实际位置」，否则从回弹动画里按下会瞬移一下
  const renderedLeft = el.knob.getBoundingClientRect().left - rect.left;
  currentLeft = Math.min(maxLeft, Math.max(KNOB_INSET, renderedLeft));
  el.knob.style.left = `${currentLeft}px`;

  // 在滑块按钮上按下 → 保持原来的抓取姿态；
  // 在轨道空白处按下 → 把滑块贴到指针底下（改成绝对定位）。
  // 否则拖动是纯相对的：从轨道中间按下时，用户把指针拖到轨道最右端松手，
  // 滑块才走到一半，会以为坏了。
  const knobCenter = currentLeft + knobWidth / 2;
  if (Math.abs(pointerX - knobCenter) > knobWidth / 2) {
    setKnob(pointerX - knobWidth / 2);
  }

  dragging = true;
  pointerId = event.pointerId;
  startPointerX = event.clientX;
  startLeft = currentLeft;
  travelled = 0;

  el.knob.classList.add('is-dragging');
  el.slider.classList.add('is-dragging');
  try {
    el.slider.setPointerCapture(event.pointerId);
  } catch {
    /* 忽略 */
  }
  event.preventDefault();
});

el.slider.addEventListener('pointermove', (event) => {
  if (!dragging || event.pointerId !== pointerId) return;
  travelled = Math.max(travelled, Math.abs(event.clientX - startPointerX));
  setKnob(startLeft + (event.clientX - startPointerX));
});

function endDrag(event) {
  if (!dragging) return;
  // 只认发起拖动的那根指针；其它指针的事件忽略（但仍然要能被无参调用兜底）
  if (event && typeof event.pointerId === 'number' && pointerId !== null && event.pointerId !== pointerId) {
    return;
  }

  const shouldFire =
    maxLeft > KNOB_INSET && travelled >= MIN_DRAG_PX && currentLeft >= maxLeft - TRIGGER_TOLERANCE;

  dragging = false;
  el.knob.classList.remove('is-dragging');
  el.slider.classList.remove('is-dragging');
  try {
    if (pointerId !== null) el.slider.releasePointerCapture(pointerId);
  } catch {
    /* 忽略 */
  }
  pointerId = null;

  if (shouldFire) fire();
  else setKnob(KNOB_INSET); // 没拖到底 → 弹回原位
}

/** 拖动被外部原因打断（窗口隐藏、尺寸变化、失焦）：结束拖动并复位，绝不触发 */
function cancelDrag() {
  dragging = false;
  pointerId = null;
  el.knob.classList.remove('is-dragging');
  el.slider.classList.remove('is-dragging');
  resetSlider();
}

// 指针事件统一挂在 window 上：指针被捕获后事件仍会从捕获元素冒泡到这里，
// 这样即使弹窗被隐藏、指针移出窗口，也一定收得到 pointerup/pointercancel。
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
el.slider.addEventListener('lostpointercapture', endDrag);
window.addEventListener('blur', cancelDrag);

/**
 * 弹窗被隐藏/重新显示：两个方向都要把滑块状态清干净。
 * 只在「隐藏」时复位是不够的 —— 一旦有某条路径漏掉复位，
 * 滑块就会带着上一轮的 fired 标志回来，表现为「第一次能拖、后面拖不动」。
 */
document.addEventListener('visibilitychange', () => {
  if (dragging || fired || currentLeft !== KNOB_INSET) {
    cancelDrag();
    resetSlider();
  }
  lastStatus = null; // 下次收到状态时按「刚进入提醒」处理
});

function fire() {
  if (fired) return;
  fired = true;
  el.knob.classList.add('is-ready');
  el.label.textContent = '开始下一轮';
  el.label.style.opacity = '1';
  window.pomodoro.nextCycle();

  // 兜底：万一主进程没有回状态（比如被别的窗口挡了一下、IPC 丢包），
  // 1.5 秒后主动解锁，绝不让滑块永久失效。
  setTimeout(() => {
    if (fired && !dragging) {
      fired = false;
      resetSlider();
    }
  }, 1500);
}

// ————————————————————— 延后按钮 —————————————————————

el.snooze.addEventListener('click', () => {
  window.pomodoro.snooze();
});

// ————————————————————— 配置与状态 —————————————————————

function applyConfig(next) {
  config = next;
  el.snoozeText.textContent = `${window.formatDuration(config.snoozeSeconds)}后再提醒`;
  el.hotkeyHint.textContent = prettyHotkey(config.hotkey);
}

function onState(state) {
  if (!state) return;
  el.title.textContent = state.phaseLabel === '专注' ? '专注结束' : `${state.phaseLabel}结束`;
  el.dot.classList.toggle('is-break', state.phase !== 'focus');

  // 两种情况都要彻底复位滑块：
  //   1) 状态离开「待处理」 —— 这一轮翻篇了
  //   2) 刚刚「进入」待处理 —— 说明这是一次全新的提醒，滑块必须从最左端重新开始
  // 之前只做了第 1 种，一旦哪条路径漏掉复位，就会表现成「第一次能拖、后面拖不动」。
  const enteringReminder = state.status === 'finished' && lastStatus !== 'finished';
  if (state.status !== 'finished' || enteringReminder) {
    cancelDrag();
    resetSlider();
  }
  lastStatus = state.status;
}

window.addEventListener('resize', () => {
  // 尺寸变了：进行中的拖动作废，滑块复位。
  // 否则 setKnob 会把 currentLeft 夹到新的 maxLeft —— 画面变成「已到底、可松手」，
  // 用户却在根本没拖过的情况下，点一下就把这一轮带走了。
  cancelDrag();
  resetSlider();
});

document.addEventListener('contextmenu', (event) => event.preventDefault());

async function boot() {
  applyConfig(await window.pomodoro.getConfig());
  window.pomodoro.onConfig(applyConfig);
  window.pomodoro.onState(onState);
  onState(await window.pomodoro.getState());
  requestAnimationFrame(() => {
    measure();
    setKnob(KNOB_INSET);
  });
}

boot();
