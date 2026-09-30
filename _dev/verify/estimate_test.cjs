// 体积预估精度回归测试（CDP 驱动无头 Edge）
//
// 覆盖用户报的问题：预估与实际导出差好几倍（矢量保真 9.45 vs 1.8、高清 5.98 vs 2 等）。
// 根因：用固定 bytesPerPixel 猜压缩率，而 JPEG 压缩率完全取决于内容（实测同档位能差 10 倍）。
// 修法：对采样页真实编码（走导出同一条路径 pageRasterJpeg），得到实际 bpp 再外推。
//
// 用法：node estimate_test.cjs [页面路径] [端口]
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { ensure: ensureBrowser } = require('./_edge.cjs');
const DEV = path.join(__dirname, '..');
const PAGE = pathToFileURL(process.argv[2] || path.join(DEV, 'index.html')).href;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms = 60000) {
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
const parseMB = s => {
  const m = String(s).match(/([\d.]+)\s*(KB|MB|GB|B)/i);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  return /KB/i.test(m[2]) ? n / 1024 : /GB/i.test(m[2]) ? n * 1024 : /^B$/i.test(m[2]) ? n / 1048576 : n;
};

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
      const t = m.params.entry.text; if (!IGNORE.test(t)) errors.push(t);
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

  await waitFor(async () => (await ev('document.readyState')) === 'complete', '页面加载');
  await sleep(400);
  await ev(`(function(){try{localStorage.clear()}catch(e){}
    window.__cap = null;
    window.downloadBytes = function(b){ window.__cap = b.length; };   // 拦截导出，避免真下载
    window.confirm = function(){ return true; };   // clearAll() 里有 confirm，无头下会一直阻塞
    return 1;})()`);

  async function importFile(file) {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
    await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId });
    await waitFor(async () => (await ev('state.pages.length')) > 0, '导入 ' + path.basename(file));
    await sleep(600);
  }
  /* 切档 → 等「实测校准」→ 读预估 → 真实导出 → 读实际
   *
   * ⚠️ 必须等「实测校准」再读预估，而且预算要给足 90s。
   * 真实采样要对最多 4 页按导出同一条路径做 300 DPI 的 JPEG 编码，是这套测试里最重的活
   * （机器空闲时实测只要 66~219ms，1.9s 内就校准完；但连着跑一堆浏览器套件、CPU 被占住时，
   * 首次采样能拖到几十秒）。
   * 早期只等 12s：采样没做完，脚本就带着**兜底系数**（QUALITY_BPP 常量）把预估读走了 ——
   * 表现为系统性低估 13~20%（图片页 0.84 vs 实际 0.97、PDF 页 0.18 vs 0.23），
   * 看着像「预估算法坏了」，实际是测试自己抢跑，机器一空闲就复现不出来，纯坑人。
   * 现在：预算 90s（正常路径 2s 内就 break，给足不花钱）+ 把「是否真的校准了」记进结果，
   * 抢跑会明确报「未校准」而不是伪装成精度问题。 */
  async function measure(q) {
    process.stdout.write('   · ' + q + ' 采样中…');
    await ev(`(function(){$('qualitySel').value='${q}';$('qualitySel').dispatchEvent(new Event('change'));
      window.__cap=null; updateEstimate(); return 1;})()`);
    let text = '', calibrated = false;
    for (let i = 0; i < 225; i++) {                      // 最多 90s
      text = await ev(`$('estText').textContent`);
      if (text.includes('实测校准') || text.includes('原样输出')) { calibrated = true; break; }
      await sleep(400);
    }
    if (!calibrated) process.stdout.write(' ⚠️ 90s 内未完成实测校准，本次预估用的是兜底系数，结果不可信…');
    const est = parseMB(text);
    process.stdout.write(' 导出中…');
    await ev(`(async function(){ window.__cap=null; await doExport(); return 1; })()`);
    let real = null;
    for (let i = 0; i < 50 && real === null; i++) { real = await ev('window.__cap'); if (real === null) await sleep(400); }
    console.log(' 预估 ' + (isFinite(est) ? est.toFixed(2) + 'MB' : '?')
      + ' / 实际 ' + (real ? (real / 1048576).toFixed(2) + 'MB' : '未捕获')
      + (calibrated ? '' : '  ← 未校准'));
    return { est, real: real ? real / 1048576 : 0, text, calibrated };
  }

  // ---------- 1. 图片页（JPEG 压缩率取决于内容，最容易估错） ----------
  console.log('[1] 图片页 扫描件样本.png');
  await importFile(path.join(__dirname, 'fixtures', '扫描件样本.png'));
  const imgRows = [];
  for (const q of ['q-high', 'q-lite']) imgRows.push(Object.assign({ q }, await measure(q)));
  const mtxt = r => `${r.q} 预估 ${r.est.toFixed(2)}MB / 实际 ${r.real.toFixed(2)}MB（×${(r.est / r.real).toFixed(2)}${r.calibrated ? '' : '，未校准'}）`;
  ok('图片页：预估与实际误差 ≤ 15%（且确已实测校准）',
    imgRows.every(r => r.calibrated && r.real && Math.abs(r.est - r.real) / r.real <= 0.15),
    imgRows.map(mtxt).join('｜'));

  // ---------- 2. PDF 页（含矢量直通） ----------
  console.log('[2] PDF 页 测试文件A.pdf');
  await ev(`(async function(){ await clearAll(); return 1;})()`);
  await sleep(600);
  await importFile(path.join(DEV, 'test', '测试文件A.pdf'));
  const pdfRows = [];
  for (const q of ['q-faithful', 'q-high', 'q-lite']) pdfRows.push(Object.assign({ q }, await measure(q)));
  const nonPassthrough = pdfRows.filter(r => !String(r.text).includes('原样输出'));
  ok('PDF 页：预估与实际误差 ≤ 15%（且确已实测校准）',
    nonPassthrough.length > 0 && nonPassthrough.every(r => r.calibrated && r.real && Math.abs(r.est - r.real) / r.real <= 0.15),
    nonPassthrough.map(mtxt).join('｜'));

  // ---------- 3. 切档位后必须重新校准（不能沿用上一档的 bpp） ----------
  const bppTrack = await ev(`(function(){ return { bpp: estBpp, sig: estSig, cur: currentEstSig() };})()`);
  ok('当前档位已完成实测校准（签名匹配）', !!bppTrack.bpp && bppTrack.sig === bppTrack.cur,
    `bpp 档位=${Object.keys(bppTrack.bpp || {}).join(',')}｜签名匹配=${bppTrack.sig === bppTrack.cur}`);

  // ---------- 4. 采样确实重编码了（每组各自有 bpp + 像素校正比，不是固定常数） ----------
  const bppVals = Object.values(bppTrack.bpp || {});
  ok('每组都有实测 bpp 与像素校正比（非固定常数表）',
    bppVals.length >= 1 && bppVals.every(v => v && typeof v === 'object' && v.bpp > 0 && v.bpp < 1 && v.ratio > 0),
    JSON.stringify(Object.fromEntries(Object.entries(bppTrack.bpp || {})
      .map(([k, v]) => [k, { bpp: +v.bpp.toFixed(4), ratio: +(v.ratio || 0).toFixed(3) }]))));

  // ---------- 4b. 混合文档（图片 + PDF 各一个文件）：两组必须分别有系数 ----------
  await ev(`(async function(){ await clearAll(); return 1;})()`);
  await sleep(600);
  await importFile(path.join(__dirname, 'fixtures', '扫描件样本.png'));
  await importFile(path.join(DEV, 'test', '测试文件A.pdf'));
  await ev(`(function(){$('qualitySel').value='q-high';$('qualitySel').dispatchEvent(new Event('change'));
    updateEstimate(); return 1;})()`);
  for (let i = 0; i < 225; i++) {                      // 同上：预算 90s，别抢跑
    if (String(await ev(`$('estText').textContent`)).includes('实测校准')) break;
    await sleep(400);
  }
  const mix = await ev(`(function(){ return { keys: Object.keys(estBpp || {}), bpp: estBpp };})()`);
  ok('混合文档：图片页与 PDF 页各自成组（不共用一套系数）',
    mix.keys.filter(k => k.indexOf('q-high') === 0).length >= 2,
    `分组=${mix.keys.join(' , ')}`);
  const detail = await ev(`(function(){
    const out = [];
    for (const p of state.pages) {
      const q = effQualityOf(p), key = q.id + '|' + (p.fileId || '_');
      const c = (estBpp || {})[key], px = estRasterPx(p, q);
      out.push(p.kind + '/f' + p.fileId + ' px=' + Math.round(px / 1e6) + 'M coef=' + (c ? c.bpp.toFixed(5) + '×' + c.ratio.toFixed(2) : '兜底')
        + ' → ' + Math.round(px * (c ? c.ratio : 1) * (c ? c.bpp : 0.1) / 1024) + 'KB');
    }
    return out.join(' ｜ ') + ' ｜ 合计 ' + Math.round(estimateBytes() / 1024) + 'KB';})()`);
  console.log('   [明细] ' + detail);
  const mixRow = await measure('q-high');
  ok('混合文档：预估与实际误差 ≤ 15%（且确已实测校准）',
    mixRow.calibrated && mixRow.real && Math.abs(mixRow.est - mixRow.real) / mixRow.real <= 0.15,
    `预估 ${mixRow.est.toFixed(2)}MB / 实际 ${mixRow.real.toFixed(2)}MB（×${(mixRow.est / mixRow.real).toFixed(2)}${mixRow.calibrated ? '' : '，未校准'}）`);

  // ---------- 5. 导出链路未被改动破坏（共用 pageRasterJpeg） ----------
  const expOk = await ev(`(function(){
    return { hasFn: typeof pageRasterJpeg === 'function' && typeof embedRasterPage === 'function',
             cap: window.__cap };})()`);
  ok('导出与预估共用同一条渲染路径', expOk.hasFn && expOk.cap > 0,
    `pageRasterJpeg/embedRasterPage 就绪｜上次导出 ${Math.round((expOk.cap || 0) / 1024)}KB`);

  ok('运行期无 JS 错误', errors.length === 0, errors.length ? errors.slice(0, 3).join(' / ') : '无');

  console.log('\n=== 体积预估测试结果 ===');
  results.forEach(r => console.log((r.pass ? '  ✅ ' : '  ❌ ') + r.name + (r.detail ? '\n       ' + r.detail : '')));
  const fail = results.filter(r => !r.pass).length;
  console.log('\n=== ' + (results.length - fail) + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
