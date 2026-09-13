'use strict';

/**
 * 全局快捷键：只做「延后 5 分钟」一个（对应 计划.md 1.3）。
 * 被别的软件占用时注册会失败，调用方负责提示用户重新录制。
 */

const { globalShortcut } = require('electron');

let current = null; // { accelerator, handler }

function clear() {
  if (current) {
    try {
      globalShortcut.unregister(current.accelerator);
    } catch {
      /* 忽略 */
    }
    current = null;
  }
}

/**
 * 注册（替换）全局快捷键。
 *
 * 关键：**先注册新键，成功了再注销旧键**。
 * 反过来的话，一旦新键被别的软件占用，「注销旧键 → 注册新键失败」会让用户
 * 静默失去全局快捷键（界面还显示着旧键，但按键已经没用了）。
 *
 * @returns {boolean} 是否注册成功；失败时旧快捷键保持有效
 */
function set(accelerator, handler) {
  if (typeof accelerator !== 'string') return false;
  const next = accelerator.trim();
  if (!next) return false;

  // 同一个键：只换处理函数，不必重新注册
  if (current && current.accelerator === next) {
    current.handler = handler;
    return true;
  }

  let ok = false;
  try {
    ok = globalShortcut.register(next, handler);
  } catch {
    ok = false;
  }
  if (!ok || !globalShortcut.isRegistered(next)) return false;

  const previous = current;
  current = { accelerator: next, handler };

  if (previous) {
    try {
      globalShortcut.unregister(previous.accelerator);
    } catch {
      /* 忽略 */
    }
  }
  return true;
}

function unregisterAll() {
  current = null;
  globalShortcut.unregisterAll();
}

module.exports = { set, clear, unregisterAll };
