'use strict';

/**
 * 诊断脚本 17：用**差分法**量出光效到底铺到屏幕边缘没有。
 *
 * 之前的教训：
 *   ① capturePage() 量的是「页面自己以为的画面」，不代表屏幕上的真实样子；
 *   ② 直接分析单张截图的颜色也不可靠 —— 需求方的壁纸本身就是大片青蓝色，
 *      会把"青色程度"这种判据整个污染掉。
 *
 * 正确做法：光效关着拍一张、开着拍一张，两张相减。壁纸、窗口、任务栏全部抵消，
 * 剩下的只有光效。然后看「离边缘每 1 像素的差异强度」，就能看出有没有缺一圈。
 *
 * 运行：npx electron scripts/diagnose-glow-edge.js
 */

const { app, screen, desktopCapturer } = require('electron');
const { Store } = require('../src/main/store');
const { WindowManager } = require('../src/main/windows');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function grab(display) {
  const scale = display.scaleFactor || 1;
  const s = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  return s.length ? s[0].thumbnail : null;
}

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const store = new Store();
  const wm = new WindowManager(store);

  // 把闪光拉长，好在"亮着"的时候慢慢截图
  store.get().glow.flashSeconds = 12;
  store.get().glow.intensity = 1;

  wm.createGlow();
  await wait(1300);

  // 先抓一次基准，顺便拿到屏幕尺寸
  const first = await grab(display);
  if (!first) {
    console.error('抓不到屏幕');
    app.exit(1);
    return;
  }
  const { width: W, height: H } = first.getSize();
  console.log(`截图尺寸 ${W} x ${H}\n`);

  /** 某点的差异强度（RGB 绝对值之和，0~765） */
  let b1 = first.toBitmap();
  let b2 = first.toBitmap();
  const diff = (x, y) => {
    const i = (y * W + x) * 4;
    return Math.abs(b1[i] - b2[i]) + Math.abs(b1[i + 1] - b2[i + 1]) + Math.abs(b1[i + 2] - b2[i + 2]);
  };

  /** 沿四条边量差分强度随距离的变化，返回最外圈和往内峰值 */
  function profile() {
    const out = [];
    for (let d = 0; d <= 40; d += 2) {
      let l = 0;
      let r = 0;
      let t = 0;
      let bo = 0;
      let n = 0;
      for (let k = 30; k <= 70; k += 10) {
        const y = Math.round((H * k) / 100);
        const x = Math.round((W * k) / 100);
        l += diff(d, y);
        r += diff(W - 1 - d, y);
        t += diff(x, d);
        bo += diff(x, H - 1 - d);
        n += 1;
      }
      out.push({ d, min: Math.min(l / n, r / n, t / n, bo / n), max: Math.max(l / n, r / n, t / n, bo / n) });
    }
    return out;
  }

  async function oneRound(label) {
    // 抓基准（光效关着）
    if (wm.glow.isVisible()) wm.glow.hide();
    await wait(900);
    const before = await grab(display);

    wm.showGlow();
    await wait(500);
    // 注入长时长并重播，保证截图时确实亮着
    await wm.glow.webContents.executeJavaScript(`(() => {
      document.documentElement.style.setProperty('--dur', '20000ms');
      const el = document.getElementById('glow');
      el.classList.remove('is-flashing');
      void el.offsetWidth;
      el.classList.add('is-flashing');
      return true;
    })()`);
    await wait(3200);

    const lit = await grab(display);
    const opacity = await wm.glow.webContents.executeJavaScript(
      `getComputedStyle(document.getElementById('glow')).opacity`,
    );

    const b1Local = before.toBitmap();
    const b2Local = lit.toBitmap();
    b1 = b1Local;
    b2 = b2Local;
    const p = profile();
    const at0 = p[0].min;
    const peak = Math.max(...p.map((q) => q.min));
    const ctrl = diff(Math.round(W / 2), Math.round(H / 2));

    console.log(`\n■ ${label}`);
    console.log(`  光效 opacity=${opacity}  bounds=${JSON.stringify(wm.glow.getBounds())}  屏幕中心对照差分=${ctrl}`);
    console.log(
      `  离边缘: ${p
        .filter((q) => q.d % 4 === 0)
        .map((q) => `${String(q.d).padStart(2)}px→${String(Math.round(q.min)).padStart(3)}`)
        .join('  ')}`,
    );
    console.log(
      `  最外圈(0px)最小差分 = ${Math.round(at0)}，往内峰值 = ${Math.round(peak)}  ` +
        `${at0 >= peak * 0.5 ? '✅ 最外圈就有光效' : '❌ 最外圈缺了一圈！'}`,
    );
    return at0 >= peak * 0.5;
  }

  const results = [];
  for (let i = 1; i <= 3; i += 1) {
    results.push(await oneRound(`第 ${i} 次显示光效`));
  }

  console.log('\n=========== 结论 ===========');
  results.forEach((ok, i) => console.log(`  第 ${i + 1} 次显示: ${ok ? '✅ 铺满最外圈' : '❌ 缺了最外圈'}`));
  console.log(
    results.every(Boolean)
      ? '  → 每次显示都铺满，重新显示不影响覆盖范围。'
      : '  → 重新显示之后光效缺了最外圈，这就是需求方截图里的现象。',
  );

  app.exit(results.every(Boolean) ? 0 : 1);
});
