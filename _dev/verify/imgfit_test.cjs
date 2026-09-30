// 图片页「尺寸 / 适应页面 / 手动摆放」回归测试（CDP 驱动无头 Edge）
//
// 覆盖用户报的问题：
//   3) 预览里图片远小于实际（缩略图/导出却是铺满的）
//      → 根因：drawWpt 由渲染 DPI 反推，300DPI 预览得 43%、150DPI 导出得 87%
//   4) 图片默认没放到最大 → 现在 contain 等比放大到刚好触到页面边缘
//   5) 预览内可对图片做缩放与拖拽调整
//
// 用法：node imgfit_test.cjs [页面路径] [端口]
const path = require('path');
const { pathToFileURL } = require('url');
const { ensure: ensureBrowser } = require('./_edge.cjs');
const DEV = path.join(__dirname, '..');
const PAGE = pathToFileURL(process.argv[2] || path.join(DEV, 'index.html')).href;
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
  ok('图片导入成功', (await ev('state.pages.length')) === 1, '页数=1');

  // ---------- 1. 核心：版面尺寸必须与渲染 DPI 解耦 ----------
  const planCmp = await ev(`(function(){
    const p = state.pages[0], s = readImgSettings();
    const hi  = planForImage(p, QUALITY['q-high'], s);      // 预览用的 300 DPI
    const lo  = planForImage(p, QUALITY['q-lite'], s);      // 导出档 150 DPI
    const fa  = planForImage(p, QUALITY['q-faithful'], s);
    return { hiW: hi.drawWpt, loW: lo.drawWpt, faW: fa.drawWpt,
             pageW: hi.pageW, pageH: hi.pageH, drawH: hi.drawHpt,
             covW: hi.drawWpt / hi.pageW, covH: hi.drawHpt / hi.pageH,
             fit: hi.fit };})()`);
  ok('版面尺寸与渲染 DPI 解耦（预览=导出=各档一致）',
    Math.abs(planCmp.hiW - planCmp.loW) < 0.5 && Math.abs(planCmp.hiW - planCmp.faW) < 0.5,
    `300DPI=${planCmp.hiW.toFixed(1)}pt 150DPI=${planCmp.loW.toFixed(1)}pt 保真=${planCmp.faW.toFixed(1)}pt（修复前 300DPI 只有 150DPI 的一半）`);

  ok('默认 contain：等比放大到长边或宽边触到页面边缘',
    Math.abs(planCmp.covW - 1) < 0.01 || Math.abs(planCmp.covH - 1) < 0.01,
    `占页面 ${(planCmp.covW * 100).toFixed(1)}% × ${(planCmp.covH * 100).toFixed(1)}%（页面 ${planCmp.pageW.toFixed(0)}×${planCmp.pageH.toFixed(0)}pt）`);

  ok('默认放大后图片占页面 ≥ 95%', planCmp.covW >= 0.95 && planCmp.covH >= 0.95,
    `${(planCmp.covW * 100).toFixed(1)}% × ${(planCmp.covH * 100).toFixed(1)}%`);

  // ---------- 2. 像素级：预览版面里图片内容确实铺满 ----------
  const cover = await ev(`(function(){
    const p = state.pages[0];
    const pc = imagePageCanvas(p, 600).cv;      // 预览同一条路径（imagePageCanvas）
    const ctx = pc.getContext('2d');
    const d = ctx.getImageData(0, 0, pc.width, pc.height).data;
    let minX = pc.width, maxX = -1, minY = pc.height, maxY = -1;
    for (let y = 0; y < pc.height; y++) {
      for (let x = 0; x < pc.width; x++) {
        const i = (y * pc.width + x) * 4;
        if (d[i] < 245 || d[i+1] < 245 || d[i+2] < 245) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return { w: pc.width, h: pc.height,
             coverW: (maxX - minX + 1) / pc.width, coverH: (maxY - minY + 1) / pc.height };})()`);
  ok('预览版面里图片内容铺满页面', cover.coverW >= 0.9 || cover.coverH >= 0.9,
    `内容范围 宽 ${(cover.coverW * 100).toFixed(1)}% × 高 ${(cover.coverH * 100).toFixed(1)}%（版面 ${cover.w}×${cover.h}）`);

  // ---------- 3. 打开预览 ----------
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await waitFor(async () => await ev(`document.getElementById('preview').classList.contains('show') && ($('pvImg').src||'').length>100`), '预览打开');
  await sleep(900);

  ok('图片页出现「图片」与「适应页面」按钮',
    (await ev(`$('tbImg').style.display !== 'none' && $('tbImgFit').style.display !== 'none'`)) === true,
    '两个按钮均可见');

  // ---------- 4. 缩放滑条调整图片大小 ----------
  await ev(`setTool('image')`);
  const z0 = await ev(`(function(){const p=state.pages[0];
    const plan=planForImage(p, effQualityOf(p), readImgSettings()); return plan.drawWpt/plan.pageW;})()`);
  await ev(`(function(){const e=$('edSize'); e.value=60; e.dispatchEvent(new Event('input')); return 1;})()`);
  await sleep(1200);
  const z1 = await ev(`(function(){const p=state.pages[0];
    const plan=planForImage(p, effQualityOf(p), readImgSettings()); return plan.drawWpt/plan.pageW;})()`);
  ok('缩放滑条可缩小图片', z1 < z0 - 0.2,
    `占页面宽 ${(z0 * 100).toFixed(1)}% → ${(z1 * 100).toFixed(1)}%（滑到 60%）`);
  ok('缩放值写回 page.imgAdj', await ev(`(function(){const a=state.pages[0].imgAdj; return !!(a && Math.abs(a.s-0.6)<0.02);})()`),
    'imgAdj.s=' + (await ev(`(state.pages[0].imgAdj||{}).s || 'null'`)));

  await ev(`(function(){const e=$('edSize'); e.value=160; e.dispatchEvent(new Event('input')); return 1;})()`);
  await sleep(1200);
  const z2 = await ev(`(function(){const p=state.pages[0];
    const plan=planForImage(p, effQualityOf(p), readImgSettings()); return plan.drawWpt/plan.pageW;})()`);
  ok('缩放滑条可放大图片', z2 > z0 + 0.3, `占页面宽 ${(z1 * 100).toFixed(1)}% → ${(z2 * 100).toFixed(1)}%（滑到 160%）`);

  // ---------- 5. 拖拽移动图片 ----------
  const rect = await ev(`(function(){const r=$('pvOverlay').getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height};})()`);
  const P = (fx, fy) => [rect.l + rect.w * fx, rect.t + rect.h * fy];
  const raw = (t, X, Y) => cdp.send('Input.dispatchMouseEvent', { type: t, x: X, y: Y, button: 'left', clickCount: 1, buttons: t === 'mouseReleased' ? 0 : 1 });
  const off0 = await ev(`(function(){const p=state.pages[0];
    const plan=planForImage(p, effQualityOf(p), readImgSettings()); return plan.offX/plan.pageW;})()`);
  {
    const [a, b] = P(0.5, 0.5); await raw('mousePressed', a, b);
    const [c, d] = P(0.38, 0.42); await raw('mouseMoved', c, d); await raw('mouseReleased', c, d);
  }
  await sleep(1200);
  const off1 = await ev(`(function(){const p=state.pages[0];
    const plan=planForImage(p, effQualityOf(p), readImgSettings()); return plan.offX/plan.pageW;})()`);
  ok('拖拽可移动图片在页面中的位置', Math.abs(off1 - off0) > 0.03,
    `offX/页宽 ${(off0 * 100).toFixed(1)}% → ${(off1 * 100).toFixed(1)}%`);

  // ---------- 6. 撤销 ----------
  await ev(`doUndo(); 1`);
  await sleep(1200);
  const off2 = await ev(`(function(){const p=state.pages[0];
    const plan=planForImage(p, effQualityOf(p), readImgSettings()); return plan.offX/plan.pageW;})()`);
  ok('撤销可恢复图片位置', Math.abs(off2 - off0) < 0.02,
    `回到 ${(off2 * 100).toFixed(1)}%（期望 ${(off0 * 100).toFixed(1)}%）`);

  // ---------- 7. 「适应页面」复位 ----------
  await ev(`$('tbImgFit').click(); 1`);
  await sleep(1400);
  const afterFit = await ev(`(function(){
    const p=state.pages[0];
    return { adj: p.imgAdj ? JSON.stringify(p.imgAdj) : null,
             covW: planForImage(p, effQualityOf(p), readImgSettings()).drawWpt / planForImage(p, effQualityOf(p), readImgSettings()).pageW };})()`);
  ok('「适应页面」清除手动调整', afterFit.adj === null, 'imgAdj=' + afterFit.adj);
  ok('复位后重新铺满页面', afterFit.covW >= 0.99, `占页面宽 ${(afterFit.covW * 100).toFixed(1)}%`);

  // ---------- 8. 缩略图也跟随同一布局 ----------
  const thumbCover = await ev(`(function(){
    const p = state.pages[0];
    const plan = planForImage(p, effQualityOf(p), readImgSettings());
    return { covW: plan.drawWpt / plan.pageW, covH: plan.drawHpt / plan.pageH };})()`);
  ok('缩略图与预览共用同一布局规则', thumbCover.covW >= 0.99 || thumbCover.covH >= 0.99,
    `缩略图侧占比 ${(thumbCover.covW * 100).toFixed(1)}% × ${(thumbCover.covH * 100).toFixed(1)}%`);

  // ---------- 9. 导出提示报「整页」像素 ----------
  const px = await ev(`(function(){const p=state.pages[0];
    const q=effQualityOf(p); const e=exportPixelsOf(p);
    return { w:e.w, h:e.h, dpi:e.dpi, pageW: e.w, ratio: e.w/e.h };})()`);
  ok('导出像素按整页报（不再是图片原始像素）',
    px.w > 600 && Math.abs(px.ratio - 595 / 842) < 0.05,
    `${px.w}×${px.h} @${px.dpi}DPI（比例 ${px.ratio.toFixed(3)}，A4 应为 0.707）`);

  // ---------- 10. 图片页预览必须跟随画质档位（否则用户切档位看不出差别） ----------
  const prevPx = {};
  for (const q of ['q-faithful', 'q-high', 'q-std', 'q-lite']) {
    prevPx[q] = await ev(`(async function(){
      $('qualitySel').value='${q}'; $('qualitySel').dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 1500));
      const im = $('pvImg'); return im.naturalWidth + 'x' + im.naturalHeight;})()`);
    await ev(`(function(){$('pvReset').click(); return 1;})()`);
    await sleep(300);
  }
  const wOf = s => parseInt(String(s).split('x')[0], 10);
  ok('图片页预览像素随画质档位变化（切档位能看出清晰度差别）',
    wOf(prevPx['q-high']) > wOf(prevPx['q-std']) && wOf(prevPx['q-std']) > wOf(prevPx['q-lite']),
    `保真 ${prevPx['q-faithful']}｜高清 ${prevPx['q-high']}｜标准 ${prevPx['q-std']}｜精简 ${prevPx['q-lite']}`);
  ok('矢量保真档按 300 DPI 预览（保持清晰，不跟随"原样"降质）',
    wOf(prevPx['q-faithful']) === wOf(prevPx['q-high']),
    `保真 ${prevPx['q-faithful']} vs 高清 ${prevPx['q-high']}`);

  // ---------- 11. 横版 / 竖版：面板宽度必须一致，页面仍按 contain 各自铺满高度 ----------
  // 历史教训：曾想用「显示面积对齐」来消除横竖版的观感差异，给横版加了宽度上限
  // （maxW = 舞台高度），结果把横版 A4 从 990×700 压到 642×454 —— 用户明确要求恢复原样。
  // 真正要解决的是【预览面板宽度】随横竖版变化（1491 vs 1378），那属于 lockPreviewWidth()
  // 的职责，已改由 preview_width_test.cjs 守护。这里只守「横版不被压小」+「面板宽度不变」。
  const dims = () => ev(`(function(){
    const im=$('pvImg').getBoundingClientRect();
    const st=document.querySelector('#preview .stage').getBoundingClientRect();
    const bx=document.querySelector('#preview .box').getBoundingClientRect();
    return { w: Math.round(im.width), h: Math.round(im.height),
             sw: Math.round(st.width), sh: Math.round(st.height),
             bw: Math.round(bx.width), bl: Math.round(bx.left), br: Math.round(bx.right),
             a: Math.round(im.width*im.height/1000) };})()`);
  const openPreview = async () => { await ev(`document.querySelector('.card .thumb').click(); 1`); await sleep(1800); };

  const showV = await dims();
  await ev(`(function(){ closePreview(); state.pages[0].rot = 90; renderList(); updateFoot(); return 1;})()`);
  await sleep(600);
  await openPreview();
  const showH = await dims();

  ok('横版页仍按 contain 铺满舞台高度（初始尺寸未被压小）',
    showH.h >= showH.sh - 2 && Math.abs(showH.w / showH.h - showV.h / showV.w) < 0.02,
    `横版 ${showH.w}×${showH.h} vs 舞台 ${showH.sw}×${showH.sh}（竖版 ${showV.w}×${showV.h}）`);
  ok('横版页宽度大于竖版（横版本来就该更宽，不再被强行压成同面积）',
    showH.w > showV.w * 1.3,
    `横版宽 ${showH.w} ／ 竖版宽 ${showV.w}（比值 ${(showH.w / showV.w).toFixed(2)}）`);
  ok('横版与竖版的【面板宽度】完全一致（这才是用户要的一致）',
    Math.abs(showV.bw - showH.bw) <= 2 && Math.abs(showV.bl - showH.bl) <= 2,
    `竖版 ${showV.bw}px x[${showV.bl},${showV.br}] ｜ 横版 ${showH.bw}px x[${showH.bl},${showH.br}]`);
  await ev(`(function(){ closePreview(); state.pages[0].rot = 0; renderList(); return 1;})()`);

  // ---------- 12. 无控制台错误 ----------
  ok('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' ｜ ') || '无');

  const pass = results.filter(r => r.pass).length;
  console.log('\n=== 结果 ===');
  results.forEach(r => console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? '  ' + r.detail : ''}`));
  console.log(`\n=== ${pass} 通过 / ${results.length - pass} 失败 ===`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  console.log('\n=== 中断时已完成 ===');
  results.forEach(r => console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? '  ' + r.detail : ''}`));
  console.error('\n测试异常：', e.message);
  process.exit(1);
});
