'use strict';

/**
 * 窗口管理：主窗口 / 提醒弹窗 / 光效层 / 小浮窗。
 *
 * 关键实现点（对应 计划.md 1.3）：
 *  - 提醒弹窗与光效层都用 setAlwaysOnTop(true, 'screen-saver')，可以盖在全屏应用之上
 *  - 两者都 focusable:false，用 showInactive() 显示 → 出现时不抢键盘焦点
 *  - 光效层 setIgnoreMouseEvents(true) → 鼠标点击完全穿透
 *  - 弹窗出现时小浮窗暂时让位（两者都在屏幕顶部居中，否则会重叠）
 */

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

const POPUP_SIZE = { width: 484, height: 162 };
const FLOAT_SIZE = { width: 132, height: 46 };
const POPUP_TOP = 18;
const FLOAT_TOP = 8;

// 主窗口尺寸。需求方反馈「倒计时占得太满、四周想多留白」，所以窗口放大了一号，
// 同时把表盘的占比压下去（见 index.css 的 .dial）—— 变大的是留白，不是数字。
const MAIN_SIZE = { width: 420, height: 640 };
const MAIN_MIN_SIZE = { minWidth: 380, minHeight: 560 };
// 旧版的默认尺寸。用户在旧版里**从没拖过窗口**的话，配置里存的就是这一份；
// 不把它识别出来，换了默认尺寸老用户也永远看不到（saved 会把它盖回去）。
const LEGACY_MAIN_SIZE = { width: 384, height: 548 };

const WEB_PREFS = {
  preload: PRELOAD,
  contextIsolation: true,
  nodeIntegration: false,
  backgroundThrottling: false,
};

function load(win, file) {
  win.loadFile(path.join(RENDERER_DIR, file));
}

class WindowManager {
  constructor(store) {
    this.store = store;
    this.main = null;
    this.popup = null;
    this.glow = null;
    this.float = null;
    this._saveTimer = null;
    this._inputFixTimer = null;
    /** 由 main.js 挂上：每次新建主窗口都会回调一次（包括重建） */
    this.onMainReady = null;
  }

  // ————————————————————————— 主窗口 —————————————————————————

  createMain({ hidden = false } = {}) {
    const saved = this.store.get().mainWindowBounds;
    const options = {
      ...MAIN_SIZE,
      ...MAIN_MIN_SIZE,
      frame: false,
      show: false,
      resizable: true,
      maximizable: false,
      backgroundColor: '#f4f8ff',
      title: '番茄钟',
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
      webPreferences: WEB_PREFS,
    };
    if (saved) {
      // 记住的尺寸正好等于旧版默认值 ⇒ 用户从没调过窗口，只沿用位置，尺寸用新的
      const untouched =
        saved.width === LEGACY_MAIN_SIZE.width && saved.height === LEGACY_MAIN_SIZE.height;
      Object.assign(options, untouched ? { x: saved.x, y: saved.y } : saved);
    }

    this.main = new BrowserWindow(options);
    load(this.main, 'index.html');

    this.main.once('ready-to-show', () => {
      if (!hidden) this.main.show();
    });

    const remember = () => {
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => {
        if (!this.main || this.main.isDestroyed()) return;
        const b = this.main.getBounds();
        this.store.set({ mainWindowBounds: b });
      }, 400);
    };
    this.main.on('resize', remember);
    this.main.on('move', remember);
    this.main.on('closed', () => {
      this.main = null;
    });

    // 让 main.js 挂上初始化推送与「关闭 = 退出」，重建出来的主窗口同样生效
    if (typeof this.onMainReady === 'function') this.onMainReady(this.main);

    return this.main;
  }

  showMain() {
    if (!this.main || this.main.isDestroyed()) {
      this.createMain({ hidden: false });
      return;
    }
    if (this.main.isMinimized()) this.main.restore();
    this.main.show();
    this.main.focus();
  }

  hideMain() {
    if (this.main && !this.main.isDestroyed()) this.main.hide();
  }

  // ————————————————————————— 提醒弹窗 —————————————————————————

  createPopup() {
    this.popup = new BrowserWindow({
      ...POPUP_SIZE,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      focusable: false, // 不抢键盘焦点
      alwaysOnTop: true,
      webPreferences: WEB_PREFS,
    });
    this.popup.setAlwaysOnTop(true, 'screen-saver');
    this.popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    load(this.popup, 'popup.html');
    this._positionPopup();
    return this.popup;
  }

  _positionPopup() {
    if (!this.popup || this.popup.isDestroyed()) return;
    const { bounds } = screen.getPrimaryDisplay();
    this.popup.setBounds({
      x: Math.round(bounds.x + (bounds.width - POPUP_SIZE.width) / 2),
      y: Math.round(bounds.y + POPUP_TOP),
      ...POPUP_SIZE,
    });
  }

  showPopup() {
    if (!this.popup || this.popup.isDestroyed()) this.createPopup();
    this._positionPopup();
    this.popup.showInactive();
    this._restorePopupInputRegion();
  }

  /**
   * ★ 关键的一步，不要删：
   *
   * Electron 在 Windows 上的「透明 + 置顶 + focusable:false」窗口，
   * hide() 之后再 showInactive() 会**丢掉鼠标输入区域** —— 表现为
   * 「第一次提醒能点能拖，第二次起整个弹窗点不动、鼠标在箭头和手型之间闪」。
   *
   * 光在显示后同步调一次 setBounds 是不够的（实测无效），必须在显示后
   * **隔一小会儿**再做一次真实的几何变更，系统才会重建输入区域。
   * 对照实验见 计划.md 第 6.4 节。
   */
  _restorePopupInputRegion() {
    const win = this.popup;
    if (!win || win.isDestroyed()) return;
    clearTimeout(this._inputFixTimer);

    this._inputFixTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      const target = win.getBounds();
      // 先挪 1px 再挪回来：确保这真的是一次几何变更（485px 宽的窗口上察觉不到）
      win.setBounds({ x: target.x + 1, y: target.y, width: target.width, height: target.height });
      this._inputFixTimer = setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        win.setBounds(target);
      }, 60);
    }, 130);
  }

  hidePopup() {
    if (this.popup && !this.popup.isDestroyed() && this.popup.isVisible()) this.popup.hide();
  }

  // ————————————————————————— 光效层 —————————————————————————

  createGlow() {
    const { bounds } = screen.getPrimaryDisplay();
    this.glow = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      focusable: false,
      enableLargerThanScreen: true,
      alwaysOnTop: true,
      webPreferences: WEB_PREFS,
    });
    this.glow.setAlwaysOnTop(true, 'screen-saver');
    this.glow.setIgnoreMouseEvents(true, { forward: true }); // 鼠标点击完全穿透
    this.glow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    load(this.glow, 'glow.html');
    // Windows 在创建窗口时会把高度裁到工作区（任务栏那条会被切掉），
    // 建好之后再用 setBounds 校正一次才能铺满整块屏幕。
    this._fitGlow();
    return this.glow;
  }

  _fitGlow() {
    if (!this.glow || this.glow.isDestroyed()) return;
    const { bounds } = screen.getPrimaryDisplay();
    this.glow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }

  showGlow() {
    if (!this.glow || this.glow.isDestroyed()) this.createGlow();
    this._fitGlow();
    this.glow.showInactive();
    this._fitGlow(); // 显示后再校正一次，确保盖住任务栏那一整条
    // 通知光效页重播一次闪光：窗口是一直存在的，光靠 CSS 不会自己重来
    if (!this.glow.webContents.isDestroyed()) this.glow.webContents.send('glow:play');
  }

  hideGlow() {
    if (this.glow && !this.glow.isDestroyed() && this.glow.isVisible()) this.glow.hide();
  }

  // ————————————————————————— 小浮窗 —————————————————————————

  createFloat() {
    this.float = new BrowserWindow({
      ...FLOAT_SIZE,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      focusable: false,
      alwaysOnTop: true,
      webPreferences: WEB_PREFS,
    });
    this.float.setAlwaysOnTop(true, 'screen-saver');
    this.float.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    load(this.float, 'float.html');
    this.float.once('ready-to-show', () => {
      if (!this.store.get().floatWindow.enabled) return;
      // 提醒弹窗正显示时不要挤上去：两者都在屏幕顶部居中。
      // 光效层是延迟创建的，启动后那一小段时间里提醒可能先弹出来，
      // 此时 showReminder 里的 hideFloat() 会因为窗口还没显示而打空，
      // 所以这里必须再挡一次。
      const popupVisible = this.popup && !this.popup.isDestroyed() && this.popup.isVisible();
      if (popupVisible) return;
      this.float.showInactive();
    });
    this.applyFloatConfig(this.store.get().floatWindow);
    this._positionFloat();
    return this.float;
  }

  _positionFloat() {
    if (!this.float || this.float.isDestroyed()) return;
    const { bounds } = screen.getPrimaryDisplay();
    this.float.setBounds({
      x: Math.round(bounds.x + (bounds.width - FLOAT_SIZE.width) / 2),
      y: Math.round(bounds.y + FLOAT_TOP),
      ...FLOAT_SIZE,
    });
  }

  /**
   * 不可拖动时整块浮窗点击穿透（完全不挡操作）；
   * 可拖动时恢复鼠标事件，并用 CSS 的 -webkit-app-region: drag 让它能被拖走。
   */
  applyFloatConfig(floatConfig) {
    if (!this.float || this.float.isDestroyed()) return;
    if (floatConfig.draggable) this.float.setIgnoreMouseEvents(false);
    else this.float.setIgnoreMouseEvents(true, { forward: true });
  }

  showFloat() {
    if (!this.float || this.float.isDestroyed()) this.createFloat();
    this._positionFloat();
    this.float.showInactive();
  }

  hideFloat() {
    if (this.float && !this.float.isDestroyed() && this.float.isVisible()) this.float.hide();
  }

  // ————————————————————————— 提醒组合动作 —————————————————————————

  /** 弹窗 + 光效一起出现，小浮窗让位 */
  showReminder() {
    this.hideFloat();
    this.showGlow();
    this.showPopup();
  }

  hideReminder() {
    this.hidePopup();
    this.hideGlow();
    if (this.store.get().floatWindow.enabled) this.showFloat();
  }

  // ————————————————————————— 其它 —————————————————————————

  syncFloatVisibility() {
    const cfg = this.store.get().floatWindow;
    this.applyFloatConfig(cfg);
    if (!cfg.enabled) {
      this.hideFloat();
      return;
    }
    // 弹窗正在展示时不让位
    const popupVisible = this.popup && !this.popup.isDestroyed() && this.popup.isVisible();
    if (!popupVisible) this.showFloat();
  }

  repositionAll() {
    this._positionPopup();
    this._fitGlow();
    this._positionFloat();
  }

  /** 给所有渲染进程广播 */
  broadcast(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      // 窗口正在销毁的瞬间 isDestroyed() 可能还是 false，但 webContents 已经没了，
      // 这时 send 会抛异常；而 tick 每 200ms 就会走一次广播，撞上的概率不低。
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    }
  }
}

module.exports = { WindowManager, POPUP_SIZE, FLOAT_SIZE };
