// 第九轮视觉确认：按用户截图同样的视口（1912×948）抓竖版 / 横版预览。
// 面板边界由 Python 侧再画红框（见 shots_redbox.py），便于与用户标注的图直接对比。
// 用法：node shots_round9.cjs [页面路径]
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1912, height: 948, deviceScaleFactor: 1, mobile: false });
  const ev = async expr => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };
  const meta = {};
  const grab = async name => {
    const m = await ev(`(function(){
      const bx=document.querySelector('#preview .box').getBoundingClientRect();
      const st=document.querySelector('#preview .stage').getBoundingClientRect();
      const im=$('pvImg').getBoundingClientRect();
      return { bl:Math.round(bx.left), bt:Math.round(bx.top), br:Math.round(bx.right), bb:Math.round(bx.bottom),
               bw:Math.round(bx.width), imgW:Math.round(im.width), imgH:Math.round(im.height),
               sw:Math.round(st.width), sh:Math.round(st.height) };})()`);
    meta[name] = m;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
    console.log(`  ${name}  面板 ${m.bw}px x[${m.bl},${m.br}] ｜ 页面 ${m.imgW}×${m.imgH}`);
    console.log(`      边界 ${JSON.stringify(m)}`);
  };

  await waitFor(async () => (await ev('document.readyState')) === 'complete', '页面加载');
  await sleep(500);
  await ev(`(function(){try{localStorage.clear()}catch(e){}
    $('qualitySel').value='q-high';$('enhanceSel').value='none';
    readImgSettings();applyOverlayUI();saveSettings();return 1;})()`);

  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId });
  await waitFor(async () => (await ev('state.pages.length')) === 1, '图片导入');
  await sleep(700);

  // 竖版
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await sleep(1800);
  await grab('H1-竖版.png');

  // 横版（旋转 90°）
  await ev(`(function(){closePreview();state.pages[0].rot=90;renderList();updateFoot();return 1;})()`);
  await sleep(700);
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await sleep(1800);
  await grab('H2-横版.png');

  fs.writeFileSync(path.join(OUT, 'H-meta.json'), JSON.stringify(meta, null, 2));
  const dv = meta['H1-竖版.png'], dh = meta['H2-横版.png'];
  console.log('\n面积对比：竖版宽 ' + dv.bw + ' ｜ 横版宽 ' + dh.bw + ' ｜ 差 ' + Math.abs(dv.bw - dh.bw) + 'px');
  console.log('页面显示：竖版 ' + dv.imgW + '×' + dv.imgH + ' ｜ 横版 ' + dh.imgW + '×' + dh.imgH);
  console.log('\n截图 → ' + OUT);
  process.exit(0);
})().catch(e => { console.error('失败：', e && e.message || e); process.exit(1); });
