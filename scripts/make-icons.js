'use strict';

/**
 * 一次性脚本：生成
 *   assets/icon.png   256  主窗口图标
 *   assets/tray.png    32  托盘图标
 *   build/icon.png    512  打包用（electron-builder 会由它生成多尺寸 .ico）
 *
 * 纯 Node 手写 PNG，不引入任何图形库；用 4x 超采样做抗锯齿。
 * 运行：node scripts/make-icons.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ————————————————————— PNG 编码 —————————————————————

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ————————————————————— 画一个番茄 —————————————————————

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function dist(x, y, cx, cy) {
  return Math.hypot(x - cx, y - cy);
}

/** 点是否在三角形内 */
function inTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** 归一化坐标 (0..1) 上的场景，返回 [r, g, b, a]（a 为 0..1） */
function scene(u, v) {
  let out = [0, 0, 0, 0];

  // 果蒂
  if (u > 0.472 && u < 0.528 && v > 0.10 && v < 0.30) {
    out = [0x2f, 0x7d, 0x32, 1];
  }

  // 番茄本体（垂直渐变）
  const bodyR = 0.375;
  const bodyCx = 0.5;
  const bodyCy = 0.585;
  if (dist(u, v, bodyCx, bodyCy) <= bodyR) {
    const t = clamp01((v - (bodyCy - bodyR)) / (bodyR * 2));
    const rgb = mix([0xff, 0x8b, 0x77], [0xd6, 0x3f, 0x2b], Math.pow(t, 0.85));
    out = [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]), 1];
  }

  // 左上高光
  const hx = (u - 0.385) / 0.115;
  const hy = (v - 0.44) / 0.075;
  if (hx * hx + hy * hy <= 1) {
    const base = out[3] > 0 ? out : [0xff, 0x8b, 0x77, 1];
    out = [...mix([base[0], base[1], base[2]], [0xff, 0xff, 0xff], 0.42).map(Math.round), base[3]];
  }

  // 五片绿叶（花萼）
  const leafCx = 0.5;
  const leafCy = 0.245;
  for (let i = 0; i < 5; i += 1) {
    const angle = Math.PI + (i * Math.PI) / 4; // 180° ~ 360°
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const tipR = 0.235;
    const baseR = 0.045;
    const halfW = 0.055;
    const tip = [leafCx + dx * tipR, leafCy + dy * tipR];
    const b1 = [leafCx + dx * baseR - dy * halfW, leafCy + dy * baseR + dx * halfW];
    const b2 = [leafCx + dx * baseR + dy * halfW, leafCy + dy * baseR - dx * halfW];
    if (inTriangle(u, v, b1, b2, tip)) {
      out = i % 2 === 0 ? [0x43, 0xa0, 0x47, 1] : [0x38, 0x8e, 0x3c, 1];
    }
  }

  // 花萼中心
  if (dist(u, v, leafCx, leafCy) <= 0.055) out = [0x2f, 0x7d, 0x32, 1];

  return out;
}

function renderIcon(size, supersample = 4) {
  const S = size * supersample;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let aSum = 0;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const u = (x * supersample + sx + 0.5) / S;
          const v = (y * supersample + sy + 0.5) / S;
          const [r, g, b, a] = scene(u, v);
          aSum += a;
          rSum += r * a;
          gSum += g * a;
          bSum += b * a;
        }
      }
      const n = supersample * supersample;
      const alpha = aSum / n;
      const idx = (y * size + x) * 4;
      if (aSum > 0) {
        out[idx] = Math.round(rSum / aSum);
        out[idx + 1] = Math.round(gSum / aSum);
        out[idx + 2] = Math.round(bSum / aSum);
      }
      out[idx + 3] = Math.round(clamp01(alpha) * 255);
    }
  }
  return encodePNG(size, size, out);
}

const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

const icon = renderIcon(256, 4);
fs.writeFileSync(path.join(assetsDir, 'icon.png'), icon);

const tray = renderIcon(32, 6);
fs.writeFileSync(path.join(assetsDir, 'tray.png'), tray);

// 打包用的母版：electron-builder 会由这一张生成 16/24/32/48/64/128/256 的 .ico。
// 512 而不是 256，是为了 256 那一档也有余量，缩下来边缘更干净。
const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
const pack = renderIcon(512, 4);
fs.writeFileSync(path.join(buildDir, 'icon.png'), pack);

console.log(`assets/icon.png    ${icon.length} bytes  (256x256)`);
console.log(`assets/tray.png    ${tray.length} bytes  (32x32)`);
console.log(`build/icon.png     ${pack.length} bytes  (512x512)`);
