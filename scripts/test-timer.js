'use strict';

/**
 * timer.js 的单元测试：纯 Node 跑，不需要 Electron。
 * 运行：node scripts/test-timer.js
 *
 * 手法：把 endAt / snoozeEndAt 拨到过去，再调 tick()，就能瞬间「快进」到阶段结束。
 */

const assert = require('node:assert/strict');
const { PomodoroTimer, STATUS, PHASE } = require('../src/main/timer');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}

function makeTimer(overrides = {}) {
  const config = {
    focusSeconds: 2400,
    shortBreakSeconds: 300,
    longBreakSeconds: 600,
    longBreakEvery: 4,
    snoozeSeconds: 300,
    ...overrides,
  };
  const store = { get: () => config, set: () => config };
  const timer = new PomodoroTimer(store);
  timer._ensureTicking = () => {}; // 测试里不真的起定时器
  return { timer, config };
}

/** 快进到当前阶段结束 */
function finishNow(timer) {
  timer.endAt = Date.now() - 1;
  timer.tick();
}

function finishSnooze(timer) {
  timer.snoozeEndAt = Date.now() - 1;
  timer.tick();
}

// ————————————————————————————————————————————————

test('初始状态：待开始，专注 40 分钟', () => {
  const { timer } = makeTimer();
  assert.equal(timer.status, STATUS.IDLE);
  assert.equal(timer.phase, PHASE.FOCUS);
  assert.equal(timer.totalMs, 40 * 60 * 1000);
  assert.equal(timer.remainingMs, 40 * 60 * 1000);
});

test('开始 → 暂停 → 继续，暂停期间剩余时间不再减少', () => {
  const { timer } = makeTimer();
  timer.start();
  assert.equal(timer.status, STATUS.RUNNING);

  timer.remainingMs = 1000 * 60;
  timer.endAt = Date.now() + 1000 * 60;
  timer.pause();
  assert.equal(timer.status, STATUS.PAUSED);

  const frozen = timer.remainingMs;
  timer.tick();
  timer.tick();
  assert.equal(timer.remainingMs, frozen, '暂停时剩余时间不应该变化');

  timer.start(); // 继续
  assert.equal(timer.status, STATUS.RUNNING);
  assert.ok(timer.endAt > Date.now(), '继续后应重新设定结束时刻');
});

test('专注归零 → 待处理状态，完成轮数 +1', () => {
  const { timer } = makeTimer();
  timer.start();
  finishNow(timer);
  assert.equal(timer.status, STATUS.FINISHED);
  assert.equal(timer.completedFocus, 1);
  assert.equal(timer.remainingMs, 0);
});

test('待处理时不会被 tick 自动推进', () => {
  const { timer } = makeTimer();
  timer.start();
  finishNow(timer);
  timer.tick();
  timer.tick();
  assert.equal(timer.status, STATUS.FINISHED);
  assert.equal(timer.phase, PHASE.FOCUS);
});

test('滑块路径：待处理 → 短休', () => {
  const { timer } = makeTimer();
  timer.start();
  finishNow(timer);
  timer.nextCycle();
  assert.equal(timer.phase, PHASE.SHORT);
  assert.equal(timer.status, STATUS.RUNNING);
  assert.equal(timer.totalMs, 5 * 60 * 1000);
});

test('休息结束 → 自动开始下一轮专注', () => {
  const { timer } = makeTimer();
  timer.start();
  finishNow(timer);
  timer.nextCycle(); // 进短休
  finishNow(timer); // 短休结束
  assert.equal(timer.phase, PHASE.FOCUS);
  assert.equal(timer.status, STATUS.RUNNING);
  assert.equal(timer.completedFocus, 1, '休息不增加完成轮数');
});

test('第 4 轮专注后进长休', () => {
  const { timer } = makeTimer();
  for (let i = 1; i <= 3; i += 1) {
    timer.start();
    finishNow(timer); // 专注结束
    timer.nextCycle(); // 进短休
    finishNow(timer); // 短休结束 → 下一轮专注
  }
  assert.equal(timer.completedFocus, 3);

  finishNow(timer); // 第 4 轮专注结束
  assert.equal(timer.completedFocus, 4);
  timer.nextCycle();
  assert.equal(timer.phase, PHASE.LONG, '第 4 轮之后应该是长休');
  assert.equal(timer.totalMs, 10 * 60 * 1000);
});

test('短休设为 0 → 滑块拖到底直接开始下一轮专注', () => {
  const { timer } = makeTimer({ shortBreakSeconds: 0 });
  timer.start();
  finishNow(timer);
  timer.nextCycle();
  assert.equal(timer.phase, PHASE.FOCUS, '休息为 0 时应跳过休息');
  assert.equal(timer.status, STATUS.RUNNING);
});

test('长短休都设为 0 时，一轮接一轮全是专注', () => {
  const { timer } = makeTimer({ shortBreakSeconds: 0, longBreakSeconds: 0 });
  for (let i = 0; i < 4; i += 1) {
    timer.start();
    finishNow(timer);
    timer.nextCycle();
  }
  assert.equal(timer.completedFocus, 4);
  assert.equal(timer.phase, PHASE.FOCUS, '休息全为 0 时应该一直在专注段之间循环');
  assert.equal(timer.status, STATUS.RUNNING);
});

test('延后：只有待处理时生效，可无限次', () => {
  const { timer } = makeTimer();
  assert.equal(timer.snooze(), false, '计时进行中不该能延后');

  timer.start();
  finishNow(timer);
  assert.equal(timer.snooze(), true);
  assert.equal(timer.status, STATUS.SNOOZED);
  assert.equal(timer.remainingMs, 5 * 60 * 1000);

  finishSnooze(timer);
  assert.equal(timer.status, STATUS.FINISHED, '延后到点后回到待处理');

  for (let i = 0; i < 5; i += 1) {
    assert.equal(timer.snooze(), true, `第 ${i + 1} 次延后应该仍然允许`);
    finishSnooze(timer);
  }
  assert.equal(timer.status, STATUS.FINISHED);
});

test('延后期间 tick 不会推进番茄钟，只是倒数', () => {
  const { timer } = makeTimer();
  timer.start();
  finishNow(timer);
  timer.snooze();
  timer.snoozeEndAt = Date.now() + 3000;
  timer.tick();
  assert.equal(timer.status, STATUS.SNOOZED);
  assert.ok(timer.remainingMs > 2500 && timer.remainingMs <= 3000, `剩余约 3 秒，实际 ${timer.remainingMs}`);
});

test('延后到点会发 remind 事件（弹窗要重新弹出并响铃）', () => {
  const { timer } = makeTimer();
  let remindCount = 0;
  timer.on('remind', () => {
    remindCount += 1;
  });
  timer.start();
  finishNow(timer);
  timer.snooze();
  finishSnooze(timer);
  assert.equal(remindCount, 1);

  timer.snooze();
  finishSnooze(timer);
  assert.equal(remindCount, 2, '每次都该重新提醒');
});

test('跳过专注不计入完成轮数，直接进入休息', () => {
  const { timer } = makeTimer();
  timer.start();
  timer.skip();
  assert.equal(timer.completedFocus, 0);
  assert.equal(timer.phase, PHASE.SHORT);
  assert.equal(timer.status, STATUS.RUNNING);
});

test('跳过休息直接回到专注', () => {
  const { timer } = makeTimer();
  timer.start();
  timer.beginPhase(PHASE.SHORT);
  timer.skip();
  assert.equal(timer.phase, PHASE.FOCUS);
  assert.equal(timer.status, STATUS.RUNNING);
});

test('重置：回到待开始并清空完成轮数', () => {
  const { timer } = makeTimer();
  timer.start();
  finishNow(timer);
  timer.nextCycle();
  timer.reset();
  assert.equal(timer.status, STATUS.IDLE);
  assert.equal(timer.phase, PHASE.FOCUS);
  assert.equal(timer.completedFocus, 0);
  assert.equal(timer.remainingMs, 40 * 60 * 1000);
});

test('改设置立即生效：跑了 10 分钟时把专注 40 → 50，剩余变 40 分钟', () => {
  const { timer, config } = makeTimer();
  timer.start();
  timer.remainingMs = 30 * 60 * 1000; // 已跑 10 分钟
  timer.endAt = Date.now() + 30 * 60 * 1000;

  config.focusSeconds = 3000;
  timer.onConfigChanged(config);

  assert.equal(timer.totalMs, 50 * 60 * 1000);
  assert.equal(timer.remainingMs, 40 * 60 * 1000);
});

test('改设置立即生效：新时长比已用时间还短 → 剩余归零，下一 tick 结束本轮', () => {
  const { timer, config } = makeTimer();
  timer.start();
  timer.remainingMs = 5 * 60 * 1000; // 已跑 35 分钟
  timer.endAt = Date.now() + 5 * 60 * 1000;

  config.focusSeconds = 600;
  timer.onConfigChanged(config);

  assert.equal(timer.remainingMs, 0);
  timer.tick();
  assert.equal(timer.status, STATUS.FINISHED);
});

test('待开始时改时长，直接反映到倒计时上', () => {
  const { timer, config } = makeTimer();
  config.focusSeconds = 1500;
  timer.onConfigChanged(config);
  assert.equal(timer.remainingMs, 25 * 60 * 1000);
});

test('休眠暂停 / 唤醒继续', () => {
  const { timer } = makeTimer();
  timer.start();
  timer.remainingMs = 12 * 60 * 1000;
  timer.endAt = Date.now() + 12 * 60 * 1000;

  timer.onSystemSuspend();
  assert.equal(timer.status, STATUS.PAUSED);
  const frozen = timer.remainingMs;

  timer.onSystemResume();
  assert.equal(timer.status, STATUS.RUNNING);
  assert.equal(timer.remainingMs, frozen, '休眠这段真实时间不该被扣掉');
});

test('手动暂停后休眠唤醒不会把计时偷偷打开', () => {
  const { timer } = makeTimer();
  timer.start();
  timer.pause();
  timer.onSystemResume();
  assert.equal(timer.status, STATUS.PAUSED);
});

test('长休间隔可配置：每 2 轮', () => {
  const { timer } = makeTimer({ longBreakEvery: 2 });
  timer.start();
  finishNow(timer);
  timer.nextCycle();
  finishNow(timer);
  finishNow(timer); // 第 2 轮专注结束
  assert.equal(timer.completedFocus, 2);
  timer.nextCycle();
  assert.equal(timer.phase, PHASE.LONG);
});

test('跳过第 4 轮专注不会给长休（跳过的轮次不计入循环）', () => {
  const { timer } = makeTimer();
  for (let i = 0; i < 3; i += 1) {
    timer.start();
    finishNow(timer);
    timer.nextCycle();
    finishNow(timer);
  }
  assert.equal(timer.completedFocus, 3);

  timer.skip(); // 第 4 轮刚开始就跳过
  assert.equal(timer.completedFocus, 3, '跳过不该算完成');
  assert.equal(timer.phase, PHASE.SHORT);
});

test('界面预告：完成 3 轮时显示「下一段是长休」', () => {
  const { timer } = makeTimer();
  for (let i = 0; i < 3; i += 1) {
    timer.start();
    finishNow(timer);
    timer.nextCycle();
    finishNow(timer);
  }
  assert.equal(timer.completedFocus, 3);
  assert.equal(timer.snapshot().nextPhaseLabel, '长休');

  // 第 4 轮结束、进入长休后，预告应该变回短休
  finishNow(timer);
  timer.nextCycle();
  assert.equal(timer.phase, PHASE.LONG);
  assert.equal(timer.snapshot().nextPhaseLabel, '短休');
});

test('待开始时点「跳过」不会凭空开始计时', () => {
  const { timer } = makeTimer();
  assert.equal(timer.status, STATUS.IDLE);
  timer.skip();
  assert.equal(timer.status, STATUS.IDLE, '待开始状态下跳过应该是空操作');
  assert.equal(timer.phase, PHASE.FOCUS);
});

test('待开始时调 nextCycle 也不会自己跑起来', () => {
  const { timer } = makeTimer();
  timer.nextCycle();
  assert.equal(timer.status, STATUS.IDLE, '还没开始就不该凭空开出一段休息');
  assert.equal(timer.phase, PHASE.FOCUS);
});

test('暂停中把时长改到比已跑时间还短 → 本轮立刻结束，不会卡在「已暂停 00:00」', () => {
  const { timer, config } = makeTimer();
  timer.start();
  timer.remainingMs = 5 * 60 * 1000; // 已跑 35 分钟
  timer.endAt = Date.now() + 5 * 60 * 1000;
  timer.pause();
  assert.equal(timer.status, STATUS.PAUSED);

  config.focusSeconds = 600;
  timer.onConfigChanged(config);

  assert.equal(timer.status, STATUS.FINISHED, '不该停在 paused + 0 秒的悬空状态');
  assert.equal(timer.completedFocus, 1);
});

test('改时长的重算规则：剩余 = 新总时长 − 已跑时间（休息段同理）', () => {
  const { timer, config } = makeTimer();
  timer.start();
  finishNow(timer);
  timer.nextCycle(); // 进 5 分钟短休
  assert.equal(timer.phase, PHASE.SHORT);

  timer.remainingMs = 1 * 60 * 1000; // 短休已跑 4 分钟
  timer.endAt = Date.now() + 1 * 60 * 1000;

  config.shortBreakSeconds = 1200;
  timer.onConfigChanged(config);
  assert.equal(timer.remainingMs, 16 * 60 * 1000, '5 → 20 且已跑 4 分钟，剩余应为 16 分钟');

  config.shortBreakSeconds = 60;
  timer.onConfigChanged(config);
  assert.equal(timer.status, STATUS.RUNNING, '新时长比已跑时间短 → 本轮立刻结束，不停在 0 秒');
  assert.equal(timer.phase, PHASE.FOCUS, '短休结束后按规则自动进入下一轮专注');
});

test('dispose 会停掉心跳', () => {
  const timer = new PomodoroTimer({ get: () => ({ focusSeconds: 2400, shortBreakSeconds: 300, longBreakSeconds: 600, longBreakEvery: 4, snoozeSeconds: 300 }), set: () => {} });
  timer._ensureTicking();
  assert.ok(timer._interval, '应先有定时器');
  timer.dispose();
  assert.equal(timer._interval, null);
});

test('时长精确到秒：90 秒的专注就是 90000 毫秒', () => {
  const { timer } = makeTimer({ focusSeconds: 90 });
  timer.reset();
  assert.equal(timer.totalMs, 90000, '应该按秒精确计算，而不是四舍五入到分钟');
  timer.start();
  finishNow(timer);
  assert.equal(timer.status, STATUS.FINISHED);
});

test('秒级精度下，休息 0 秒同样表示跳过休息', () => {
  const { timer } = makeTimer({ shortBreakSeconds: 0 });
  timer.start();
  finishNow(timer); // 专注结束
  timer.nextCycle();
  assert.equal(timer.phase, PHASE.FOCUS, '0 秒休息应直接进入下一轮专注');
  assert.equal(timer.status, STATUS.RUNNING);
});

test('秒级精度下，延后 90 秒就是 90000 毫秒', () => {
  const { timer } = makeTimer({ snoozeSeconds: 90 });
  timer.start();
  finishNow(timer);
  timer.snooze();
  const remaining = timer.snoozeEndAt - Date.now();
  assert.ok(remaining > 88000 && remaining <= 90000, `延后剩余应约 90 秒，实际 ${remaining}ms`);
});

test('snapshot 供 UI 使用的字段齐全', () => {
  const { timer } = makeTimer();
  const snap = timer.snapshot();
  for (const key of [
    'phase',
    'phaseLabel',
    'status',
    'remainingMs',
    'totalMs',
    'completedFocus',
    'longBreakEvery',
    'cycleDone',
    'isSnoozing',
    'snoozeSeconds',
    'snoozeRemainingMs',
    'nextPhaseLabel',
    'focusSeconds',
  ]) {
    assert.ok(key in snap, `snapshot 缺少字段 ${key}`);
  }
  assert.equal(snap.phaseLabel, '专注');
  assert.equal(snap.nextPhaseLabel, '短休');
});

// ————————————————————————————————————————————————

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
