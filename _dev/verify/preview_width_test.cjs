// 预览面板宽度一致性回归（CDP 驱动无头 Edge）
//
// 覆盖用户报的问题：
//   「横向和纵向的页面，预览窗口本身的宽度表现不一致」——用户用红框量出
//   横版 1504px / 竖版 1389px（1912×948 视口下），差 115px。
//   根因：lockPreviewWidth() 里 boxW 掺了「当前页按宽高比需要的宽度 fitW」，
//         stageMax = fitW×2.4 再取 min，于是横版被 78vw 限住、竖版被 stageMax 限住。
//   修法：面板宽度只由视口决定，与页面横竖版 / 工具条文案全部解耦。
//
// 同时守住「横版 A4 初始尺寸不能变小」——曾经用 maxW=舞台高度 压过宽度，
// 把横版 A4 从约 990×700 压到 642×454，用户明确要求恢复原样。
//
// 用法：node preview_width_test.cjs [页面路径] [端口]
const path = require('path');
const { pathToFileURL } = require('url');
const { ensure: ensureBrowser } = require('./_edge.cjs');

const DEV = path.join(__dirname, '..');
const PAGE = pathToFileURL(process.argv[2] || path.join(DEV, 'index.html')).href;
const IMG = path.join(__dirname, 'fixtures', '扫描件样本.png');
const PDF = path.join(DEV, 'test', '测试文件A.pdf');

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms = 40000) {
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
  const ev = async expr => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };
  const setViewport = (w, h) => cdp.send('Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 1, mobile: false });

  // 一次完整的「打开预览 → 量尺寸」：返回面板 / 舞台 / 图片三者尺寸
  const measure = () => ev(`(function(){
    const box = document.querySelector('#preview .box');
    const stage = document.querySelector('#preview .stage');
    const im = $('pvImg');
    const br = box.getBoundingClientRect(), sr = stage.getBoundingClientRect(), ir = im.getBoundingClientRect();
    return { boxW: Math.round(br.width), boxL: Math.round(br.left), boxR: Math.round(br.right),
             stageW: Math.round(sr.width), stageH: Math.round(sr.height),
             imgW: Math.round(ir.width), imgH: Math.round(ir.height),
             ratio: +(ir.width / Math.max(ir.height, 1)).toFixed(3) };})()`);

  await waitFor(async () => (await ev('document.readyState')) === 'complete', '页面加载');
  await setViewport(1912, 948);
  await sleep(500);
  await ev(`(function(){try{localStorage.clear()}catch(e){}
    $('qualitySel').value='q-high';$('enhanceSel').value='none';
    readImgSettings();applyOverlayUI();saveSettings();return 1;})()`);

  const { root } = await cdp.send('DOM.getDocument');
  const setFiles = async files => {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
    await cdp.send('DOM.setFileInputFiles', { files, nodeId });
  };

  /* ---------- 场景 A：图片页，竖版 vs 横版（用户截图就是 1912×948 视口） ---------- */
  await setFiles([IMG]);
  await waitFor(async () => (await ev('state.pages.length')) === 1, '图片导入');
  await sleep(600);
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await sleep(1800);
  const A_v = await measure();
  const stageH_v = A_v.stageH;

  await ev(`(function(){closePreview();state.pages[0].rot=90;renderList();updateFoot();return 1;})()`);
  await sleep(700);
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await sleep(1800);
  const A_h = await measure();

  ok('① 竖版与横版的面板宽度一致（差 ≤ 2px）', Math.abs(A_v.boxW - A_h.boxW) <= 2,
    `竖版 ${A_v.boxW}px ｜ 横版 ${A_h.boxW}px ｜ 差值 ${Math.abs(A_v.boxW - A_h.boxW)}px`);
  ok('② 面板左右边界也一致（不只是宽度）',
    Math.abs(A_v.boxL - A_h.boxL) <= 2 && Math.abs(A_v.boxR - A_h.boxR) <= 2,
    `竖版 x[${A_v.boxL},${A_v.boxR}] ｜ 横版 x[${A_h.boxL},${A_h.boxR}]`);
  ok('③ 横版页仍按 contain 铺满舞台高度（初始尺寸未被压小）',
    A_h.imgH >= A_h.stageH - 2 && A_h.imgH > A_v.imgH * 0.98,
    `横版图片高 ${A_h.imgH} vs 舞台高 ${A_h.stageH}（竖版图片高 ${A_v.imgH}）`);
  ok('④ 横版宽高比正确（宽 > 高，未被压成近方形）', A_h.ratio > 1.2,
    `横版 显示 ${A_h.imgW}×${A_h.imgH}（比 ${A_h.ratio}）`);
  ok('⑤ 竖版占满舞台高度', A_v.imgH >= A_v.stageH - 2,
    `竖版图片高 ${A_v.imgH} vs 舞台高 ${stageH_v}`);

  /* ---------- 场景 B：多页 PDF 逐页翻，面板宽度全程不变 ---------- */
  await ev(`(function(){ closePreview(); state.pages=[]; state.files=[]; state.thumbCache={};
    renderList(); updateFoot(); return 1; })()`);
  await sleep(300);
  await setFiles([PDF]);
  await waitFor(async () => (await ev('state.pages.length')) >= 2, 'PDF 导入', 60000);
  await sleep(1500);
  const pageCount = await ev('state.pages.length');

  const perPage = [];
  for (let i = 0; i < pageCount; i++) {
    await ev(`(function(){ const c=document.querySelectorAll('.card:not(.skel)')[${i}]; c.querySelector('.thumb').click(); return 1; })()`);
    await sleep(1600);
    const m = await measure();
    perPage.push({ i, ...m });
    await ev('closePreview(); 1');
    await sleep(250);
  }
  const boxWs = perPage.map(m => m.boxW);
  const spread = Math.max(...boxWs) - Math.min(...boxWs);
  ok('⑥ PDF 逐页翻页时面板宽度全程不变（差 ≤ 2px）', spread <= 2,
    `${pageCount} 页宽度 ${boxWs.join(' / ')} ｜ 极差 ${spread}px`);

  // 把其中一页转成横版，再量一次
  await ev(`(function(){ state.pages[1] && (state.pages[1].rot = 90); renderList(); updateFoot(); return 1; })()`);
  await sleep(900);
  await ev(`(function(){ const c=document.querySelectorAll('.card:not(.skel)')[1]; c.querySelector('.thumb').click(); return 1; })()`);
  await sleep(2000);
  const B_h = await measure();
  ok('⑦ PDF 横版页与竖版页面板宽度一致（差 ≤ 2px）', Math.abs(B_h.boxW - boxWs[0]) <= 2,
    `竖版 ${boxWs[0]}px ｜ 横版(旋转 90°) ${B_h.boxW}px`);
  await ev('closePreview(); 1');

  /* ---------- 场景 C：换一个视口，面板宽度依然只由视口决定 ---------- */
  await ev(`(function(){ state.pages.forEach(p => p.rot = 0); renderList(); return 1; })()`);
  await setViewport(1440, 900);
  await sleep(600);
  await ev(`(function(){ const c=document.querySelectorAll('.card:not(.skel)')[0]; c.querySelector('.thumb').click(); return 1; })()`);
  await sleep(1800);
  const C_v = await measure();
  await ev('closePreview(); 1'); await sleep(300);
  await ev(`(function(){ state.pages[0].rot = 90; renderList(); return 1; })()`);
  await sleep(900);
  await ev(`(function(){ const c=document.querySelectorAll('.card:not(.skel)')[0]; c.querySelector('.thumb').click(); return 1; })()`);
  await sleep(1800);
  const C_h = await measure();
  ok('⑧ 1440×900 视口下横竖版面板宽度也一致', Math.abs(C_v.boxW - C_h.boxW) <= 2,
    `竖版 ${C_v.boxW}px ｜ 横版 ${C_h.boxW}px ｜（与 1912 视口的 ${A_v.boxW}px 不同属正常）`);

  /* ---------- 场景 D：工具条文案变化（单页设置 vs 恢复全局）不影响面板宽度 ---------- */
  await ev('closePreview(); 1'); await sleep(300);
  await ev(`(function(){ state.pages[0].rot = 0; state.pages[0].ovq = 'q-lite'; renderList(); return 1; })()`);
  await sleep(700);
  await ev(`(function(){ const c=document.querySelectorAll('.card:not(.skel)')[0]; c.querySelector('.thumb').click(); return 1; })()`);
  await sleep(1800);
  const D_override = await measure();
  const toolsTxt = await ev(`($('pvTools').innerText || '').replace(/\\s+/g,' ').trim()`);
  await ev('closePreview(); 1'); await sleep(300);
  await ev(`(function(){ state.pages[0].ovq = null; renderList(); return 1; })()`);
  await sleep(700);
  await ev(`(function(){ const c=document.querySelectorAll('.card:not(.skel)')[0]; c.querySelector('.thumb').click(); return 1; })()`);
  await sleep(1800);
  const D_follow = await measure();
  ok('⑨ 单页设置 / 跟随全局 两种工具条文案下面板宽度不变',
    Math.abs(D_override.boxW - D_follow.boxW) <= 2,
    `已单独设置 ${D_override.boxW}px ｜ 跟随全局 ${D_follow.boxW}px ｜ 文案「${toolsTxt.slice(0, 46)}」`);
  await ev('closePreview(); 1');

  ok('⑩ 运行期无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' ｜ ') || '无');

  const pass = results.filter(r => r.pass).length;
  console.log('\n=== 结果 ===');
  results.forEach(r => console.log('  ' + (r.pass ? '✅' : '❌') + ' ' + r.name + (r.detail ? '\n       ' + r.detail : '')));
  console.log(`\n=== ${pass} 通过 / ${results.length - pass} 失败 ===`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('失败：', e && e.message || e); process.exit(1); });
