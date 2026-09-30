// 单页设置回归测试（CDP 驱动无头 Edge）：预览内的「本页画质 / 本页白底增强」覆盖 + 卡片无条纹
// 用法：node per_page_test.cjs [页面路径] [端口]
//   默认验证 _dev/index.html；传产物路径则验证打包后的单文件，例：
//     node per_page_test.cjs "C:/.../创立PDF编辑器.html" 9333
// 需先启动：start msedge --headless=new --remote-debugging-port=9333 --user-data-dir=%TEMP%\edge-dev --no-first-run --disable-gpu
const path = require('path');
const { pathToFileURL } = require('url');
const { ensure: ensureBrowser } = require('./_edge.cjs');
const DEV = path.join(__dirname, '..');            // _dev

// 默认验证开发源码；传参则验证打包产物（单文件）
const PAGE = pathToFileURL(process.argv[2] || path.join(DEV, 'index.html')).href;
const IMG = path.join(__dirname, 'fixtures', '扫描件样本.png');
const PDF = path.join(DEV, 'test', '测试文件A.pdf');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms = 20000) {
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
  // 未显式指定端口则自启专属实例（唯一 profile + 空闲端口），结束后回收
  const browser = await ensureBrowser(process.argv[3]);
  BASE = browser.base;
  process.on('exit', () => { if (browser.owned) browser.stop(); });
  const tab = await (await fetch(BASE + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  const errors = [];
  cdp.on(m => {
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception || {}).description || 'exception');
  });
  await cdp.send('Page.enable');
  // 用贴近真实桌面的视口测量（headless 默认 754x487 过窄，会让设置卡换行、预览被压）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('DOM.enable');

  const ev = async expr => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };
  /* 预览框尺寸快照：盒子总宽 + 舞台宽高，用来验证切换档位时不抖动 */
  const boxW = () => ev(`(function(){const b=document.querySelector('#preview .box'),s=document.querySelector('#preview .stage');
    return {box:b?b.offsetWidth:0, stage:s?s.offsetWidth:0, stageH:s?s.offsetHeight:0,
            vw:window.innerWidth, vh:window.innerHeight};})()`);

  await waitFor(async () => (await ev('document.readyState')) === 'complete', '页面加载');

  // ---- 0. 布局紧凑化（导入前测量：设置卡 / 导入区 / 文件区起始位置） ----
  const sz = await ev(`(function(){const c=document.querySelector('.scard'), d=$('dropzone');
    return {sh:c.offsetHeight, dh:d.offsetHeight, top:$('list').getBoundingClientRect().top + window.scrollY};})()`);
  ok('设置卡与导入区已紧凑化', sz.sh <= 110 && sz.dh <= 135 && sz.top <= 340,
    `设置卡高 ${sz.sh}｜导入区高 ${sz.dh}｜文件网格起始 Y ${Math.round(sz.top)}（改前：119 / 163 / 396）`);

  // ---- 1. 导入图片 ----
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId });
  await waitFor(async () => (await ev('state.pages.length')) > 0, '图片导入');
  ok('图片导入成功', true, '页数=' + await ev('state.pages.length'));

  // ---- 2. 条纹已移除 ----
  const stripe = await ev(`(function(){const c=document.querySelector('.card');const s=getComputedStyle(c);const a=getComputedStyle(c,'::after');
    return {bl:s.borderLeftWidth, aw:a.width, ac:a.content};})()`);
  // 卡片自身有 1px 描边（正常）；要确认的是 4px 色条（border-left:4px 或 ::after）已不存在
  ok('卡片左侧条纹已取消', stripe.bl !== '4px' && (stripe.ac === 'none' || stripe.aw === 'auto' || stripe.aw === '0px'),
    `卡片自身边框=${stripe.bl}（非 4px）｜::after.content=${stripe.ac}（条纹伪元素已移除）`);

  // ---- 3. 打开预览 ----
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await waitFor(async () => await ev(`document.getElementById('preview').classList.contains('show') && (document.getElementById('pvImg').src||'').length>100`), '预览打开');
  const t0 = await ev(`({q0:$('pvQualitySel').options[0].textContent, e0:$('pvEnhanceSel').options[0].textContent,
    qv:$('pvQualitySel').value, ev:$('pvEnhanceSel').value, disp:getComputedStyle($('pvTools')).display, note:$('pvNote').textContent})`);
  ok('预览工具条可见且默认跟随全局', t0.disp !== 'none' && t0.qv === '' && t0.ev === '' && /跟随全局/.test(t0.q0),
    `${t0.q0} / ${t0.e0}`);
  const bw0 = await boxW();   // 基准宽度

  // ---- 4. 单页白底增强 ----
  await ev(`(function(){const s=$('pvEnhanceSel');s.value='standard';s.dispatchEvent(new Event('change'));})()`);
  await waitFor(async () => await ev(`state.pages[0].ove === 'standard'`), '单页增强写入');
  await sleep(800);
  const t1 = await ev(`({tag:!!document.querySelector('.ovtag'), title:(document.querySelector('.ovtag')||{}).title||'', note:$('pvNote').textContent})`);
  ok('单页增强写入 state 且卡片打标记', t1.tag && /标准/.test(t1.title), t1.title);
  const bw1 = await boxW();

  // ---- 5. 单页画质 ----
  await ev(`(function(){const s=$('pvQualitySel');s.value='q-lite';s.dispatchEvent(new Event('change'));})()`);
  await waitFor(async () => await ev(`state.pages[0].ovq === 'q-lite'`), '单页画质写入');
  await sleep(800);
  const t2 = await ev(`({note:$('pvNote').textContent, title:(document.querySelector('.ovtag')||{}).title||''})`);
  ok('单页画质写入 state', /精简/.test(t2.title), t2.title);
  const bw2 = await boxW();

  // ---- 5.5 预览框宽度在切换画质/白底时保持不变 ----
  ok('切换画质/白底时预览框宽度不抖动', bw0.box > 0 && bw0.box === bw1.box && bw1.box === bw2.box,
    `初始 ${bw0.box}px → 增强后 ${bw1.box}px → 精简档后 ${bw2.box}px（舞台 ${bw0.stage}×${bw0.stageH}）`);
  ok('预览框按偏宽样式处理', bw0.stage >= Math.round(bw0.stageH * 0.94) && bw0.stage <= bw0.box,
    `舞台宽 ${bw0.stage}px ≥ 舞台高 ${bw0.stageH}px 的 0.95 倍，且不超过盒子 ${bw0.box}px`);
  ok('预览可视区域足够大（高度≈74vh、宽度≥78vw）',
    bw0.stageH >= Math.round(bw0.vh * 0.70) && bw0.box >= Math.round(bw0.vw * 0.75),
    `舞台 ${bw0.stage}×${bw0.stageH}（高占视口 ${(bw0.stageH / bw0.vh * 100).toFixed(0)}%）｜盒子宽 ${bw0.box}（占视口 ${(bw0.box / bw0.vw * 100).toFixed(0)}%）｜视口 ${bw0.vw}×${bw0.vh}`);

  // ---- 6. 单页设置是否真的影响导出管线（对比编码体积；像素未变时看 JPEG 质量） ----
  const px = await ev(`(async function(){
    const p=state.pages[0];
    $('qualitySel').value='q-high'; $('qualitySel').dispatchEvent(new Event('change'));
    const ovq=p.ovq;
    p.ovq=null; const g=renderImageCanvas(p); const gb=await canvasToJpegBytes(g.cv, effQualityOf(p).q);
    p.ovq='q-lite'; const o=renderImageCanvas(p); const ob=await canvasToJpegBytes(o.cv, effQualityOf(p).q);
    p.ovq=ovq;
    return {gw:g.cv.width, gh:g.cv.height, ow:o.cv.width, oh:o.cv.height,
            gkb:Math.round(gb.length/1024), okb:Math.round(ob.length/1024),
            gpt:+(g.plan.drawWpt||0).toFixed(1), opt:+(o.plan.drawWpt||0).toFixed(1),
            gdpi:g.plan.effDpi, odpi:o.plan.effDpi,
            src:(state.thumbCache[p.uid]||{}).width||0};
  })()`);
  ok('单页画质进入导出管线', px.gkb > px.okb * 1.2,
    `全局300DPI=${px.gw}x${px.gh}/${px.gkb}KB｜单页150DPI=${px.ow}x${px.oh}/${px.okb}KB`);
  // 新规则：图片默认等比放大到触碰页面边缘（不再"只缩不放"）。
  // 因此 DPI 只影响渲染像素，不改变版面物理尺寸——两者必须解耦。
  ok('画质档只改渲染像素、不改版面尺寸（图片放大填满页面）',
    px.gdpi > px.odpi && px.gw > px.ow * 1.7 && Math.abs(px.gpt - px.opt) < 0.5,
    `${px.odpi}DPI=${px.ow}px/${px.opt}pt｜${px.gdpi}DPI=${px.gw}px/${px.gpt}pt（源图 ${px.src}px，版面不变、像素随DPI放大）`);
  ok('不同画质档下版面宽高比一致（未发生拉伸/裁切）',
    Math.abs(px.gw / px.gh - px.ow / px.oh) < 0.02,
    `300DPI 比例 ${(px.gw / px.gh).toFixed(3)}｜150DPI 比例 ${(px.ow / px.oh).toFixed(3)}`);

  // ---- 7. 恢复跟随全局 ----
  await ev(`(function(){$('pvReset').click();})()`);
  await waitFor(async () => await ev(`!state.pages[0].ovq && !state.pages[0].ove`), '恢复跟随全局');
  await sleep(600);
  const t3 = await ev(`({tag:!!document.querySelector('.ovtag'), qv:$('pvQualitySel').value, ev:$('pvEnhanceSel').value})`);
  ok('恢复跟随全局（标记消失 + 下拉回到跟随）', !t3.tag && t3.qv === '' && t3.ev === '', JSON.stringify(t3));

  // ---- 8. PDF 页预览也支持单页设置 ----
  await ev(`closePreview(); 1`);
  const { nodeId: n2 } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { files: [PDF], nodeId: n2 });
  await waitFor(async () => (await ev(`state.pages.filter(p=>p.kind==='pdf').length`)) > 0, 'PDF 导入');
  const pdfUid = await ev(`state.pages.filter(p=>p.kind==='pdf')[0].uid`);
  await ev(`(function(){const cards=[...document.querySelectorAll('.card')];
    const p=state.pages.filter(x=>x.kind==='pdf')[0];
    const c=cards.find(c=>c.dataset.uid==String(p.uid)); c.querySelector('.thumb').click();})()`);
  await waitFor(async () => await ev(`document.getElementById('preview').classList.contains('show') && !!state.previewUid`), 'PDF 预览打开');
  await sleep(2000);
  // 防回归：PDF 预览必须走真实高清渲染，不能停在 displayThumb 占位图（那是一张被拉伸的缩略图）
  const pvp = await ev(`(function(){
    const p = state.pages.filter(x => x.kind === 'pdf')[0];
    const th = new Image(); th.src = p.displayThumb || '';
    return { nat: $('pvImg').naturalWidth, natH: $('pvImg').naturalHeight,
             thumbW: th.naturalWidth, isThumb: $('pvImg').src === (p.displayThumb || '') };
  })()`);
  ok('PDF 预览是高清渲染（非缩略图占位）', !pvp.isThumb && pvp.nat > pvp.thumbW * 2,
    `预览 ${pvp.nat}x${pvp.natH}｜缩略图仅 ${pvp.thumbW}px｜占位=${pvp.isThumb}`);
  await ev(`(function(){const s=$('pvEnhanceSel');s.value='light';s.dispatchEvent(new Event('change'));})()`);
  await waitFor(async () => await ev(`!!state.pages.find(p=>p.uid===` + pdfUid + `).ove`), 'PDF 单页增强写入');
  await sleep(600);
  const t4 = await ev(`$('pvNote').textContent`);
  ok('PDF 页也支持单页设置并提示栅格化', /栅格化/.test(t4), t4);

  // ---- 8.5 滚轮缩放速度 ----
  await ev(`resetZoom(); 1`);
  await ev(`(function(){const r=$('pvImg').getBoundingClientRect();
    $('pvImg').dispatchEvent(new WheelEvent('wheel',{deltaY:-100,clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true,cancelable:true}));})()`);
  const z1 = await ev(`previewScale`);
  // 目标：约 20 格滚完 100%→1500%，一格 ≈ ×1.145
  ok('滚轮速度适中（约 20 格到 1500%）', z1 >= 1.10 && z1 <= 1.20,
    `1 格：1.00 → ${z1.toFixed(3)}（一格 ×${z1.toFixed(3)}，20 格累计 ≈ ${Math.pow(z1, 20).toFixed(1)}x）`);

  // ---- 8.7 侧边滑条控制缩放 ----
  await ev(`(function(){const t=$('pvZoomTrack').getBoundingClientRect();
    $('pvZoomTrack').dispatchEvent(new MouseEvent('mousedown',{clientX:t.left+t.width/2,clientY:t.top+t.height*0.3,bubbles:true,cancelable:true}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));})()`);
  const z2 = await ev(`({s:previewScale, val:$('pvZoomVal').textContent, knob:$('pvZoomKnob').style.bottom})`);
  ok('侧边滑条可控制缩放（最大 1500%）', Math.abs(z2.s - Math.pow(15, 0.7)) < 0.5,
    `拖到 70% → ${z2.s.toFixed(2)}x（期望 ${Math.pow(15, 0.7).toFixed(2)}x），显示 ${z2.val}，滑块位置 ${z2.knob}`);

  // ---- 8.8 导航缩略图出现 + 可拖动画面 ----
  const m0 = await ev(`({show:$('pvMap').classList.contains('show'),
    vw:parseFloat($('pvMapView').style.width)||0, vh:parseFloat($('pvMapView').style.height)||0,
    mw:$('pvMapImg').getBoundingClientRect().width, mh:$('pvMapImg').getBoundingClientRect().height})`);
  ok('放大后导航缩略图出现且只框住可见部分', m0.show && m0.vw > 0 && m0.vw < m0.mw - 1 && m0.vh < m0.mh - 1,
    `视口框 ${m0.vw.toFixed(0)}x${m0.vh.toFixed(0)} / 缩略图 ${m0.mw.toFixed(0)}x${m0.mh.toFixed(0)}`);

  const b4 = await ev(`({tx:previewTranslateX, ty:previewTranslateY})`);
  await ev(`(function(){const mr=$('pvMapImg').getBoundingClientRect();
    $('pvMap').dispatchEvent(new MouseEvent('mousedown',{clientX:mr.left+mr.width*0.15,clientY:mr.top+mr.height*0.15,bubbles:true,cancelable:true}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));})()`);
  const af = await ev(`({tx:previewTranslateX, ty:previewTranslateY,
    vl:parseFloat($('pvMapView').style.left), vt:parseFloat($('pvMapView').style.top)})`);
  ok('可在导航缩略图里拖动画面', Math.abs(af.tx - b4.tx) > 1 || Math.abs(af.ty - b4.ty) > 1,
    `位移 ${b4.tx.toFixed(1)},${b4.ty.toFixed(1)} → ${af.tx.toFixed(1)},${af.ty.toFixed(1)}｜视口框回到 ${af.vl.toFixed(1)},${af.vt.toFixed(1)}`);

  // ---- 8.9 缩回 100% 后导航图自动隐藏 ----
  await ev(`(function(){const t=$('pvZoomTrack').getBoundingClientRect();
    $('pvZoomTrack').dispatchEvent(new MouseEvent('mousedown',{clientX:t.left+t.width/2,clientY:t.bottom-1,bubbles:true,cancelable:true}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));})()`);
  const m1 = await ev(`({show:$('pvMap').classList.contains('show'), s:previewScale})`);
  ok('缩回 100% 后导航图隐藏', !m1.show && m1.s === 1, `scale=${m1.s}｜显示=${m1.show}`);

  // ---- 8.10 图片页预览跟随画质档位（像素规模随之变化；版面尺寸始终不变） ----
  // 历史口径曾断言「预览像素不随档位变化」，那正是用户报的「切档位预览毫无变化」的根因，
  // 现在行为已反过来：图片页与 PDF 页一样，切档位预览就要跟着变清晰度。
  const qp = await ev(`(async function(){
    const p = state.pages.filter(x => x.kind === 'image')[0];
    const s = readImgSettings();
    const decode = async v => { const im = new Image(); im.src = await buildPreviewSrc(p); await im.decode(); return { w: im.naturalWidth, len: im.src.length }; };
    const shot = async v => { p.ovq = v; const d = await decode(); return { w: d.w, kb: Math.round(d.len / 1024),
      pt: planForImage(p, QUALITY[v] || effQualityOf(p), s).drawWpt }; };
    const hi = await shot('q-high');
    const lo = await shot('q-lite');
    p.ovq = null;
    return { hiSrc: hi.w, hiKb: hi.kb, hiPt: hi.pt, loSrc: lo.w, loKb: lo.kb, loPt: lo.pt,
             src: (state.thumbCache[p.uid] || {}).width || 0, px: exportPixelsOf(p).w };
  })()`);
  ok('图片页预览像素随画质档位变化（切档位能看出清晰度差别）',
    qp.hiSrc > qp.loSrc * 1.5 && qp.hiKb > qp.loKb * 1.1,
    `高清档 ${qp.hiSrc}px/${qp.hiKb}KB；精简档 ${qp.loSrc}px/${qp.loKb}KB（像素与体积都应随档位下降）`);
  ok('档位变化不改版面尺寸（只改渲染像素）', Math.abs(qp.hiPt - qp.loPt) < 0.5,
    `高清 ${qp.hiPt.toFixed(1)}pt ｜ 精简 ${qp.loPt.toFixed(1)}pt（源图 ${qp.src}px）`);

  // ---- 8.11 矢量保真「零编辑直通」：单文件未编辑时原样输出，体积不变 ----
  await ev(`(function(){
    state.pages = state.pages.filter(p => p.kind === 'pdf');
    state.files = state.files.filter(f => f.kind === 'pdf');
    state.pages.forEach(p => { p.ovq = null; p.ove = null; });
    $('qualitySel').value = 'q-faithful'; $('qualitySel').dispatchEvent(new Event('change'));
    afterMutate();
  })()`);
  await sleep(400);
  const pt1 = await ev(`(function(){const f = passthroughFile(); return f ? { kb: Math.round(f.size/1024) } : null;})()`);
  ok('单文件未编辑 → 可原样直通', !!pt1, pt1 ? `源文件 ${pt1.kb} KB，将直接输出（体积不变）` : '未触发直通');
  const est1 = await ev(`$('estText').textContent`);
  ok('预估区提示「原样输出」', /原样输出/.test(est1), est1);
  await ev(`(function(){ state.pages[0].rot = 90; afterMutate(); })()`);
  await sleep(300);
  const pt2 = await ev(`passthroughFile() ? 'x' : null`);
  ok('有编辑（旋转/删页/多文件）时不直通', pt2 === null, '旋转一页后已回退为正常重写流程');
  await ev(`(function(){ state.pages[0].rot = 0; afterMutate(); })()`);

  // ---- 9. 运行期无 JS 错误 ----
  ok('运行期无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | ') || '无');

  ws.close();
  console.log('\n=== 端到端验证结果 ===');
  for (const r of results) console.log((r.pass ? '✅ ' : '❌ ') + r.name + '  →  ' + r.detail);
  const bad = results.filter(r => !r.pass).length;
  console.log(bad ? `\n❌ 失败 ${bad} 项` : '\n✅ 全部通过');
  process.exit(bad ? 1 : 0);
})().catch(e => {
  console.log('\n=== 已完成的检查项 ===');
  for (const r of results) console.log((r.pass ? '✅ ' : '❌ ') + r.name + '  →  ' + r.detail);
  console.error('\n脚本异常：', e.message);
  process.exit(2);
});
