'use strict';
// lx-hub 演示站适配层：拦截 /api/* 请求，用 Actions 预生成的 data.json 应答。
// 真前端 index.html/style.css/app.js 逐字复用、零改动：
//   - 「设置」按钮因 authed=false 不会出现；「更新」扫描按钮已在构建期剥除
//   - 复制/下载/导出 ZIP/详情弹窗/搜索筛选全部走真前端逻辑
(function () {
  var realFetch = window.fetch.bind(window);
  var realOpen = window.open ? window.open.bind(window) : null;
  var DATA = null;
  var ready = realFetch('data.json', { cache: 'no-cache' })
    .then(function (r) { return r.json(); })
    .then(function (d) { DATA = d; });

  function jsonResp(obj) {
    return Promise.resolve(new Response(JSON.stringify(obj), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
  }
  function qs(url) {
    var i = url.indexOf('?');
    return new URLSearchParams(i >= 0 ? url.slice(i + 1) : '');
  }
  function rel(ms) {
    var diff = Math.max(0, Date.now() - ms);
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.max(1, Math.floor(diff / 60000)) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return Math.floor(diff / 86400000) + ' 天前';
  }
  function findItem(id) {
    var list = (DATA && DATA.items) || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(id)) return list[i];
    }
    return null;
  }
  // 加速前缀（与 Docker 版同源行为：后台配置镜像 → 前台勾选拼接）；演示端固定 proxy.vvvv.ee
  var ACCEL_PREFIX = 'https://proxy.vvvv.ee';
  function accelRewrite(url) {
    if (!url) return url;
    return ACCEL_PREFIX + '/' + url;
  }

  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/') !== 0) return realFetch(input, init);
      var path = url.replace(/^https?:\/\/[^/]+/, '');
      return ready.then(function () {
        if (path.indexOf('/api/overview') === 0) {
          var genAt = DATA.generatedAt ? new Date(DATA.generatedAt).getTime() : 0;
          return jsonResp({
            total: DATA.totalEntries, ok: DATA.usableCount, sources: DATA.usableCount,
            lastCrawlRel: genAt ? rel(genAt) : null, lastCrawlAt: genAt,
            accelReady: true, accelPrefix: ACCEL_PREFIX, accelHost: 'proxy.vvvv.ee', authed: false
          });
        }
        if (path.indexOf('/api/entries') === 0) {
          var q = qs(path);
          var s = (q.get('search') || '').toLowerCase();
          var st = q.get('status') || 'all';
          var tp = q.get('type') || 'src';
          var list = (DATA.items || []).filter(function (it) {
            if ((st === 'alive' || st === 'ok' || st === 'all') === false) return false; // 演示数据全为可用
            if (tp === 'unk') return false; // 演示数据无存疑条目
            if (!s) return true;
            return (it.name + ' ' + it.author + ' ' + (it.url || '') + ' ' + (it.originRepo || '')).toLowerCase().indexOf(s) >= 0;
          });
          return jsonResp({ items: list, total: list.length });
        }
        if (path.indexOf('/api/source/link') === 0) {
          var it = findItem(qs(path).get('id'));
          if (!it) return jsonResp({ error: 'not found' });
          var u = qs(path).get('accel') === '1' ? accelRewrite(it.url) : it.url;
          return jsonResp({ url: u });
        }
        if (path.indexOf('/api/source/detail') === 0) {
          var d = findItem(qs(path).get('id'));
          if (!d) return jsonResp({ error: 'not found' });
          if (qs(path).get('accel') === '1') d = Object.assign({}, d, { url: accelRewrite(d.url) });
          return jsonResp(d);
        }
        if (path.indexOf('/api/export') === 0) {
          return realFetch('sources.zip').then(function (r) { return r.blob(); }).then(function (b) {
            return new Response(b, {
              status: 200,
              headers: {
                'content-type': 'application/zip',
                'content-disposition': 'attachment; filename="lx-sources-' + new Date().toISOString().slice(0, 10) + '.zip"'
              }
            });
          });
        }
        if (path.indexOf('/api/task/current') === 0) return jsonResp({ running: false });
        return jsonResp({}); // 其余（admin 类）接口：演示站一律空应答
      });
    } catch (e) { return realFetch(input, init); }
  };

  // 单源下载走 window.open，fetch 拦截不到：改造成 blob + a[download]（保留源名作文件名）
  window.open = function (url) {
    if (typeof url === 'string' && url.indexOf('/api/source/download') === 0) {
      ready.then(function () {
        var it = findItem(qs(url).get('id'));
        if (!it) return;
        return realFetch('s/' + encodeURIComponent(it.id) + '.js').then(function (r) {
          if (!r.ok) throw new Error('file missing');
          return r.blob();
        }).then(function (b) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(b);
          a.download = ((it.name || 'source').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)) + '.js';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
        });
      }).catch(function () { /* 静默 */ });
      return null;
    }
    return realOpen ? realOpen.apply(window, arguments) : null;
  };
})();
