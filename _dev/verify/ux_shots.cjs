// 视觉确认：截图骨架屏与拖拽插入指示条
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEV = path.join(__dirname, '..');
const PAGE = path.join(DEV, 'index.html');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

function openWs(url) {
  return new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(ws); ws.onerror = rej; });
}
function makePNG(W, H, fn) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const [r, g, b] = fn(x, y);
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  function crc32(buf) {
    let c; const t = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const ty = Buffer.from(type, 'ascii');
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([ty, data])));
    return Buffer.concat([len, ty, data, cr]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

const scan = (x, y) => {                       // 模拟泛黄扫描件
  const base = 186 + Math.round(18 * Math.sin(x / 90) + 10 * Math.cos(y / 140));
  return [Math.min(255, base + 14), Math.min(255, base + 2), Math.max(0, base - 16)];
};

(async () => {
  const newTab = await new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: 9333, path: '/json/new?about:blank', method: 'PUT' },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.end();
  });
  const ws = await openWs(newTab.webSocketDebuggerUrl);
  let id = 0; const pending = {};
  const send = (m, p = {}) => new Promise(r => { const mid = ++id; pending[mid] = r; ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; }
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: 'file:///' + PAGE.replace(/\\/g, '/') });
  await new Promise(r => setTimeout(r, 3000));

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('  saved', name);
  };

  // ---- 截图1：导入中的骨架屏（3 张图，人为放慢以稳定捕捉） ----
  console.log('=== 截图1：导入骨架屏 ===');
  const bigPng = makePNG(1200, 1600, scan).toString('base64');
  await ev(`(async () => {
    const realToBitmap = window.toBitmap;
    window.toBitmap = async (blob) => { await new Promise(r => setTimeout(r, 2500)); return realToBitmap(blob); };
    const mk = (name) => {
      const bin = atob("${bigPng}");
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new File([arr], name, { type: 'image/png' });
    };
    const dt = new DataTransfer();
    ['合同扫描件_第1页.png','合同扫描件_第2页.png','合同扫描件_第3页.png'].forEach(n => dt.items.add(mk(n)));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
  })()`);
  await shot('01-skeleton-importing.png');

  // 等导入完成后再截一张（真实缩略图）
  await ev(`(async () => {
    for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 200)); if (!state.importing) break; }
    window.toBitmap = window.toBitmap;   // 恢复
    return state.pages.length;
  })()`);
  await new Promise(r => setTimeout(r, 800));
  await shot('02-imported-real.png');

  // ---- 截图2：拖拽插入位置指示条（第2/3页之间） ----
  console.log('=== 截图2：拖拽插入指示条（中间缝隙） ===');
  await ev(`(() => {
    const cards = [...document.querySelectorAll('.card:not(.skel)')];
    const r2 = cards[1].getBoundingClientRect(), r3 = cards[2].getBoundingClientRect();
    const gapX = (r2.right + r3.left) / 2;
    const cy = r2.top + r2.height / 2;
    // 模拟拖拽态
    cards[0].classList.add('dragging');
    state.dragUid = state.pages[0].uid;
    const slot = computeDropSlot(gapX, cy);
    state.dropIndex = slot;
    drawDropInd(slot);
    return slot;
  })()`);
  await new Promise(r => setTimeout(r, 400));
  await shot('03-drop-ind-between.png');

  // ---- 截图3：拖到文末（高亮最后一页右侧） ----
  console.log('=== 截图3：拖到文末 ===');
  await ev(`(() => {
    const cards = [...document.querySelectorAll('.card:not(.skel)')];
    const last = cards[cards.length - 1].getBoundingClientRect();
    const slot = computeDropSlot(last.right + 40, last.top + last.height / 2);
    state.dropIndex = slot;
    drawDropInd(slot);
    return slot;
  })()`);
  await new Promise(r => setTimeout(r, 400));
  await shot('04-drop-ind-end.png');

  console.log('输出:', OUT);
  ws.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
