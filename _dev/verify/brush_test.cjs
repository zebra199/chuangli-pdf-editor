// 画笔（自由涂抹）回归测试（CDP 驱动无头 Edge）
//
// 覆盖需求：
//   · 新增「画笔」工具，按住左键自由涂画
//   · 配套「颜色」与「大小（笔触粗细）」两个控件
//   · 颜色走经典色板，粗细可改，画完可再选中 / 移动 / 缩放 / 删除
//   · 预览 / 缩略图 / 导出三处共用同一条 drawOps → 所见即所得
//
// 用法：node brush_test.cjs [页面路径] [端口]
const path = require('path');
const { pathToFileURL } = require('url');
const { ensure: ensureBrowser } = require('./_edge.cjs');

const DEV = path.join(__dirname, '..');
const PAGE = pathToFileURL(process.argv[2] || path.join(DEV, 'index.html')).href;
const IMG = path.join(__dirname, 'fixtures', '扫描件样本.png');

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return; } catch (e) {} await sleep(300); }
  throw new Error('超时等待：' + label);
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) this.handlers.forEach(h => h(m));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(fn) { this.handlers.push(fn); }
}

/* 在页面里模拟一次画笔拖拽（归一化坐标）。事件目标与源码一致：
 * mousedown 挂在 overlay canvas 上，mousemove / mouseup 挂在 document 上。 */
const STROKE_FN = `
window.__stroke = function(pts){
  const cv = edCanvas(), r = cv.getBoundingClientRect();
  const at = p => ({ clientX: r.left + p[0]*r.width, clientY: r.top + p[1]*r.height, bubbles:true, cancelable:true, button:0 });
  cv.dispatchEvent(new MouseEvent('mousedown', at(pts[0])));
  for (let i = 1; i < pts.length; i++) document.dispatchEvent(new MouseEvent('mousemove', at(pts[i])));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, cancelable:true }));
  return state.pages.length;
};
/* 数一数画面上「接近指定颜色」的像素：用来证明笔画真的画上去了 */
window.__countColor = async function(hex, tol){
  const im = new Image(); im.src = $('pvImg').src; await im.decode();
  const cv = document.createElement('canvas'); cv.width = im.naturalWidth; cv.height = im.naturalHeight;
  const ctx = cv.getContext('2d'); ctx.drawImage(im, 0, 0);
  const tgt = [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i]-tgt[0])<=tol && Math.abs(d[i+1]-tgt[1])<=tol && Math.abs(d[i+2]-tgt[2])<=tol) n++;
  }
  return n;
};
window.__ops = function(){ const p = currentPreviewPage(); return p ? JSON.parse(JSON.stringify(pageOps(p))) : []; };
1`;

(async () => {
  const browser = await ensureBrowser(process.argv[3]);
  process.on('exit', () => { if (browser.owned) browser.stop(); });
  const tab = await (await fetch(browser.base + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  const IGNORE = /Not allowed to load local resource: blob:|Images loaded lazily/;
  const errors = [];
  cdp.on(m => {
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const t = m.params.entry.text;
      if (!IGNORE.test(t)) errors.push(t);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const t = (m.params.exceptionDetails.exception || {}).description || 'exception';
      if (!IGNORE.test(t)) errors.push(t);
    }
  });
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('DOM.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const ev = async expr => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };

  await waitFor(async () => (await ev('document.readyState')) === 'complete', '页面加载');
  await sleep(400);
  await ev(`(function(){try{localStorage.clear()}catch(e){}
    $('qualitySel').value='q-high';$('enhanceSel').value='none';
    readImgSettings();applyOverlayUI();saveSettings();return 1;})()`);

  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId });
  await waitFor(async () => (await ev('state.pages.length')) === 1, '图片导入');
  await sleep(600);
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await sleep(1800);
  await ev(STROKE_FN);

  /* ---------- 1. 工具条：画笔按钮 + 颜色 + 大小 ---------- */
  const btn = await ev(`(function(){ const b=$('tbBr');
    return { has: !!b, txt: b ? b.textContent.trim() : '', tool: b ? b.dataset.tool : '' };})()`);
  ok('① 工具条出现「画笔」按钮', btn.has && btn.txt === '画笔' && btn.tool === 'brush',
    `按钮「${btn.txt}」 data-tool=${btn.tool}`);

  await ev(`$('tbBr').click(); 1`); await sleep(400);
  const afterTool = await ev(`({ tool: state.edit.tool, note: $('edNote').textContent.slice(0, 30) })`);
  ok('② 点「画笔」进入画笔模式', afterTool.tool === 'brush', `tool=${afterTool.tool}`);

  /* 画笔要颜色（不像马赛克那样隐藏选色） */
  const colorUI = await ev(`(function(){
    const w = $('edColorWrap');
    return { disp: getComputedStyle(w).display, val: $('edColor').value,
             sw: document.querySelectorAll('#edColor ~ .swatches .swc, .swatches .swc').length };})()`);
  ok('③ 画笔保留「颜色」选色器（未像马赛克那样隐藏）', colorUI.disp !== 'none',
    `#edColorWrap display=${colorUI.disp}｜当前色 ${colorUI.val}`);

  const sizeUI = await ev(`(function(){ const s=$('edSize');
    return { min: s.min, max: s.max, val: s.value, lb: $('edSizeV').textContent, dis: s.disabled };})()`);
  ok('④ 画笔的「大小」滑条是笔触粗细（1~60，默认 12）',
    !sizeUI.dis && +sizeUI.min === 1 && +sizeUI.max === 60 && +sizeUI.val === 12,
    `范围 ${sizeUI.min}~${sizeUI.max}｜当前 ${sizeUI.val}｜显示「${sizeUI.lb}」`);

  /* ---------- 2. 画一笔 ---------- */
  // 用蓝色，避开扫描件本身的暖色调，便于像素统计
  await ev(`(function(){ $('edColor').value='#1c7ed6';
    $('edColor').dispatchEvent(new Event('input',{bubbles:true})); return state.edit.colors.brush; })()`);
  await sleep(300);
  const before = await ev(`__countColor('#1c7ed6', 40)`);

  /* 故意画成纵向跨度大的折线：扁笔画的包围盒很矮，8 个控制点会紧贴笔迹，
   * 拿笔迹上的点去按会误命中控制点（走成「缩放」而不是「移动」），测出来的位移就不对了。
   * 这里按下点取 pts[1]，离四边/四角控制点都足够远。 */
  const pts = [[0.25, 0.25], [0.35, 0.40], [0.45, 0.30], [0.55, 0.50], [0.65, 0.35]];
  await ev(`__stroke(${JSON.stringify(pts)})`);
  await sleep(1800);

  const ops1 = await ev(`__ops()`);
  const br = ops1.filter(o => o.t === 'br');
  ok('⑤ 拖拽后生成一个画笔标注（t=br）', br.length === 1,
    `ops=${ops1.map(o => o.t).join(',')}｜pts 点数 ${br[0] ? br[0].pts.length : 0}`);
  ok('⑥ 记录了颜色与线宽', br.length === 1 && br[0].c === '#1c7ed6' && Math.abs(br[0].lw - 0.012) < 1e-6,
    br.length ? `c=${br[0].c} lw=${br[0].lw}` : '无');
  ok('⑦ 自动补出包围盒（供选中框与命中测试复用）',
    br.length === 1 && br[0].w > 0 && br[0].h > 0 && br[0].x >= 0 && br[0].x + br[0].w <= 1.0001,
    br.length ? `bbox x=${br[0].x.toFixed(3)} y=${br[0].y.toFixed(3)} w=${br[0].w.toFixed(3)} h=${br[0].h.toFixed(3)}` : '无');
  ok('⑧ 画完自动回到「选择」并选中刚画的那一笔',
    (await ev(`({t: state.edit.tool, s: state.edit.sel})`)).t === 'select' &&
    (await ev('state.edit.sel')) === 0,
    `tool=${(await ev('state.edit.tool'))} sel=${(await ev('state.edit.sel'))}`);

  const after = await ev(`__countColor('#1c7ed6', 40)`);
  ok('⑨ 预览画面上确实出现了这一笔（像素验证）', after > before + 500,
    `画前 ${before} 个蓝色像素 → 画后 ${after} 个`);

  /* ---------- 3. 缩略图同步 ---------- */
  const thumb = await ev(`(async function(){
    const p = state.pages[0];
    const u = p.displayThumb || (state.thumbCache[p.uid]||{}).url || '';
    if (!u) return -1;
    const im = new Image(); im.src = u; await im.decode();
    const cv = document.createElement('canvas'); cv.width = im.naturalWidth; cv.height = im.naturalHeight;
    const ctx = cv.getContext('2d'); ctx.drawImage(im,0,0);
    const d = ctx.getImageData(0,0,cv.width,cv.height).data;
    let n=0;
    for (let i=0;i<d.length;i+=4) if (Math.abs(d[i]-0x1c)<=40 && Math.abs(d[i+1]-0x7e)<=40 && Math.abs(d[i+2]-0xd6)<=40) n++;
    return n;})()`);
  ok('⑩ 缩略图里也能看到这一笔（与预览共用 drawOps）', thumb > 20, `缩略图蓝色像素 ${thumb} 个`);

  /* ---------- 4. 改颜色 / 改粗细 ---------- */
  await ev(`(function(){ $('edColor').value='#2f9e44';
    $('edColor').dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(1500);
  const c2 = (await ev(`__ops()`))[0];
  ok('⑪ 改颜色后该笔跟着变色（可再编辑）', c2 && c2.c === '#2f9e44', `op.c=${c2 && c2.c}`);

  /* 用户要求：选中笔迹后只能删除 / 撤销重做 / 改颜色 / 拖动，**不能改粗细** */
  const sizeHidden = await ev(`(function(){
    const w = $('edSizeWrap');
    return { disp: getComputedStyle(w).display, h: Math.round(w.getBoundingClientRect().height) };})()`);
  ok('⑫ 选中笔迹后「大小」组隐藏（不能再改粗细）', sizeHidden.disp === 'none',
    `#edSizeWrap display=${sizeHidden.disp} 高=${sizeHidden.h}`);

  // 就算绕过 UI 强行派发 input 事件，也不该把粗细改掉（代码里不留这个口子）
  await ev(`(function(){ const s=$('edSize'); s.value=40;
    s.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(1200);
  const w2 = (await ev(`__ops()`))[0];
  ok('⑬ 强行改「大小」也改不动笔迹粗细（粗细下笔时定死）',
    w2 && Math.abs(w2.lw - 0.012) < 1e-9, `op.lw=${w2 && w2.lw}（期望仍是 0.012）`);

  await ev(`$('tbUndo').click(); 1`); await sleep(1200);
  const w3 = (await ev(`__ops()`))[0];
  ok('⑭ 撤销可回退改颜色（一次撤销一步）', w3 && w3.c === '#1c7ed6', `撤销后 op.c=${w3 && w3.c}`);

  /* ---------- 5. 选中后移动 / 缩放 ---------- */
  await ev(`setTool('select'); state.edit.sel = 0; syncSelProps(); drawOverlayLayer(); 1`);
  await sleep(300);
  const beforePts = (await ev(`__ops()`))[0].pts;
  // 拖动：按在笔迹中段（pts[1]），整体平移
  await ev(`(function(){
    const cv = edCanvas(), r = cv.getBoundingClientRect();
    const at=(x,y)=>({clientX:r.left+x*r.width, clientY:r.top+y*r.height, bubbles:true, cancelable:true, button:0});
    const s = ${JSON.stringify(beforePts)};
    cv.dispatchEvent(new MouseEvent('mousedown', at(s[1][0], s[1][1])));
    document.dispatchEvent(new MouseEvent('mousemove', at(s[1][0]+0.10, s[1][1]+0.05)));
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true}));
    return 1;})()`);
  await sleep(1200);
  const moved = (await ev(`__ops()`))[0];
  const dMove = beforePts.length && moved.pts ? Math.hypot(moved.pts[1][0] - beforePts[1][0], moved.pts[1][1] - beforePts[1][1]) : 0;
  ok('⑮ 选中后可整体拖动移动（形状不变）', Math.abs(dMove - Math.hypot(0.10, 0.05)) < 0.01,
    `首点位移 ${dMove.toFixed(4)}（期望 ${Math.hypot(0.10, 0.05).toFixed(4)}）`);

  const shapeKept = beforePts.length === moved.pts.length &&
    Math.abs((moved.pts[2][0] - moved.pts[0][0]) - (beforePts[2][0] - beforePts[0][0])) < 1e-6;
  ok('⑯ 移动是整体平移，不是逐点漂移（点数与相对形状不变）', shapeKept,
    `点数 ${beforePts.length}→${moved.pts.length}`);

  /* 用户要求：笔迹**不能**拉边框缩放。
   * 在原来右下角控制点的位置按下并往外拖，应该「纹丝不动」（既不放大也不乱跑）。 */
  await ev(`setTool('select'); state.edit.sel = 0; syncSelProps(); drawOverlayLayer(); 1`);
  await sleep(300);
  const bb = (await ev(`__ops()`))[0];
  const noHandle = await ev(`(function(){
    const cv = edCanvas();
    const o = pageOps(currentPreviewPage())[0];
    return hitHandle(o, { x: ${bb.x + bb.w}, y: ${bb.y + bb.h} }, cv.width, cv.height);})()`);
  ok('⑰ 笔迹不再命中控制点（hitHandle 恒为 null）', noHandle === null, `hitHandle=${JSON.stringify(noHandle)}`);

  await ev(`(function(){
    const cv = edCanvas(), r = cv.getBoundingClientRect();
    const at=(x,y)=>({clientX:r.left+x*r.width, clientY:r.top+y*r.height, bubbles:true, cancelable:true, button:0});
    const o = ${JSON.stringify({ x: bb.x, y: bb.y, w: bb.w, h: bb.h })};
    // 在右下角（原控制点位置）按下并往外拖 —— 应该完全不缩放
    cv.dispatchEvent(new MouseEvent('mousedown', at(o.x+o.w, o.y+o.h)));
    document.dispatchEvent(new MouseEvent('mousemove', at(o.x+o.w*1.5, o.y+o.h*1.5)));
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true}));
    return 1;})()`);
  await sleep(1200);
  const scaled = (await ev(`__ops()`))[0];
  const sizeKept = Math.abs(scaled.w - bb.w) < 1e-6 && Math.abs(scaled.h - bb.h) < 1e-6 &&
                   Math.abs(scaled.lw - bb.lw) < 1e-9;
  ok('⑱ 拉边框不再缩放笔迹（尺寸与粗细都保持不变）', sizeKept,
    `包围盒 ${bb.w.toFixed(3)}×${bb.h.toFixed(3)} → ${scaled.w.toFixed(3)}×${scaled.h.toFixed(3)}｜lw ${bb.lw} → ${scaled.lw}`);

  /* ---------- 6. 删除 + 撤销整笔 ---------- */
  await ev(`setTool('select'); state.edit.sel = 0; syncSelProps(); $('tbDel').click(); 1`);
  await sleep(1500);
  const afterDel = await ev(`__ops()`);
  ok('⑲ 可删除选中的笔画', afterDel.length === 0, `剩余标注 ${afterDel.length} 个`);

  await ev(`$('tbUndo').click(); 1`); await sleep(1500);
  const afterUndo = await ev(`__ops()`);
  ok('⑳ 撤销可恢复整笔（一次撤销即整笔）', afterUndo.length === 1 && afterUndo[0].t === 'br',
    `恢复 ${afterUndo.length} 个（${afterUndo.map(o => o.t).join(',')}）`);

  /* ---------- 7. 单击不留下孤立圆点 ---------- */
  const n0 = (await ev(`__ops()`)).length;
  await ev(`(function(){ $('tbBr').click();
    __stroke([[0.70,0.70]]); return 1; })()`);
  await sleep(1200);
  const n1 = (await ev(`__ops()`)).length;
  ok('㉑ 只是单击一下不留孤立圆点（与矩形工具一致：太小就丢弃）', n1 === n0,
    `标注数 ${n0} → ${n1}`);

  /* ---------- 8. 导出仍然带这一笔（走栅格） ---------- */
  const raster = await ev(`(function(){ const p = state.pages[0];
    return { needs: pageNeedsRaster(p), vector: effQualityOf(p).vector && !pageNeedsRaster(p) };})()`);
  ok('㉒ 有画笔的页强制栅格化（导出不会丢笔迹）', raster.needs === true && raster.vector === false,
    `needsRaster=${raster.needs}｜矢量=${raster.vector}`);

  /* ---------- 9. 多了一个按钮，工具条会不会把「删除/撤销/重做」挤出面板 ---------- */
  const setViewport = (w, h) => cdp.send('Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const fitReport = [];
  for (const [vw, vh] of [[1440, 900], [1280, 800]]) {
    await setViewport(vw, vh);
    await sleep(600);
    await ev(`(function(){ setTool('brush'); return 1; })()`);
    await sleep(500);
    const rep = await ev(`(function(){
      const box = document.querySelector('#preview .box').getBoundingClientRect();
      const ids = ['edColorWrap','edSizeWrap','tbDel','tbUndo','tbRedo'];
      const out = {};
      ids.forEach(id => {
        const e = $(id); if (!e) { out[id] = 'MISSING'; return; }
        const r = e.getBoundingClientRect();
        const inside = r.width > 0 && r.height > 0 &&
          r.left >= box.left - 1 && r.right <= box.right + 1 &&
          r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
        out[id] = inside ? 'OK' : 'OUT';
      });
      return { rows: Math.round($('pvEdit').getBoundingClientRect().height), box: Math.round(box.width), out: out };})()`);
    const bad = Object.keys(rep.out).filter(k => rep.out[k] !== 'OK');
    fitReport.push(`${vw}×${vh}: 面板 ${rep.box}px 工具条高 ${rep.rows}px ${bad.length ? '超界 ' + bad.join(',') : '全部在面板内'}`);
    ok(`㉓+ ${vw}×${vh} 颜色/大小/删除/撤销/重做 全都在面板内`, bad.length === 0, fitReport[fitReport.length - 1]);
  }
  await setViewport(1440, 900);

  /* ---------- 10. PDF 页上同样能画（PDF 才是主用场景，不能只在图片页上验证） ---------- */
  await ev(`(function(){ closePreview(); state.pages=[]; state.files=[]; state.thumbCache={};
    renderList(); updateFoot(); return 1; })()`);
  await sleep(400);
  const { nodeId: nid2 } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { files: [path.join(DEV, 'test', '测试文件A.pdf')], nodeId: nid2 });
  await waitFor(async () => (await ev('state.pages.length')) >= 2, 'PDF 导入', 60000);
  await sleep(1500);
  await ev(`document.querySelector('.card:not(.skel) .thumb').click(); 1`);
  await sleep(2200);
  await ev(`(function(){ $('tbBr').click();
    $('edColor').value='#7048e8'; $('edColor').dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(300);
  const pBefore = await ev(`__countColor('#7048e8', 40)`);
  await ev(`__stroke(${JSON.stringify([[0.20, 0.30], [0.35, 0.45], [0.50, 0.32], [0.65, 0.50], [0.78, 0.34]])})`);
  await sleep(2200);
  const pdfOps = await ev(`__ops()`);
  const pAfter = await ev(`__countColor('#7048e8', 40)`);
  ok('㉔ PDF 页上也能画（生成 br 标注 + 画面出现该颜色）',
    pdfOps.some(o => o.t === 'br') && pAfter > pBefore + 300,
    `ops=${pdfOps.map(o => o.t).join(',')}｜紫色像素 ${pBefore} → ${pAfter}`);

  ok('㉕ 运行期无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' ｜ ') || '无');

  const pass = results.filter(r => r.pass).length;
  console.log('\n=== 结果 ===');
  results.forEach(r => console.log('  ' + (r.pass ? '✅' : '❌') + ' ' + r.name + (r.detail ? '\n       ' + r.detail : '')));
  console.log(`\n=== ${pass} 通过 / ${results.length - pass} 失败 ===`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('失败：', e && e.message || e); process.exit(1); });
