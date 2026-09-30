// 用真实多页 PDF 验证：解析后应把单个占位展开成"对应页数"的灰格
const http = require('http');
const fs = require('fs');
const path = require('path');

const DEV = path.join(__dirname, '..');
const ROOT = path.join(DEV, '..');
const PAGE = path.join(DEV, 'index.html');

function openWs(url) {
  return new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(ws); ws.onerror = rej; });
}

(async () => {
  // 找项目里的测试 PDF
  const testDir = path.join(DEV, 'test');
  let pdfPath = null;
  if (fs.existsSync(testDir)) {
    const f = fs.readdirSync(testDir).find(x => /\.pdf$/i.test(x));
    if (f) pdfPath = path.join(testDir, f);
  }
  if (!pdfPath) { console.error('未找到测试 PDF'); process.exit(1); }
  console.log('测试 PDF:', path.basename(pdfPath), (fs.statSync(pdfPath).size / 1048576).toFixed(2), 'MB');

  const newTab = await new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: +(process.env.EDGE_PORT || 9333), path: '/json/new?about:blank', method: 'PUT' },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.end();
  });
  const ws = await openWs(newTab.webSocketDebuggerUrl);
  let id = 0; const pending = {}; const errors = [];
  const send = (m, p = {}) => new Promise(r => { const mid = ++id; pending[mid] = r; ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
      errors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'file:///' + PAGE.replace(/\\/g, '/') });
  await new Promise(r => setTimeout(r, 3000));

  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result && r.result.value; };

  const b64 = fs.readFileSync(pdfPath).toString('base64');

  // 注入 PDF，并持续采样骨架数量变化
  const res = await ev(`(async () => {
    const bytes = "${b64}";
    const bin = atob(bytes);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([arr], '多页文档.pdf', { type: 'application/pdf' }));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const samples = [];
    let maxSkel = 0, sawPageLevelSkeleton = false;
    for (let t = 0; t < 200; t++) {
      await new Promise(r => setTimeout(r, 20));
      const skels = [...document.querySelectorAll('.card.skel')];
      const labels = skels.map(s => (s.querySelector('.name') || {}).textContent || '');
      const pageLevel = labels.filter(l => /·\\s*P\\d+/.test(l)).length;
      if (pageLevel > 0) sawPageLevelSkeleton = true;
      maxSkel = Math.max(maxSkel, skels.length);
      samples.push({ t: t * 20, skel: skels.length, pageLevel, real: document.querySelectorAll('.card:not(.skel)').length });
      if (!state.importing && t > 3) break;
    }
    await new Promise(r => setTimeout(r, 800));
    return JSON.stringify({
      numPages: state.files[0] ? state.files[0].pageCount : 0,
      importedPages: state.pages.length,
      maxSkel, sawPageLevelSkeleton,
      finalSkel: document.querySelectorAll('.card.skel').length,
      samples: samples.filter((s, i) => i % 3 === 0 || s.pageLevel > 0).slice(0, 14),
      folderInfo: document.getElementById('footInfo').textContent,
      thumbs: state.pages.filter(p => p.displayThumb).length
    });
  })()`);
  console.log(res);
  const R = JSON.parse(res);

  let pass = 0, fail = 0;
  const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✅ ' + n + (x ? '  ' + x : '')); } else { fail++; console.log('  ❌ ' + n + (x ? '  ' + x : '')); } };

  console.log('\n=== 结果 ===');
  check('PDF 页数解析正确', R.numPages > 0, `${R.numPages} 页`);
  check('全部页面导入完成', R.importedPages === R.numPages, `${R.importedPages}/${R.numPages}`);
  check('出现过"逐页"灰格（对应页数占位）', R.sawPageLevelSkeleton);
  check('灰格数量曾接近页数', R.maxSkel >= Math.min(R.numPages, 4), `峰值 ${R.maxSkel} 个 / 共 ${R.numPages} 页`);
  check('结束后骨架全部清除', R.finalSkel === 0);
  check('所有页都生成了缩略图', R.thumbs === R.numPages, `${R.thumbs}/${R.numPages}`);
  check('底栏显示页数', /共 \d+ 页/.test(R.folderInfo), R.folderInfo);
  check('无控制台错误', errors.length === 0, errors.join(' | ') || '');

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
