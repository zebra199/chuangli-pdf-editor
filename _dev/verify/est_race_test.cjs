// 预估采样竞态回归（CDP 驱动无头 Edge）
//
// 守护的缺陷：runEstSample 开头 `if (estBusy || ...) return false;` 会把请求直接丢掉，
// 而 scheduleEstSample 的 350ms 防抖定时器**已经烧掉**了 —— 采样在飞时切档位，
// 这一轮请求就没人再排，界面**永久停在「测算中」**，预估一直用兜底常数（会系统性偏低）。
//
// 确定性复现手法：把 pageRasterJpeg 人为拖慢 3s，保证 estBusy 在切档时必然为真。
//   未修版本：start@389 → DROPPED@828 → end@4481，之后再无采样 → 一直「测算中」
//   已修版本：…→ end@4463 → **start@4817** → end@8898 → 以当前档位系数校准完成
// 同时统计「被 estBusy 丢掉的请求次数」，让缺陷机制可见（丢 1 次是预期的，关键是丢完要补跑）。
//
// 用法：node est_race_test.cjs [页面路径] [端口]
const path = require('path');
const { pathToFileURL } = require('url');
const { ensure: ensureBrowser } = require('./_edge.cjs');
const DEV = path.join(__dirname, '..');
const PAGE = pathToFileURL(process.argv[2] ? path.resolve(__dirname, process.argv[2]) : path.join(DEV, 'index.html')).href;
const IMG = path.join(__dirname, 'fixtures', '扫描件样本.png');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) {} await sleep(100); }
  return false;
}
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
  const browser = await ensureBrowser(process.argv[3] || process.env.EDGE_PORT);
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

  await waitFor(async () => (await ev('document.readyState')) === 'complete', '页面加载', 30000);
  // 注意：readyState=complete 之后主脚本的全局**还没**全部就位（实测 pageRasterJpeg 会晚上一点），
  // 这里必须等到它真的是函数再打桩，否则直接 ReferenceError。
  await waitFor(async () => (await ev('typeof pageRasterJpeg')) === 'function', 'pageRasterJpeg 就绪', 15000);
  await sleep(200);
  // 桩：拖慢编码 + 记录每次 runEstSample 的调用与是否被 estBusy 丢掉
  await ev(`(function(){try{localStorage.clear()}catch(e){}
    window.__log = []; window.__drops = 0; window.T0 = Date.now();
    const oj = pageRasterJpeg;
    pageRasterJpeg = async function(){ await new Promise(r=>setTimeout(r,3000)); return oj.apply(null,arguments); };
    const orig = runEstSample;
    runEstSample = async function(){
      if (estBusy) { window.__drops++; window.__log.push('DROPPED@'+(Date.now()-T0)); return false; }
      window.__log.push('start@'+(Date.now()-T0));
      const r = await orig.apply(null, arguments);
      window.__log.push('end@'+(Date.now()-T0));
      return r;
    };
    return 1;})()`);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId });
  await waitFor(async () => (await ev('state.pages.length')) === 1, '图片导入');

  // 等导入时那次采样真的跑起来（estBusy=true），此时切档最容易被丢
  const busy = await waitFor(async () => (await ev('estBusy')) === true, '采样在飞', 8000);
  console.log('  estBusy 已置位：' + busy);
  await ev(`(function(){$('qualitySel').value='q-lite';$('qualitySel').dispatchEvent(new Event('change'));
    updateEstimate(); return 1;})()`);
  console.log('  已在采样在飞时切到 q-lite');

  let ok = false;
  for (let i = 0; i < 60; i++) {                       // 最多 24s（桩每次 3s）
    const st = await ev(`(function(){return { t: Date.now()-T0, text: $('estText').textContent,
      busy: estBusy, drops: window.__drops, keys: Object.keys(estBpp||{}),
      sigMatch: estSig === currentEstSig() };})()`);
    if (i % 4 === 0 || st.text.includes('实测校准')) {
      console.log(`  ${String(st.t).padStart(6)}ms ${st.text.includes('实测校准') ? '★已校准' : '测算中'} busy=${st.busy} 丢请求=${st.drops} 签名匹配=${st.sigMatch} keys=${st.keys.join(',') || '-'}`);
    }
    if (st.text.includes('实测校准') && st.sigMatch) { ok = true; break; }
    await sleep(400);
  }
  const log = await ev('window.__log');
  console.log('  采样轨迹：' + log.join(' → '));
  console.log('  被 estBusy 丢掉的请求次数：' + (await ev('window.__drops')));
  console.log(ok ? '\n  ✅ 切档后最终完成校准（不会卡死）'
                 : '\n  ❌ 一直没校准 → 永久卡在「测算中」，预估只能用兜底常数');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('失败：', e && e.message || e); process.exit(1); });
