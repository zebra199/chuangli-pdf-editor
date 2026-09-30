// 预览内左右翻页回归测试（CDP 驱动无头 Edge）
//
// 覆盖：按钮显隐 / 首末页禁用 / 点击翻页不退出预览 / 方向键翻页 /
//       翻页后标注归属正确的页（不串页）/ 单页时按钮隐藏
//
// 用法：node pagenav_test.cjs [页面路径] [端口]
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
  const ev = async expr => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };

  await waitFor(async () => (await ev('document.readyState')) === 'complete', '页面加载');
  // 用常见桌面视口，避免 headless 默认窄窗口触发响应式分支（按钮尺寸会量偏小）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  await ev(`(function(){try{localStorage.clear()}catch(e){}$('qualitySel').value='q-high';$('enhanceSel').value='none';readImgSettings();saveSettings();return 1;})()`);

  const importOne = async () => {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
    await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId });
  };
  const nPages = () => ev('state.pages.length');
  const idx = () => ev('previewIndex()');
  const shown = () => ev(`document.getElementById('preview').classList.contains('show')`);
  const nav = () => ev(`(function(){const p=$('pvPrev'),n=$('pvNext');
    return {pd:p.disabled, nd:n.disabled, pv:getComputedStyle(p).display, nv:getComputedStyle(n).display,
            pw:p.offsetWidth, ph:p.offsetHeight, nw:n.offsetWidth, nh:n.offsetHeight};})()`);
  const clickNav = async which => {
    await ev(`$('${which}').click(); 1`);
    await sleep(900);
  };
  const arrow = async key => {
    const code = key === 'ArrowRight' ? 39 : 37;
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await sleep(900);
  };
  const openFirst = async () => {
    await ev(`document.querySelector('.card .thumb').click(); 1`);
    await waitFor(async () => await ev(`document.getElementById('preview').classList.contains('show') && ($('pvImg').src||'').length>100`), '预览打开');
    await sleep(700);
  };
  const closePv = async () => { await ev(`closePreview(); 1`); await sleep(400); };

  // ---------- 1. 先只导入 1 页：单页时按钮应隐藏 ----------
  await importOne();
  await waitFor(async () => (await nPages()) === 1, '导入第 1 页');
  await openFirst();
  const one = await nav();
  ok('单页时翻页按钮隐藏', one.pv === 'none' && one.nv === 'none',
    `display: 上一页=${one.pv} 下一页=${one.nv}`);
  await closePv();

  // ---------- 2. 再导入 2 页 → 共 3 页 ----------
  await importOne(); await waitFor(async () => (await nPages()) === 2, '导入第 2 页');
  await importOne(); await waitFor(async () => (await nPages()) === 3, '导入第 3 页');
  ok('共导入 3 页', (await nPages()) === 3, '页数=' + (await nPages()));

  // ---------- 3. 打开第 1 页：上一页禁用、下一页可用 ----------
  await openFirst();
  const s1 = await nav();
  ok('多页时翻页按钮显示', s1.pv !== 'none' && s1.nv !== 'none',
    `display: 上一页=${s1.pv} 下一页=${s1.nv}`);
  ok('按钮是大体积（≥44×88）', s1.pw >= 44 && s1.ph >= 88,
    `${s1.pw}×${s1.ph} px`);
  ok('第 1 页：上一页禁用、下一页可用', s1.pd === true && s1.nd === false,
    `上一页 disabled=${s1.pd}｜下一页 disabled=${s1.nd}`);
  const geo = await ev(`(function(){
    const st = document.querySelector('#preview .stage').getBoundingClientRect();
    const box = document.querySelector('#preview .box').getBoundingClientRect();
    const p = $('pvPrev').getBoundingClientRect(), n = $('pvNext').getBoundingClientRect();
    const vw = window.innerWidth;
    return { outL: Math.round(box.left - p.right), outR: Math.round(n.left - box.right),
             pLeft: Math.round(p.left), nRight: Math.round(vw - n.right),
             boxW: Math.round(box.width), vw: vw,
             host: $('pvPrev').parentElement.id };})()`);
  ok('按钮在白色面板【之外】（不遮挡任何内容）',
    geo.outL >= 0 && geo.outR >= 0,
    `按钮与面板间距：左 ${geo.outL}px、右 ${geo.outR}px（面板宽 ${geo.boxW} / 视口 ${geo.vw}）`);
  ok('按钮完整落在视口内', geo.pLeft >= 0 && geo.nRight >= 0,
    `左按钮距视口左 ${geo.pLeft}px，右按钮距视口右 ${geo.nRight}px`);
  ok('按钮挂在预览遮罩层上（不再位于舞台内部）', geo.host === 'preview', 'parentElement=#' + geo.host);

  // 按钮挂在面板外，不应随页面缩放而移动
  const zoomPos = await ev(`(function(){
    const before = { pl: $('pvPrev').getBoundingClientRect().left, nl: $('pvNext').getBoundingClientRect().left };
    previewScale = 3; updateTransform();
    const after = { pl: $('pvPrev').getBoundingClientRect().left, nl: $('pvNext').getBoundingClientRect().left };
    previewScale = 1; updateTransform();
    return { d0: Math.abs(after.pl - before.pl), d1: Math.abs(after.nl - before.nl) };})()`);
  ok('放大 300% 后按钮位置不变（不随页面缩放漂移）', zoomPos.d0 < 1 && zoomPos.d1 < 1,
    `位移 左 ${zoomPos.d0.toFixed(1)}px / 右 ${zoomPos.d1.toFixed(1)}px`);

  // ---------- 4. 点击「下一页」 ----------
  await clickNav('pvNext');
  await waitFor(async () => (await idx()) === 1, '翻到第 2 页');
  ok('点「下一页」翻到下一页', (await idx()) === 1, 'previewIndex=' + (await idx()));
  ok('翻页没有退出预览', (await shown()) === true, 'preview.show=' + (await shown()));
  const cap = await ev(`$('pvCap').textContent`);
  ok('标题同步为全局第 2 页', /全局第 2 页/.test(cap), cap);
  const s2 = await nav();
  ok('中间页：两个方向都可用', s2.pd === false && s2.nd === false,
    `上一页 disabled=${s2.pd}｜下一页 disabled=${s2.nd}`);

  // ---------- 5. 翻到最后一页 ----------
  await clickNav('pvNext');
  await waitFor(async () => (await idx()) === 2, '翻到第 3 页');
  ok('点「下一页」可到最后一页', (await idx()) === 2, 'previewIndex=' + (await idx()));
  const s3 = await nav();
  ok('最后一页：下一页禁用、上一页可用', s3.nd === true && s3.pd === false,
    `上一页 disabled=${s3.pd}｜下一页 disabled=${s3.nd}`);
  await clickNav('pvNext');
  ok('末页再点下一页不越界', (await idx()) === 2 && (await shown()) === true, '仍在最后一页且预览未关闭');

  // ---------- 6. 方向键翻页 ----------
  await arrow('ArrowLeft');
  await waitFor(async () => (await idx()) === 1, '方向键回到第 2 页');
  ok('← 键翻到上一页', (await idx()) === 1, 'previewIndex=' + (await idx()));
  await arrow('ArrowRight');
  await waitFor(async () => (await idx()) === 2, '方向键到第 3 页');
  ok('→ 键翻到下一页', (await idx()) === 2, 'previewIndex=' + (await idx()));

  // ---------- 7. 翻页不串页：标注只属于画的那一页 ----------
  await clickNav('pvPrev'); await clickNav('pvPrev');   // 回到第 1 页
  await waitFor(async () => (await idx()) === 0, '回到第 1 页');
  await ev(`setTool('highlight')`);
  const rect = await ev(`(function(){const r=$('pvOverlay').getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height};})()`);
  const P = (fx, fy) => [rect.l + rect.w * fx, rect.t + rect.h * fy];
  const raw = (t, X, Y) => cdp.send('Input.dispatchMouseEvent', { type: t, x: X, y: Y, button: 'left', clickCount: 1, buttons: t === 'mouseReleased' ? 0 : 1 });
  {
    const [a, b] = P(0.20, 0.45); await raw('mousePressed', a, b);
    const [c, d] = P(0.55, 0.60); await raw('mouseMoved', c, d); await raw('mouseReleased', c, d);
  }
  await sleep(1200);
  ok('第 1 页画上高亮', (await ev('pageOps(state.pages[0]).length')) === 1,
    '第 1 页标注数=' + (await ev('pageOps(state.pages[0]).length')));

  await clickNav('pvNext');
  await waitFor(async () => (await idx()) === 1, '翻到第 2 页看是否串页');
  const p2cnt = await ev('pageOps(state.pages[1]).length');
  ok('翻页后第 2 页没有串来标注', p2cnt === 0, '第 2 页标注数=' + p2cnt);
  ok('翻页后第 1 页的标注还在', (await ev('pageOps(state.pages[0]).length')) === 1,
    '第 1 页标注数=' + (await ev('pageOps(state.pages[0]).length')));

  // ---------- 8. 无控制台错误 ----------
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
