'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };

  // ---- 主题 ----
  var themeSel = $('themeSel');
  themeSel.value = localStorage.getItem('lxhub-theme') || 'system';
  function applyTheme() {
    var pref = themeSel.value;
    localStorage.setItem('lxhub-theme', pref);
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = pref === 'system' ? (dark ? 'dark' : 'light') : pref;
    document.documentElement.dataset.theme = theme;
  }
  themeSel.addEventListener('change', applyTheme);
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if ((localStorage.getItem('lxhub-theme') || 'system') === 'system') applyTheme();
    });
  }

  // ---- toast ----
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.display = 'none'; }, 2800);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function relTime(ts) {
    if (!ts) return null;
    var diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 30 * 86400000) return Math.floor(diff / 86400000) + ' 天前';
    return null; // 超过 30 天走日期
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }
  function fullTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
  }
  function fmtElapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function fmtSize(n) {
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  var overview = null;
  var items = [];
  var sortKey = null, sortDir = 1;

  // ---- 统计 ----
  function renderStats() {
    if (!overview) return;
    $('stTotal').textContent = overview.total;
    $('stAlive').textContent = overview.ok;
    $('stValid').textContent = overview.sources;
    var stCrawl = $('stCrawl');
    stCrawl.textContent = overview.lastCrawlRel || '—';
    stCrawl.title = overview.lastCrawlAt ? fullTime(overview.lastCrawlAt) : '';
    $('pfxOn').disabled = !overview.accelReady;
    $('pfxWrap').title = overview.accelReady
      ? ('开启后复制链接时拼接：' + overview.accelPrefix)
      : '后台未配置加速镜像 URL';
    if (!overview.accelReady) $('modeTip').textContent = '';
    // 登录后前台出现「设置」按钮跳后台（动态创建：未登录时 DOM 里没有此元素）
    if (overview.authed && !document.getElementById('btnAdminGo')) {
      var hdrBtns = document.querySelector('header .btns');
      if (hdrBtns) {
        var b = document.createElement('button');
        b.id = 'btnAdminGo';
        b.title = '打开后台管理';
        b.textContent = '设置';
        b.addEventListener('click', function () { location.href = '/admin'; });
        hdrBtns.appendChild(b);
      }
    }
  }

  // ---- 加速前缀勾选提示 ----
  function accelTip(checked) {
    if (!overview || !overview.accelReady) return '后台未配置加速镜像 URL';
    return checked ? ('复制时拼接 ' + (overview.accelHost || '加速镜像')) : '复制原始直链';
  }
  $('pfxOn').addEventListener('change', function () {
    var tip = accelTip(this.checked);
    $('pfxWrap').title = tip;
    if (!$('pfxOn').disabled) toast(tip);
  });

  // ---- 列表 ----
  var STATUS_ORD = { ok: 0, suspect: 1, down: 2, unknown: 3, dead: 4 };
  function sortedItems() {
    if (!sortKey || sortKey === 'no') return items.slice();
    var arr = items.slice();
    arr.sort(function (a, b) {
      var va, vb;
      if (sortKey === 'status') { va = STATUS_ORD[a.status] != null ? STATUS_ORD[a.status] : 9; vb = STATUS_ORD[b.status] != null ? STATUS_ORD[b.status] : 9; }
      else if (sortKey === 'plat') { va = (a.platforms || []).join(); vb = (b.platforms || []).join(); }
      else if (sortKey === 'upd') { va = a.updatedAt || 0; vb = b.updatedAt || 0; }
      else { va = String(a[sortKey] || ''); vb = String(b[sortKey] || ''); }
      var r = va < vb ? -1 : va > vb ? 1 : 0;
      return r * sortDir;
    });
    return arr;
  }

  function statusPill(s) {
    if (s === 'ok') return '<span class="pill ok"><i class="dot"></i>可用</span>';
    if (s === 'suspect') return '<span class="pill suspect" title="脚本可达但实测未取到任何可用平台音频">存疑</span>';
    if (s === 'down') return '<span class="pill down"><i class="dot"></i>后端挂</span>';
    if (s === 'dead') return '<span class="pill dead"><i class="dot"></i>失效</span>';
    return '<span class="pill unknown"><i class="dot"></i>待验证</span>';
  }

  // 「更新」列显示基准：仓库更新时间优先，其次脚本内容更新；<30 天相对，否则日期
  function updBase(e) {
    return e.repoPushAt || e.contentUpdatedAt || e.updatedAt;
  }
  function updText(e) {
    var rel = relTime(updBase(e));
    return rel || fmtDate(updBase(e));
  }
  function updTitle(e) {
    var lines = [];
    if (e.repoPushAt) lines.push('GitHub 仓库更新 ' + fullTime(e.repoPushAt));
    if (e.contentUpdatedAt) lines.push('脚本内容更新 ' + fullTime(e.contentUpdatedAt));
    lines.push('最近检测 ' + (e.lastCheckAt ? fullTime(e.lastCheckAt) : '未检测'));
    return lines.join('\n');
  }

  function renderRows() {
    var rows = $('rows');
    var list = sortedItems();
    $('modeTip').textContent = list.length ? ('共 ' + list.length + ' 条') : '';
    $('empty').style.display = list.length ? 'none' : 'block';
    if (!list.length) { rows.innerHTML = ''; return; }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var tags = '';
      if (e.scriptType === 'unknown' && e.status !== 'suspect') tags += '<span class="tag warn" title="脚本加载失败或结构不全，疑似非完整音源">存疑</span>';
      // 置信度标签已移除：可用/存疑状态由沙箱实测判定，旧的静态结构评分不再展示
      if (e.mirrorCount > 0) tags += '<span class="tag mirror" title="' + esc((e.mirrors || []).join('\n')) + '">+' + e.mirrorCount + ' 镜像</span>';
      if (e.variantCount > 0) tags += '<span class="tag mirror" title="' + esc((e.variants || []).map(function (v) { return v.src + ' · ' + (v.ver || '?'); }).join('\n')) + '">+' + e.variantCount + ' 变体</span>';
      var tagHtml = tags ? '<span class="inline-tags">' + tags + '</span>' : '';
      // 平台标签 = 沙箱实测可用的平台（不是脚本声明什么就显示什么）；实测真无损的平台追加 FLAC 小角标
      var PS_KEY = { '网易云': 'wy', 'QQ': 'tx', '酷我': 'kw', '酷狗': 'kg', '咪咕': 'mg' };
      var plats = (e.platforms || []).length
        ? '<div class="plats">' + e.platforms.map(function (p) {
            var ps = (e.platStatus || {})[PS_KEY[p] || p];
            var badge = '';
            if (ps && ps.lossless === 'matched') {
              var spec = ps.losslessSpec;
              var tip = '实测真无损' + (spec && spec.container === 'flac' && spec.bitDepth ? '（FLAC ' + spec.bitDepth + 'bit' + (spec.sampleRate ? '/' + Math.round(spec.sampleRate / 1000) + 'kHz' : '') + '）' : '');
              badge = '<i class="flac" title="' + esc(tip) + '">FLAC</i>';
            }
            return '<span class="plat">' + esc(p) + badge + '</span>';
          }).join('') + '</div>'
        : '<span class="muted">—</span>';
      html += '<div class="grid-row row" data-id="' + e.id + '">' +
        '<div class="c-no muted">' + (i + 1) + '</div>' +
        '<div class="c-st">' + statusPill(e.status) + '</div>' +
        '<div class="c-name name" title="' + esc(e.name) + '">' + esc(e.name) + tagHtml + '</div>' +
        '<div class="c-plat">' + plats + '</div>' +
        '<div class="c-ver muted cell-min" title="' + esc(e.version || '') + '">' + esc(e.version || '—') + '</div>' +
        '<div class="c-auth muted cell-min" title="' + esc(e.author || '') + '">' + esc(e.author || '—') + '</div>' +
        '<div class="c-upd muted" title="' + esc(updTitle(e)) + '">' + updText(e) + '</div>' +
        '<div class="c-act">' +
        '<button class="copy" data-copy="' + e.id + '">复制</button>' +
        '<button class="dl" data-dl="' + e.id + '">下载</button>' +
        '</div></div>';
    }
    rows.innerHTML = html;
  }

  // 表头排序
  $('thead').addEventListener('click', function (ev) {
    var span = ev.target.closest('span[data-sort]');
    if (!span) return;
    var key = span.dataset.sort;
    if (key === 'no') { sortKey = null; }
    else if (sortKey === key) { sortDir = -sortDir; }
    else { sortKey = key; sortDir = 1; }
    document.querySelectorAll('#thead span').forEach(function (s) {
      s.classList.remove('sorted-asc', 'sorted-desc');
    });
    if (sortKey && sortKey !== 'no') span.classList.add(sortDir === 1 ? 'sorted-asc' : 'sorted-desc');
    renderRows();
  });

  // ---- 数据加载 ----
  var searchTimer = null;
  function loadEntries() {
    var params = new URLSearchParams({
      search: $('q').value.trim(),
      status: $('st').value,
      type: $('tp').value
    });
    fetch('/api/entries?' + params).then(function (r) { return r.json(); }).then(function (data) {
      items = data.items || [];
      renderRows();
    }).catch(function () { toast('加载失败'); });
  }
  function refresh() {
    fetch('/api/overview').then(function (r) { return r.json(); }).then(function (d) {
      overview = d; renderStats();
    });
    loadEntries();
  }

  $('q').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadEntries, 300);
  });
  $('st').addEventListener('change', loadEntries);
  $('tp').addEventListener('change', loadEntries);

  // 行内操作 & 行点击弹详情
  $('rows').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button');
    if (btn) {
      ev.stopPropagation();
      if (btn.classList.contains('copy')) {
        copyEntry(btn.dataset.copy);
      } else if (btn.classList.contains('dl')) {
        var accel = $('pfxOn').checked && overview && overview.accelReady ? '1' : '0';
        window.open('/api/source/download?id=' + btn.dataset.dl + '&accel=' + accel, '_blank');
      }
      return;
    }
    var row = ev.target.closest('.grid-row.row');
    if (row) openDlg(row.dataset.id);
  });

  function copyEntry(id) {
    var accel = $('pfxOn').checked && overview && overview.accelReady ? '1' : '0';
    fetch('/api/source/link?id=' + id + '&accel=' + accel)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.url) return toast(d.error || '获取失败');
        navigator.clipboard.writeText(d.url).then(function () { toast($('pfxOn').checked ? '已复制（拼接加速前缀）' : '已复制原始直链'); })
          .catch(function () { toast('复制失败（需 HTTPS 或 localhost）'); });
      });
  }

  // ---- 详情弹窗 ----
  function openDlg(id) {
    var accel = $('pfxOn').checked && overview && overview.accelReady ? '1' : '0';
    fetch('/api/source/detail?id=' + id + '&accel=' + accel).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) return toast(d.error);
      window.dlgData = d;
      $('dName').textContent = d.name || '(未命名)';
      var subParts = [];
      if (d.version) subParts.push('v' + d.version);
      subParts.push(d.author || '未知作者');
      if (d.platforms && d.platforms.length) subParts.push(d.platforms.join(' / '));
      $('dSub').innerHTML = subParts.map(esc).join('<span class="sep">·</span>');
      $('dStatus').innerHTML = statusPill(d.status) +
        (d.httpStatus ? ' <span class="muted">(HTTP ' + d.httpStatus + ')</span>' : '');
      var apiEl = $('dApi');
      if (d.backendDomains && d.backendDomains.length) {
        apiEl.textContent = d.backendAlive > 0
          ? ('活 · ' + d.backendAlive + ' 个域名可访问')
          : '挂：声明的后端域名均不可达';
        apiEl.title = d.backendDomains.join('\n');
      } else {
        apiEl.textContent = '未识别';
        apiEl.title = '';
      }
      $('dType').textContent = d.scriptType === 'unknown'
        ? '存疑脚本' + (d.deepError ? '（加载失败: ' + d.deepError + '）' : '')
        : (d.platforms && d.platforms.length
          ? '音源脚本（沙箱实测）'
          : '音源脚本 · ' + (d.confidence === 'high' ? '高置信' : '低置信'));
      // 平台实测明细（复刻插件红绿点）：usable 绿 / failed 红 / skipped 灰
      // L2 无损核验徽章（仅 usable 平台）：真无损 / 降级 / 假无损 / 未响应 / 规格未知
      var psEl = $('dPlats');
      if (d.platStatus && Object.keys(d.platStatus).length) {
        var PLAT_NAMES = { wy: '网易云', tx: 'QQ', kw: '酷我', kg: '酷狗', mg: '咪咕' };
        var LL = {
          matched: { text: '真无损', cls: 'll-ok', tip: '声称无损实测确为无损' },
          degraded: { text: '降级', cls: 'll-mid', tip: '声称无损实测为 16bit FLAC（低于无损24bit）' },
          mismatch: { text: '假无损', cls: 'll-bad', tip: '声称无损实测为 MP3/MP4 等有损格式套壳' },
          refused: { text: '无损未响应', cls: 'll-dim', tip: '平台可用但请求无损音质未返回有效链接' },
          unknown: { text: '规格未知', cls: 'll-dim', tip: '返回了音频但头部规格无法识别（流式或非标封装）' }
        };
        var psHtml = '';
        for (var pk in d.platStatus) {
          var pe = d.platStatus[pk];
          var st = pe.status;
          var cls = st === 'usable' ? 'ok' : (st === 'failed' ? 'fail' : 'dim');
          var tip = pe.message || '';
          if (st === 'usable' && pe.lossless) {
            var ll = LL[pe.lossless];
            if (ll) {
              var specTip = '';
              var sp = pe.losslessSpec;
              if (sp && sp.container === 'flac' && sp.bitDepth && sp.sampleRate) {
                specTip = '（实测 ' + sp.container.toUpperCase() + ' ' + sp.bitDepth + 'bit/' + (sp.sampleRate / 1000) + 'kHz）';
              }
              psHtml += '<span class="plat-st ok" title="' + esc(tip) + '"><i class="dot"></i>' + (PLAT_NAMES[pk] || pk) + '</span>' +
                '<span class="ll-tag ' + ll.cls + '" title="' + esc(ll.tip + specTip + (pe.losslessReason ? '：' + pe.losslessReason : '')) + '">' + ll.text + '</span>';
              continue;
            }
          }
          psHtml += '<span class="plat-st ' + cls + '" title="' + esc(tip) + '"><i class="dot"></i>' + (PLAT_NAMES[pk] || pk) + '</span>';
        }
        psEl.innerHTML = psHtml;
        psEl.style.display = 'flex';
      } else {
        psEl.innerHTML = '';
        psEl.style.display = 'none';
      }
      $('dUrl').value = d.url || '';
      $('dMirrors').innerHTML = (d.mirrors && d.mirrors.length)
        ? d.mirrors.map(function (u) { return '<div class="mir-line">' + esc(u) + '</div>'; }).join('')
        : '—';
      $('dVars').innerHTML = (d.variants && d.variants.length)
        ? d.variants.map(function (v) { return '<div class="mir-line">' + esc(v.src + ' · ' + (v.ver || '?')) + '</div>'; }).join('')
        : '—';
      $('dOrigin').innerHTML = d.originRepo
        ? '<a href="https://github.com/' + esc(d.originRepo) + '" target="_blank" rel="noopener">' + esc(d.originRepo) + '</a>'
        : esc(d.origin || '—');
      $('dId').textContent = '第 ' + (d.seq || '?') + ' 条';
      $('dSize').textContent = fmtSize(d.size);
      $('dHash').textContent = d.sha256 || '—';
      $('dFirst').textContent = fullTime(d.firstSeenAt);
      $('dCheck').textContent = d.lastCheckAt ? fullTime(d.lastCheckAt) : '未检测';
      $('dPre').textContent = d.bodyHead || '（无缓存内容）';
      document.getElementById('dlg').showModal();
    });
  }
  function copyUrl(url) {
    navigator.clipboard.writeText(url).then(function () { toast('已复制到剪贴板'); })
      .catch(function () { toast('复制失败（需 HTTPS 或 localhost）'); });
  }
  $('dCopyUrl').addEventListener('click', function () { copyUrl($('dUrl').value); });
  $('dCopy').addEventListener('click', function () { copyUrl($('dUrl').value); });

  // ---- 导出（只打包可用源 JS，与后端 /api/export 口径一致） ----
  $('btnExportZip').addEventListener('click', function () {
    var n = sortedItems().filter(function (e) { return e.status === 'ok'; }).length;
    if (!n) { toast('当前筛选没有可用的音源可导出'); return; }
    // 浮层提示打包进度，完成后在当前页直接触发下载（不开新窗口，可被 IDM 等下载工具接管）
    var mask = $('zipMask');
    $('zipMsg').textContent = '正在打包 ' + n + ' 个音源…';
    mask.style.display = 'flex';
    fetch('/api/export?search=' + encodeURIComponent($('q').value.trim())).then(function (r) {
      var isZip = (r.headers.get('content-type') || '').indexOf('zip') >= 0;
      var m = (r.headers.get('content-disposition') || '').match(/filename="?([^";]+)"?/);
      var fname = m ? m[1] : ('lx-sources-' + new Date().toISOString().slice(0, 10) + '.zip');
      return r.blob().then(function (b) { return { ok: isZip, blob: b, name: fname }; });
    }).then(function (res) {
      if (!res.ok) {
        mask.style.display = 'none';
        return res.blob().text().then(function (t) { toast(t || '导出失败'); });
      }
      var url = URL.createObjectURL(res.blob);
      var a = document.createElement('a');
      a.href = url; a.download = res.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      $('zipMsg').textContent = '已开始下载';
      setTimeout(function () { mask.style.display = 'none'; }, 1200);
    }).catch(function () {
      mask.style.display = 'none';
      toast('导出失败，请重试');
    });
  });

  // ---- 更新下拉 → 启动任务 ----
  // 注意：外网部署模式下服务端会把扫描按钮段从 HTML 里剥掉（id 元素不存在），这里必须判空。
  var menu = $('taskMenu');
  if (menu) {
    $('btnTasks').addEventListener('click', function (ev) {
      ev.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', function () { menu.classList.remove('open'); });
    menu.addEventListener('click', function (ev) {
      var item = ev.target.closest('.menu-item');
      if (!item) return;
      startTask(item.dataset.task);
    });
  }
  function startTask(type) {
    // 未登录：直接跳后台登录（登录后回来再点即可执行）；已登录：前台直接执行
    if (!overview || !overview.authed) {
      toast('请先登录后台…');
      setTimeout(function () { location.href = '/admin'; }, 600);
      return;
    }
    toast(type === 'crawl' ? '已触发立即搜索…' : '已触发重新检测…');
    fetch('/api/admin/' + type, { method: 'POST' }).then(function (r) {
      if (r.status === 401) { location.href = '/admin'; return null; } // cookie 过期兜底
      return r.json().then(function (d) {
        if (d.error) toast('失败: ' + d.error);
        else { pollTask(); }
      });
    }).catch(function () { toast('请求失败'); });
  }

  // ---- 任务进度轮询 ----
  var lastRunning = false;
  function pollTask() {
    fetch('/api/task/current').then(function (r) { return r.json(); }).then(function (t) {
      var prog = $('prog');
      if (t.running) {
        prog.style.display = 'block';
        $('pTitle').textContent = t.type === 'crawl' ? '正在搜索' : '正在检测';
        $('pMsg').textContent = t.msg || t.phase || '';
        $('pElapsed').textContent = fmtElapsed(t.elapsed || 0);
        $('btnCancel').style.display = '';
        $('btnCancel').disabled = false;
        var pct = t.total > 0 ? Math.min(100, Math.round(t.done / t.total * 100)) : 0;
        $('pBar').style.width = pct + '%';
        $('pStats').textContent = t.total > 0 ? (t.done + ' / ' + t.total + ' · ' + pct + '%') : '准备中…';
      } else if (lastRunning) {
        prog.style.display = 'block';
        $('pTitle').textContent = t.result && t.result.cancelled ? '任务已取消' : '任务完成';
        $('pMsg').textContent = '';
        $('pElapsed').textContent = fmtElapsed(t.elapsed || 0);
        $('btnCancel').style.display = 'none';
        $('pBar').style.width = '100%';
        $('pStats').textContent = t.stats || (t.result && t.result.error ? '出错: ' + t.result.error : '');
        toast(t.result && t.result.cancelled ? '任务已取消' : '任务完成');
        refresh();
      }
      lastRunning = t.running;
    }).catch(function () { /* noop */ });
  }
  $('btnCancel').addEventListener('click', function () {
    var btn = this;
    fetch('/api/task/cancel', { method: 'POST' }).then(function (r) {
      if (r.status === 401) { location.href = '/admin'; return null; }
      toast('已请求取消…');
      if (r.ok) btn.disabled = true;
    }).catch(function () { /* noop */ });
  });

  // 表头 sticky 偏移跟随工具栏实际高度
  function fixTheadTop() {
    document.documentElement.style.setProperty('--thead-top', $('toolbar').offsetHeight + 'px');
  }
  window.addEventListener('resize', fixTheadTop);
  window.addEventListener('load', fixTheadTop);
  fixTheadTop();

  setInterval(pollTask, 1500);
  setInterval(function () {
    fetch('/api/overview').then(function (r) { return r.json(); }).then(function (d) {
      overview = d; renderStats();
    }).catch(function () { /* noop */ });
  }, 30000);
  refresh();
  pollTask();
})();
