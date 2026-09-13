'use strict';

/**
 * 配置持久化。
 * 存放在 Electron 用户数据目录：%APPDATA%\pomodoro-timer\config.json
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = Object.freeze({
  // —— 计时循环（**秒**，设置面板里用「分 + 秒」两个输入框）——
  focusSeconds: 40 * 60,
  shortBreakSeconds: 5 * 60,
  longBreakSeconds: 10 * 60,
  longBreakEvery: 4,
  // —— 延后 ——
  snoozeSeconds: 5 * 60,
  // —— 全局快捷键（Electron accelerator 语法）——
  hotkey: 'Control+Alt+P',
  // —— 提示音 ——
  soundEnabled: true,
  soundVolume: 0.6,
  // —— 光效 ——
  // flashSeconds：一次性闪光的时长（闪一下之后自己淡出消失）
  glow: { color: '#4fc3f7', intensity: 0.8, flashSeconds: 1.6 },
  // —— 小浮窗 ——
  floatWindow: { enabled: true, draggable: false },
  // —— 开机自启 ——
  autoLaunch: true,
  // —— 主窗口位置记忆（非用户可见设置）——
  mainWindowBounds: null,
});

const RANGES = {
  focusSeconds: [1, 10800],
  shortBreakSeconds: [0, 7200],
  longBreakSeconds: [0, 7200],
  longBreakEvery: [1, 12],
  snoozeSeconds: [1, 3600],
  soundVolume: [0, 1],
};

function clampNumber(value, range, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(range[1], Math.max(range[0], n));
}

function pickBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value;
  const nums = [x, y, width, height];
  if (!nums.every((n) => Number.isFinite(Number(n)))) return null;
  return {
    x: Math.round(Number(x)),
    y: Math.round(Number(y)),
    width: Math.max(340, Math.round(Number(width))),
    height: Math.max(440, Math.round(Number(height))),
  };
}

/** 把任意输入规整成一份完整、合法的配置 */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULTS;
  const glow = src.glow && typeof src.glow === 'object' ? src.glow : {};
  const fw = src.floatWindow && typeof src.floatWindow === 'object' ? src.floatWindow : {};

  // 兼容旧版本按「分钟」存的配置：老字段存在而新字段不存在时，自动换算过来
  const legacy = (secondsKey, minutesKey, fallback) => {
    if (src[secondsKey] !== undefined) return clampNumber(src[secondsKey], RANGES[secondsKey], fallback);
    if (typeof src[minutesKey] === 'number') {
      return clampNumber(Math.round(src[minutesKey] * 60), RANGES[secondsKey], fallback);
    }
    return fallback;
  };

  return {
    focusSeconds: legacy('focusSeconds', 'focusMinutes', d.focusSeconds),
    shortBreakSeconds: legacy('shortBreakSeconds', 'shortBreakMinutes', d.shortBreakSeconds),
    longBreakSeconds: legacy('longBreakSeconds', 'longBreakMinutes', d.longBreakSeconds),
    longBreakEvery: clampNumber(src.longBreakEvery, RANGES.longBreakEvery, d.longBreakEvery),
    snoozeSeconds: legacy('snoozeSeconds', 'snoozeMinutes', d.snoozeSeconds),
    hotkey: typeof src.hotkey === 'string' && src.hotkey.trim() ? src.hotkey.trim() : d.hotkey,
    soundEnabled: pickBool(src.soundEnabled, d.soundEnabled),
    soundVolume: clampNumber(src.soundVolume, RANGES.soundVolume, d.soundVolume),
    glow: {
      color: /^#[0-9a-fA-F]{6}$/.test(String(glow.color || '')) ? String(glow.color).toLowerCase() : d.glow.color,
      intensity: clampNumber(glow.intensity, [0.1, 1], d.glow.intensity),
      // 旧字段 glow.speed 不再使用（现在是「闪一次」而不是持续脉动），读不到就回默认
      flashSeconds: clampNumber(glow.flashSeconds, [0.4, 4], d.glow.flashSeconds),
    },
    floatWindow: {
      enabled: pickBool(fw.enabled, d.floatWindow.enabled),
      draggable: pickBool(fw.draggable, d.floatWindow.draggable),
    },
    autoLaunch: pickBool(src.autoLaunch, d.autoLaunch),
    mainWindowBounds: normalizeBounds(src.mainWindowBounds),
  };
}

class Store {
  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'config.json');
    this.config = normalize(this._read());
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  _write() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (err) {
      console.error('[store] 写入配置失败：', err);
    }
  }

  get() {
    return this.config;
  }

  /**
   * 合并一部分设置并落盘，返回新的完整配置。
   *
   * 注意：这里刻意用 Object.assign 就地更新同一个对象，而不是换成新对象。
   * 因为 timer 等模块会长期持有 store.get() 的引用，一旦换对象它们就会读到过期配置
   * （曾经导致「计时器永远跑不完」的 bug）。
   */
  set(patch) {
    const merged = { ...this.config, ...patch };
    if (patch && patch.glow) merged.glow = { ...this.config.glow, ...patch.glow };
    if (patch && patch.floatWindow) merged.floatWindow = { ...this.config.floatWindow, ...patch.floatWindow };

    Object.assign(this.config, normalize(merged));
    this._write();
    return this.config;
  }

  reset() {
    Object.assign(this.config, normalize({}));
    this._write();
    return this.config;
  }

  get defaults() {
    return DEFAULTS;
  }
}

module.exports = { Store, DEFAULTS, normalize };
