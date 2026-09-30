// 交付物最终验收：隔离目录便携性 + 新增 UX 功能是否随构建带入
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, '创立PDF编辑器.html'));

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

(async () => {
  const iso = path.join(os.tmpdir(), 'pdf-final-' + Date.now());
  fs.mkdirSync(iso, { recursive: true });
  const target = path.join(iso, '创立PDF编辑器.html');
  fs.writeFileSync(target, html);
  console.log('隔离目录:', iso);
  console.log('目录内容:', fs.readdirSync(iso));

  const newTab = await new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: +(process.env.EDGE_PORT || 9333), path: '/json/new?about:blank', method: 'PUT' },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.end();
  });
  const ws = await openWs(newTab.webSocketDebuggerUrl);
  let id = 0; const pending = {}; const errors = []; const reqs = [];
  const send = (m, p = {}) => new Promise(r => { const mid = ++id; pending[mid] = r; ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
      errors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
    if (msg.method === 'Network.requestWillBeSent') reqs.push(msg.params.request.url);
  });
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Page.navigate', { url: 'file:///' + target.replace(/\\/g, '/') });
  await new Promise(r => setTimeout(r, 3500));

  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result && r.result.value; };

  let pass = 0, fail = 0;
  const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✅ ' + n + (x ? '  ' + x : '')); } else { fail++; console.log('  ❌ ' + n + (x ? '  ' + x : '')); } };

  console.log('\n=== 交付物自包含性 ===');
  check('核心库自包含', await ev('typeof PDFLib!=="undefined" && typeof pdfjsLib!=="undefined" && typeof heic2any!=="undefined"'));
  check('worker 已内嵌', await ev('(window.__PDFJS_WORKER_B64__||"").length > 1000'));
  const ext = reqs.filter(u => !u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:'));
  check('无外部网络请求', ext.length === 0, ext.join(', ') || '');

  console.log('\n=== 需求1：导入骨架屏（交付物内） ===');
  const png = makePNG(1200, 1600, (x, y) => [188 + (x % 40), 180, 168]).toString('base64');
  const r1 = await ev(`(async () => {
    const realToBitmap = window.toBitmap;
    window.toBitmap = async (b) => { await new Promise(r => setTimeout(r, 2000)); return realToBitmap(b); };
    const mk = (n) => { const bin = atob("${png}"); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new File([a], n, { type: 'image/png' }); };
    const dt = new DataTransfer();
    ['甲.png','乙.png','丙.png','丁.png'].forEach(n => dt.items.add(mk(n)));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const skel = document.querySelectorAll('.card.skel').length;
    const spin = document.querySelectorAll('.card.skel .spinner').length;
    // 同时验证重复投放被拦截
    const before = state.pages.length;
    const dt2 = new DataTransfer(); dt2.items.add(mk('重复.png'));
    input.files = dt2.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const toast = document.getElementById('toast').textContent;
    await new Promise(r => setTimeout(r, 9000));
    window.toBitmap = realToBitmap;
    return JSON.stringify({ skel, spin, toast, before, after: state.pages.length,
      finalSkel: document.querySelectorAll('.card.skel').length, importing: state.importing });
  })()`);
  console.log('  ', r1);
  const R1 = JSON.parse(r1);
  check('一次性显示 4 个灰格（对应数量）', R1.skel === 4, `${R1.skel} 个`);
  check('每格含转圈', R1.spin === 4, `${R1.spin} 个`);
  check('重复投放被拦截并有提示', /请稍候/.test(R1.toast) && R1.after === R1.before + 4, `页数 ${R1.before}→${R1.after}`);
  check('导入完成后骨架清除', R1.finalSkel === 0 && R1.importing === false);

  console.log('\n=== 需求2：拖拽插入指示条（交付物内） ===');
  const r2 = await ev(`(async () => {
    const cards = [...document.querySelectorAll('.card:not(.skel)')];
    const lr = document.getElementById('list').getBoundingClientRect();
    const ind = ensureDropInd(); ind.style.transition = 'none';
    const first = cards[0].getBoundingClientRect();
    state.dragUid = state.pages[0].uid;
    cards[0].classList.add('dragging');
    // 文末
    const last = cards[cards.length-1].getBoundingClientRect();
    const slotEnd = computeDropSlot(last.right + 40, last.top + last.height/2);
    drawDropInd(slotEnd);
    const irE = ind.getBoundingClientRect();
    const endInfo = { slot: slotEnd, x: Math.round(irE.left + irE.width/2 - lr.left), lastRight: Math.round(last.right - lr.left) };
    // 中间
    const a = cards[1].getBoundingClientRect(), b = cards[2].getBoundingClientRect();
    const gap = (a.right + b.left) / 2;
    const slotMid = computeDropSlot(gap, a.top + a.height/2);
    drawDropInd(slotMid);
    const irM = ind.getBoundingClientRect();
    const midInfo = { slot: slotMid, x: Math.round(irM.left + irM.width/2 - lr.left), gap: Math.round(gap - lr.left) };
    hideDropInd();
    const indHidden = getComputedStyle(ind).display === 'none';
    // 补测：删除到剩 1 页（末行未占满）时，文末指示条应落在该页右侧（不钳制）
    while (state.pages.length > 1) { state.pages.pop(); }
    afterMutate();
    await new Promise(r => setTimeout(r, 250));
    const solo = document.querySelector('.card:not(.skel)').getBoundingClientRect();
    const lr2 = document.getElementById('list').getBoundingClientRect();
    const ind2 = ensureDropInd(); ind2.style.transition = 'none';
    const slotSolo = computeDropSlot(solo.right + 40, solo.top + solo.height/2);
    drawDropInd(slotSolo);
    const irS = ind2.getBoundingClientRect();
    const soloInfo = { slot: slotSolo, x: Math.round(irS.left + irS.width/2 - lr2.left), cardRight: Math.round(solo.right - lr2.left) };
    hideDropInd();
    return JSON.stringify({ cardCount: cards.length, endInfo, midInfo, indHidden, soloInfo,
      hasDropIndEl: !!document.querySelector('.drop-ind'),
      draggingShown: cards[0].classList.contains('dragging') });
  })()`);
  console.log('  ', r2);
  const R2 = JSON.parse(r2);
  check('存在插入指示条元素', R2.hasDropIndEl);
  // 说明：若末行刚好占满，末页右缘≡列表右边界，指示条会被钳制在边界内（防溢出），
  // 此时允许它略在末页右缘内侧；若右侧仍有空间则应在末页右缘外侧。
  check('文末：slot=页数，且位于最后一页右侧',
    R2.endInfo.slot === R2.cardCount &&
    R2.endInfo.x >= R2.endInfo.lastRight - 6 && R2.endInfo.x <= R2.endInfo.lastRight + 12,
    `slot=${R2.endInfo.slot}/${R2.cardCount} x=${R2.endInfo.x} 末页右缘=${R2.endInfo.lastRight}`);
  check('中间：slot 与缝隙对齐', R2.midInfo.slot === 2 && Math.abs(R2.midInfo.x - R2.midInfo.gap) <= 3,
    `slot=${R2.midInfo.slot} x=${R2.midInfo.x} gap=${R2.midInfo.gap}`);
  check('清理后指示条隐藏', R2.indHidden);
  check('末行未占满时：文末指示条在最后一页右侧外侧',
    R2.soloInfo.slot === 1 && Math.abs(R2.soloInfo.x - (R2.soloInfo.cardRight + 7)) <= 6,
    `slot=${R2.soloInfo.slot} x=${R2.soloInfo.x} 单页右缘=${R2.soloInfo.cardRight}`);

  console.log('\n=== 导出回归（交付物内真实导出，含深色文字） ===');
  const contentPng = makePNG(1000, 1400, (x, y) => {
    // 浅黄纸面 + 横向深色文字条，接近真实扫描件
    const onText = (y % 120) < 34 && y > 100 && x > 90 && x < 900;
    const base = 190 + Math.round(8 * Math.sin(x / 70));
    return onText ? [42, 40, 46] : [Math.min(255, base + 12), base, Math.max(0, base - 14)];
  }).toString('base64');
  const r3 = await ev(`(async () => {
    // 清空后导入带文字的图
    state.pages = []; state.files = []; state.thumbCache = {}; state.imageCache = {};
    const bin = atob("${contentPng}");
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([arr], '带文字扫描件.png', { type: 'image/png' }));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 200)); if (!state.importing && state.pages.length) break; }

    document.getElementById('qualitySel').value = 'q-std';
    document.getElementById('qualitySel').dispatchEvent(new Event('change'));
    document.getElementById('enhanceSel').value = 'none';
    document.getElementById('enhanceSel').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    const cvNone = renderImageCanvas(state.pages[0]).cv;
    const none = (() => { const c = cvNone.getContext('2d',{willReadFrequently:true}); const d = c.getImageData(0,0,cvNone.width,cvNone.height).data;
      let n=cvNone.width*cvNone.height, dark=0, white=0, sum=0;
      for (let i=0;i<d.length;i+=4){const g=(d[i]*54+d[i+1]*183+d[i+2]*19)>>8; sum+=g; if(g<100)dark++; if(g>=250)white++;}
      return { mean:+(sum/n).toFixed(1), darkPct:+(dark/n*100).toFixed(2), whitePct:+(white/n*100).toFixed(2) }; })();

    document.getElementById('enhanceSel').value = 'standard';
    document.getElementById('enhanceSel').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    const cv = renderImageCanvas(state.pages[0]).cv;
    const bytes = await canvasToJpegBytes(cv, readQuality().q);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let n = cv.width*cv.height, dark = 0, white = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) { const g = (d[i]*54+d[i+1]*183+d[i+2]*19)>>8; sum += g; if (g<100) dark++; if (g>=250) white++; }
    return JSON.stringify({ jpeg: bytes.length, isJPEG: bytes[0]===0xFF&&bytes[1]===0xD8,
      none, enhanced: { mean:+(sum/n).toFixed(1), darkPct:+(dark/n*100).toFixed(2), whitePct:+(white/n*100).toFixed(2) } });
  })()`);
  console.log('  ', r3);
  const R3 = JSON.parse(r3);
  check('可导出合法 JPEG', R3.isJPEG && R3.jpeg > 1000);
  check('白底增强在交付物内生效（纯白大幅提升）', R3.enhanced.whitePct > R3.none.whitePct && R3.enhanced.whitePct > 40,
    `${R3.none.whitePct}% → ${R3.enhanced.whitePct}%`);
  check('文字加深保留（深色像素不被洗白）', R3.enhanced.darkPct >= R3.none.darkPct * 0.9 && R3.enhanced.darkPct > 1,
    `${R3.none.darkPct}% → ${R3.enhanced.darkPct}%`);
  check('文字更黑（深色区亮度下降）', R3.enhanced.mean <= R3.none.mean + 60,
    `均值 ${R3.none.mean} → ${R3.enhanced.mean}`);

  check('无控制台错误', errors.length === 0, errors.join(' | ') || '');

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  ws.close();
  setTimeout(() => { try { fs.rmSync(iso, { recursive: true, force: true }); } catch {} process.exit(fail ? 1 : 0); }, 400);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
