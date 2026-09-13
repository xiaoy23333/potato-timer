'use strict';

/** 时间与时长格式化 */

function fmtTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 把「秒」说成中文，例如 300 → 「5 分钟」，90 → 「1 分 30 秒」 */
function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s} 秒`;
  if (s === 0) return `${m} 分钟`;
  return `${m} 分 ${s} 秒`;
}

/** 秒 → { minutes, seconds }，用于设置面板的「分 / 秒」两个输入框 */
function splitDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

window.fmtTime = fmtTime;
window.formatDuration = formatDuration;
window.splitDuration = splitDuration;
