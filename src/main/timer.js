'use strict';

/**
 * 番茄钟计时状态机。
 *
 * 跑在主进程：窗口被隐藏 / 最小化到托盘 / 渲染进程被后台节流都不会影响计时。
 * 剩余时间永远由 endAt 时间戳反算，setInterval 只负责刷新，因此不会累积误差。
 *
 * 状态流转见 计划.md「2. 状态机」。
 */

const { EventEmitter } = require('node:events');

const PHASE = { FOCUS: 'focus', SHORT: 'short', LONG: 'long' };
const STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  FINISHED: 'finished', // 专注结束，等待用户处理（弹窗展示中）
  SNOOZED: 'snoozed', // 已延后，等待「再次提醒」
};

const PHASE_LABEL = { focus: '专注', short: '短休', long: '长休' };

const TICK_MS = 200;

class PomodoroTimer extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.config = store.get();
    // 记住上一次的时长设置。不依赖「配置对象是否换了新引用」，避免引用同步问题
    this._timing = this._timingOf(this.config);

    this.phase = PHASE.FOCUS;
    this.status = STATUS.IDLE;
    this.completedFocus = 0; // 累计完成的专注轮数
    this.totalMs = this.durationFor(PHASE.FOCUS);
    this.remainingMs = this.totalMs;
    this.endAt = 0;
    this.snoozeEndAt = 0;
    this.systemPaused = false; // 由休眠/锁屏触发的暂停

    this._interval = null;
    this._lastKey = '';
  }

  // ——————————————————————————— 基础 ———————————————————————————

  durationFor(phase) {
    const c = this.config;
    const seconds =
      phase === PHASE.FOCUS
        ? c.focusSeconds
        : phase === PHASE.SHORT
          ? c.shortBreakSeconds
          : c.longBreakSeconds;
    return Math.round(seconds * 1000);
  }

  /**
   * 刚刚完成一轮专注（completedFocus 已经 +1）之后，该进入哪种休息。
   * 每 longBreakEvery 轮给一次长休：完成 4 轮时 4 % 4 === 0 → 长休。
   */
  breakDueAfterFocus() {
    const every = Math.max(1, Math.round(this.config.longBreakEvery));
    return this.completedFocus > 0 && this.completedFocus % every === 0 ? PHASE.LONG : PHASE.SHORT;
  }

  /** 预告用：如果正在进行的这一轮专注完成，之后会是哪种休息 */
  predictedBreak() {
    const every = Math.max(1, Math.round(this.config.longBreakEvery));
    return (this.completedFocus + 1) % every === 0 ? PHASE.LONG : PHASE.SHORT;
  }

  snapshot() {
    const c = this.config;
    const every = Math.max(1, Math.round(c.longBreakEvery));
    return {
      phase: this.phase,
      phaseLabel: PHASE_LABEL[this.phase],
      status: this.status,
      remainingMs: Math.max(0, Math.round(this.remainingMs)),
      totalMs: Math.max(0, Math.round(this.totalMs)),
      completedFocus: this.completedFocus,
      longBreakEvery: every,
      cycleDone: this.completedFocus % every,
      isSnoozing: this.status === STATUS.SNOOZED,
      snoozeSeconds: c.snoozeSeconds,
      snoozeRemainingMs:
        this.status === STATUS.SNOOZED ? Math.max(0, Math.round(this.snoozeEndAt - Date.now())) : 0,
      nextPhaseLabel: PHASE_LABEL[this.predictedBreak()],
      focusSeconds: c.focusSeconds,
      shortBreakSeconds: c.shortBreakSeconds,
      longBreakSeconds: c.longBreakSeconds,
    };
  }

  start() {
    this._ensureTicking();
    if (this.status === STATUS.RUNNING) return;
    if (this.status === STATUS.PAUSED) {
      this._resumeFromPause();
      return;
    }
    if (this.status === STATUS.FINISHED || this.status === STATUS.SNOOZED) {
      // 弹窗还在的情况：按「开始」等同于确认进入下一轮
      this.nextCycle();
      return;
    }
    this.beginPhase(this.phase === PHASE.FOCUS ? PHASE.FOCUS : this.phase);
  }

  pause() {
    if (this.status !== STATUS.RUNNING) return;
    this.remainingMs = Math.max(0, this.endAt - Date.now());
    this.status = STATUS.PAUSED;
    this._emitChange(true);
  }

  togglePause() {
    if (this.status === STATUS.RUNNING) this.pause();
    else this.start();
  }

  _resumeFromPause() {
    this.endAt = Date.now() + this.remainingMs;
    this.status = STATUS.RUNNING;
    this._emitChange(true);
  }

  /** 开始某个阶段；时长为 0 的休息会被直接跳过 */
  beginPhase(phase) {
    this._ensureTicking();
    this.phase = phase;
    this.totalMs = this.durationFor(phase);

    if (this.totalMs <= 0) {
      if (phase === PHASE.FOCUS) {
        // 专注时长不允许为 0（设置里最小 1 分钟），兜底给 1 分钟
        this.totalMs = 60 * 1000;
      } else {
        // 休息设为 0 分钟 = 跳过休息，直接开始下一轮专注
        this.beginPhase(PHASE.FOCUS);
        return;
      }
    }

    this.remainingMs = this.totalMs;
    this.endAt = Date.now() + this.totalMs;
    this.status = STATUS.RUNNING;
    this._emitChange(true);
  }

  _finishPhase() {
    if (this.phase === PHASE.FOCUS) {
      this.completedFocus += 1;
      this.remainingMs = 0;
      this.totalMs = this.durationFor(PHASE.FOCUS);
      this.status = STATUS.FINISHED;
      this._emitChange(true);
      this.emit('focusFinished', this.snapshot());
      return;
    }

    // 休息结束 → 自动开始下一轮专注
    this.emit('breakFinished', this.snapshot());
    this.beginPhase(PHASE.FOCUS);
  }

  /** 滑块拖到底 / 弹窗确认：进入下一轮循环 */
  nextCycle() {
    // 还没开始计时：不该凭空开出一段休息或专注
    if (this.status === STATUS.IDLE) return;

    if (this.status !== STATUS.FINISHED && this.status !== STATUS.SNOOZED) {
      // 计时还在跑的时候调用，等价于跳过当前段
      this.skip();
      return;
    }
    const next = this.breakDueAfterFocus();
    if (this.durationFor(next) > 0) this.beginPhase(next);
    else this.beginPhase(PHASE.FOCUS); // 休息为 0 → 直接下一轮专注
    this.emit('cycleStarted', this.snapshot());
  }

  /** 跳过当前段（不计入完成数、不弹提醒） */
  skip() {
    // 还没开始计时：没什么可跳过的，更不能因此自己跑起来
    if (this.status === STATUS.IDLE) return;

    if (this.status === STATUS.FINISHED || this.status === STATUS.SNOOZED) {
      this.nextCycle();
      return;
    }
    if (this.phase === PHASE.FOCUS) {
      // 跳过的专注不计入完成轮数，所以只给短休，不给长休
      this.beginPhase(this.durationFor(PHASE.SHORT) > 0 ? PHASE.SHORT : PHASE.FOCUS);
    } else {
      this.beginPhase(PHASE.FOCUS);
    }
  }

  reset() {
    this._ensureTicking();
    this.completedFocus = 0;
    this.phase = PHASE.FOCUS;
    this.status = STATUS.IDLE;
    this.systemPaused = false;
    this.snoozeEndAt = 0;
    this.totalMs = this.durationFor(PHASE.FOCUS);
    this.remainingMs = this.totalMs;
    this._emitChange(true);
  }

  /** 「5 分钟后再提醒」，可无限次 */
  snooze() {
    if (this.status !== STATUS.FINISHED) return false;
    const ms = Math.round(this.config.snoozeSeconds * 1000);
    this._ensureTicking();
    this.snoozeEndAt = Date.now() + ms;
    this.remainingMs = ms;
    this.status = STATUS.SNOOZED;
    this._emitChange(true);
    this.emit('snoozed', this.snapshot());
    return true;
  }

  // ——————————————————————————— 设置变更 ———————————————————————————

  /** 只挑出与「时长」有关的四项，用来判断设置改动是否影响当前这一轮 */
  _timingOf(config) {
    return {
      focus: config.focusSeconds,
      short: config.shortBreakSeconds,
      long: config.longBreakSeconds,
      every: config.longBreakEvery,
    };
  }

  /**
   * 时长类设置立即生效：当前这轮的剩余时间按新时长重算。
   * 例：40 分钟跑了 10 分钟时把专注改成 50 → 剩余变 40 分钟。
   */
  onConfigChanged(config) {
    this.config = config;

    const next = this._timingOf(config);
    const prev = this._timing || next;
    const timingChanged =
      prev.focus !== next.focus ||
      prev.short !== next.short ||
      prev.long !== next.long ||
      prev.every !== next.every;
    this._timing = next;

    if (timingChanged) {
      if (this.status === STATUS.RUNNING || this.status === STATUS.PAUSED) {
        const elapsed = Math.max(0, this.totalMs - this.remainingMs);
        const newTotal = this.durationFor(this.phase);
        this.totalMs = newTotal;
        this.remainingMs = Math.max(0, newTotal - elapsed);

        if (this.remainingMs <= 0) {
          // 新时长比已经跑掉的时间还短 → 本轮直接结束。
          // 不能停在 0 秒的悬空状态：暂停中会卡在「已暂停 00:00」永远不动，
          // 而且用户点「继续」之后还会把这一轮算成完成。
          this._finishPhase();
          return;
        }

        if (this.status === STATUS.RUNNING) this.endAt = Date.now() + this.remainingMs;
      } else if (this.status === STATUS.IDLE) {
        this.totalMs = this.durationFor(this.phase);
        this.remainingMs = this.totalMs;
      }
    }
    this._emitChange(true);
  }

  /** 延后时长改动时，同步正在进行的延后倒计时 */
  onSnoozeDurationChanged() {
    if (this.status === STATUS.SNOOZED) {
      this.snoozeEndAt = Date.now() + Math.round(this.config.snoozeSeconds * 1000);
    }
  }

  // ——————————————————————————— 系统电源事件 ———————————————————————————

  onSystemSuspend() {
    if (this.status === STATUS.RUNNING) {
      this.systemPaused = true;
      this.pause();
    }
  }

  onSystemResume() {
    if (this.systemPaused) {
      this.systemPaused = false;
      if (this.status === STATUS.PAUSED) this._resumeFromPause();
    }
  }

  // ——————————————————————————— 心跳 ———————————————————————————

  _ensureTicking() {
    if (this._interval) return;
    this._interval = setInterval(() => this.tick(), TICK_MS);
  }

  /** 退出前停掉心跳 */
  dispose() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  tick() {
    if (this.status === STATUS.RUNNING) {
      const remaining = this.endAt - Date.now();
      if (remaining <= 0) {
        this._finishPhase();
        return;
      }
      this.remainingMs = remaining;
    } else if (this.status === STATUS.SNOOZED) {
      const remaining = this.snoozeEndAt - Date.now();
      if (remaining <= 0) {
        this.remainingMs = 0;
        this.status = STATUS.FINISHED;
        this._emitChange(true);
        this.emit('remind', this.snapshot());
        return;
      }
      this.remainingMs = remaining;
    }
    this._emitChange(false);
  }

  _emitChange(force) {
    const snap = this.snapshot();
    const key = `${snap.status}|${snap.phase}|${Math.ceil(snap.remainingMs / 1000)}|${snap.completedFocus}`;
    if (!force && key === this._lastKey) return;
    this._lastKey = key;
    this.emit('change', snap);
  }
}

module.exports = { PomodoroTimer, PHASE, STATUS, PHASE_LABEL };
