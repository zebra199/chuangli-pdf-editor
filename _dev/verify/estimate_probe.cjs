// 一次性诊断：量化「体积预估」与「真实导出」的偏差
// 用法：node _diag_est.cjs [样本文件]
const path = require('path');
const { pathToFileURL } = require('url');
const { ensure } = require('./_edge.cjs');
const PAGE = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
/* 默认样本改成 fixtures 里的 1.2MB 扫描件：原来默认指向 test/扫描件合集.pdf（12.7MB），
 * 那个大样本已随大文件清理删掉了。要拿别的样本做标定，命令行传路径即可。 */
const SAMPLE = process.argv[2] || path.join(__dirname, 'fixtures', '扫描件样本.png');
const sleep = ms => new Promise(r => setTimeout(r, ms));
class C {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map();
    ws.addEventListener('message', ev => { const m = JSON.parse(ev.data);
      if (m.id && this.p.has(m.id)) { const { res, rej } = this.p.get(m.id); this.p.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, pa = {}) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: pa })); }); }
}
(async () => {
  const b = await ensure();
  const tab = await (await fetch(b.base + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  const c = new C(ws);
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('DOM.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const ev = async e => {
    const r = await c.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval error');
    return r.result.value;
  };
  await sleep(2000);
  await ev(`(function(){try{localStorage.clear()}catch(e){}return 1;})()`);
  const { root } = await c.send('DOM.getDocument');
  const { nodeId } = await c.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await c.send('DOM.setFileInputFiles', { files: [SAMPLE], nodeId });
  for (let i = 0; i < 120 && !(await ev('state.pages.length')); i++) await sleep(500);
  const info = await ev(`({n:state.pages.length, kinds:state.pages.map(p=>p.kind).join(','),
    files:state.files.map(f=>f.name+'/'+f.pageCount+'p/'+Math.round((f.bytes.length||0)/1024)+'KB').join(' | ')})`);
  console.log('样本:', path.basename(SAMPLE));
  console.log('页数:', info.n, '｜类型:', info.kinds);
  console.log('源文件:', info.files);

  // 拦截 downloadBytes 以捕获真实导出字节
  await ev(`(function(){
    window.__cap = null;
    window.downloadBytes = function(bytes){ window.__cap = bytes.length; };
    return 1;})()`);

  const rows = [];
  for (const q of ['q-faithful', 'q-high', 'q-std', 'q-lite']) {
    await ev(`(function(){$('qualitySel').value='${q}';$('qualitySel').dispatchEvent(new Event('change'));
      window.__cap=null; updateEstimate(); return 1;})()`);
    // 等真实采样跑完（文案会从「测算中」变成「实测校准」）
    let est = '';
    for (let i = 0; i < 60; i++) {
      est = await ev(`$('estText').textContent`);
      if (est.includes('实测校准') || est.includes('原样输出')) break;
      await sleep(400);
    }
    const dbg = await ev(`(async function(){
      try { const r = await runEstSample(); return JSON.stringify({r, bpp: estBpp}); }
      catch (e) { return 'ERR: ' + (e && e.message); }})()`);
    await sleep(300);
    const m = est.match(/预计约\s*([\d.]+\s*[KMG]?B)/);
    const per = await ev(`(async function(){
      const out = [];
      for (const p of state.pages) {
        const q = effQualityOf(p);
        try { const r = await pageRasterJpeg(p, q);
          out.push({ pxReal: r.px, pxEst: estRasterPx(p, q), kb: Math.round(r.jpg.length/1024) }); }
        catch(e){ out.push({err: e.message}); }
      }
      return JSON.stringify({ per: out, bpp: estBpp, est: Math.round(estimateBytes()/1024) });})()`);
    console.log('   [per  ]', String(per).slice(0, 320));
    console.log('   [text ]', String(est).slice(0, 110));
    // 真实导出
    await ev(`(async function(){ window.__cap=null; await doExport(); return 1; })()`);
    let real = null;
    for (let i = 0; i < 200 && real === null; i++) { real = await ev(`window.__cap`); if (real === null) await sleep(500); }
    rows.push({ q, est: m ? m[1] : est.slice(0, 40), real });
  }
  console.log('\n档位        预估        实际      偏差');
  for (const r of rows) {
    const p = s => { const n = parseFloat(s); return /KB/i.test(s) ? n * 1024 : /MB/i.test(s) ? n * 1048576 : n; };
    const e = p(r.est), a = r.real || 0;
    const ratio = a ? (e / a) : 0;
    console.log(`${r.q.padEnd(12)} ${String(r.est).padEnd(11)} ${(a / 1048576).toFixed(2)}MB  ×${ratio.toFixed(2)}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
