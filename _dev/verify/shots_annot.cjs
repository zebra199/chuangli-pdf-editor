// 生成「标注选中后可再编辑」的效果截图（人工比对用）
// 用法：node _shots3.cjs [页面路径]
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ensure: ensureBrowser } = require('./_edge.cjs');
const DEV = path.join(__dirname, '..');
const PAGE = pathToFileURL(process.argv[2] || path.join(DEV, 'index.html')).href;
const IMG = path.join(__dirname, 'fixtures', '扫描件样本.png');
const OUT = __dirname + '/_shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
}

(async () => {
  const browser = await ensureBrowser(process.argv[3]);
  process.on('exit', () => { if (browser.owned) browser.stop(); });
  const tab = await (await fetch(browser.base + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable');
  // 用常见桌面视口，否则 headless 默认窄窗口会触发响应式分支，按钮量出来偏小
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const ev = async expr => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };
  const shot = async name => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
    console.log('已保存', name);
  };

  for (let i = 0; i < 60 && (await ev('document.readyState')) !== 'complete'; i++) await sleep(300);
  await ev(`(function(){try{localStorage.clear()}catch(e){}$('qualitySel').value='q-high';$('enhanceSel').value='none';readImgSettings();saveSettings();return 1;})()`);

  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId });
  for (let i = 0; i < 60 && !(await ev('state.pages.length')); i++) await sleep(300);
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await sleep(1800);

  const rect = await ev(`(function(){const r=$('pvOverlay').getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height};})()`);
  const P = (fx, fy) => [rect.l + rect.w * fx, rect.t + rect.h * fy];
  const raw = (t, X, Y) => cdp.send('Input.dispatchMouseEvent', { type: t, x: X, y: Y, button: 'left', clickCount: 1, buttons: t === 'mouseReleased' ? 0 : 1 });
  const drag = async (x0, y0, x1, y1) => {
    let [a, b] = P(x0, y0); await raw('mousePressed', a, b);
    let [c, d] = P((x0 + x1) / 2, (y0 + y1) / 2); await raw('mouseMoved', c, d);
    [c, d] = P(x1, y1); await raw('mouseMoved', c, d); await raw('mouseReleased', c, d);
    await sleep(150);
  };

  // 1) 高亮：画完自动选中，显示 8 个控制点
  await ev(`setTool('highlight')`);
  await drag(0.12, 0.42, 0.55, 0.60);
  await sleep(1500);
  await shot('C1-选中标注控制点.png');

  // 2) 文本框：底色纯透明（压在原文上才看得出没有灰白底），字号调大便于肉眼确认
  await ev(`state.edit.txtS = 30; setTool('text'); 1`);
  await drag(0.22, 0.34, 0.82, 0.47);
  await sleep(900);
  await ev(`(function(){const ta=$('pvEditorTa');ta.value='透明底色 · 下方原文仍可见';ta.dispatchEvent(new Event('input'));return 1;})()`);
  await sleep(300);
  await ev(`$('pvEditorTa').blur(); 1`);
  await sleep(1600);
  await shot('C2-文本框透明底色.png');

  // 3) 左右翻页大按钮：再导入 2 页，回到第 1 页（此时「上一页」为禁用态）
  await ev(`closePreview(); 1`);
  await sleep(500);
  for (let k = 0; k < 2; k++) {
    const { root: r2 } = await cdp.send('DOM.getDocument');
    const { nodeId: n2 } = await cdp.send('DOM.querySelector', { nodeId: r2.nodeId, selector: '#fileInput' });
    await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId: n2 });
    await sleep(1600);
  }
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await sleep(2000);
  await shot('D1-预览翻页按钮.png');

  // 4) 图片页：默认等比放大到触边（与缩略图/导出一致）
  await ev(`setTool('select'); 1`);
  await sleep(400);
  await shot('E1-图片默认触边.png');

  // 5) 「图片」工具：缩放 + 拖拽手动摆放
  await ev(`setTool('image'); 1`);
  await sleep(1200);
  const zr = await ev(`(async function(){const p=currentPreviewPage();ensureImgAdj(p);p.imgAdj.s=0.7;clampImgAdj(p);syncEdSizeUI();await refreshPreviewOps(p);return JSON.stringify({adj:p.imgAdj,vis:$('tbImg').style.display});})()`);
  console.log('缩放 70% →', zr);
  await sleep(500);
  await shot('E2-图片缩放到70%.png');

  const r2 = await ev(`(function(){const r=$('pvOverlay').getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height};})()`);
  const sx = r2.l + r2.w * 0.52, sy = r2.t + r2.h * 0.52;
  await raw('mousePressed', sx, sy);
  await raw('mouseMoved', sx - r2.w * 0.10, sy - r2.h * 0.08);
  await raw('mouseMoved', sx - r2.w * 0.20, sy - r2.h * 0.16);
  await raw('mouseReleased', sx - r2.w * 0.20, sy - r2.h * 0.16);
  await sleep(1200);
  const dr = await ev(`(function(){const p=currentPreviewPage();return JSON.stringify(p.imgAdj);})()`);
  console.log('拖拽后 →', dr);
  await shot('E3-图片拖拽摆放.png');

  // 6) 常用色快捷色板：标注工具条
  await ev(`setTool('highlight'); 1`);
  await sleep(500);
  await shot('F1-常用色色板-标注工具条.png');

  // 7) 常用色快捷色板：设置卡（水印 / 页码）
  await ev(`closePreview(); 1`);
  await sleep(500);
  await ev(`(function(){
    ['wmOn','pnOn'].forEach(id => { $(id).checked = true; $(id).dispatchEvent(new Event('change')); });
    document.querySelector('.scard:nth-of-type(3)').scrollIntoView({block:'center'});
    return 1;})()`);
  await sleep(700);
  await shot('F2-常用色色板-设置卡.png');

  console.log('完成');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
