// 单文件构建：内联 pdf-lib + pdf.js + worker(base64) + heic2any → ../创立PDF编辑器.html
// 用法：node _dev/build_single.cjs
//
// 目录约定：
//   _dev/index.html + _dev/lib/   开发源码（引用外部库，便于调试）
//   创立PDF编辑器.html             唯一交付物（拷到任意电脑双击即用）
const fs = require('fs');
const path = require('path');

const DEV = __dirname;                        // _dev
const SRC = path.join(DEV, '..');             // PDF编辑器 项目根
const indexHtml = fs.readFileSync(path.join(DEV, 'index.html'), 'utf8');

function read(p) { return fs.readFileSync(path.join(DEV, 'lib', p), 'utf8'); }
function b64(p) { return fs.readFileSync(path.join(DEV, 'lib', p)).toString('base64'); }

let out = indexHtml;
const inlined = [];
const missing = [];

function inline(placeholder, file, label) {
  if (!out.includes(placeholder)) { missing.push(label); return; }
  const code = read(file);
  out = out.replace(placeholder, () => { inlined.push(label); return '<script>' + code + '</script>'; });
}

// 1-3. 内联三个外部库（用函数式 replace，避免库代码里的 $ 被当作替换模式）
inline('<script src="lib/pdf-lib.min.js"></script>', 'pdf-lib.min.js', 'pdf-lib.min.js');
inline('<script src="lib/pdf.min.js"></script>', 'pdf.min.js', 'pdf.min.js');
inline('<script src="lib/heic2any.min.js"></script>', 'heic2any.min.js', 'heic2any.min.js');

// 4. 内联 pdf.js worker（base64）：在主脚本前注入独立 <script> 设置 window.__PDFJS_WORKER_B64__
//    （不改主脚本里的读取处，避免把读变成赋值导致语法错误）
const workerB64 = b64('pdf.worker.min.js');
const workerInjection = '<script>window.__PDFJS_WORKER_B64__ = "' + workerB64 + '";<\/script>';
out = out.replace(/<script>\s*'use strict';/, () => {
  inlined.push('pdf.worker.min.js (base64)');
  return workerInjection + "<script>\n'use strict';";
});

// 校验：不应再有残留的 lib/ 相对引用
const leftover = (out.match(/src="lib\//g) || []).length;
if (missing.length) console.error('错误：未找到内联占位符 → ' + missing.join(', '));
if (leftover) console.error('错误：仍有 ' + leftover + ' 处 lib/ 引用未内联');

const OUT = path.join(SRC, '创立PDF编辑器.html');
fs.writeFileSync(OUT, out);
console.log('✅ 单文件构建完成');
console.log('   内联:');
inlined.forEach(x => console.log('     - ' + x));
console.log('   源 _dev/index.html: ' + indexHtml.length + ' B');
console.log('   输出 ' + path.basename(OUT) + ': ' + out.length + ' B ('
  + (out.length / 1024 / 1024).toFixed(2) + ' MB)');
if (missing.length || leftover) process.exit(1);
