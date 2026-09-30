// 验证需求1（导入骨架屏）与需求2（拖拽插入位置指示条）
// 在真实无头 Edge 中加载开发版页面，逐项检查 DOM 行为。
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEV = __dirname && path.join(__dirname, '..');
const ROOT = path.join(DEV, '..');
const PAGE = path.join(DEV, 'index.html');

function openWs(url) {
  return new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(ws); ws.onerror = rej; });
}

// 生成测试用 PNG（纯色/渐变），避免依赖外部图片
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
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

(async () => {
  const newTab = await new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: +(process.env.EDGE_PORT || 9333), path: '/json/new?about:blank', method: 'PUT' },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.end();
  });
  const ws = await openWs(newTab.webSocketDebuggerUrl);
  let id = 0; const pending = {}; const errors = [];
  const send = (m, p = {}) => new Promise(r => { const mid = ++id; pending[mid] = r; ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
      errors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'file:///' + PAGE.replace(/\\/g, '/') });
  await new Promise(r => setTimeout(r, 3000));

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EVAL: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result && r.result.value;
  };

  let pass = 0, fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
    else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
  };

  console.log('=== 需求1：导入骨架屏 ===');

  // 准备 3 张图片（一张较大以拉长处理时间）
  const pngs = [
    { name: '大图1.png', buf: makePNG(1600, 2200, (x, y) => [180 + (x % 60), 175, 165]) },
    { name: '图2.png', buf: makePNG(700, 900, (x, y) => [200, 190 + (y % 40), 180]) },
    { name: '图3.png', buf: makePNG(700, 900, (x, y) => [190, 200, 170 + (x % 50)]) },
  ];

  // 注入文件并立即采样（不等处理完），验证骨架卡是否立刻出现
  const res1 = await ev(`(async () => {
    const files = ${JSON.stringify(pngs.map(p => ({ name: p.name, b64: p.buf.toString('base64') })))};
    const dt = new DataTransfer();
    for (const f of files) {
      const bin = atob(f.b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      dt.items.add(new File([arr], f.name, { type: 'image/png' }));
    }
    // ⚠️ 必须给解码打桩：这几张纯色 PNG 解码只要几毫秒，骨架帧一闪而过，
    // 25ms 的采样根本抓不到，会误报「骨架卡数量为 0」。ux_geom.cjs 用的是同一手法。
    // 原函数只留一份、永不删除：1b 段会再套一层桩，若这里删了属性，内层桩就会拿到 undefined
    if (!window.__origToBitmap) window.__origToBitmap = window.toBitmap;
    const realToBitmap = window.__origToBitmap;
    window.toBitmap = async blob => { await new Promise(r => setTimeout(r, 1500)); return realToBitmap(blob); };

    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // 尽快采样：骨架应已出现（不等待处理完成）
    const samples = [];
    for (let t = 0; t < 40; t++) {
      await new Promise(r => setTimeout(r, 25));
      samples.push({
        t: t * 25,
        skel: document.querySelectorAll('.card.skel').length,
        real: document.querySelectorAll('.card:not(.skel)').length,
        spin: document.querySelectorAll('.card.skel .spinner').length,
        importing: state.importing,
      });
      if (!state.importing && samples.length > 3) break;
    }
    // 等彻底结束：这里必须**轮询** state.importing，不能定长等待 ——
    // 三张图各套了一层 1.5s 的解码桩，定长 1500ms 会在导入中途收尾，
    // 于是「骨架未清除 / 只导入 1 页」全是假失败，还会连累后面的 1b 段。
    for (let i = 0; i < 200 && state.importing; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 400));
    return JSON.stringify({
      samples,
      final: { skel: document.querySelectorAll('.card.skel').length,
               real: document.querySelectorAll('.card:not(.skel)').length,
               pages: state.pages.length, importing: state.importing },
      maxSkel: Math.max(...samples.map(s => s.skel)),
      anySpinner: samples.some(s => s.spin > 0)
    });
  })()`);
  const r1 = JSON.parse(res1);
  console.log('  采样:', JSON.stringify(r1.samples.slice(0, 8)));
  console.log('  最终:', JSON.stringify(r1.final));
  check('导入中出现骨架卡片', r1.maxSkel > 0, `峰值 ${r1.maxSkel} 个`);
  check('骨架卡含转圈图案', r1.anySpinner);
  check('导入结束后骨架全部清除', r1.final.skel === 0);
  check('三张图全部导入成功', r1.final.real === 3 && r1.final.pages === 3, `real=${r1.final.real} pages=${r1.final.pages}`);
  // 卸掉需求1的打桩，否则后面的用例会把「桩」当成真身层层包下去（延迟越滚越大）
  await ev(`(function(){ if (window.__origToBitmap) window.toBitmap = window.__origToBitmap; return 1; })()`);

  console.log('\n=== 需求1b：导入中重复投放被拦截 ===');
  // 用可控延迟使导入变慢，从而稳定观察拦截行为（仅测试时替换 toBitmap）
  const resDup = await ev(`(async () => {
    const realToBitmap = window.toBitmap;
    window.toBitmap = async (blob) => { await new Promise(r => setTimeout(r, 600)); return realToBitmap(blob); };
    const mk = (name) => {
      const bin = atob("${makePNG(300, 400, (x, y) => [190, 185, 175]).toString('base64')}");
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new File([arr], name, { type: 'image/png' });
    };
    const input = document.getElementById('fileInput');
    const before = state.pages.length;

    const dt1 = new DataTransfer(); dt1.items.add(mk('A.png'));
    input.files = dt1.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const duringImporting = state.importing;
    const pendingDuring = document.querySelectorAll('.card.skel').length;

    // 导入中再次投放：应被拦截
    const dt2 = new DataTransfer(); dt2.items.add(mk('B.png'));
    input.files = dt2.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const toastDuring = document.getElementById('toast').textContent;

    await new Promise(r => setTimeout(r, 1600));
    window.toBitmap = realToBitmap;
    return JSON.stringify({ before, duringImporting, pendingDuring, toastDuring,
      after: state.pages.length, importing: state.importing });
  })()`);
  console.log('  ', resDup);
  const rd = JSON.parse(resDup);
  check('导入中 state.importing=true', rd.duringImporting === true);
  check('导入中显示骨架占位', rd.pendingDuring > 0, `${rd.pendingDuring} 个`);
  check('重复投放被拦截', rd.after === rd.before + 1, `页数 ${rd.before}→${rd.after}（应仅 +1）`);
  check('拦截时给出提示文案', /请稍候/.test(rd.toastDuring), `toast="${rd.toastDuring}"`);
  check('导入结束后状态复位', rd.importing === false && await ev('document.querySelectorAll(".card.skel").length') === 0);

  console.log('\n=== 需求2：拖拽插入位置指示条 ===');
  const res2 = await ev(`(async () => {
    // 造 4 张卡片（清空后重新导入，确保数量可控）
    state.pages = []; state.files = []; state.pending = []; state.thumbCache = {}; state.imageCache = {};
    const mk = (name, r, g, b) => {
      const bin = atob("${makePNG(400, 520, (x, y) => [200, 190, 180]).toString('base64')}");
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new File([arr], name, { type: 'image/png' });
    };
    // 直接构造 4 个图片页（跳过文件导入，聚焦拖拽逻辑）
    for (let i = 1; i <= 4; i++) {
      const cv = document.createElement('canvas'); cv.width = 400; cv.height = 520;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = 'rgb(' + (170 + i * 12) + ',' + (165 + i * 8) + ',160)';
      ctx.fillRect(0, 0, 400, 520);
      ctx.fillStyle = '#222'; ctx.font = 'bold 90px sans-serif';
      ctx.fillText('P' + i, 140, 300);
      const bmp = await createImageBitmap(cv);
      const uid = ++state.pageSeq;
      state.files.push({ id: ++state.fileSeq, name: 'F' + i, size: 1000, kind: 'image', color: '#2f6fed', bitmap: bmp });
      state.pages.push({ uid, fileId: state.fileSeq, fileName: 'F' + i, kind: 'image', srcNo: 1,
        w: 400, h: 520, rot: 0, hMirror: false, vMirror: false, err: false });
      state.thumbCache[uid] = bmp;
    }
    afterMutate();
    await new Promise(r => setTimeout(r, 300));

    const cards = [...document.querySelectorAll('.card:not(.skel)')];
    const list = document.getElementById('list');
    const lr = list.getBoundingClientRect();

    const results = {};
    // 测量前关闭过渡动画，避免读到动画途中的中间值
    const ind0 = ensureDropInd();
    ind0.style.transition = 'none';

    // 场景A：拖到第2、3页之间的缝隙（slot=2）
    const r2 = cards[1].getBoundingClientRect(), r3 = cards[2].getBoundingClientRect();
    const gapX = (r2.right + r3.left) / 2;
    const cy = r2.top + r2.height / 2;
    let slot = computeDropSlot(gapX, cy);
    drawDropInd(slot);
    const ind = document.querySelector('.drop-ind');
    const ir = ind.getBoundingClientRect();
    results.between = {
      slot, expected: 2,
      indVisible: ind.style.display === 'block',
      indCenter: Math.round(ir.left + ir.width / 2 - lr.left),
      gapCenter: Math.round(gapX - lr.left),
      indTop: Math.round(ir.top - lr.top), indH: Math.round(ir.height),
      cardTop: Math.round(r2.top - lr.top), cardH: Math.round(r2.height)
    };

    // 场景B：拖到文末（slot=4）→ 应高亮最后一页右侧
    const last = cards[3].getBoundingClientRect();
    slot = computeDropSlot(last.right + 30, last.top + last.height / 2);
    drawDropInd(slot);
    const indB = document.querySelector('.drop-ind');
    indB.style.transition = 'none';
    const ir2 = indB.getBoundingClientRect();
    results.end = {
      slot, expected: 4,
      indCenter: Math.round(ir2.left + ir2.width / 2 - lr.left),
      lastRight: Math.round(last.right - lr.left),
      listWidth: Math.round(lr.width)
    };

    // 场景C：拖到最前（slot=0）
    const first = cards[0].getBoundingClientRect();
    slot = computeDropSlot(first.left - 30, first.top + first.height / 2);
    drawDropInd(slot);
    results.front = { slot, expected: 0 };

    hideDropInd();
    return JSON.stringify({ results, cardCount: cards.length,
      sameRow: Math.abs(cards[0].getBoundingClientRect().top - cards[1].getBoundingClientRect().top) < 5 });
  })()`);
  const r2 = JSON.parse(res2);
  console.log('  ', JSON.stringify(r2, null, 1));
  const B = r2.results.between, E = r2.results.end, F = r2.results.front;
  check('插入位计算正确（第2/3页之间 = slot 2）', B.slot === B.expected, `得到 ${B.slot}`);
  check('指示条可见', B.indVisible);
  check('指示条落在两页之间', Math.abs(B.indCenter - B.gapCenter) <= 4, `条中心 ${B.indCenter} vs 缝隙 ${B.gapCenter}`);
  check('指示条高度贴合卡片', Math.abs(B.indH - B.cardH) <= 6, `条高 ${B.indH} vs 卡高 ${B.cardH}`);
  check('文末插入 = slot 4', E.slot === E.expected, `得到 ${E.slot}`);
  check('文末指示条在最后一页右侧', Math.abs(E.indCenter - E.lastRight) <= 12,
    `条 ${E.indCenter} vs 末页右缘 ${E.lastRight}（列表宽 ${E.listWidth}）`);
  check('最前插入 = slot 0', F.slot === F.expected, `得到 ${F.slot}`);

  console.log('\n=== 需求2b：落点后顺序真的改变了 ===');
  const res3 = await ev(`(async () => {
    const before = state.pages.map(p => p.fileName).join(',');
    const fromUid = state.pages[0].uid;
    state.dragUid = fromUid;
    state.dropIndex = 2;                 // 把第1页拖到第2/3之间
    const evt = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'target', { value: document.querySelectorAll('.card:not(.skel)')[1] });
    document.getElementById('list').dispatchEvent(evt);
    await new Promise(r => setTimeout(r, 200));
    const after = state.pages.map(p => p.fileName).join(',');
    return JSON.stringify({ before, after });
  })()`);
  console.log('  ', res3);
  const r3 = JSON.parse(res3);
  check('拖拽后顺序发生变化', r3.before !== r3.after, `${r3.before} → ${r3.after}`);
  check('顺序符合预期（1 插到 2 之后）', r3.after === 'F2,F1,F3,F4', `得到 ${r3.after}`);

  console.log('\n=== 回归：原有功能未被破坏 ===');
  check('enhanceCanvas 仍存在', await ev('typeof enhanceCanvas === "function"'));
  check('renderImageCanvas 仍存在', await ev('typeof renderImageCanvas === "function"'));
  check('导入的 3 张图仍可渲染缩略图', await ev('state.pages.length >= 3 && !!state.pages[0].displayThumb'));

  console.log('\n错误日志:', errors.length ? errors : '无 ✅');
  if (errors.length) fail++;
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
