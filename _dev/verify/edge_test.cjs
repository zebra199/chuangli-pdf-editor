// 边界与回归测试：直接对 enhanceCanvas 注入各种极端输入，确保不崩溃、不出错
// 用法：node _dev/verify/edge_test.cjs
const fs = require('fs');
const path = require('path');
const DEV = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(DEV, 'index.html'), 'utf8');
const fnSrc = html.match(/function enhanceCanvas\(cv, level\) \{[\s\S]*?\n\}/)[0];
const enhanceCanvas = new Function('return (' + fnSrc + ')')();

function mk(W, H, fn) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    const [r, g, b] = fn(x, y);
    data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
  }
  return { width: W, height: H, data };
}

function runImg(imgData, level) {
  let put = false;
  const cv = {
    width: imgData.width, height: imgData.height,
    getContext: () => ({ getImageData: () => imgData, putImageData: () => { put = true; } })
  };
  enhanceCanvas(cv, level);
  return put;
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}

console.log('=== 边界测试 ===');

// 1. 全白图
try {
  const img = mk(200, 200, () => [255, 255, 255]);
  const ok = runImg(img, 'standard');
  let allWhite = true;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] !== 255) { allWhite = false; break; }
  check('全白图不崩溃且保持纯白', ok && allWhite);
} catch (e) { check('全白图不崩溃', false, e.message); }

// 2. 全黑图（极端：背景估计会很低）
try {
  const img = mk(200, 200, () => [0, 0, 0]);
  const ok = runImg(img, 'standard');
  check('全黑图不崩溃', ok);
} catch (e) { check('全黑图不崩溃', false, e.message); }

// 3. 极小尺寸 1x1
try {
  const img = mk(1, 1, () => [128, 128, 128]);
  const ok = runImg(img, 'standard');
  check('1x1 不崩溃', ok);
} catch (e) { check('1x1 不崩溃', false, e.message); }

// 4. 小于 BLOCK 的尺寸
try {
  const img = mk(10, 8, (x, y) => [200 + (x % 20), 190, 180]);
  const ok = runImg(img, 'standard');
  check('10x8 (小于块尺寸) 不崩溃', ok);
} catch (e) { check('10x8 不崩溃', false, e.message); }

// 5. 非整除尺寸（避免越界）
try {
  const img = mk(101, 77, (x, y) => [180 + (x % 30), 170, 160]);
  const ok = runImg(img, 'standard');
  check('101x77 (非整除) 不崩溃', ok);
} catch (e) { check('101x77 不崩溃', false, e.message); }

// 6. 纯彩色（饱和度满）—— 确认色度增强不溢出
try {
  const img = mk(300, 300, () => [255, 0, 0]);
  const ok = runImg(img, 'standard');
  let inRange = true;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] < 0 || img.data[i] > 255 || img.data[i + 1] < 0 || img.data[i + 1] > 255) { inRange = false; break; }
  }
  check('纯红图 通道值在 0-255 内', ok && inRange);
} catch (e) { check('纯红图不崩溃', false, e.message); }

// 7. 大块深色（鲁棒性核心：不应被洗白）
try {
  const img = mk(600, 600, (x, y) => (x >= 150 && x < 450 && y >= 200 && y < 400) ? [30, 30, 30] : [185, 178, 168]);
  runImg(img, 'standard');
  const px = (x, y) => img.data[(y * 600 + x) * 4];
  const center = px(300, 300), paper = px(40, 40);
  check('大块深色被保留（未被洗白）', center < 80, `深色块=${center} 纸面=${paper}`);
  check('纸面被净化接近纯白', paper > 240, `纸面=${paper}`);
} catch (e) { check('大块深色测试', false, e.message); }

// 8. 细密文字（高频细节，确认不过曝丢失）
try {
  const img = mk(400, 400, (x, y) => (((x >> 2) + (y >> 2)) % 2 === 0) ? [20, 20, 20] : [210, 205, 195]);
  runImg(img, 'standard');
  let dark = 0, n = 400 * 400;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 100) dark++;
  check('棋盘格细纹保留深色像素', dark / n > 0.2, `深色占比=${(dark / n * 100).toFixed(1)}%`);
} catch (e) { check('棋盘格测试', false, e.message); }

// 9. 两个档位均正常工作
try {
  for (const lvl of ['light', 'standard']) {
    const img = mk(300, 300, (x, y) => [170 + (x % 40), 165, 155]);
    const ok = runImg(img, lvl);
    check(`档位 ${lvl} 正常执行`, ok);
  }
} catch (e) { check('档位执行', false, e.message); }

// 10. 未知档位（防御性）
try {
  const img = mk(100, 100, () => [180, 175, 165]);
  const ok = runImg(img, 'bogus');
  check('未知档位按 standard 参数执行且不崩溃', ok);
} catch (e) { check('未知档位不崩溃', false, e.message); }

// 11. 灰度渐变（确认输出单调，不产生反相伪影）
try {
  const img = mk(256, 50, (x) => [x, x, x]);
  runImg(img, 'standard');
  let mono = true;
  for (let y = 0; y < 50; y++) {
    for (let x = 1; x < 256; x++) {
      const a = img.data[(y * 256 + x - 1) * 4], b = img.data[(y * 256 + x) * 4];
      if (b < a - 2) { mono = false; break; }
    }
  }
  check('灰度渐变输出单调不减', mono);
} catch (e) { check('灰度渐变', false, e.message); }

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
