// 第八轮视觉确认截图：
//   1) 竖版页预览  2) 横版页预览（rot=90）  —— 两者显示面积应基本一致
//   3) 图片页在「精简」档的预览（应与高清档有可见的清晰度差别）
// 用法：node shots_round8.cjs [页面路径]
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
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
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
  await sleep(500);
  await ev(`(function(){try{localStorage.clear()}catch(e){}
    $('qualitySel').value='q-high';$('enhanceSel').value='none';
    readImgSettings();applyOverlayUI();saveSettings();return 1;})()`);

  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId });
  await waitFor(async () => (await ev('state.pages.length')) === 1, '图片导入');
  await sleep(800);

  // 1. 竖版（原始方向）
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await sleep(1800);
  const v = await ev(`(function(){const r=$('pvImg').getBoundingClientRect();
    return {w:Math.round(r.width),h:Math.round(r.height)};})()`);
  console.log('竖版显示 ' + v.w + '×' + v.h);
  await shot('G1-竖版预览.png');

  // 2. 横版（旋转 90°）
  await ev(`(function(){closePreview();state.pages[0].rot=90;renderList();updateFoot();return 1;})()`);
  await sleep(700);
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await sleep(1800);
  const h = await ev(`(function(){const r=$('pvImg').getBoundingClientRect();
    return {w:Math.round(r.width),h:Math.round(r.height)};})()`);
  console.log('横版显示 ' + h.w + '×' + h.h);
  await shot('G2-横版预览.png');

  const d = Math.abs(v.w * v.h - h.w * h.h) / Math.max(v.w * v.h, h.w * h.h);
  console.log('面积差 ' + (d * 100).toFixed(1) + '%');

  // 3. 精简档（切档位后预览应变糊 → 像素明显变小）
  await ev(`(function(){closePreview();state.pages[0].rot=0;renderList();updateFoot();
    $('qualitySel').value='q-lite';$('qualitySel').dispatchEvent(new Event('change'));return 1;})()`);
  await sleep(600);
  await ev(`document.querySelector('.card .thumb').click(); 1`);
  await sleep(2000);
  const px = await ev(`(function(){const im=$('pvImg');return im.naturalWidth+'x'+im.naturalHeight;})()`);
  console.log('精简档预览像素 ' + px);
  await shot('G3-精简档图片预览.png');

  console.log('\n截图完成 → ' + OUT);
  process.exit(0);
})().catch(e => { console.error('失败：', e && e.message || e); process.exit(1); });
