'use strict';
// 沙箱深检工人进程：代码经 stdin 传入，结果 JSON 经 stdout 返回。
// 单独进程的意义：混淆/恶意脚本在 vm 里抛出的未捕获 Promise 拒绝、process.exit、
// 死循环（vm timeout 只管同步段）都只会杀死本工人，不会波及 lx-hub 主服务。
const sandbox = require('./sandbox');

process.on('unhandledRejection', function () { /* 脚本内部裸奔的 rejection：吞掉，按平台失败处理 */ });
process.on('uncaughtException', function (e) {
  process.stdout.write(JSON.stringify({ checkedAt: Date.now(), loadable: false, loadError: String(e && e.message || e).slice(0, 200), inited: false, platforms: {} }));
  process.exit(2);
});

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (d) { buf += d; });
process.stdin.on('end', function () {
  sandbox.deepCheck(buf).then(function (r) {
    process.stdout.write(JSON.stringify(r));
    process.exit(0);
  }).catch(function (e) {
    process.stdout.write(JSON.stringify({ checkedAt: Date.now(), loadable: false, loadError: String(e && e.message || e).slice(0, 200), inited: false, platforms: {} }));
    process.exit(0);
  });
  // 深检整体兜底超时：平台测试卡死也能退出（主进程另有强杀）
  setTimeout(function () {
    process.stdout.write(JSON.stringify({ checkedAt: Date.now(), loadable: true, loadError: '平台测试超时', inited: true, platforms: {} }));
    process.exit(3);
  }, 100000).unref();
});
