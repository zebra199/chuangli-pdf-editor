// 交叉验证：抽取 _dev/index.html 中真实的 enhanceCanvas，在 Node 中运行，
// 与 Python 参考实现（final_ref.py）的输出逐像素比对。
//
// 用法：先跑 `python _dev/verify/final_ref.py` 生成基准，再跑本脚本。
// 判定：两个档位的最大通道差 ≤ 2 视为通过。
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const DEV = path.join(HERE, '..');
const TMP = path.join(HERE, '.tmp');
const html = fs.readFileSync(path.join(DEV, 'index.html'), 'utf8');

const m = html.match(/function enhanceCanvas\(cv, level\) \{[\s\S]*?\n\}/);
if (!m) { console.error('未找到 enhanceCanvas'); process.exit(1); }
const enhanceCanvas = new Function('return (' + m[0] + ')')();
console.log('已抽取 enhanceCanvas，长度 =', m[0].length);

const meta = JSON.parse(fs.readFileSync(path.join(TMP, 'in.json'), 'utf8'));
const { W, H } = meta;
const srcBuf = fs.readFileSync(path.join(TMP, 'in.rgba'));

let fail = 0;
for (const level of ['light', 'standard']) {
  const data = new Uint8ClampedArray(srcBuf);
  const imgData = { width: W, height: H, data };
  const cv = {
    width: W, height: H,
    getContext: () => ({ getImageData: () => imgData, putImageData: (d) => { imgData.data.set(d.data); } })
  };
  const t0 = Date.now();
  enhanceCanvas(cv, level);
  const ms = Date.now() - t0;

  const ref = fs.readFileSync(path.join(TMP, `ref_${level}.rgba`));
  let maxDiff = 0, nDiff = 0, sumDiff = 0;
  for (let i = 0; i < ref.length; i++) {
    if (i % 4 === 3) continue;                       // 跳过 alpha
    const dv = Math.abs(data[i] - ref[i]);
    if (dv) { nDiff++; sumDiff += dv; if (dv > maxDiff) maxDiff = dv; }
  }
  const total = ref.length * 3 / 4;
  const pct = nDiff / total * 100;
  const ok = maxDiff <= 2;
  if (!ok) fail++;
  console.log(`  [${level.padEnd(8)}] 耗时=${String(ms).padStart(5)}ms  ` +
    `最大差=${maxDiff}  差异像素=${nDiff} (${pct.toFixed(3)}%)  ` + (ok ? '✅ 一致' : '❌ 不一致'));
}

// 功能回归：确认深色文字未被洗白
const data = new Uint8ClampedArray(srcBuf);
const imgData = { width: W, height: H, data };
const cv = {
  width: W, height: H,
  getContext: () => ({ getImageData: () => imgData, putImageData: (d) => { imgData.data.set(d.data); } })
};
enhanceCanvas(cv, 'standard');
function lum(p) { return (data[p * 4] * 54 + data[p * 4 + 1] * 183 + data[p * 4 + 2] * 19) >> 8; }
let dark = 0, white = 0;
const n = W * H;
for (let p = 0; p < n; p++) { const g = lum(p); if (g < 100) dark++; if (g >= 250) white++; }
console.log(`\n功能回归(standard)：深色占比=${(dark / n * 100).toFixed(2)}% (原图≈3.3 / 理想≈5.2)  ` +
  `纯白占比=${(white / n * 100).toFixed(2)}% (理想≈75.4)`);

console.log(fail === 0 ? '\n✅ 全部通过：应用内实现与参考实现一致' : `\n❌ ${fail} 个档位不一致`);
process.exit(fail ? 1 : 0);
