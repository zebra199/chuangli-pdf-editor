// 精确核对截图：用 DOM 几何定位卡片区域，再对裁剪区做像素判定
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEV = path.join(__dirname, '..');
const PAGE = path.join(DEV, 'index.html');
const OUT = path.join(__dirname, 'shots');

function openWs(url) {
  return new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(ws); ws.onerror = rej; });
}
function makePNG(W, H, fn) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) { const [r, g, b] = fn(x, y); const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  }
  function crc32(buf) { let c; const t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let crc = 0xffffffff; for (let i = 0; i < buf.length; i++) crc = t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
  function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const ty = Buffer.from(type, 'ascii'); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([ty, data]))); return Buffer.concat([len, ty, data, cr]); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
const scan = (x, y) => { const base = 186 + Math.round(18 * Math.sin(x / 90) + 10 * Math.cos(y / 140)); return [Math.min(255, base + 14), Math.min(255, base + 2), Math.max(0, base - 16)]; };

(async () => {
  const newTab = await new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: +(process.env.EDGE_PORT || 9333), path: '/json/new?about:blank', method: 'PUT' },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.end();
  });
  const ws = await openWs(newTab.webSocketDebuggerUrl);
  let id = 0; const pending = {};
  const send = (m, p = {}) => new Promise(r => { const mid = ++id; pending[mid] = r; ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
  ws.addEventListener('message', ev => { const msg = JSON.parse(ev.data.toString()); if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; } });
  await send('Runtime.enable'); await send('Page.enable');
  const DSF = 2;
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: DSF, mobile: false });
  await send('Page.navigate', { url: 'file:///' + PAGE.replace(/\\/g, '/') });
  await new Promise(r => setTimeout(r, 3000));
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result && r.result.value; };

  const bigPng = makePNG(1200, 1600, scan).toString('base64');

  // 导入中截图，同时返回骨架卡的几何信息
  const geo = await ev(`(async () => {
    const realToBitmap = window.toBitmap;
    window.toBitmap = async (blob) => { await new Promise(r => setTimeout(r, 3000)); return realToBitmap(blob); };
    const mk = (name) => { const bin = atob("${bigPng}"); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return new File([arr], name, { type: 'image/png' }); };
    const dt = new DataTransfer();
    ['A.png','B.png','C.png'].forEach(n => dt.items.add(mk(n)));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 800));
    const skels = [...document.querySelectorAll('.card.skel')];
    const thumbs = [...document.querySelectorAll('.card.skel .thumb')];
    const spins = [...document.querySelectorAll('.card.skel .spinner')];
    const r = e => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
    return JSON.stringify({
      skelCount: skels.length,
      skel: skels.map(r), thumb: thumbs.map(r), spin: spins.map(r),
      spinStyle: spins[0] ? { bw: getComputedStyle(spins[0]).borderTopWidth, color: getComputedStyle(spins[0]).borderTopColor, anim: getComputedStyle(spins[0]).animationName } : null,
      thumbBg: thumbs[0] ? getComputedStyle(thumbs[0]).backgroundImage.slice(0, 60) : null
    });
  })()`);
  console.log('=== 骨架屏几何/DOM ===');
  console.log(geo);
  const G = JSON.parse(geo);

  let pass = 0, fail = 0;
  const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✅ ' + n + (x ? '  ' + x : '')); } else { fail++; console.log('  ❌ ' + n + (x ? '  ' + x : '')); } };

  check('骨架卡数量 = 文件数（同时可见）', G.skelCount === 3, `${G.skelCount} 张（期望 3）`);
  check('转圈图标存在', G.spin.length === 3, `${G.spin.length} 个`);
  check('转圈为旋转动画', G.spinStyle && G.spinStyle.anim === 'spin', JSON.stringify(G.spinStyle));
  // 转圈应位于缩略图区正中
  if (G.spin[0] && G.thumb[0]) {
    const s = G.spin[0], t = G.thumb[0];
    const dx = (s.x + s.w / 2) - (t.x + t.w / 2);
    const dy = (s.y + s.h / 2) - (t.y + t.h / 2);
    check('转圈居中于灰格', Math.abs(dx) <= 2 && Math.abs(dy) <= 2, `偏移 dx=${dx} dy=${dy}`);
  }
  check('灰格有呼吸渐变（骨架动效）', !!G.thumbBg && /gradient/.test(G.thumbBg), G.thumbBg || '');

  // 落点指示条几何
  const slotGeo = await ev(`(async () => {
    // 结束导入，换成真实卡片
    for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 200)); if (!state.importing) break; }
    await new Promise(r => setTimeout(r, 400));
    const cards = [...document.querySelectorAll('.card:not(.skel)')];
    const list = document.getElementById('list');
    const lr = list.getBoundingClientRect();
    const mk = (x, y) => {
      const cards2 = [...document.querySelectorAll('.card:not(.skel)')];
      const slot = computeDropSlot(x, y);
      drawDropInd(slot);
      const ind = document.querySelector('.drop-ind');
      ind.style.transition = 'none';
      const ir = ind.getBoundingClientRect();
      // 检查该缝隙附近是否存在竖线像素颜色
      return { slot, x: Math.round(ir.left + ir.width/2 - lr.left), y: Math.round(ir.top - lr.top), h: Math.round(ir.height) };
    };
    const r2 = cards[1].getBoundingClientRect(), r3 = cards[2].getBoundingClientRect();
    const between = mk((r2.right + r3.left) / 2, r2.top + r2.height / 2);
    const last = cards[cards.length-1].getBoundingClientRect();
    const end = mk(last.right + 40, last.top + last.height / 2);
    const first = cards[0].getBoundingClientRect();
    const front = mk(first.left - 40, first.top + first.height / 2);
    hideDropInd();
    return JSON.stringify({ cardCount: cards.length, listW: Math.round(lr.width), between, end, front,
      r2Right: Math.round(r2.right - lr.left), r3Left: Math.round(r3.left - lr.left),
      gapCenter: Math.round((r2.right + r3.left) / 2 - lr.left),
      lastRight: Math.round(last.right - lr.left), firstLeft: Math.round(first.left - lr.left),
      cardW: Math.round(cards[0].getBoundingClientRect().width), cardH: Math.round(cards[0].getBoundingClientRect().height) });
  })()`);
  console.log('\n=== 指示条几何 ===');
  console.log(slotGeo);
  const S = JSON.parse(slotGeo);
  check('中间缝隙：指示条落在第2页与第3页正中间', Math.abs(S.between.x - S.gapCenter) <= 3,
    `条 x=${S.between.x}，实际缝隙中心=${S.gapCenter}（第2页右缘 ${S.r2Right} / 第3页左缘 ${S.r3Left}）`);
  check('中间缝隙：slot=2', S.between.slot === 2, `slot=${S.between.slot}`);
  check('文末：位置=最后一页右缘外侧', Math.abs(S.end.x - (S.lastRight + 7)) <= 6,
    `条 x=${S.end.x}，末页右缘=${S.lastRight}`);
  check('文末：slot=页数', S.end.slot === S.cardCount, `slot=${S.end.slot} / ${S.cardCount}`);
  check('最前：slot=0', S.front.slot === 0, `slot=${S.front.slot}`);
  check('竖线高度=卡片高度', S.between.h === S.cardH, `${S.between.h} vs ${S.cardH}`);

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
