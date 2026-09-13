'use strict';

/**
 * 检查配置迁移：读一份「旧版按分钟存」的配置，看 normalize 是否换算成秒。
 * 只读不写，不会改动你的配置文件。
 *
 * 运行：npx electron scripts/check-migration.js
 */

const { app } = require('electron');
const { Store, normalize } = require('../src/main/store');

app.whenReady().then(() => {
  // 注意：直接跑 `electron scripts/xxx.js` 时，Electron 认定的「应用目录」不是项目根目录，
  // 因此 userData 路径会和正式启动（`electron .`）不一样，可能读不到你的真实配置。
  // 这里把路径打出来，避免误判。
  console.log(`本次读取的配置路径: ${app.getPath('userData')}\\config.json`);
  console.log('（正式启动 `pnpm start` 时用的是 %APPDATA%\\pomodoro-timer\\config.json）\n');

  // 1) 真实配置文件（只读）
  const store = new Store();
  const live = store.get();
  console.log('=== 这份配置经过 normalize 之后 ===');
  console.log(
    JSON.stringify(
      {
        focusSeconds: live.focusSeconds,
        shortBreakSeconds: live.shortBreakSeconds,
        longBreakSeconds: live.longBreakSeconds,
        snoozeSeconds: live.snoozeSeconds,
        longBreakEvery: live.longBreakEvery,
        soundVolume: live.soundVolume,
        glow: live.glow,
      },
      null,
      2,
    ),
  );

  // 2) 直接用旧格式样本过一遍，覆盖各种边界
  const cases = [
    { name: '全旧字段（分钟）', input: { focusMinutes: 40, shortBreakMinutes: 5, longBreakMinutes: 10, snoozeMinutes: 5 } },
    { name: '旧字段里有 0 休息', input: { focusMinutes: 1, shortBreakMinutes: 0, longBreakMinutes: 0, snoozeMinutes: 1 } },
    { name: '新字段（秒）', input: { focusSeconds: 90, shortBreakSeconds: 0, longBreakSeconds: 0, snoozeSeconds: 30 } },
    { name: '空配置', input: {} },
    { name: '新旧混杂（新字段优先）', input: { focusMinutes: 40, focusSeconds: 90 } },
  ];

  console.log('\n=== 迁移用例 ===');
  let bad = 0;
  const expect = [
    [2400, 300, 600, 300],
    [60, 0, 0, 60],
    [90, 0, 0, 30],
    [2400, 300, 600, 300],
    [90, 300, 600, 300],
  ];
  cases.forEach((c, i) => {
    const out = normalize(c.input);
    const got = [out.focusSeconds, out.shortBreakSeconds, out.longBreakSeconds, out.snoozeSeconds];
    const ok = got.every((v, k) => v === expect[i][k]);
    if (!ok) bad += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}: ${got.join(' / ')} 秒（期望 ${expect[i].join(' / ')}）`);
  });

  console.log(`\n${cases.length - bad} / ${cases.length} 用例通过`);
  app.exit(bad ? 1 : 0);
});
