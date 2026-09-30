// 无头 Edge 生命周期管理（供各 verify 脚本共用）
// 设计要点：
//  1. 每个实例配唯一的 --user-data-dir（同名目录会被 SingletonLock 抢占，导致无头参数被忽略或直接启动失败）
//  2. 端口由系统自动分配空闲端口（固定 9333 在多任务并发时必然撞车）
//  3. 脚本退出前回收实例，不留僵尸进程
// 兼容用法：脚本若显式传入端口，则假定外部已有实例，本模块只连接不启动。
const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : ''
];

function findBrowser() {
  for (const p of EDGE_CANDIDATES) { try { if (p && fs.existsSync(p)) return p; } catch (e) {} }
  return '';
}
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
function waitReady(url, ms = 30000) {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    (async function loop() {
      for (;;) {
        try { const r = await fetch(url); if (r.ok) { await r.json(); return res(); } } catch (e) {}
        if (Date.now() - t0 > ms) return rej(new Error('调试端口 ' + url + ' 未就绪'));
        await new Promise(r => setTimeout(r, 300));
      }
    })();
  });
}
function killTree(pid) {
  if (!pid) return;
  try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
}

/**
 * 启动一个专属的无头浏览器实例。
 * @returns {{ port:number, base:string, version:object, stop:function, owned:boolean }}
 */
async function launch() {
  const exe = findBrowser();
  if (!exe) throw new Error('找不到 Edge/Chrome，请调整 _edge.cjs 的候选路径');
  const port = await freePort();
  const dir = path.join(os.tmpdir(), 'edge-verify-' + process.pid + '-' + Date.now());
  const proc = spawn(exe, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + dir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--allow-file-access-from-files'
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  proc.unref();
  const base = 'http://127.0.0.1:' + port;
  await waitReady(base + '/json/version');
  let version = {};
  try { version = await (await fetch(base + '/json/version')).json(); } catch (e) {}
  return {
    port, base, version, owned: true,
    stop() { killTree(proc.pid); }
  };
}

/**
 * 若外部没给端口就自启，否则连接已有实例。
 * @param {string|number} outerPort 命令行传入的端口（空则自启）
 */
async function ensure(outerPort) {
  if (outerPort) {
    const base = 'http://127.0.0.1:' + outerPort;
    await waitReady(base + '/json/version');
    return { port: +outerPort, base, version: {}, owned: false, stop() {} };
  }
  return launch();
}

module.exports = { ensure, launch, freePort, findBrowser };
