'use strict';

/**
 * 配色审计：直接从 src/renderer/shared/theme.css 解析令牌，算 WCAG 对比度。
 *
 * 之所以要解析而不是抄一份常量：抄的那份迟早会和真源码脱节，
 * 那样这个脚本就会变成"看起来在守门、其实在骗人"的东西。
 *
 * 用法：node scripts/audit-colors.js
 */

const fs = require('node:fs');
const path = require('node:path');

const THEME = path.join(__dirname, '..', 'src', 'renderer', 'shared', 'theme.css');
const css = fs.readFileSync(THEME, 'utf8');

// —— 解析 :root 里的令牌 ——
const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
const TOKENS = {};
for (const m of rootBlock.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
  TOKENS[m[1]] = m[2].trim();
}

const hexOf = (name) => {
  const v = TOKENS[name];
  if (!v) throw new Error(`theme.css 里没有令牌 --${name}`);
  return v;
};

const toRgb = (value) => {
  const s = String(value).trim().replace('#', '');
  if (s.length === 6) {
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  throw new Error(`看不懂的颜色值: ${value}`);
};

/** 令牌名（或 rgba/hex 字面量）→ RGB */
const rgb = (nameOrValue) =>
  toRgb(nameOrValue in TOKENS || /^#|^rgb/.test(String(nameOrValue)) ? (TOKENS[nameOrValue] ?? nameOrValue) : `--${nameOrValue}`);

const alphaOf = (name) => {
  const m = /rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(hexOf(name));
  return m ? Number(m[1]) : 1;
};

/** 把 alpha 前景合成到背景上 */
const over = (fgRgb, a, bgRgb) => fgRgb.map((c, i) => c * a + bgRgb[i] * (1 - a));

const lum = (c) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a, b) => {
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/** 复算 color-mix(in srgb, A, B p%) 与 "transparent p%"、"white/black p%" */
function mix(aName, bSpec, bAmount) {
  const a = rgb(aName);
  const amount = bAmount / 100;
  let b;
  let bAlpha = 1;
  if (bSpec === 'transparent') {
    b = [0, 0, 0];
    bAlpha = 0;
  } else if (bSpec === 'white') {
    b = [255, 255, 255];
  } else if (bSpec === 'black') {
    b = [0, 0, 0];
  } else {
    b = rgb(bSpec);
  }
  // color-mix 在 srgb 下按 amount 线性插值；transparent 只影响 alpha
  if (bSpec === 'transparent') {
    return { rgb: a, alpha: 1 - amount };
  }
  void bAlpha;
  return { rgb: a.map((c, i) => c * (1 - amount) + b[i] * amount), alpha: 1 };
}

const rows = [];
function check(label, fg, bg, need, note) {
  const r = ratio(fg, bg);
  rows.push({ label, r, need, pass: r >= need, note: note || '' });
}

// —— 画布 ——
const BG = rgb('bg');
const CARD = rgb('card');
const BG_DEEP = rgb('bg-deep');

// —— 文字三级 ——
check('正文 ink / 画布', rgb('ink'), BG, 4.5);
check('正文 ink / 卡片', rgb('ink'), CARD, 4.5);
check('次要 ink-soft / 画布', rgb('ink-soft'), BG, 4.5);
check('次要 ink-soft / 卡片', rgb('ink-soft'), CARD, 4.5);
check('弱文字 ink-faint / 画布', rgb('ink-faint'), BG, 4.5, '注释、状态、提示');
check('弱文字 ink-faint / 卡片', rgb('ink-faint'), CARD, 4.5, '设置面板注释');

// —— 阶段徽章（浅底上的深字）——
const focusSoft = over(rgb('focus'), alphaOf('focus-soft'), BG);
const restSoft = over(rgb('rest'), alphaOf('rest-soft'), BG);
const restSoftOnCard = over(rgb('rest'), alphaOf('rest-soft'), CARD);
check('专注徽章 focus-deep / focus-soft⊕画布', rgb('focus-deep'), focusSoft, 4.5, '13px 粗体');
check('休息徽章 rest-deep / rest-soft⊕画布', rgb('rest-deep'), restSoft, 4.5, '13px 粗体');

// —— 主操作：白字压实心番茄红 ——
check('主按钮 on-color / focus', rgb('on-color'), rgb('focus'), 4.5, '15px 粗体');

// —— 提醒弹窗 ——
check('延后按钮 rest-deep / rest-soft⊕卡片', rgb('rest-deep'), restSoftOnCard, 4.5);
// 层级靠字号与字重拉开，颜色不洗淡 —— 洗淡会掉到 3.3:1
check('延后按钮快捷键（10px）', rgb('rest-deep'), restSoftOnCard, 4.5, '彩色面上的次要文字，从该色相推导');
check('滑块提示 ink-soft / 轨道', rgb('ink-soft'), BG_DEEP, 4.5);
check('弹窗标题 ink / 卡片', rgb('ink'), CARD, 4.5);

// —— 主窗口 ——
check('关闭按钮悬停 focus-deep / 画布', rgb('focus-deep'), BG, 4.5);
check('标题栏图标 ink-soft / 画布', rgb('ink-soft'), BG, 3.0, '图标，3:1');
check('焦点环 rest-deep / 画布', rgb('rest-deep'), BG, 3.0, '焦点指示器，3:1');
check('开关打开态 rest-strong / 画布', rgb('rest-strong'), BG, 3.0, '控件，3:1');

// —— 进度环：它是"理解还剩多少"的图形对象，弧线要过 3:1 ——
// （环里的大号数字也说了同一件事，但两条路都该走得通）
check('进度弧 focus / 画布', rgb('focus'), BG, 3.0, '专注中，3:1');
check('进度弧 rest-strong / 画布', rgb('rest-strong'), BG, 3.0, '休息 / 延后，3:1');
check(
  '进度弧 idle-ring / 画布',
  rgb('idle-ring'),
  BG,
  3.0,
  '已暂停，纯灰 —— 对「中性色从品牌青蓝推导」的点名例外',
);

// —— 主按钮的描边态（计时跑起来之后的那副面孔）——
check('主按钮描边态文字 focus-deep / 画布', rgb('focus-deep'), BG, 4.5, '15px 粗体');
check('主按钮描边 focus / 画布', rgb('focus'), BG, 3.0, '控件边界，3:1');

// —— 状态条右侧的轮次刻度 ——
check('轮次刻度（已完成）focus / 画布', rgb('focus'), BG, 3.0, '4px 小节，3:1');
check('轮次刻度（休息）rest-strong / 画布', rgb('rest-strong'), BG, 3.0, '4px 小节，3:1');
check('轮次刻度（延后中性）ink-faint / 画布', rgb('ink-faint'), BG, 3.0, '4px 小节，3:1');

const ghostOnBg = over(rgb('ink'), 0.055, BG);
check('延后态徽章 ink-soft / ghost⊕画布', rgb('ink-soft'), ghostOnBg, 4.5, '12.5px 粗体');

const ghostRow = over(rgb('ink'), 0.055, CARD);
check('次级按钮文字 ink-soft / ghost⊕卡片', rgb('ink-soft'), ghostRow, 4.5);

const inkOverlay = over(rgb('ink'), 0.92, BG);
check('浮层文字 on-color / ink-overlay⊕画布', rgb('on-color'), inkOverlay, 4.5);
check('警告浮层 on-color / focus', rgb('on-color'), rgb('focus'), 4.5);

check('开关关闭态轨道 / 卡片', rgb('switch-off'), CARD, 3.0, 'ON/OFF 另有滑块位置作为非颜色线索');

// —— 输出 ——
console.log(`令牌来源: src/renderer/shared/theme.css（共解析到 ${Object.keys(TOKENS).length} 个令牌）\n`);
console.log('检查项'.padEnd(42) + '对比度   要求   结果');
console.log('─'.repeat(84));
for (const row of rows) {
  console.log(
    `${row.label.padEnd(42)}${row.r.toFixed(2).padStart(6)}${String(row.need).padStart(6)}   ` +
      `${row.pass ? '✅ 通过' : '❌ 不通过'}${row.note ? '   ← ' + row.note : ''}`,
  );
}
const fails = rows.filter((r) => !r.pass);
console.log('─'.repeat(84));
console.log(`共 ${rows.length} 项，${fails.length} 项不达标。`);
if (fails.length) {
  console.log('\n不达标的：');
  for (const f of fails) console.log(`  · ${f.label}  ${f.r.toFixed(2)} < ${f.need}`);
  process.exitCode = 1;
}

// —— 顺带报一下被替换掉的关键值，方便和旧版对照 ——
console.log('\n关键令牌：');
for (const k of ['bg', 'card', 'ink', 'ink-soft', 'ink-faint', 'focus', 'focus-deep', 'rest', 'rest-deep']) {
  console.log(`  --${k.padEnd(12)} ${TOKENS[k]}`);
}
