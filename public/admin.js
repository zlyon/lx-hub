'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.display = 'none'; }, 2600);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }
  function statusPill(s) {
    if (s === 'ok') return '<span class="pill ok"><i class="dot"></i>可用</span>';
    if (s === 'suspect') return '<span class="pill suspect" title="脚本可达但实测未取到任何可用平台音频">存疑</span>';
    if (s === 'down') return '<span class="pill down"><i class="dot"></i>后端挂</span>';
    if (s === 'dead') return '<span class="pill dead"><i class="dot"></i>失效</span>';
    return '<span class="pill unknown"><i class="dot"></i>待验证</span>';
  }

  // ---- 标签页切换（复刻插件 nav-item 交互；支持 /admin#settings 直达） ----
  function activateView(name) {
    for (var j = 0; j < navBtns.length; j++) navBtns[j].classList.toggle('active', navBtns[j].dataset.view === name);
    var views = document.querySelectorAll('.view');
    for (var k = 0; k < views.length; k++) views[k].style.display = 'none';
    var target = document.getElementById('view-' + name);
    if (target) target.style.display = 'block';
    if (name === 'library') { loadOverview(); loadLibrary(); loadLogs(); }
    if (name === 'sources') { loadConfig(); loadMarket(false); }
    if (name === 'push') { loadPushTargets(); loadPushEntries(); }
    if (name === 'sched') loadSched();
    if (name === 'runs') loadRuns();
    if (name === 'settings') loadConfig();
  }
  var navBtns = document.querySelectorAll('.nav-item');
  // 窄屏抽屉（复刻插件后台形态）：汉堡开合、遮罩/选中导航后收起
  var sideEl = document.querySelector('.side');
  var sideMask = $('sideMask');
  function closeDrawer() {
    if (sideEl) sideEl.classList.remove('open');
    if (sideMask) sideMask.classList.remove('open');
  }
  if ($('mMenuBtn')) {
    $('mMenuBtn').addEventListener('click', function () {
      sideEl.classList.toggle('open');
      sideMask.classList.toggle('open');
    });
    sideMask.addEventListener('click', closeDrawer);
  }
  for (var ti = 0; ti < navBtns.length; ti++) {
    navBtns[ti].addEventListener('click', function () {
      activateView(this.dataset.view);
      history.replaceState(null, '', '#' + this.dataset.view);
      closeDrawer();
    });
  }

  var pollTimer = null;
  var allEntries = [];
  var mirrorPresets = [];
  var builtinRepos = [];
  var blockedRepos = [];
  var seedsState = [];
  var repoStats = {};
  var lastCustom = [];
  var cfgState = null;

  function startAdmin() {
    $('loginView').style.display = 'none';
    $('adminView').style.display = 'flex';
    loadConfig();
    loadOverview();
    loadLibrary();
    loadLogs();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 2500);
  }

  function loadOverview() {
    fetch('/api/overview').then(function (r) { return r.json(); }).then(function (d) {
      $('ovTotal').textContent = d.total;
      $('ovOk').textContent = d.ok;
      $('ovSuspect').textContent = d.suspect || 0;
      $('ovDown').textContent = d.down || 0;
      $('ovDead').textContent = d.dead || 0;
      $('ovLastCrawl').textContent = d.lastCrawlRel || (d.lastCrawlAt ? fmtDate(d.lastCrawlAt) : '—');
      $('statTotal').textContent = d.total + ' 条';
    });
  }

  function fmtElapsed(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' 秒';
    return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  }

  // 任务按钮两态：运行中「开始搜索」原地变「取消任务」（红），「可用性检测」置灰
  var btnTaskRunning = false;
  function setTaskBtns(running, type) {
    if (btnTaskRunning === running) return; // 状态没变不抖动
    btnTaskRunning = running;
    var crawl = $('crawlBtn'), check = $('checkBtn');
    if (running) {
      crawl.textContent = '✋ 取消任务';
      crawl.classList.add('btn-cancel');
      crawl.disabled = false;
      check.disabled = true;
      check.title = '有任务在运行，请等待完成或取消';
    } else {
      crawl.textContent = '开始搜索';
      crawl.classList.remove('btn-cancel');
      crawl.disabled = false;
      crawl.title = '';
      check.disabled = false;
      check.title = '';
    }
  }

  function pollStatus() {
    fetch('/api/task/current').then(function (r) { return r.json(); }).then(function (t) {
      var title = $('ovTaskTitle');
      var pct = t.total > 0 ? Math.round(t.done / t.total * 1000) / 10 : 0;
      if (t.running) {
        var typeText = t.type === 'crawl' ? '正在搜索' : (t.type === 'push' ? '正在灌入' : '正在检测');
        title.textContent = typeText + '：' + (t.msg || t.phase || '');
        title.classList.add('busy');
      } else {
        title.textContent = '空闲' + (t.stats ? (' · 上次: ' + t.stats) : '');
        title.classList.remove('busy');
      }
      $('ovBar').style.width = t.running ? (pct + '%') : (t.stats ? '100%' : '0');
      $('ovPct').textContent = t.running && t.total > 0 ? pct + '%' : '';
      $('ovElapsed').textContent = t.running && t.elapsed > 0 ? '已用时 ' + fmtElapsed(t.elapsed) : '';
      $('ovMsg').textContent = t.running ? (t.total > 0 ? (t.done + ' / ' + t.total) : '准备中…') : '';
      setTaskBtns(!!t.running, t.type);
    }).catch(function () { /* noop */ });
    // 任务面板内嵌日志：跟随任务轮询一起刷新
    loadLogs();
  }

  // 日志分类着色（参考原版后台：分类标签一眼可辨）
  function logLineClass(msg) {
    if (msg.indexOf('[实测]') === 0) return 'lg-test';
    if (/发现新源|扫描完成|检测完成|已取消/.test(msg)) return 'lg-ok';
    if (/失败|异常|错误|失效|超时|终止/.test(msg)) return 'lg-err';
    return '';
  }

  function loadLogs() {
    fetch('/api/admin/logs').then(function (r) { return r.json(); }).then(function (d) {
      var box = $('taskLogBox');
      var logs = (d.logs || []).slice().reverse(); // 升序（旧→新），与插件任务面板一致
      var wasBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.innerHTML = logs.map(function (l) {
        var t = new Date(l.t);
        var hh = [t.getHours(), t.getMinutes(), t.getSeconds()].map(function (n) { return ('0' + n).slice(-2); }).join(':');
        var cls = logLineClass(l.msg);
        return '<div' + (cls ? ' class="' + cls + '"' : '') + '><span class="lt">[' + hh + ']</span> ' + esc(l.msg) + '</div>';
      }).join('') || '暂无日志';
      if ($('autoScroll').checked && wasBottom) box.scrollTop = box.scrollHeight;
    }).catch(function () { /* noop */ });
  }

  // ---- 定时任务页 ----
  var FREQ_ROWS = {
    daily:   { interval: false, weekday: false, monthday: false, time: true },
    nday:    { interval: true,  weekday: false, monthday: false, time: true },
    nhour:   { interval: true,  weekday: false, monthday: false, time: false },
    weekly:  { interval: false, weekday: true,  monthday: false, time: true },
    monthly: { interval: false, weekday: false, monthday: true,  time: true }
  };
  function refreshSchedRows() {
    var r = FREQ_ROWS[$('schedFreq').value] || FREQ_ROWS.daily;
    $('schedInterval').style.display = r.interval ? '' : 'none';
    $('rowSchedWeekday').style.display = r.weekday ? 'flex' : 'none';
    $('rowSchedMonthDay').style.display = r.monthday ? 'flex' : 'none';
    $('rowSchedTime').style.display = r.time ? 'flex' : 'none';
  }
  // 总开关关闭 → 下面所有选项全部禁用不可设置（复刻插件交互）
  function refreshSchedDisabled() {
    var off = !$('schedEnabled').checked;
    var ids = ['schedFreq', 'schedInterval', 'schedWeekday', 'schedMonthDay', 'schedHour', 'schedMinute', 'btnSchedRun'];
    for (var i = 0; i < ids.length; i++) $(ids[i]).disabled = off;
    $('schedBody').classList.toggle('off', off);
  }

  function fmtTs(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function loadSched() {
    fetch('/api/admin/schedule').then(function (r) { return r.json(); }).then(function (d) {
      var c = d.cfg || {}, s = d.state || {};
      $('schedEnabled').checked = !!c.schedEnabled;
      $('schedFreq').value = c.schedFreq || 'daily';
      $('schedInterval').value = c.schedInterval || 1;
      $('schedWeekday').value = c.schedWeekday != null ? c.schedWeekday : 1;
      $('schedMonthDay').value = c.schedMonthDay || 1;
      $('schedHour').value = c.schedHour != null ? c.schedHour : 3;
      $('schedMinute').value = c.schedMinute != null ? c.schedMinute : 0;
      refreshSchedRows();
      refreshSchedDisabled();
      var parts = [];
      parts.push('当前周期: ' + (s.desc || '—'));
      if (c.schedEnabled) parts.push('下次执行: ' + fmtTs(s.nextRun));
      if (s.lastRun) parts.push('上次执行: ' + fmtTs(s.lastRun));
      if (s.lastResult) parts.push('上次结果: ' + s.lastResult);
      $('schedState').textContent = parts.join('  |  ');
    });
  }

  $('schedEnabled').addEventListener('change', refreshSchedDisabled);
  $('schedFreq').addEventListener('change', refreshSchedRows);

  $('btnSaveSched').addEventListener('click', function () {
    var body = {
      schedEnabled: $('schedEnabled').checked,
      schedFreq: $('schedFreq').value,
      schedInterval: Number($('schedInterval').value) || 1,
      schedWeekday: Number($('schedWeekday').value) || 0,
      schedMonthDay: Number($('schedMonthDay').value) || 1,
      schedHour: Number($('schedHour').value) || 0,
      schedMinute: Number($('schedMinute').value) || 0
    };
    act('/api/admin/schedule', body, this, '定时设置已保存').then(function (ok) { if (ok) loadSched(); });
  });

  $('btnSchedRun').addEventListener('click', function () {
    act('/api/admin/schedule/run', {}, this, '已触发立即执行');
  });

  // 日志弹窗（复刻插件：分页列表 + 保留份数 + 单条下载）
  var schedLogPage = 1;
  function fmtListTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function loadSchedLogs(pg) {
    var box = $('schedLogList');
    box.innerHTML = '<div class="hint" style="text-align:center;padding:30px 0">加载中…</div>';
    fetch('/api/admin/schedlogs?page=' + pg).then(function (r) { return r.json(); }).then(function (d) {
      schedLogPage = d.page || 1;
      $('schedLogKeep').value = String([3, 7, 10, 30].indexOf(d.keep) >= 0 ? d.keep : 10);
      var rows = d.list || [];
      if (!rows.length) {
        box.innerHTML = '<div class="hint" style="text-align:center;padding:40px 0">暂无运行日志（每次定时/手动运行开始即记录，结束后回填结果）</div>';
      } else {
        var html = '';
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var st = String(r.status || '');
          // 未正常收尾的记录（运行中占位 / 中断标记）如实显示：at=0 时展示开始时间
          var ok = st !== '异常终止' && st.indexOf('中断') !== 0;
          html += '<div class="sl-row"><div class="sl-main">' +
            '<span class="sl-time">' + (r.at ? '完成 ' + fmtListTime(r.at) : '开始 ' + fmtListTime(r.startedAt)) + '</span>' +
            '<span class="sl-trig">' + (r.trigger === '手动' ? '手动' : '定时') + '</span>' +
            '<span class="sl-status ' + (ok ? 'ok' : 'fail') + '">' + esc(st || '—') + '</span>' +
            '</div><button class="pill-btn" type="button" data-id="' + esc(r.id) + '">下载</button></div>';
        }
        box.innerHTML = html;
        var btns = box.querySelectorAll('button[data-id]');
        for (var j = 0; j < btns.length; j++) btns[j].onclick = schedLogDownload;
      }
      $('schedLogPager').textContent = '第 ' + (d.page || 1) + ' / ' + (d.pages || 1) + ' 页（共 ' + (d.total || 0) + ' 条）';
      $('schedLogPrev').disabled = (d.page || 1) <= 1;
      $('schedLogNext').disabled = (d.page || 1) >= (d.pages || 1);
    }).catch(function () {
      box.innerHTML = '<div class="hint" style="text-align:center;padding:30px 0">加载失败</div>';
    });
  }
  function schedLogDownload(ev) {
    var btn = ev.currentTarget || ev.target;
    var id = btn.getAttribute('data-id');
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    fetch('/api/admin/schedlogs/download?id=' + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      a.download = 'lx-hub-定时日志-' + id + '.log';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      btn.disabled = false;
      btn.textContent = old;
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = old;
    });
  }
  $('btnSchedLog').addEventListener('click', function () {
    document.getElementById('schedLogDlg').showModal();
    loadSchedLogs(1);
  });
  $('schedLogPrev').addEventListener('click', function () { loadSchedLogs(Math.max(1, schedLogPage - 1)); });
  $('schedLogNext').addEventListener('click', function () { loadSchedLogs(schedLogPage + 1); });
  $('schedLogKeep').addEventListener('change', function () {
    var keep = parseInt($('schedLogKeep').value, 10) || 10;
    act('/api/admin/schedule', { schedLogKeep: keep }, null, '').then(function (ok) { if (ok) loadSchedLogs(1); });
  });

  $('btnExportJson').addEventListener('click', function () {
    window.open('/api/admin/export-json', '_blank');
  });

  // ---- 运行日志页（每次搜索/检测任务留痕：展开看全过程 / 下载） ----
  function loadRuns() {
    var box = $('runsList');
    fetch('/api/admin/runs').then(function (r) { return r.json(); }).then(function (d) {
      var runs = d.runs || [];
      if (!runs.length) { box.innerHTML = '<div class="hint" style="text-align:center;padding:40px 0">暂无运行记录（执行搜索 / 检测后自动留痕）</div>'; return; }
      var kindName = { crawl: '🔍 搜索', check: '🧪 检测', push: '📤 灌入' };
      var html = '';
      for (var i = 0; i < runs.length; i++) {
        var r = runs[i];
        var ms = Math.max(0, (r.endedAt || 0) - r.startedAt);
        var dur = ms > 60000 ? Math.floor(ms / 60000) + ' 分 ' + Math.round(ms % 60000 / 1000) + ' 秒' : Math.round(ms / 1000) + ' 秒';
        var fail = r.status !== '完成';
        html += '<div class="run-item" data-id="' + esc(r.id) + '">' +
          '<div class="run-head" data-toggle="1">' +
          '<span class="run-kind">' + (kindName[r.kind] || r.kind) + '</span>' +
          '<span class="run-trig">' + esc(r.trigger || '手动') + '</span>' +
          '<span class="run-time">' + fmtTs(r.startedAt) + '</span>' +
          '<span class="run-dur">' + dur + '</span>' +
          '<span class="sl-status ' + (fail ? 'fail' : 'ok') + '">' + esc(r.status) + '</span>' +
          '<span class="run-caret">▸</span></div>' +
          (r.stats ? '<div class="run-stats">' + esc(r.stats) + '</div>' : '') +
          '<pre class="run-log" style="display:none"></pre>' +
          '<div class="run-ops" style="display:none"><button type="button" class="pill-btn" data-dl="1">下载日志</button></div>' +
          '</div>';
      }
      box.innerHTML = html;
    }).catch(function () { box.innerHTML = '<div class="hint">加载失败</div>'; });
  }
  $('runsList').addEventListener('click', function (ev) {
    var item = ev.target.closest('.run-item');
    if (!item) return;
    var id = item.getAttribute('data-id');
    var dlBtn = ev.target.closest('button[data-dl]');
    if (dlBtn) {
      dlBtn.disabled = true;
      fetch('/api/admin/runs/download?id=' + encodeURIComponent(id)).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (text) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        a.download = 'lx-hub-运行日志-' + id + '.log';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
        dlBtn.disabled = false;
      }).catch(function () { toast('下载失败'); dlBtn.disabled = false; });
      return;
    }
    if (!ev.target.closest('[data-toggle]')) return;
    var log = item.querySelector('.run-log');
    var ops = item.querySelector('.run-ops');
    var caret = item.querySelector('.run-caret');
    var open = log.style.display !== 'none';
    if (open) {
      log.style.display = 'none'; ops.style.display = 'none'; caret.textContent = '▸';
      return;
    }
    caret.textContent = '▾';
    if (log.dataset.loaded) { log.style.display = 'block'; ops.style.display = 'flex'; return; }
    log.textContent = '加载中…'; log.style.display = 'block'; ops.style.display = 'flex';
    fetch('/api/admin/runs/download?id=' + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      log.textContent = text;
      log.dataset.loaded = '1';
    }).catch(function () { log.textContent = '加载失败'; });
  });

  // ---- 设置页（复刻插件）----
  function loadConfig() {
    fetch('/api/admin/config').then(function (r) { return r.json(); }).then(function (d) {
      var c = d.config || {};
      cfgState = c;
      mirrorPresets = d.mirrorPresets || [];
      builtinRepos = d.builtinRepos || [];
      $('cfgProxy').value = c.proxy || '';
      $('cfgForceProxy').checked = !!c.forceProxy;
      $('cfgUseJsdelivr').checked = !!c.useJsdelivr;
      $('cfgAutoCheck').checked = c.autoCheck !== false;
      $('cfgBatchSize').value = c.batchSize || 60;
      $('cfgFastMode').checked = !!c.fastMode;
      $('cfgDebug').checked = !!c.debug;
      $('cfgExternalDeploy').checked = !!c.externalDeploy;
      $('cfgGhToken').value = '';
      $('cfgGhToken').placeholder = c.ghTokenSet ? 'ghp_… / github_pat_…' : '';
      $('ghTokenState').textContent = c.ghTokenSet ? '已配置 ✓' : '';
      $('ghTokenState').className = c.ghTokenSet ? 'hint ok' : 'hint';
      renderMirrorSel(c.ghMirror || '');
      blockedRepos = c.blockedRepos || [];
      seedsState = c.seeds || [];
      renderRepos(c.repos || []);
      renderManifest(d.manifest || null);
      repoErrors = d.repoErrors || {};
      if ($('view-sources').style.display !== 'none') loadRepoStats();
    });
  }

  // 每仓统计（收录来源页「可用音源/包含链接」），随配置刷新
  var repoErrors = {};
  function loadRepoStats() {
    return fetch('/api/admin/repo-stats').then(function (r) { return r.json(); }).then(function (d) {
      repoStats = (d && d.stats) || {};
      renderRepos(lastCustom);
    }).catch(function () {});
  }

  // ---- 内置仓清单热更新（数据与代码分离：远端 manifest 版本号比对，热应用无需重启） ----
  var manifestState = null;
  function renderManifest(m) {
    manifestState = m || manifestState;
    var el = $('manifestInfo');
    if (!el) return;
    if (manifestState && manifestState.version) {
      el.textContent = '清单 v' + manifestState.version + '（' + manifestState.count + ' 个仓库' +
        (manifestState.updatedAt ? '，更新于 ' + manifestState.updatedAt : '') + '）· 远端自动维护';
    } else {
      el.textContent = '内置默认清单（' + manifestState.count + ' 个仓库）· 尚未拉取远端更新';
    }
  }
  $('btnManifestCheck').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    btn.textContent = '检查中…';
    fetch('/api/admin/manifest/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btn.textContent = '检查更新';
        btn.disabled = false;
        if (!d.ok) { toast('检查失败: ' + (d.error || '未知')); return; }
        if (d.applied) {
          toast('清单已更新: v' + d.current + ' → v' + d.latest + '（' + d.count + ' 个仓库）');
          loadConfig();
        } else {
          toast('已是最新: v' + d.current + '（' + d.count + ' 个仓库）');
        }
      })
      .catch(function () { btn.textContent = '检查更新'; btn.disabled = false; toast('请求失败'); });
  });

  // ---- 社区精选（照插件版：直接展示列表，采用=加自定义来源，移除反向） ----
  function marketItemHtml(s) {
    var target = s.type === 'repo' ? (s.repo || '') : (s.url || '');
    var typeTxt = s.type === 'repo' ? '仓库' : (s.type === 'page' ? '发布页' : '直链');
    var show = s.type === 'repo' ? s.repo : s.url;
    var stats = (s.usable != null && s.total != null) ? '<span class="rstat">可用 ' + s.usable + '/' + s.total + '</span>' : '';
    var sub = s.submitter ? '<span class="rstat">by ' + esc(s.submitter) + '</span>' : '';
    return '<li><span class="lock">🌍</span><span class="grow" style="white-space:normal" title="' + esc(show) + '"><b>' + esc(s.name || show) + '</b> <span class="tag">' + typeTxt + '</span> ' + stats + ' ' + sub +
      (s.notes ? '<div class="rstat" style="white-space:normal">' + esc(s.notes.length > 60 ? s.notes.slice(0, 60) + '…' : s.notes) + '</div>' : '') +
      '</span><button type="button" class="small ' + (s.adopted ? 'danger' : 'ok') + '" data-mkey="' + esc(target) + '" data-mktype="' + esc(s.type) + '">' + (s.adopted ? '移除' : '采用') + '</button></li>';
  }
  function loadMarket(force) {
    var box = $('marketList');
    box.innerHTML = '<li class="grow-empty">加载中…</li>';
    fetch('/api/admin/market' + (force ? '?force=1' : '')).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { box.innerHTML = '<li class="grow-empty">社区精选获取失败：' + esc(d.error || '') + '（点右上「刷新」重试）</li>'; return; }
      var items = d.items || [];
      var head = $('marketHead');
      if (head) head.textContent = '经恶意特征扫描 + 人工审核的社区收录，点「采用」加入上方自定义来源' + (items.length ? '（共 ' + items.length + ' 条）' : '');
      box.innerHTML = items.length ? items.map(marketItemHtml).join('') : '<li class="grow-empty">社区精选暂无收录</li>';
    }).catch(function () { box.innerHTML = '<li class="grow-empty">社区精选获取失败（点右上「刷新」重试）</li>'; });
  }
  $('btnMarketRefresh').addEventListener('click', function () { loadMarket(true); });
  $('marketList').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-mkey]');
    if (!btn) return;
    var adopt = btn.textContent !== '移除';
    if (adopt && !confirm('采用该来源并加入自定义列表？')) return;
    btn.disabled = true;
    fetch('/api/admin/market/adopt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: btn.getAttribute('data-mkey'), type: btn.getAttribute('data-mktype'), adopt: adopt })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { toast('失败: ' + d.error); btn.disabled = false; return; }
      toast(adopt ? '已采用，下次扫描生效' : '已移除');
      loadMarket(true);
      loadConfig();
    }).catch(function () { btn.disabled = false; toast('请求失败'); });
  });

  // raw 加速镜像下拉：预设 + 自定义…；选中预设回填，选中「自定义…」显示自定义行
  function renderMirrorSel(current) {
    var sel = $('cfgMirrorSel');
    var isPreset = mirrorPresets.indexOf(current) >= 0;
    var html = '<option value="">不使用</option>';
    for (var i = 0; i < mirrorPresets.length; i++) {
      html += '<option value="' + esc(mirrorPresets[i]) + '">' + esc(mirrorPresets[i]) + '</option>';
    }
    html += '<option value="__custom__">自定义…</option>';
    sel.innerHTML = html;
    sel.value = isPreset ? current : (current ? '__custom__' : '');
    $('rowMirrorCustom').style.display = (!isPreset && current) ? 'flex' : (sel.value === '__custom__' ? 'flex' : 'none');
    $('cfgMirror').value = (!isPreset && current) ? current : '';
  }

  $('cfgMirrorSel').addEventListener('change', function () {
    var v = this.value;
    $('rowMirrorCustom').style.display = v === '__custom__' ? 'flex' : 'none';
    if (v !== '__custom__') $('cfgMirror').value = '';
    $('rowMirrorTest').style.display = 'none';
  });

  $('btnTestMirror').addEventListener('click', function () {
    var mirror = $('cfgMirrorSel').value === '__custom__' ? $('cfgMirror').value.trim() : $('cfgMirrorSel').value;
    var out = $('mirrorTestResult');
    if (!mirror) { out.textContent = '请先选择或填写镜像'; out.className = 'hint fail'; $('rowMirrorTest').style.display = 'flex'; return; }
    var btn = this;
    btn.disabled = true;
    out.textContent = '测试中…'; out.className = 'hint';
    $('rowMirrorTest').style.display = 'flex';
    fetch('/api/admin/mirror-test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mirror: mirror })
    }).then(function (r) { return r.json(); }).then(function (d) {
      btn.disabled = false;
      if (d.ok) { out.textContent = '✓ 可用（HTTP ' + d.status + '，' + d.ms + 'ms），与搜索使用同一拼接规则'; out.className = 'hint ok'; }
      else { out.textContent = '✗ 不可用：' + (d.error || ('HTTP ' + d.status)); out.className = 'hint fail'; }
    }).catch(function () { btn.disabled = false; out.textContent = '✗ 请求失败'; out.className = 'hint fail'; });
  });

  // 收录来源：照插件版结构移植（内置=🔒 屏蔽/恢复+打开；自定义=👤 仓库 / 🔗 直链 + 删除；行内「可用音源/包含链接」统计）
  function repoStatHtml(repo) {
    var st = repoStats[repo];
    if (!st || !st.total) {
      if (st && st.error) return '<span class="rstat fail" title="上次扫描爬取失败：' + esc(st.error) + '">爬取失败</span>';
      return '<span class="rstat">0/0</span>';
    }
    if (st.untested > 0) return '<span class="rstat">待检测</span>';
    return '<span class="rstat' + (st.usable > 0 ? ' good' : ' zero') + '">' + st.usable + '/' + st.total + '</span>';
  }
  var builtinFolded = true;
  function builtinCntText() {
    var n = builtinRepos.length, b = blockedRepos.length;
    return n ? '（' + (n - b) + '/' + n + ' 个参与扫描，点击' + (builtinFolded ? '展开' : '收起') + '）' : '';
  }
  function renderRepos(custom) {
    lastCustom = custom || [];
    $('builtinRepos').innerHTML = builtinRepos.map(function (r) {
      var isBlocked = blockedRepos.indexOf(r) !== -1;
      return '<li><span class="lock">' + (isBlocked ? '🚫' : '🔒') + '</span><span class="grow"' + (isBlocked ? ' style="opacity:.55;text-decoration:line-through"' : '') + ' title="' + esc(r) + '">' + esc(r) + '</span>' +
        repoStatHtml(r) +
        '<button type="button" class="small' + (isBlocked ? '' : ' danger') + '" data-blockrepo="' + esc(r) + '">' + (isBlocked ? '恢复' : '屏蔽') + '</button>' +
        '<button type="button" class="small" data-openrepo="' + esc(r) + '" title="在新窗口打开 GitHub 仓库">打开</button></li>';
    }).join('');
    $('builtinCnt').textContent = builtinCntText();
    var fold = $('btnFoldBuiltin');
    fold.classList.toggle('open', !builtinFolded);
    $('builtinRepos').classList.toggle('collapsed', builtinFolded);
    var cHtml = (lastCustom.length || seedsState.length)
      ? lastCustom.map(function (r) {
          return '<li><span class="lock">👤</span><span class="grow" title="' + esc(r) + '">' + esc(r) + '</span>' +
            repoStatHtml(r) +
            '<button type="button" class="small danger" data-delrepo="' + esc(r) + '">删除</button></li>';
        }).join('') + seedsState.map(function (u) {
          return '<li><span class="lock">🔗</span><span class="grow" title="' + esc(u) + '">' + esc(u.length > 60 ? u.slice(0, 60) + '…' : u) + '</span>' +
            repoStatHtml(u) +
            '<button type="button" class="small danger" data-delurl="' + esc(u) + '">删除</button></li>';
        }).join('')
      : '<li class="grow-empty">暂无自定义来源，用下方输入框添加（支持 owner/repo、GitHub 仓库地址、.js 直链、音源列表页）</li>';
    $('customRepos').innerHTML = cHtml;
  }

  $('btnFoldBuiltin').addEventListener('click', function () {
    builtinFolded = !builtinFolded;
    this.classList.toggle('open', !builtinFolded);
    $('builtinRepos').classList.toggle('collapsed', builtinFolded);
    $('builtinCnt').textContent = builtinCntText();
  });

  // 屏蔽内置来源确认框：勾选「不再提醒」后当前登录会话内不再弹出（sessionStorage）
  function askBlockRepo(repo) {
    try { if (sessionStorage.getItem('hx_blockRepoMuted') === '1') return Promise.resolve(true); } catch (e) { /* 隐私模式按每次提醒处理 */ }
    return new Promise(function (resolve) {
      $('blockRepoMsg').textContent = '屏蔽内置来源 ' + repo + '？扫描时将自动跳过该仓库（已收录的链接不受影响）';
      $('blockRepoMute').checked = false;
      var mask = $('blockRepoMask');
      mask.style.display = 'flex';
      function done(yes) {
        mask.style.display = 'none';
        if (yes && $('blockRepoMute').checked) {
          try { sessionStorage.setItem('hx_blockRepoMuted', '1'); } catch (e2) {}
        }
        resolve(yes);
      }
      $('blockRepoOk').onclick = function () { done(true); };
      $('blockRepoCancel').onclick = function () { done(false); };
      mask.onclick = function (e) { if (e.target === mask) done(false); };
    });
  }

  $('builtinRepos').addEventListener('click', function (ev) {
    var blk = ev.target.closest('button[data-blockrepo]');
    if (blk) {
      var repo = blk.getAttribute('data-blockrepo');
      var isBlocked = blockedRepos.indexOf(repo) !== -1;
      var go = function () {
        return fetch('/api/admin/repos/block', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: repo, blocked: !isBlocked }) })
          .then(function (r) { return r.json(); })
          .then(function (d) { if (d.error) { toast('失败: ' + d.error); return; } toast(isBlocked ? '已恢复，下次扫描生效' : '已屏蔽，扫描时自动跳过'); loadConfig(); });
      };
      if (isBlocked) return go();
      return askBlockRepo(repo).then(function (yes) { if (yes) return go(); });
    }
    var open = ev.target.closest('button[data-openrepo]');
    if (open) window.open('https://github.com/' + open.getAttribute('data-openrepo'), '_blank');
  });

  document.getElementById('customRepos').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-delrepo]');
    if (btn) {
      if (!confirm('删除自定义仓库 ' + btn.dataset.delrepo + '？（已收录的链接不受影响）')) return;
      fetch('/api/admin/repos/' + encodeURIComponent(btn.dataset.delrepo), { method: 'DELETE' }).then(function (r) {
        if (r.ok) { toast('已删除'); loadConfig(); }
        else r.json().then(function (d) { toast(d.error || '删除失败'); });
      });
      return;
    }
    var urlBtn = ev.target.closest('button[data-delurl]');
    if (urlBtn) {
      var u = urlBtn.dataset.delurl;
      if (!confirm('删除自定义链接？（已收录的链接不受影响）\n' + u)) return;
      fetch('/api/admin/urls/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: u }) }).then(function (r) {
        if (r.ok) { toast('已删除'); loadConfig(); }
        else r.json().then(function (d) { toast(d.error || '删除失败'); });
      });
    }
  });

  $('btnAddRepo').addEventListener('click', function () {
    var raw = $('inpRepo').value.trim();
    if (!raw) return;
    act('/api/admin/repos', { repo: raw }, this, '已添加').then(function (ok) {
      if (ok) { $('inpRepo').value = ''; loadConfig(); loadRepoStats(); }
    });
  });

  // ---- 通用灌入（📤）：目标管理 + 批量直推内容到各洛雪服务端变种 ----
  var pushTypes = [];
  var pushTargetsState = [];
  var pushEditingId = null;
  function ptTypeLabel(type) {
    for (var i = 0; i < pushTypes.length; i++) if (pushTypes[i].type === type) return pushTypes[i].label;
    return type;
  }
  function loadPushTargets() {
    return fetch('/api/admin/push/targets').then(function (r) { return r.json(); }).then(function (d) {
      pushTypes = d.types || [];
      pushTargetsState = d.targets || [];
      var sel = $('ptType');
      if (!sel.options.length) {
        for (var i = 0; i < pushTypes.length; i++) {
          var o = document.createElement('option');
          o.value = pushTypes[i].type;
          o.textContent = pushTypes[i].label;
          sel.appendChild(o);
        }
      }
      ptShowHint();
      var html = pushTargetsState.length ? '' : '<li class="grow-empty">暂无灌入目标，用下方表单添加（支持 LX Server / HollyMusic / Ro；知音插件请在 lx-hunter 插件内灌入）</li>';
      for (var j = 0; j < pushTargetsState.length; j++) {
        var t = pushTargetsState[j];
        html += '<li><span class="lock">' + (t.enabled !== false ? '📤' : '⏸') + '</span>' +
          '<span class="grow" title="' + esc(t.baseUrl) + '"><b>' + esc(t.name) + '</b> <span class="tag">' + esc(ptTypeLabel(t.type)) + '</span> <span class="rstat" title="' + esc(t.baseUrl) + '">' + esc(t.baseUrl.length > 42 ? t.baseUrl.slice(0, 42) + '…' : t.baseUrl) + '</span>' +
          (t.pushed ? ' <span class="rstat">已灌 ' + t.pushed + ' 条</span>' : '') + '</span>' +
          '<button type="button" class="small' + (t.enabled !== false ? '' : ' danger') + '" data-pt-toggle="' + esc(t.id) + '">' + (t.enabled !== false ? '停用' : '启用') + '</button>' +
          '<button type="button" class="small" data-pt-test="' + esc(t.id) + '">测试</button>' +
          (t.pushed ? '<button type="button" class="small" data-pt-revoke="' + esc(t.id) + '">撤回</button>' : '') +
          '<button type="button" class="small" data-pt-edit="' + esc(t.id) + '">编辑</button>' +
          '<button type="button" class="small danger" data-pt-del="' + esc(t.id) + '">删除</button></li>';
      }
      $('pushTargets').innerHTML = html;
      updatePushSelInfo();
      return d;
    }).catch(function () { $('pushTargets').innerHTML = '<li class="grow-empty">加载失败</li>'; });
  }
  function ptShowHint() {
    var type = $('ptType').value;
    for (var i = 0; i < pushTypes.length; i++) {
      if (pushTypes[i].type === type) { $('ptHint').textContent = '提示：' + pushTypes[i].hint; return; }
    }
    $('ptHint').textContent = '';
  }
  $('ptType').addEventListener('change', ptShowHint);

  function ptFormTarget() {
    return {
      id: pushEditingId || undefined,
      name: $('ptName').value.trim(),
      type: $('ptType').value,
      baseUrl: $('ptUrl').value.trim(),
      token: $('ptToken').value.trim(),
      username: $('ptUser').value.trim()
    };
  }
  $('btnPtSave').addEventListener('click', function () {
    var t = ptFormTarget();
    if (!/^https?:\/\//i.test(t.baseUrl)) { toast('地址必须是 http(s):// 开头'); return; }
    fetch('/api/admin/push/targets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { toast('保存失败: ' + d.error); return; }
        toast(pushEditingId ? '目标已更新' : '目标已添加');
        pushEditingId = null;
        $('ptName').value = ''; $('ptToken').value = ''; $('ptUser').value = '';
        loadPushTargets();
      }).catch(function () { toast('请求失败'); });
  });
  $('btnPtTest').addEventListener('click', function () {
    var btn = this;
    var t = ptFormTarget();
    if (!t.baseUrl) { toast('请先填写地址'); return; }
    btn.disabled = true; btn.textContent = '测试中…';
    fetch('/api/admin/push/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: t }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btn.disabled = false; btn.textContent = '测试连接';
        if (d.ok) toast('✓ ' + (d.info || '连接成功'));
        else toast('✗ ' + (d.error || '连接失败'));
      }).catch(function () { btn.disabled = false; btn.textContent = '测试连接'; toast('请求失败'); });
  });

  $('pushTargets').addEventListener('click', function (ev) {
    var act = function (attr, fn) {
      var btn = ev.target.closest('button[' + attr + ']');
      if (!btn) return false;
      fn(btn.getAttribute(attr));
      return true;
    };
    if (act('data-pt-toggle', function (id) {
      fetch('/api/admin/push/targets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id, enabled: !pushTargetsState.filter(function (x) { return x.id === id; })[0].enabled, keepToken: true }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.error) { toast(d.error); return; } loadPushTargets(); });
    })) return;
    if (act('data-pt-test', function (id) {
      fetch('/api/admin/push/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { toast(d.ok ? '✓ ' + (d.info || '连接成功') : '✗ ' + (d.error || '连接失败')); });
    })) return;
    if (act('data-pt-revoke', function (id) {
      var t = pushTargetsState.filter(function (x) { return x.id === id; })[0];
      var n = t ? (t.pushed || 0) : 0;
      if (!confirm('撤回灌入到「' + (t ? t.name : '') + '」的音源？\n将删除该目标内由本系统灌入的 ' + n + ' 条记录对应的音源，不影响你手动添加的源。')) return;
      var btn = document.querySelector('[data-pt-revoke="' + id + '"]');
      if (btn) { btn.disabled = true; btn.textContent = '撤回中…'; }
      fetch('/api/admin/push/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (btn) { btn.disabled = false; btn.textContent = '撤回'; }
          if (d.error) { toast('✗ ' + d.error); return; }
          var removed = (d.removed || []).length;
          toast(d.note ? d.note : ('已撤下 ' + removed + ' 个音源' + (d.failed ? '，' + d.failed + ' 个失败' : '')));
          loadPushTargets();
        }).catch(function () { if (btn) { btn.disabled = false; btn.textContent = '撤回'; } toast('请求失败'); });
    })) return;
    if (act('data-pt-edit', function (id) {
      var t = pushTargetsState.filter(function (x) { return x.id === id; })[0];
      if (!t) return;
      pushEditingId = id;
      $('ptName').value = t.name || '';
      $('ptType').value = t.type;
      ptShowHint();
      $('ptUrl').value = t.baseUrl || '';
      $('ptToken').value = '';
      $('ptToken').placeholder = t.tokenSet ? '已配置（留空保持不变）' : '凭据（密码 / API Key / 令牌）';
      $('ptUser').value = t.username || '';
      toast('已载入表单，修改后点「保存目标」');
    })) return;
    act('data-pt-del', function (id) {
      if (!confirm('删除该灌入目标？（不影响目标服务端已灌入的音源）')) return;
      fetch('/api/admin/push/targets/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.error) { toast(d.error); return; } toast('已删除'); loadPushTargets(); });
    });
  });

  // 批量灌入：条目列表（实测可用）+ 已灌状态
  var pushEntries = [];
  function loadPushEntries() {
    var rows = $('pushEntryRows');
    return Promise.all([
      fetch('/api/entries?status=alive&type=all').then(function (r) { return r.json(); }),
      fetch('/api/admin/push/targets').then(function (r) { return r.json(); })
    ]).then(function (rs) {
      var items = (rs[0].items || []).filter(function (e) { return e.hasBody; });
      var targets = (rs[1].targets || []).filter(function (t) { return t.enabled !== false; });
      pushTargetsState = rs[1].targets || [];
      pushEntries = items;
      $('pushScanInfo').textContent = '实测可用且已缓存脚本 ' + items.length + ' 个 · 启用目标 ' + targets.length + ' 个';
      var html = '';
      for (var i = 0; i < items.length; i++) {
        var e = items[i];
        var en = 0, same = 0;
        for (var k = 0; k < targets.length; k++) {
          var sha = (targets[k].pushedMap || {})[e.id];
          if (sha) { en++; }
        }
        var st = en === 0 ? '<span class="rstat">未灌</span>'
          : (en >= targets.length ? '<span class="rstat good">已灌入</span>' : '<span class="rstat">部分(' + en + '/' + targets.length + ')</span>');
        html += '<tr><td><input type="checkbox" data-pe="' + esc(e.id) + '"' + ($('pushScopeAll').checked ? '' : ' checked') + '></td>' +
          '<td title="' + esc(e.name) + '">' + esc(e.name) + '</td>' +
          '<td>' + statusPill(e.status) + '</td>' +
          '<td>' + st + '</td></tr>';
      }
      rows.innerHTML = html || '<tr><td colspan="4" class="muted" style="text-align:center;padding:16px">暂无实测可用的音源（先跑搜索 + 检测）</td></tr>';
      updatePushSelInfo();
    }).catch(function () { rows.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;padding:16px">加载失败</td></tr>'; });
  }
  function updatePushSelInfo() {
    var all = $('pushScopeAll').checked;
    var n = 0;
    if (!all) {
      var boxes = document.querySelectorAll('#pushEntryRows input[data-pe]');
      for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) n++;
    }
    $('pushSelInfo').textContent = all ? '将灌入全部实测可用音源到所有启用目标' : ('将灌入勾选的 ' + n + ' 个音源到所有启用目标');
  }
  $('pushScopeAll').addEventListener('change', function () {
    var boxes = document.querySelectorAll('#pushEntryRows input[data-pe]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = !this.checked;
    updatePushSelInfo();
  });
  $('pushEntryRows').addEventListener('change', function (ev) {
    if (ev.target.closest('input[data-pe]')) updatePushSelInfo();
  });
  $('btnPushRefresh').addEventListener('click', function () { loadPushEntries(); });
  $('btnPushStart').addEventListener('click', function () {
    var btn = this;
    var all = $('pushScopeAll').checked;
    var ids = null;
    if (!all) {
      ids = [];
      var boxes = document.querySelectorAll('#pushEntryRows input[data-pe]');
      for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) ids.push(boxes[i].getAttribute('data-pe'));
      if (!ids.length) { toast('请先勾选要灌入的音源（或勾选「灌入全部实测可用」）'); return; }
    }
    var text = all ? '将把全部实测可用音源灌入所有启用目标？\n同名重灌=覆盖，同版本已灌自动跳过。' : '将把勾选的 ' + ids.length + ' 个音源灌入所有启用目标？';
    if (!confirm(text)) return;
    btn.disabled = true; btn.textContent = '启动中…';
    fetch('/api/admin/push/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entryIds: ids }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btn.disabled = false; btn.textContent = '🚀 开始灌入';
        if (d.error) { toast(d.error); return; }
        toast('灌入任务已启动（' + d.targets + ' 个目标 × ' + d.entries + ' 个音源），进度见顶部任务条');
      }).catch(function () { btn.disabled = false; btn.textContent = '🚀 开始灌入'; toast('请求失败'); });
  });

  // 导出配置（JSON 下载，剪贴板兜底）
  $('btnExportCfg').addEventListener('click', function () {
    if (!cfgState) return;
    var exportable = {
      proxy: cfgState.proxy, ghMirror: cfgState.ghMirror, forceProxy: cfgState.forceProxy,
      useJsdelivr: cfgState.useJsdelivr, autoCheck: cfgState.autoCheck, batchSize: cfgState.batchSize,
      fastMode: cfgState.fastMode, debug: cfgState.debug,
      repos: cfgState.repos, exportedAt: new Date().toISOString()
    };
    var text = JSON.stringify(exportable, null, 2);
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'lx-hub-config.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('配置已导出');
    } catch (e) {
      var ta = $('exportCfgText');
      ta.value = text;
      $('rowExportCfg').style.display = 'flex';
      ta.focus(); ta.select();
    }
  });

  $('btnSaveCfg').addEventListener('click', function () {
    var body = {
      proxy: $('cfgProxy').value.trim(),
      ghMirror: $('cfgMirrorSel').value === '__custom__' ? $('cfgMirror').value.trim() : $('cfgMirrorSel').value,
      forceProxy: $('cfgForceProxy').checked,
      useJsdelivr: $('cfgUseJsdelivr').checked,
      ghToken: $('cfgGhToken').value.trim(), // 留空则后端保持不变
      autoCheck: $('cfgAutoCheck').checked,
      batchSize: Number($('cfgBatchSize').value) || 60,
      fastMode: $('cfgFastMode').checked,
      debug: $('cfgDebug').checked,
      externalDeploy: $('cfgExternalDeploy').checked
    };
    act('/api/admin/config', body, this, '设置已保存').then(function (ok) {
      if (ok) loadConfig();
    });
  });

  // ---- 源库（音源列表：状态/名称/仓库/可用平台/大小/链接） ----
  var libTimer = null;
  function loadLibrary() {
    var params = new URLSearchParams({ search: $('libSearch').value.trim() });
    fetch('/api/admin/entries?' + params).then(function (r) { return r.json(); }).then(function (d) {
      allEntries = d.items || [];
      $('libCount').textContent = allEntries.length;
      var html = '<table><thead><tr><th style="width:118px">状态</th><th>名称</th><th style="width:190px">仓库</th><th style="width:190px">可用平台</th><th style="width:76px">大小</th><th style="width:64px">链接</th><th style="width:88px">操作</th></tr></thead><tbody>';
      for (var i = 0; i < allEntries.length; i++) {
        var e = allEntries[i];
        // 平台 chip 悬停带 L2 无损核验结果（数据来自沙箱深检 platStatus）
        var PS_LABEL_KEY = { '网易云': 'wy', 'QQ': 'tx', '酷我': 'kw', '酷狗': 'kg', '咪咕': 'mg' };
        var LL_TEXT = { matched: '真无损', degraded: '降级(16bit)', mismatch: '假无损', refused: '无损未响应', unknown: '规格未知' };
        var plats = (e.platforms || []).length
          ? e.platforms.map(function (p) {
              var ps = (e.platStatus || {})[PS_LABEL_KEY[p] || p];
              var tip = p + '：实测可用';
              if (ps && ps.lossless) tip += ' · 无损核验: ' + (LL_TEXT[ps.lossless] || ps.lossless) + (ps.losslessReason ? '（' + ps.losslessReason + '）' : '');
              return '<span class="chip" title="' + esc(tip) + '">' + esc(p) + '</span>';
            }).join('')
          : '<span class="muted">—</span>';
        html += '<tr>' +
          '<td>' + statusPill(e.status) + '</td>' +
          '<td class="lib-name" title="' + esc(e.name) + '">' + esc(e.name) + '</td>' +
          '<td class="muted" title="' + esc(e.originRepo || '') + '">' + esc(e.originRepo || '—') + '</td>' +
          '<td><div class="plats">' + plats + '</div></td>' +
          '<td class="muted">' + (e.bodySize ? (e.bodySize / 1024).toFixed(1) + 'K' : '—') + '</td>' +
          '<td><a href="' + esc(e.primaryUrl) + '" target="_blank" rel="noopener">打开</a></td>' +
          '<td><button class="del-btn" data-del="' + e.id + '">删除</button></td></tr>';
      }
      html += '</tbody></table>';
      $('libList').innerHTML = allEntries.length ? html : '暂无数据';
    });
  }
  $('libSearch').addEventListener('input', function () {
    clearTimeout(libTimer);
    libTimer = setTimeout(loadLibrary, 300);
  });
  $('libList').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button.del-btn');
    if (!btn) return;
    if (!confirm('确定删除该条目？')) return;
    fetch('/api/admin/entries/' + btn.dataset.del, { method: 'DELETE' }).then(function (r) {
      if (r.ok) { toast('已删除'); loadLibrary(); loadOverview(); }
    });
  });

  function act(path, body, btn, done) {
    if (btn) btn.disabled = true;
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      if (r.status === 401) { location.reload(); return null; }
      return r.json();
    }).then(function (d) {
      if (!d) return null;
      if (d.error) toast('失败: ' + d.error);
      else toast(done || '操作完成');
      loadLogs();
      return d.error ? null : d;
    }).catch(function () { toast('请求失败'); return null; }).finally(function () { if (btn) btn.disabled = false; });
  }

  $('loginForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('loginErr').textContent = '';
    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: $('loginUser').value.trim(), pass: $('loginPass').value })
    }).then(function (r) {
      if (r.ok) { startAdmin(); return null; }
      return r.json().then(function (d) { $('loginErr').textContent = d.error || '登录失败'; });
    }).catch(function () { $('loginErr').textContent = '网络错误'; });
  });

  $('logoutBtn').addEventListener('click', function (ev) {
    ev.preventDefault();
    fetch('/api/admin/logout', { method: 'POST' }).then(function () { location.reload(); });
  });

  $('crawlBtn').addEventListener('click', function () {
    if (btnTaskRunning) { // 两态：运行中 = 取消
      fetch('/api/task/cancel', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
        toast(d.ok ? '已请求取消，任务将在当前条目处理后停止' : (d.error || '取消失败'));
      }).catch(function () { toast('取消请求失败'); });
      return;
    }
    act('/api/admin/crawl', {}, this, '搜索任务已启动');
  });
  $('checkBtn').addEventListener('click', function () { act('/api/admin/check', {}, this, '检测任务已启动'); });

  // 会话探测
  fetch('/api/admin/session').then(function (r) { return r.json(); }).then(function (d) {
    if (d.authed) {
      startAdmin();
      var hash = (location.hash || '').replace('#', '');
      if (hash && document.getElementById('view-' + hash)) activateView(hash);
    }
    else { $('loginView').style.display = 'flex'; $('loginUser').focus(); }
  });
})();
