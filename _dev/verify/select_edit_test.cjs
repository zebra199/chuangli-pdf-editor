// 标注「选中后重新编辑」回归测试（CDP 驱动无头 Edge）
//
// 覆盖用户报的两个问题：
//   1) 已录入的标注选不中（overlay 在 select 工具下 pointer-events:none，点击被 img 吃掉）
//      → 选中 / 拖动移动 / 拖控制点调整边框 / 删除选中 / 双击改文字
//   2) 文本框带一层灰白底色（drawTextOp 里的 op.bg 白底衬板）→ 改为纯透明
//
// 用法：node select_edit_test.cjs [页面路径] [端口]
//   默认跑 _dev/index.html；传产物路径则验证打包单文件。
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
  const BASE = browser.base;
  process.on('exit', () => { if (browser.owned) browser.stop(); });
  const tab = await (await fetch(BASE + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  // file:// 下 pdf.js worker 走 blob 会被协议拦截后回退主线程，属既有现象
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
  await ev(`(function(){try{localStorage.clear()}catch(e){}
    $('qualitySel').value='q-high';$('enhanceSel').value='none';
    $('wmOn').checked=false;$('pnOn').checked=false;
    readImgSettings();applyOverlayUI();saveSettings();return 1;})()`);

  // ---------- 导入图片页 ----------
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId });
  await waitFor(async () => (await ev('state.pages.length')) > 0, '图片导入');
  ok('素材导入成功', (await ev('state.pages.length')) >= 1, '页数=' + (await ev('state.pages.length')));

  // ---------- 打开预览 ----------
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await waitFor(async () => await ev(`document.getElementById('preview').classList.contains('show') && ($('pvImg').src||'').length>100`), '预览打开');
  await sleep(600);

  /* ---- 鼠标操作助手（坐标一律用版面归一化 0~1） ---- */
  const rectOf = () => ev(`(function(){const r=$('pvOverlay').getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height};})()`);
  const raw = async (type, X, Y, cc) => cdp.send('Input.dispatchMouseEvent',
    { type, x: X, y: Y, button: 'left', clickCount: cc || 1, buttons: type === 'mouseReleased' ? 0 : 1 });
  const at = async (fx, fy) => { const r = await rectOf(); return [r.l + r.w * fx, r.t + r.h * fy]; };
  const press = async (fx, fy) => { const [X, Y] = await at(fx, fy); await raw('mousePressed', X, Y); };
  const move = async (fx, fy) => { const [X, Y] = await at(fx, fy); await raw('mouseMoved', X, Y); };
  const release = async (fx, fy) => { const [X, Y] = await at(fx, fy); await raw('mouseReleased', X, Y); };
  const click = async (fx, fy) => { await press(fx, fy); await release(fx, fy); await sleep(120); };
  const drag = async (x0, y0, x1, y1) => {
    await press(x0, y0); await move((x0 + x1) / 2, (y0 + y1) / 2); await move(x1, y1); await release(x1, y1); await sleep(150);
  };
  const dblclick = async (fx, fy) => {
    const [X, Y] = await at(fx, fy);
    await raw('mousePressed', X, Y, 1); await raw('mouseReleased', X, Y, 1);
    await raw('mousePressed', X, Y, 2); await raw('mouseReleased', X, Y, 2);
    await sleep(200);
  };
  const ops = async () => JSON.parse(await ev(
    `JSON.stringify(pageOps(state.pages[0]).map(o=>({t:o.t,x:+o.x.toFixed(4),y:+o.y.toFixed(4),w:+o.w.toFixed(4),h:+o.h.toFixed(4),text:o.text||''})))`));
  const sel = () => ev('state.edit.sel');
  const tool = () => ev('state.edit.tool');

  // ---------- 1. select 工具下 overlay 必须能收到点击（本 bug 的根因） ----------
  const pe = await ev(`getComputedStyle($('pvOverlay')).pointerEvents`);
  ok('「选择」工具下 overlay 可接收点击', pe === 'auto',
    `tool=${await tool()} pointer-events=${pe}（若为 none，标注将永远选不中）`);

  // ---------- 2. 画一个高亮 ----------
  await ev(`setTool('highlight')`);
  await drag(0.15, 0.40, 0.50, 0.55);
  await waitFor(async () => (await ops()).length === 1, '高亮落 op');
  await sleep(600);
  const afterDraw = { tool: await tool(), sel: await sel() };
  ok('画完自动回到「选择」并选中新标注', afterDraw.tool === 'select' && afterDraw.sel === 0,
    `tool=${afterDraw.tool} sel=${afterDraw.sel}`);

  // ---------- 3. 点空白取消选中 ----------
  await click(0.88, 0.90);
  ok('点击空白处取消选中', (await sel()) === -1, 'sel=' + (await sel()));

  // ---------- 4. 点击已有标注能选中（核心回归） ----------
  await click(0.30, 0.47);
  const selNow = await sel();
  ok('点击已有标注可以选中', selNow === 0, 'sel=' + selNow + '（修复前恒为 -1）');

  // ---------- 5. 拖动移动 ----------
  const before = (await ops())[0];
  await drag(0.30, 0.47, 0.45, 0.62);
  await sleep(700);
  const moved = (await ops())[0];
  ok('拖动可移动标注', Math.abs(moved.x - before.x) > 0.05 && Math.abs(moved.y - before.y) > 0.05,
    `(${before.x},${before.y}) → (${moved.x},${moved.y})`);
  ok('移动不改变尺寸', Math.abs(moved.w - before.w) < 0.005 && Math.abs(moved.h - before.h) < 0.005,
    `${before.w}×${before.h} → ${moved.w}×${moved.h}`);
  ok('移动后仍保持选中', (await sel()) === 0, 'sel=' + (await sel()));

  // ---------- 6. 拖控制点调整边框 ----------
  const b2 = (await ops())[0];
  const seX = b2.x + b2.w, seY = b2.y + b2.h;
  await drag(seX, seY, seX + 0.12, seY + 0.10);           // 抓右下角往外拉
  await sleep(700);
  const r2 = (await ops())[0];
  ok('拖右下角控制点可放大边框', r2.w > b2.w + 0.05 && r2.h > b2.h + 0.04,
    `${b2.w}×${b2.h} → ${r2.w}×${r2.h}`);
  ok('缩放时左上角锚点不动', Math.abs(r2.x - b2.x) < 0.01 && Math.abs(r2.y - b2.y) < 0.01,
    `(${b2.x},${b2.y}) → (${r2.x},${r2.y})`);

  // ---------- 7. 删除选中按钮 ----------
  const delDisabled = await ev(`$('tbDel').disabled`);
  ok('选中后「删除选中」按钮可用', delDisabled === false, 'disabled=' + delDisabled);
  await ev(`$('tbDel').click(); 1`);
  await sleep(700);
  ok('删除选中生效', (await ops()).length === 0, '剩余标注 ' + (await ops()).length + ' 个');
  ok('删除后按钮回到禁用', (await ev(`$('tbDel').disabled`)) === true, '已复位');

  // ---------- 8. 撤销把标注找回来 ----------
  await ev(`doUndo(); 1`);
  await sleep(700);
  ok('撤销可恢复被删标注', (await ops()).length === 1, '恢复后 ' + (await ops()).length + ' 个');

  // ---------- 9. 文本框：双击可重新编辑 ----------
  await ev(`setTool('text')`);
  await drag(0.20, 0.15, 0.60, 0.28);
  await waitFor(async () => (await ops()).length === 2, '文本框落 op');
  await waitFor(async () => (await ev(`getComputedStyle($('pvEditor')).display`)) === 'block', '输入框弹出');
  await ev(`(function(){const ta=$('pvEditorTa');ta.value='初稿';ta.dispatchEvent(new Event('input'));return 1;})()`);
  await ev(`$('pvEditorTa').blur(); 1`);
  await sleep(800);
  const txOp = (await ops())[1];
  ok('文本框内容写回 op', txOp.text === '初稿', 'text=' + JSON.stringify(txOp.text));
  ok('输入收尾后回到「选择」并选中该文本框', (await tool()) === 'select' && (await sel()) === 1,
    `tool=${await tool()} sel=${await sel()}`);

  await dblclick(0.35, 0.21);
  const edOpen = await ev(`getComputedStyle($('pvEditor')).display`);
  ok('双击文本框可再次编辑', edOpen === 'block', 'editor display=' + edOpen);
  if (edOpen === 'block') {
    await ev(`(function(){const ta=$('pvEditorTa');ta.value='修订版';ta.dispatchEvent(new Event('input'));ta.blur();return 1;})()`);
    await sleep(800);
    ok('双击后可改文字', (await ops())[1].text === '修订版', 'text=' + JSON.stringify((await ops())[1].text));
  }

  // ---------- 10. 文本框背景必须纯透明（像素级） ----------
  const bgDiff = await ev(`(async function(){
    const p = state.pages[0];
    const ops = pageOps(p);
    const saved = ops.slice();
    const render = () => {
      const pc = imagePageCanvas(p, 900, QUALITY['q-high']);
      drawOps(pc.cv.getContext('2d'), p, pc.cv.width, pc.cv.height, ovMeta(p));
      return pc.cv;
    };
    // A：不带任何标注
    ops.length = 0;
    const a = render();
    // B：放一个「空文本」的文本框，且故意带上历史数据里的 bg:true
    ops.push({ t:'tx', x:0.08, y:0.08, w:0.70, h:0.30, text:'', s:16, c:'#1f2733', al:'left', b:false, bg:true });
    const b = render();
    const ca = a.getContext('2d'), cb = b.getContext('2d');
    const X = Math.round(a.width*0.10), Y = Math.round(a.height*0.10);
    const W = Math.round(a.width*0.60), H = Math.round(a.height*0.24);
    const da = ca.getImageData(X,Y,W,H).data, db = cb.getImageData(X,Y,W,H).data;
    let diff = 0, maxd = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.abs(da[i]-db[i]) + Math.abs(da[i+1]-db[i+1]) + Math.abs(da[i+2]-db[i+2]);
      if (d > 6) diff++;
      if (d > maxd) maxd = d;
    }
    // 还原现场
    ops.length = 0; saved.forEach(o => ops.push(o));
    return { diff: diff, maxd: maxd, total: da.length/4, box: W + 'x' + H };
  })()`);
  ok('文本框背景纯透明（历史 bg:true 也不铺白底）', bgDiff.diff === 0,
    `框内 ${bgDiff.box} 共 ${bgDiff.total} 像素，差异 ${bgDiff.diff} 个（最大通道差 ${bgDiff.maxd}）`);

  /* 「透明」不能等于「什么都没画」：再验证文字本身确实落在框内 */
  const ink = await ev(`(async function(){
    const p = state.pages[0];
    const ops = pageOps(p); const saved = ops.slice();
    const render = () => {
      const pc = imagePageCanvas(p, 900, QUALITY['q-high']);
      drawOps(pc.cv.getContext('2d'), p, pc.cv.width, pc.cv.height, ovMeta(p));
      return pc.cv;
    };
    ops.length = 0;
    const a = render();
    ops.push({ t:'tx', x:0.10, y:0.10, w:0.70, h:0.22, text:'透明底色 ABC 123', s:30, c:'#1f2733', al:'left', b:false });
    const b = render();
    const ca = a.getContext('2d'), cb = b.getContext('2d');
    const X = Math.round(a.width*0.11), Y = Math.round(a.height*0.11);
    const W = Math.round(a.width*0.62), H = Math.round(a.height*0.19);
    const da = ca.getImageData(X,Y,W,H).data, db = cb.getImageData(X,Y,W,H).data;
    let darkA = 0, darkB = 0;
    for (let i = 0; i < da.length; i += 4) {
      if (((da[i]*54+da[i+1]*183+da[i+2]*19)>>8) < 120) darkA++;
      if (((db[i]*54+db[i+1]*183+db[i+2]*19)>>8) < 120) darkB++;
    }
    ops.length = 0; saved.forEach(o => ops.push(o));
    return { darkA: darkA, darkB: darkB };
  })()`);
  ok('文本框文字确实绘制在框内', ink.darkB > ink.darkA + 50,
    `框内深色像素 ${ink.darkA} → ${ink.darkB}（画上文字后应显著增加）`);

  // ---------- 11. 无控制台错误 ----------
  ok('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' ｜ ') || '无');

  const pass = results.filter(r => r.pass).length;
  console.log('\n=== 结果 ===');
  results.forEach(r => console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? '  ' + r.detail : ''}`));
  console.log(`\n=== ${pass} 通过 / ${results.length - pass} 失败 ===`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  // 中途异常也要把已跑完的断言打出来，便于对比「修复前/修复后」的差异
  console.log('\n=== 中断时已完成 ===');
  results.forEach(r => console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? '  ' + r.detail : ''}`));
  console.error('\n测试异常：', e.message);
  process.exit(1);
});
