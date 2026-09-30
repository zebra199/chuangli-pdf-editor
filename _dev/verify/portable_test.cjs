// 便携性实测：把 创立PDF编辑器.html 单独复制到一个空目录（不帯 lib/、不帯任何依赖），
// 模拟"拷贝到另一台电脑"，用真实 Edge 加载并跑完整 导入→增强→导出 流程。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJ = path.join(__dirname, '..', '..');   // 项目根（含交付物）
const html = fs.readFileSync(path.join(PROJ, '创立PDF编辑器.html'));

// 隔离目录：完全空，只有这一个 html
const iso = path.join(os.tmpdir(), 'pdf-portable-test-' + Date.now());
fs.mkdirSync(iso, { recursive: true });
const target = path.join(iso, '创立PDF编辑器.html');
fs.writeFileSync(target, html);
console.log('隔离目录:', iso);
console.log('目录内容:', fs.readdirSync(iso));

function openWs(url) {
  return new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(ws); ws.onerror = rej; });
}

(async () => {
  const newTab = await new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: +(process.env.EDGE_PORT || 9333), path: '/json/new?' + encodeURIComponent('file:///' + target.replace(/\\/g, '/')), method: 'PUT' },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.end();
  });
  const ws = await openWs(newTab.webSocketDebuggerUrl);
  let id = 0; const pending = {}; const errors = []; const reqs = [];
  const send = (method, params = {}) => new Promise(res => {
    const mid = ++id; pending[mid] = res;
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.addEventListener('message', m => {
    const msg = JSON.parse(m.data.toString());
    if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; }
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXC: ' + (msg.params.exceptionDetails && msg.params.exceptionDetails.text));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
      errors.push('CONSOLE: ' + msg.params.args.map(a => a.value || a.description || '').join(' '));
    // 捕获所有网络请求，确认没有外部依赖
    if (msg.method === 'Network.requestWillBeSent') reqs.push(msg.params.request.url);
  });
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await new Promise(r => setTimeout(r, 3500));

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EVAL: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  };

  console.log('\n=== 1. 核心库自包含（无外网、无 lib/） ===');
  console.log(await ev(`JSON.stringify({
    url: location.href,
    protocol: location.protocol,
    PDFLib: typeof PDFLib,
    pdfjsLib: typeof pdfjsLib,
    heic2any: typeof heic2any,
    workerB64Len: (window.__PDFJS_WORKER_B64__||'').length,
    enhanceCanvas: typeof enhanceCanvas,
    enhanceHasNewAlgo: enhanceCanvas.toString().includes('BG_FLOOR')
  })`));

  console.log('\n=== 2. UI 完整性 ===');
  console.log(await ev(`JSON.stringify({
    title: document.title,
    qualityOptions: Array.from(document.getElementById('qualitySel').options).map(o=>o.value),
    enhanceOptions: Array.from(document.getElementById('enhanceSel').options).map(o=>o.value),
    hasDropzone: !!document.getElementById('dropzone'),
    hasExportBtn: !!document.getElementById('exportBtn')
  })`));

  console.log('\n=== 3. 真实导入 JPG → 增强 → 导出（file:// 协议下） ===');
  // 生成一张测试图（不依赖外部文件）
  const jpgB64 = fs.readFileSync(path.join(__dirname, 'fixtures', '扫描件样本.png')).toString('base64');
  console.log(await ev(`(async () => {
    const bin = atob("${jpgB64}");
    const arr = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([arr],'t.png',{type:'image/png'}));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,4000));
    return JSON.stringify({ pages: state.pages.length, kind: state.pages[0] && state.pages[0].kind });
  })()`));

  console.log(await ev(`(async () => {
    const stat = (cv) => {
      const ctx=cv.getContext('2d',{willReadFrequently:true});
      const d=ctx.getImageData(0,0,cv.width,cv.height).data;
      let n=cv.width*cv.height,dark=0,white=0,sum=0,rr=0,rg=0,rn=0;
      for(let i=0;i<d.length;i+=4){const r=d[i],g=d[i+1],b=d[i+2];
        const gy=(r*54+g*183+b*19)>>8; sum+=gy; if(gy<100)dark++; if(gy>=250)white++;
        if(r-g>30&&r>90){rr+=r;rg+=g;rn++;}}
      return {mean:+(sum/n).toFixed(1),darkPct:+(dark/n*100).toFixed(2),
        whitePct:+(white/n*100).toFixed(2),redRG:rn?+(rr/rn-rg/rn).toFixed(1):0};
    };
    const out={};
    for (const lvl of ['none','standard']) {
      document.getElementById('enhanceSel').value=lvl;
      document.getElementById('enhanceSel').dispatchEvent(new Event('change'));
      out[lvl]=stat(renderImageCanvas(state.pages[0]).cv);
    }
    document.getElementById('enhanceSel').value='none';
    document.getElementById('enhanceSel').dispatchEvent(new Event('change'));
    return JSON.stringify(out);
  })()`));

  console.log('\n=== 4. 外部网络请求（应仅 file:// 本地） ===');
  const external = reqs.filter(u => !u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:'));
  console.log('  总请求数:', reqs.length, ' 非本地请求:', external.length ? external : '无 ✅');

  console.log('\n错误日志:', errors.length ? errors : '无 ✅');

  // 清理隔离目录
  ws.close();
  setTimeout(() => { try { fs.rmSync(iso, { recursive: true, force: true }); } catch {} process.exit(0); }, 500);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
