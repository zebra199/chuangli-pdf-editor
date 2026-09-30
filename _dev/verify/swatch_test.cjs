// 常用色快捷色板回归测试（CDP 驱动无头 Edge）
//
// 覆盖：每个选色器（水印 / 页码 / 标注工具条）下方自动注入一行经典色，
//      点选即写入并驱动下游（readOverlay / state.edit.colors / 选中标注的 op.c）
//
// 用法：node swatch_test.cjs [页面路径] [端口]
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
  // 模拟真实点击（走命中测试，能验证色块确实可点、没被遮挡）
  const clickSel = async sel => {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
    if (!nodeId) throw new Error('找不到元素：' + sel);
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId });
    const q = model.content;
    const x = (q[0] + q[4]) / 2, y = (q[1] + q[5]) / 2;
    for (const t of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1, buttons: t === 'mouseReleased' ? 0 : 1 });
    }
    await sleep(220);
  };

  await waitFor(async () => (await ev('document.readyState')) === 'complete', '页面加载');
  await sleep(400);
  await ev(`(function(){try{localStorage.clear()}catch(e){}
    $('qualitySel').value='q-high';$('enhanceSel').value='none';
    readImgSettings();applyOverlayUI();saveSettings();return 1;})()`);

  // ---------- 1. 三个选色器都挂上了色板 ----------
  const sw = await ev(`(function(){
    const ids = ['wmColor','pnColor','edColor'];
    return ids.map(id => {
      const inp = $(id);
      const row = document.querySelector('.swatches[data-for="'+id+'"]');
      const anchor = inp && (inp.closest('label, .sw') || inp);
      const inLabel = !!(inp && inp.closest('label'));
      return { id, has: !!inp, row: !!row,
               n: row ? row.querySelectorAll('.swc').length : 0,
               // 竖排设置卡：色板整行挂在 label 之后；横排工具条：紧跟在选色器右侧
               next: !!(row && (inLabel ? anchor.nextElementSibling === row : inp.nextElementSibling === row)),
               colors: row ? Array.from(row.querySelectorAll('.swc')).map(b => b.dataset.color) : [] };
    });})()`);
  ok('水印 / 页码 / 标注三处选色器都生成了色板',
    sw.every(s => s.has && s.row && s.n > 0),
    sw.map(s => `${s.id}:${s.row ? s.n + '色' : '缺失'}`).join('｜'));
  ok('色板紧跟在对应选色器之后（不是别处）', sw.every(s => s.next),
    sw.map(s => `${s.id}=${s.next}`).join('｜'));
  ok('经典色齐全（黑/白/灰/红/橙/黄/绿/青/蓝/紫/粉）',
    sw.every(s => ['#1a1a1a', '#ffffff', '#555555', '#e03131', '#f59f00', '#ffd400', '#2f9e44', '#1c7ed6', '#7048e8'].every(c => s.colors.includes(c))),
    sw[0].colors.join(' '));

  // ---------- 2. 几何：色板在选色器下方（设置卡内）且不越出卡片 ----------
  // 卡片默认折叠（display:none 量出来全是 0），先展开再量
  await ev(`(function(){$('wmOn').checked = true; $('wmOn').dispatchEvent(new Event('change')); return 1;})()`);
  await sleep(400);
  const geo = await ev(`(function(){
    const inp = $('wmColor'), row = document.querySelector('.swatches[data-for="wmColor"]');
    const a = inp.getBoundingClientRect(), b = row.getBoundingClientRect();
    const card = inp.closest('.scard').getBoundingClientRect();
    return { below: b.top >= a.bottom - 1, inCard: b.left >= card.left - 1 && b.right <= card.right + 1,
             rowH: Math.round(b.height), visible: b.width > 0 && b.height > 0 };})()`);
  ok('色板位于选色器正下方且在卡片内不溢出', geo.below && geo.inCard && geo.visible,
    `下方=${geo.below}｜未溢出=${geo.inCard}｜行高 ${geo.rowH}px`);

  // ---------- 3. 点选色块 → 水印颜色真的改了 ----------
  await clickSel('.swatches[data-for="wmColor"] .swc[data-color="#e03131"]');
  const wm = await ev(`(function(){readOverlay();return {v:$('wmColor').value, c:state.overlay.wm.color,
    on:document.querySelectorAll('.swatches[data-for="wmColor"] .swc.on').length};})()`);
  ok('点选「红」→ 水印颜色生效（走 readOverlay）', wm.v === '#e03131' && wm.c === '#e03131',
    `input=${wm.v}｜state.overlay.wm.color=${wm.c}`);
  ok('当前色高亮唯一（只有一个 .on）', wm.on === 1, `.on 数量=${wm.on}`);

  // ---------- 4. 点选色块 → 页码颜色真的改了 ----------
  await ev(`(function(){$('pnOn').checked = true; $('pnOn').dispatchEvent(new Event('change')); return 1;})()`);
  await sleep(300);
  await clickSel('.swatches[data-for="pnColor"] .swc[data-color="#1c7ed6"]');
  const pn = await ev(`(function(){readOverlay();return {v:$('pnColor').value, c:state.overlay.pn.color};})()`);
  ok('点选「蓝」→ 页码颜色生效', pn.v === '#1c7ed6' && pn.c === '#1c7ed6',
    `input=${pn.v}｜state.overlay.pn.color=${pn.c}`);

  // 换一色再确认可反复切换
  await clickSel('.swatches[data-for="pnColor"] .swc[data-color="#2f9e44"]');
  const pn2 = await ev(`(function(){readOverlay();return state.overlay.pn.color;})()`);
  ok('可反复切换（蓝 → 绿）', pn2 === '#2f9e44', `state.overlay.pn.color=${pn2}`);

  // ---------- 5. 设置持久化：改动被存进 localStorage ----------
  const saved = await ev(`(function(){
    const s = JSON.parse(localStorage.getItem('pdfe_settings') || '{}');
    return { key: 'pdfe_settings',
             wm: (s.ov||{}).wm ? s.ov.wm.color : null,
             pn: (s.ov||{}).pn ? s.ov.pn.color : null };})()`);
  ok('颜色改动已持久化到设置', saved.wm === '#e03131' && saved.pn === '#2f9e44',
    `存档 wm=${saved.wm}｜pn=${saved.pn}`);

  // ---------- 6. 标注工具条：点色块 → 工具记忆色 + 已有标注改色 ----------
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId });
  await waitFor(async () => (await ev('state.pages.length')) === 1, '图片导入');
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await sleep(1800);

  // —— 用户反馈：色板若独占一行，会把「大小/删除/撤销」挤出可视区 ——
  const edGeo = await ev(`(function(){
    const inp = $('edColor'), row = document.querySelector('.swatches[data-for="edColor"]');
    const ir = inp.getBoundingClientRect(), b = row.getBoundingClientRect();
    const bar = $('pvEdit').getBoundingClientRect();
    return { sameRow: Math.abs(b.top - ir.top) < 12, onRight: b.left >= ir.right - 1,
             rowH: Math.round(b.height), barH: Math.round(bar.height),
             order: Array.from($('pvEdit').children).map(c => c.id || c.className).join(',') };})()`);
  ok('工具条内色板与【颜色】选色器同一行、位于其右侧', edGeo.sameRow && edGeo.onRight,
    `同行=${edGeo.sameRow}｜在右侧=${edGeo.onRight}｜工具条高 ${edGeo.barH}px（单行，未撑高）`);
  // 工具条末尾的 .note 本来就独占一行，所以不能拿整体高度判「是否两行」；
  // 改为看第一行控件（选择…重做）是否仍在同一水平线上
  const line = await ev(`(function(){
    const u = $('tbUndo').getBoundingClientRect(), r = $('tbRedo').getBoundingClientRect();
    return { du: Math.round(Math.abs(u.top - r.top)) };})()`);
  ok('撤销 / 重做成组不拆行（两按钮顶边对齐）', line.du <= 2,
    `撤销与重做 top 差 ${line.du}px`);

  // 治本验证：舞台高度按【实测】工具条高度让位，而不是写死的常数
  const adapt = await ev(`(function(){
    const stage = document.querySelector('#preview .stage');
    const row = document.querySelector('.swatches[data-for="edColor"]');
    const box = document.querySelector('#preview .box');
    const pvc = () => box.style.getPropertyValue('--pvc');
    const h1 = Math.round(stage.getBoundingClientRect().height), v1 = pvc();
    row.style.display = 'none'; lockPreviewWidth(currentPreviewPage());
    const h2 = Math.round(stage.getBoundingClientRect().height), v2 = pvc();
    row.style.display = ''; lockPreviewWidth(currentPreviewPage());
    return { h1, h2, v1, v2 };})()`);
  ok('舞台高度按实测的 --pvc 让位（非写死常数 175）',
    adapt.v1 && adapt.v2 && parseInt(adapt.v1) !== parseInt(adapt.v2) && adapt.h2 > adapt.h1,
    `有色板 --pvc=${adapt.v1}/舞台 ${adapt.h1}px → 无色板 --pvc=${adapt.v2}/舞台 ${adapt.h2}px（工具条变矮，舞台自动变高）`);

  const vis = await ev(`(function(){
    const box = document.querySelector('#preview .box').getBoundingClientRect();
    const ids = ['edSizeWrap','tbDel','tbUndo','tbRedo'];
    return { boxBottom: Math.round(box.bottom),
             items: ids.map(id => { const r = $(id).getBoundingClientRect();
               return { id, inside: r.bottom <= box.bottom + 1 && r.right <= box.right + 1,
                        bottom: Math.round(r.bottom) }; }) };})()`);
  ok('「大小 / 删除 / 撤销 / 重做」完整落在预览面板内（未被挤出可视区）',
    vis.items.every(i => i.inside),
    vis.items.map(i => `${i.id}=${i.inside ? 'OK' : '溢出 ' + (i.bottom - vis.boxBottom) + 'px'}`).join('｜'));

  const noTitle = await ev(`(function(){
    const bar = $('pvEdit');
    return { hasEt: !!bar.querySelector('.et'), first: (bar.firstElementChild || {}).id || '',
             text: bar.textContent.slice(0, 12) };})()`);
  ok('工具条最前的「标注」标题已移除', !noTitle.hasEt && !/^标注/.test(noTitle.text),
    `首个控件=${noTitle.first}｜开头文字="${noTitle.text}"`);

  // 高亮工具下默认色 #ffd400 → 「黄」应处于选中态
  await ev(`setTool('highlight'); 1`);
  await sleep(300);
  const hlOn = await ev(`(function(){
    const on = document.querySelector('.swatches[data-for="edColor"] .swc.on');
    return { c: on ? on.dataset.color : null, n: document.querySelectorAll('.swatches[data-for="edColor"] .swc.on').length };})()`);
  ok('切到高亮：默认荧光黄自动高亮为选中态', hlOn.c === '#ffd400' && hlOn.n === 1,
    `.on=${hlOn.c}（数量 ${hlOn.n}）`);

  await clickSel('.swatches[data-for="edColor"] .swc[data-color="#0ca678"]');
  const hl = await ev(`(function(){return {v:$('edColor').value, c:state.edit.colors.highlight};})()`);
  ok('点选「青」→ 高亮工具记忆色生效', hl.v === '#0ca678' && hl.c === '#0ca678',
    `input=${hl.v}｜state.edit.colors.highlight=${hl.c}`);

  // 切到文本框（默认 #1f2733 不在色板里）→ 不应有 .on 残留
  await ev(`setTool('text'); 1`);
  await sleep(300);
  const txOn = await ev(`(function(){return {v:$('edColor').value,
    n:document.querySelectorAll('.swatches[data-for="edColor"] .swc.on').length};})()`);
  ok('切到文本框：默认墨色不在色板中 → 无高亮残留', txOn.v === '#1f2733' && txOn.n === 0,
    `input=${txOn.v}｜.on 数量=${txOn.n}`);

  // ---------- 7. 给已画的标注改色（走 applyPropToSel） ----------
  const rect = await ev(`(function(){const r=$('pvOverlay').getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height};})()`);
  const P = (fx, fy) => [rect.l + rect.w * fx, rect.t + rect.h * fy];
  const raw = (t, X, Y) => cdp.send('Input.dispatchMouseEvent', { type: t, x: X, y: Y, button: 'left', clickCount: 1, buttons: t === 'mouseReleased' ? 0 : 1 });
  await ev(`setTool('highlight'); 1`);
  await sleep(200);
  {
    const [x0, y0] = P(0.15, 0.40), [x1, y1] = P(0.55, 0.52);
    await raw('mousePressed', x0, y0); await raw('mouseMoved', (x0 + x1) / 2, (y0 + y1) / 2);
    await raw('mouseMoved', x1, y1); await raw('mouseReleased', x1, y1);
  }
  await sleep(1200);
  const before = await ev(`(function(){const p=state.pages[0];return (p.ops[0]||{}).c;})()`);
  await ev(`setTool('select'); 1`);
  await sleep(200);
  const [hx, hy] = P(0.35, 0.46);
  await raw('mousePressed', hx, hy); await raw('mouseReleased', hx, hy);
  await sleep(500);
  await clickSel('.swatches[data-for="edColor"] .swc[data-color="#e64980"]');
  await sleep(900);
  const after = await ev(`(function(){const p=state.pages[0];
    return {c:(p.ops[0]||{}).c, sel:state.edit.sel, inp:$('edColor').value};})()`);
  ok('选中已有高亮后点「粉」→ 该标注颜色被改掉',
    before === '#0ca678' && after.c === '#e64980',
    `画时 ${before} → 改后 ${after.c}（input=${after.inp}）`);

  // ---------- 8. 撤销可回退颜色改动 ----------
  const diag = await ev(`(function(){
    return { hist: state.history.length, undoDisabled: $('tbUndo').disabled,
             sel: state.edit.sel, dirty: (typeof edPropDirty !== 'undefined' ? edPropDirty : null) };})()`);
  await ev(`(function(){$('tbUndo').click();return 1;})()`);
  await sleep(700);
  const undone = await ev(`(function(){return (state.pages[0].ops[0]||{}).c;})()`);
  ok('撤销可回退色板改色', undone === before,
    `撤销后 ${undone}（期望 ${before}）｜诊断 ${JSON.stringify(diag)}`);

  // ---------- 9. 白色块也可见（有描边，不会在白底上"消失"） ----------
  const white = await ev(`(function(){
    const b = document.querySelector('.swatches[data-for="pnColor"] .swc[data-color="#ffffff"]');
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return { border: cs.borderTopWidth + ' ' + cs.borderTopColor, w: Math.round(r.width), h: Math.round(r.height) };})()`);
  ok('白色块有描边、尺寸可点（≥14px）', parseFloat(white.border) >= 1 && white.w >= 14 && white.h >= 14,
    `描边 ${white.border}｜尺寸 ${white.w}×${white.h}`);

  // ---------- 10. 马赛克没有颜色概念 → 整组隐藏（选色器 + 色板） ----------
  await ev(`setTool('mosaic'); 1`);
  await sleep(350);
  const mos = await ev(`(function(){
    const wrap = $('edColorWrap'), row = document.querySelector('.swatches[data-for="edColor"]');
    return { disp: getComputedStyle(wrap).display,
             rowH: row ? Math.round(row.getBoundingClientRect().height) : -1,
             sizeLbl: $('edSizeWrap').textContent.trim().slice(0, 2) };})()`);
  ok('选中「马赛克」→ 颜色选色器与色板一起隐藏', mos.disp === 'none' && mos.rowH === 0,
    `#edColorWrap display=${mos.disp}｜色板高 ${mos.rowH}px`);
  ok('隐藏颜色后「大小」仍为马赛克块粒度（未被误改）', mos.sizeLbl === '大小',
    `大小组文案="${mos.sizeLbl}…"`);

  await ev(`setTool('highlight'); 1`);
  await sleep(350);
  const back = await ev(`(function(){
    const wrap = $('edColorWrap'), row = document.querySelector('.swatches[data-for="edColor"]');
    return { disp: getComputedStyle(wrap).display,
             rowH: row ? Math.round(row.getBoundingClientRect().height) : -1 };})()`);
  ok('切回「高亮」→ 颜色组与色板重新出现', back.disp !== 'none' && back.rowH > 0,
    `display=${back.disp}｜色板高 ${back.rowH}px`);

  // 选中一个【马赛克】标注时同样隐藏（只看选中项类型，不只看工具）
  await ev(`(function(){
    const p = state.pages[0];
    p.ops.push({ t: 'mos', x: 0.1, y: 0.1, w: 0.2, h: 0.2, b: 0.008 });
    state.edit.sel = p.ops.length - 1; syncSelProps(); return 1;})()`);
  await sleep(300);
  const mosSel = await ev(`(function(){return getComputedStyle($('edColorWrap')).display;})()`);
  ok('选中马赛克标注时也隐藏颜色（按选中项类型判定）', mosSel === 'none', `display=${mosSel}`);
  await ev(`(function(){const p=state.pages[0];p.ops.pop();state.edit.sel=-1;syncSelProps();return 1;})()`);

  ok('运行期无 JS 错误', errors.length === 0, errors.length ? errors.slice(0, 3).join(' / ') : '无');

  // ---------- 输出 ----------
  console.log('\n=== 色板测试结果 ===');
  results.forEach(r => {
    console.log((r.pass ? '  ✅ ' : '  ❌ ') + r.name + (r.detail ? '\n       ' + r.detail : ''));
  });
  const fail = results.filter(r => !r.pass).length;
  console.log('\n=== ' + (results.length - fail) + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
