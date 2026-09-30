// 画笔功能的人工确认截图：画三种颜色 / 三种粗细的笔迹，并保留选中态。
// 用法：node shots_brush.cjs [页面路径]
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { ensure: ensureBrowser } = require('./_edge.cjs');

const DEV = path.join(__dirname, '..');
const PAGE = pathToFileURL(process.argv[2] || path.join(DEV, 'index.html')).href;
const IMG = path.join(__dirname, 'fixtures', '扫描件样本.png');
const OUT = path.join(__dirname, '_shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms = 30000) {
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

(async () => {
  const browser = await ensureBrowser(process.argv[3]);
  process.on('exit', () => { if (browser.owned) browser.stop(); });
  const tab = await (await fetch(browser.base + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const ev = async expr => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };
  const shot = async name => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
    console.log('  已保存 ' + name);
  };

  await waitFor(async () => (await ev('document.readyState')) === 'complete', '页面加载');
  await sleep(400);
  await ev(`(function(){try{localStorage.clear()}catch(e){}
    $('qualitySel').value='q-high';$('enhanceSel').value='none';
    readImgSettings();applyOverlayUI();saveSettings();
    window.__stroke = function(pts){
      const cv = edCanvas(), r = cv.getBoundingClientRect();
      const at = p => ({ clientX: r.left + p[0]*r.width, clientY: r.top + p[1]*r.height, bubbles:true, cancelable:true, button:0 });
      cv.dispatchEvent(new MouseEvent('mousedown', at(pts[0])));
      for (let i = 1; i < pts.length; i++) document.dispatchEvent(new MouseEvent('mousemove', at(pts[i])));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, cancelable:true }));
      return 1;
    };
    return 1;})()`);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId });
  await waitFor(async () => (await ev('state.pages.length')) === 1, '图片导入');
  await sleep(600);
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await sleep(1800);

  // 朱红细笔 / 蓝色中笔 / 绿色粗笔，最后一步保留选中态（能看到 8 个控制点）
  const strokes = [
    { c: '#e03131', w: 4,  pts: [[0.15, 0.20], [0.30, 0.26], [0.45, 0.20], [0.60, 0.27], [0.75, 0.20]] },
    { c: '#1c7ed6', w: 12, pts: [[0.15, 0.42], [0.32, 0.50], [0.50, 0.42], [0.68, 0.52], [0.80, 0.44]] },
    { c: '#2f9e44', w: 28, pts: [[0.15, 0.68], [0.34, 0.78], [0.52, 0.66], [0.70, 0.80], [0.82, 0.70]] },
  ];
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    await ev(`(function(){ $('tbBr').click();
      $('edColor').value='${s.c}'; $('edColor').dispatchEvent(new Event('input',{bubbles:true}));
      const sl=$('edSize'); sl.value=${s.w}; sl.dispatchEvent(new Event('input',{bubbles:true}));
      __stroke(${JSON.stringify(s.pts)}); return 1; })()`);
    await sleep(1600);
    console.log(`  第 ${i + 1} 笔：${s.c} 粗细 ${s.w}`);
  }
  /* 画完最后一笔时 mouseup 会自动 setTool('select') 并选中刚画那笔，
   * 所以这里必须先清掉选中，I1 才是「三笔干干净净」的样子 ——
   * 否则 I1 就已经带选中框，和 I2 拍出来一模一样（这个坑真实踩过）。 */
  await ev(`(function(){ setTool('select'); state.edit.sel = -1;
    syncSelProps(); drawOverlayLayer(); return 1; })()`);
  await sleep(600);
  await shot('I1-画笔三种颜色与粗细.png');

  // 选中态：选中中间那笔（蓝色中粗）→ 只有虚线框，**没有** 8 个控制点，「大小」组也被隐藏
  await ev(`(function(){ setTool('select'); state.edit.sel = 1;
    syncSelProps(); drawOverlayLayer(); return 1; })()`);
  await sleep(600);
  await shot('I2-画笔选中态.png');

  const info = await ev(`(function(){ const o = pageOps(currentPreviewPage());
    return o.map(x => x.t + ':' + x.c + ':lw' + x.lw).join(' | '); })()`);
  const st = await ev(`(function(){
    return { tool: state.edit.tool, sel: state.edit.sel,
             sizeDisp: getComputedStyle($('edSizeWrap')).display }; })()`);
  console.log('  op 摘要：' + info);
  console.log('  选中态：tool=' + st.tool + ' sel=' + st.sel + ' 「大小」组 display=' + st.sizeDisp);

  const f1 = path.join(OUT, 'I1-画笔三种颜色与粗细.png');
  const f2 = path.join(OUT, 'I2-画笔选中态.png');
  const same = fs.readFileSync(f1).equals(fs.readFileSync(f2));
  console.log(same ? '  ⚠️ 两张截图完全相同，选中态没拍出来！' : '  ✓ I1 / I2 内容不同（选中态已体现）');
  console.log('\n截图 → ' + OUT);
  process.exit(0);
})().catch(e => { console.error('失败：', e && e.message || e); process.exit(1); });
