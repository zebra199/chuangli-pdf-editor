// 串行跑「旧」浏览器套件（这些脚本本身不自启浏览器，需要外部实例）。
// 本运行器负责：用唯一 profile + 系统空闲端口启动一个共享无头 Edge，
// 再把端口通过 EDGE_PORT 传给各脚本，跑完后回收实例。
// 用法：node run_legacy.cjs [脚本名 ...]   省略参数时跑默认清单
const { spawn } = require('child_process');
const path = require('path');
const edge = require('./_edge.cjs');

const DEFAULT = ['ux_test.cjs', 'final_accept.cjs', 'ux_geom.cjs', 'ux_pdf_test.cjs', 'portable_test.cjs',
                 'est_race_test.cjs'];   // 预估采样竞态：采样在飞时切档位必须补跑，不能卡在「测算中」

function run(file, env) {
  return new Promise(res => {
    const p = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: __dirname, stdio: 'inherit',
      env: Object.assign({}, process.env, env)
    });
    p.on('exit', code => res(code || 0));
  });
}

(async function main() {
  const list = process.argv.slice(2).filter(a => a.endsWith('.cjs'));
  const files = list.length ? list : DEFAULT;

  console.log('启动共享无头浏览器（唯一 profile + 自动空闲端口）…');
  const b = await edge.launch();
  console.log('已就绪：端口 ' + b.port + '\n');

  let bad = 0;
  for (const f of files) {
    console.log('\n##### ' + f + ' #####');
    const code = await run(f, { EDGE_PORT: String(b.port) });
    if (code !== 0) { bad++; console.log('（' + f + ' 退出码 ' + code + '）'); }
    console.log('');
  }

  b.stop();
  console.log(bad ? ('\n有 ' + bad + ' 个套件退出码非 0') : '\n全部套件执行完毕');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('运行器失败：', e && e.message || e); process.exit(1); });
