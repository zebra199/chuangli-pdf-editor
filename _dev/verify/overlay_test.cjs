// 叠加层回归测试（CDP 驱动无头 Edge）
// 覆盖：水印 / 页码 / 马赛克 / 高亮 / 文本框 / 撤销重做 / 导出接入
// 用法：node overlay_test.cjs [页面路径] [端口]
//   默认验证 _dev/index.html；传产物路径则验证打包单文件：
//     node overlay_test.cjs "C:/…/创立PDF编辑器.html" 9333
// 需先启动：msedge --headless=new --remote-debugging-port=9333 --user-data-dir=%TEMP%\edge-dev --no-first-run --disable-gpu
const path = require('path');
const { pathToFileURL } = require('url');
const { ensure: ensureBrowser } = require('./_edge.cjs');
const DEV = path.join(__dirname, '..');
const PAGE = pathToFileURL(process.argv[2] || path.join(DEV, 'index.html')).href;
const PDF = path.join(DEV, 'test', '测试文件A.pdf');
const IMG = path.join(__dirname, 'fixtures', '扫描件样本.png');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return; } catch (e) {}
    await sleep(300);
  }
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
const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass, detail }); };

(async () => {
  // 未显式指定端口时，自启一个「唯一 profile + 空闲端口」的专属实例，结束后回收
  const browser = await ensureBrowser(process.argv[3]);
  const BASE = browser.base;
  process.on('exit', () => { if (browser.owned) browser.stop(); });
  const tab = await (await fetch(BASE + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  /* 白名单：file:// 下单文件版用 base64→blob 启动 pdf.js worker 会被协议拦截
   * （pdf.js 自动回退主线程，功能不受影响；改造前的打包产物同样有这条，属既有现象） */
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
  const ev = async expr => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };
  const set = async (id, v, evt) => ev(`(function(){const e=$('${id}');e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('${evt || 'change'}'));return e.value;})()`);
  const check = async (id, v) => ev(`(function(){const e=$('${id}');e.checked=${!!v};e.dispatchEvent(new Event('change'));return e.checked;})()`);

  await waitFor(async () => (await ev('document.readyState')) === 'complete', '页面加载');
  // file:// 下 localStorage 按 null origin 共享，同一 profile 的遗留设置会污染本次测试
  await ev(`(function(){try{localStorage.clear()}catch(e){}
    $('qualitySel').value='q-faithful';$('enhanceSel').value='none';
    readImgSettings();applyOverlayUI();saveSettings();return 1;})()`);

  // ---------- 1. 导入 PDF ----------
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { files: [PDF], nodeId });
  await waitFor(async () => (await ev('state.pages.length')) > 0, 'PDF 导入');
  const np = await ev('state.pages.length');
  ok('PDF 导入成功', np >= 1, '页数=' + np);

  const thumbHash = () => ev(`(function(){const p=state.pages[0];return (p.displayThumb||'').length + ':' + (p.displayThumb||'').slice(-24);})()`);

  // ---------- 2. 水印（文本） ----------
  const t0 = await thumbHash();
  await check('wmOn', true);
  await sleep(600);
  const t1 = await thumbHash();
  ok('开启文字水印后缩略图重绘', t0 !== t1, `改前 ${t0.slice(0, 10)} → 改后 ${t1.slice(0, 10)}`);

  await ev(`onOverlayChange()`);
  const wmState = await ev(`JSON.stringify(state.overlay.wm)`);
  ok('水印参数写入 state', /"on":true/.test(wmState), wmState);

  // ---------- 3. 页码 ----------
  await set('pnPos', 'center'); await set('pnFmt', 'page-n-m');
  const pnBefore = await thumbHash();
  await check('pnOn', true);
  await sleep(600);
  const pnAfter = await thumbHash();
  ok('开启页码后缩略图重绘', pnBefore !== pnAfter, '位置/格式：居中 · 第 N 页 / 共 M 页');

  /* 底部像素检测：页码画在版面底部，取底部 6% 区域统计深色像素 */
  const probeBottom = async expr => ev(`(async function(){
    const p = state.pages[0];
    const f = state.files.find(x=>x.id===p.fileId);
    const cv = await renderPdfPreviewCanvas(f.bytes, p);
    drawOps(cv.getContext('2d'), p, cv.width, cv.height, ovMeta(p));
    const ctx = cv.getContext('2d');
    const y0 = Math.floor(cv.height*0.94), hh = cv.height - y0;
    const d = ctx.getImageData(0, y0, cv.width, hh).data;
    let dark=0, mid=0;
    for(let i=0;i<d.length;i+=4){ const lum=(d[i]*54+d[i+1]*183+d[i+2]*19)>>8; if(lum<120)dark++; else if(lum<235)mid++; }
    return { dark: dark, mid: mid, total: d.length/4 };
  })()`);
  const bot = await probeBottom();
  ok('页码绘制在版面底部', bot.dark > 20, `底部区域深色像素 ${bot.dark}（阈值 >20）`);

  // 三种位置都能画
  const posScan = [];
  for (const pos of ['left', 'center', 'right']) {
    await set('pnPos', pos);
    await sleep(400);
    const r = await ev(`(async function(){
      const p = state.pages[0];
      const f = state.files.find(x=>x.id===p.fileId);
      const cv = await renderPdfPreviewCanvas(f.bytes, p);
      drawOps(cv.getContext('2d'), p, cv.width, cv.height, ovMeta(p));
      const ctx = cv.getContext('2d');
      const y0 = Math.floor(cv.height*0.93);
      const W = cv.width, hh = cv.height - y0;
      const d = ctx.getImageData(0, y0, W, hh).data;
      let minX = W, maxX = -1;
      for (let y=0;y<hh;y++) for (let x=0;x<W;x++){
        const i=(y*W+x)*4; const lum=(d[i]*54+d[i+1]*183+d[i+2]*19)>>8;
        if (lum<120){ if(x<minX)minX=x; if(x>maxX)maxX=x; }
      }
      return { minX: minX, maxX: maxX, W: W };
    })()`);
    posScan.push({ pos, cx: Math.round((r.minX + r.maxX) / 2), W: r.W });
  }
  const [L, C, R] = posScan;
  ok('页码三种位置生效', L.cx < C.cx && C.cx < R.cx && C.cx > L.W * 0.3 && C.cx < L.W * 0.7,
    `左下 x≈${L.cx}｜居中 x≈${C.cx}｜右下 x≈${R.cx}（版面宽 ${L.W}）`);
  await set('pnPos', 'center');

  // ---------- 4. 页码随排序变化 ----------
  // 排序跟随：断言索引位的页码恒等于序号，且交换后「索引位 ↔ 源页」的对应关系确实变了
  const swapRes = await ev(`(function(){
    if (state.pages.length < 2) return { skip: true };
    const arr = state.pages;
    const before = arr.map(p => ({ src: p.srcNo, no: ovMeta(p).no }));
    const t = arr[0]; arr[0] = arr[1]; arr[1] = t;
    const after = arr.map(p => ({ src: p.srcNo, no: ovMeta(p).no }));
    const t2 = arr[0]; arr[0] = arr[1]; arr[1] = t2;
    return { before: before, after: after };
  })()`);
  if (swapRes.skip) ok('页码随排序自动重编号', true, '单页文件，跳过');
  else ok('页码随排序自动重编号：第 3 页拖到第 2 位，编号跟着变',
    swapRes.after.every((p, i) => p.no === i + 1) && swapRes.after[0].src !== swapRes.before[0].src,
    `源页序列 ${swapRes.before.map(p => p.src + '→' + p.no).join(',')} 交换后 ${swapRes.after.map(p => p.src + '→' + p.no).join(',')}`);

  // ---------- 5. 旋转后页码仍在底部 ----------
  const rotRes = await ev(`(async function(){
    const p = state.pages[0]; const oldRot = p.rot;
    p.rot = 90;
    const f = state.files.find(x=>x.id===p.fileId);
    const cv = await renderPdfPreviewCanvas(f.bytes, p);
    drawOps(cv.getContext('2d'), p, cv.width, cv.height, ovMeta(p));
    const ctx = cv.getContext('2d');
    const y0 = Math.floor(cv.height*0.93);
    const d = ctx.getImageData(0, y0, cv.width, cv.height-y0).data;
    let dark=0; for(let i=0;i<d.length;i+=4){ const lum=(d[i]*54+d[i+1]*183+d[i+2]*19)>>8; if(lum<120)dark++; }
    p.rot = oldRot;
    return { w: cv.width, h: cv.height, dark: dark };
  })()`);
  ok('页面旋转 90° 后页码仍在底部', rotRes.dark > 20, `版面 ${rotRes.w}×${rotRes.h}，底部深色像素 ${rotRes.dark}`);

  // ---------- 6. 叠加层强制栅格化 / 关闭直通 ----------
  const gate = await ev(`(function(){
    const p = state.pages[0];
    return { raster: pageNeedsRaster(p), vectorFlag: exportPixelsOf(p).vector, pt: passthroughFile() ? 'yes' : 'no' };
  })()`);
  ok('有叠加层时该页强制栅格且不通直通', gate.raster === true && gate.vectorFlag === false && gate.pt === 'no',
    `needsRaster=${gate.raster}｜vector=${gate.vectorFlag}｜直通=${gate.pt}`);

  // ---------- 7. 预览编辑层 ----------
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await waitFor(async () => await ev(`document.getElementById('preview').classList.contains('show') && ($('pvImg').src||'').length>100`), '预览打开');
  await sleep(500);
  const ovGeo = await ev(`(function(){const c=$('pvOverlay'), s=$('pvSheet');
    return { cw:c.width, ch:c.height, sw:s.offsetWidth, sh:s.offsetHeight };})()`);
  ok('overlay 画布与预览图同尺寸', ovGeo.cw === ovGeo.sw && ovGeo.ch === ovGeo.sh && ovGeo.cw > 0,
    `overlay ${ovGeo.cw}×${ovGeo.ch}｜sheet ${ovGeo.sw}×${ovGeo.sh}`);

  /* 回归防护：预览图必须按原始宽高比显示，且 overlay 完全覆盖图片的真实渲染区。
   * 一旦 sheet 与 img 互相以 max-*:100% 参照（循环约束），sheet 尺寸会偏离图片，
   * 表现为「在 A 处画、在 B 处显示」——这里用比例一致来卡住它。 */
  const geo2 = await ev(`(function(){const img=$('pvImg'), sh=$('pvSheet'), cv=$('pvOverlay');
    return { iw: img.offsetWidth, ih: img.offsetHeight, nw: img.naturalWidth, nh: img.naturalHeight,
             cw: cv.width, ch: cv.height };})()`);
  const rImg = geo2.nw / geo2.nh, rShow = geo2.iw / geo2.ih;
  ok('预览图按原始比例显示且 overlay 完全贴合',
    Math.abs(rShow - rImg) < 0.01 && geo2.cw === geo2.iw && geo2.ch === geo2.ih,
    `显示 ${geo2.iw}×${geo2.ih}（比 ${rShow.toFixed(3)}）｜原图比 ${rImg.toFixed(3)}｜overlay ${geo2.cw}×${geo2.ch}`);

  /* 用原生鼠标事件在 overlay 上拖出一个矩形，等价于画笔/马赛克操作 */
  const dragDraw = async (tool, x0, y0, x1, y1) => {
    await ev(`setTool(${JSON.stringify(tool)})`);
    const rect = await ev(`(function(){const r=$('pvOverlay').getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height};})()`);
    const px = f => rect.l + rect.w * f, py = f => rect.t + rect.h * f;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px(x0), y: py(y0), button: 'left', clickCount: 1, buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px((x0 + x1) / 2), y: py((y0 + y1) / 2), button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px(x1), y: py(y1), button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px(x1), y: py(y1), button: 'left', clickCount: 1, buttons: 0 });
  };

  await dragDraw('mosaic', 0.15, 0.12, 0.45, 0.30);
  await waitFor(async () => (await ev('pageOps(state.pages[0]).length')) === 1, '马赛克落op');
  const op1 = await ev(`JSON.stringify(pageOps(state.pages[0])[0])`);
  ok('马赛克：拖拽后生成 op', /"t":"mos"/.test(op1), op1);
  await sleep(700);

  await dragDraw('highlight', 0.15, 0.40, 0.50, 0.52);
  await waitFor(async () => (await ev('pageOps(state.pages[0]).length')) === 2, '高亮落op');
  await sleep(700);
  const op2 = await ev(`JSON.stringify(pageOps(state.pages[0])[1])`);
  ok('区域高亮：拖拽后生成 op', /"t":"hl"/.test(op2), op2);

  await dragDraw('text', 0.20, 0.60, 0.70, 0.70);
  await waitFor(async () => (await ev('pageOps(state.pages[0]).length')) === 3, '文本框落op');
  const op3 = await ev(`JSON.stringify(pageOps(state.pages[0])[2])`);
  ok('文本框：拖拽后生成 op 并弹出输入', /"t":"tx"/.test(op3) && (await ev(`getComputedStyle($('pvEditor')).display`)) === 'block', op3);
  await ev(`(function(){const ta=$('pvEditorTa');ta.value='这是一段中文测试文本';ta.dispatchEvent(new Event('blur'));})()`);
  await sleep(500);
  const txVal = await ev(`pageOps(state.pages[0])[2].text`);
  ok('文本框内容写回 op', txVal === '这是一段中文测试文本', '内容：' + txVal);

  /* 回归防护：拖出的归一化坐标必须等于「在 overlay 上拖的比例」，且绘制结果落在同一位置。
   * 这是「在 A 处画、在 B 处显示」类错位的直接验证。 */
  const geoOp = await ev(`(async function(){
    const p = state.pages[0];
    const op = pageOps(p).find(o => o.t === 'hl');
    if (!op) return null;
    const f = state.files.find(x => x.id === p.fileId);
    const cv = await renderPdfPreviewCanvas(f.bytes, p);
    drawOps(cv.getContext('2d'), p, cv.width, cv.height, ovMeta(p));
    const ctx = cv.getContext('2d');
    const at = (fx, fy) => { const d = ctx.getImageData(Math.round(fx*cv.width), Math.round(fy*cv.height), 1, 1).data; return [d[0], d[1], d[2]]; };
    return { op: { x: op.x, y: op.y, w: op.w, h: op.h },
             inside: at(op.x + op.w/2, op.y + op.h/2),
             outside: at(0.02, 0.02) };
  })()`);
  ok('拖拽位置与记录坐标一致（画在 A 就落在 A）',
    !!geoOp && Math.abs(geoOp.op.x - 0.15) < 0.02 && Math.abs(geoOp.op.y - 0.40) < 0.02
    && Math.abs(geoOp.op.w - 0.35) < 0.02 && Math.abs(geoOp.op.h - 0.12) < 0.02,
    geoOp ? `拖 (0.15,0.40)-(0.50,0.52) → 记录 x=${geoOp.op.x.toFixed(3)} y=${geoOp.op.y.toFixed(3)} w=${geoOp.op.w.toFixed(3)} h=${geoOp.op.h.toFixed(3)}` : '无高亮 op');
  // 高亮是 alpha 0.4 的 multiply，落在白底上是淡黄（R≈255、B 明显低），不是饱和黄
  ok('高亮绘制落在记录的位置上（像素验证）',
    !!geoOp && geoOp.inside[0] > 200 && (geoOp.inside[0] - geoOp.inside[2]) > 60
    && (geoOp.outside[0] - geoOp.outside[2]) < 15,
    geoOp ? `框内 RGB=${geoOp.inside.join(',')}（偏黄 ✓）｜框外 RGB=${geoOp.outside.join(',')}（应无黄色偏移）` : '无数据');

  /* 选中 + 移动 + 删除 */
  await ev(`setTool('select')`);
  await ev(`(function(){const e=new MouseEvent('mousedown',{button:0,bubbles:true,clientX:$('pvOverlay').getBoundingClientRect().left+$('pvOverlay').getBoundingClientRect().width*0.30,clientY:$('pvOverlay').getBoundingClientRect().top+$('pvOverlay').getBoundingClientRect().height*0.20});$('pvOverlay').dispatchEvent(e);})()`);
  await ev(`document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))`);
  await sleep(300);
  ok('选择工具可命中已有标注', (await ev('state.edit.sel')) >= 0, 'sel=' + await ev('state.edit.sel'));

  // ---------- 8. 撤销 / 重做 ----------
  // 最后一次改动是「文本框内容」，所以按内容而不是数量来验证
  const txt0 = await ev(`pageOps(state.pages[0])[2].text`);
  await ev('doUndo()');
  await sleep(400);
  const txt1 = await ev(`(pageOps(state.pages[0])[2]||{}).text`);
  await ev('doRedo()');
  await sleep(400);
  const txt2 = await ev(`(pageOps(state.pages[0])[2]||{}).text`);
  ok('撤销/重做对标注内容生效', txt1 !== txt0 && txt2 === txt0,
    `「${txt0}」→ 撤销「${txt1}」→ 重做「${txt2}」`);
  // 整体回退到「一个标注都没有」
  const back = await ev(`(function(){ for(let i=0;i<40 && pageOps(state.pages[0]).length;i++) doUndo(); return pageOps(state.pages[0]).length; })()`);
  ok('连续撤销可回退到无标注', back === 0, '剩余标注数 ' + back);
  await ev(`(function(){ for(let i=0;i<40;i++) doRedo(); })()`);
  await sleep(400);
  const fwd = await ev('pageOps(state.pages[0]).length');
  ok('连续重做可恢复到全部标注', fwd === 3, '恢复标注数 ' + fwd);

  // ---------- 9. 导出接入 ----------
  await ev(`(function(){window.__cap=null;window.__origDL=window.downloadBytes;
    window.downloadBytes=function(b,n){ window.__cap={ len:b.length, name:n }; };})()`);
  await ev(`doExport()`);
  await waitFor(async () => (await ev('!!window.__cap')) === true, '导出完成', 60000);
  const cap = await ev('JSON.stringify(window.__cap)');
  const capO = JSON.parse(cap);
  ok('导出生成 PDF 且体积合理', capO.len > 3000, `${capO.name}｜${capO.len} 字节`);

  // 关闭叠加层后矢量直通应恢复
  await check('wmOn', false); await check('pnOn', false);
  await sleep(400);
  await ev(`state.pages.forEach(p=>{p.ops=[];})`);
  await ev(`afterMutate()`);
  await sleep(400);
  const gate2 = await ev(`(function(){const p=state.pages[0];
    return { raster: pageNeedsRaster(p), vector: exportPixelsOf(p).vector, pt: passthroughFile()?'yes':'no' };})()`);
  ok('清空叠加层后矢量/直通能力恢复', gate2.raster === false && gate2.pt === 'yes',
    `needsRaster=${gate2.raster}｜vector=${gate2.vector}｜直通=${gate2.pt}`);

  // ---------- 9b. 缩略图内容要铺满版面（不能缩在正中央一小块） ----------
  const { nodeId: nid2 } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId: nid2 });
  await waitFor(async () => (await ev(`state.pages.some(p => p.kind === 'image')`)) === true, '图片页导入');
  await sleep(1200);
  const fill = await ev(`(async function(){
    const p = state.pages.find(x => x.kind === 'image');
    const im = new Image(); im.src = p.displayThumb; await im.decode();
    const cv = document.createElement('canvas'); cv.width = im.naturalWidth; cv.height = im.naturalHeight;
    const ctx = cv.getContext('2d'); ctx.drawImage(im, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4;
      if (d[i] < 246 || d[i+1] < 246 || d[i+2] < 246) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return { w: cv.width, h: cv.height,
             fw: (maxX - minX + 1) / cv.width, fh: (maxY - minY + 1) / cv.height };
  })()`);
  ok('缩略图内容铺满版面（不缩在中央）', fill.fw > 0.85 && fill.fh > 0.85,
    `缩略图 ${fill.w}×${fill.h}，内容占比 宽 ${(fill.fw * 100).toFixed(0)}% × 高 ${(fill.fh * 100).toFixed(0)}%（阈值 85%）`);

  // ---------- 10. 运行期无报错 ----------
  ok('运行期无控制台错误', errors.length === 0, errors.length ? errors.slice(0, 4).join(' ｜ ') : '无');

  await cdp.send('Page.close').catch(() => {});
  ws.close();

  const pass = results.filter(r => r.pass).length;
  console.log('\n══════ 叠加层回归测试 ══════');
  results.forEach((r, i) => console.log((r.pass ? '  ✅' : '  ❌') + ' ' + String(i + 1).padStart(2) + '. ' + r.name + '\n       ' + r.detail));
  console.log(`\n结果：${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('测试异常：', e.message); process.exit(2); });
