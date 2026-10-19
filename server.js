'use strict';
// lx-hub 服务入口（零依赖 Node http）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');
const core = require('./lib/core');
const sched = require('./lib/sched');

const PORT = Number(process.env.PORT || process.env.LXHUB_PORT || 58059); // 小众端口，减少与其他项目冲突
const HOST = process.env.HOST || process.env.LXHUB_HOST || undefined; // 不设则监听全部网卡
const ADMIN_USER = process.env.ADMIN_USER || process.env.LXH_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || process.env.LXH_ADMIN_PASS || 'admin888';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// ---- 会话（HMAC 签名 cookie：exp.hmac） ----
function sign(exp) {
  const db = store.getDb();
  return crypto.createHmac('sha256', db.secret).update('admin' + exp).digest('hex').slice(0, 32);
}
function makeSession() {
  const exp = Date.now() + 1000 * 60 * 60 * 12; // 12h
  return exp + '.' + sign(exp);
}
function checkSession(req) {
  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)lxhub_admin=([0-9]+\.[a-f0-9]+)/);
  if (!m) return false;
  const exp = Number(m[1].split('.')[0]);
  if (exp < Date.now()) return false;
  return sign(exp) === m[1].split('.')[1];
}

// ---- 工具 ----
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise(function (resolve) {
    let data = '';
    req.on('data', function (c) { if (data.length < 1e6) data += c; });
    req.on('end', function () {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
  });
}
function clientUa(req) {
  return req.headers['user-agent'] || core.DEFAULT_UA; // 表头跟随浏览器
}
function relTime(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return Math.floor(diff / 86400000) + ' 天前';
}

// 分类：深检过的按实测（source=音源 / unknown=存疑），未深检的按文本识别兜底
function kindOf(e) { return e.scriptType || (e.isSource ? 'source' : 'unknown'); }

function entryPublic(e) {
  return {
    id: e.id, seq: e.seq || 0, name: e.name, author: e.author, version: e.version,
    platforms: e.platforms || [], status: e.status,
    scriptType: kindOf(e), platStatus: e.platStatus || null,
    isSource: !!e.isSource, confidence: e.confidence || 'low',
    mirrorCount: (e.mirrors || []).length, variantCount: (e.variants || []).length,
    repoPushAt: e.repoPushAt || 0, contentUpdatedAt: e.contentUpdatedAt || e.updatedAt,
    backendAlive: e.backendAlive != null ? e.backendAlive : -1,
    updatedAt: e.updatedAt, lastOkAt: e.lastOkAt, hasBody: !!e.body
  };
}

function filterEntries(q) {
  const db = store.getDb();
  const search = (q.search || '').toLowerCase();
  const status = q.status || 'all';          // all | alive | down | dead
  const type = q.type || 'src';              // src | source | unk | all
  const stMap = { alive: 'ok', ok: 'ok', suspect: 'suspect', down: 'down', dead: 'dead' };
  let list = db.entries.slice();
  if (stMap[status]) list = list.filter(function (e) { return e.status === stMap[status]; });
  if (type === 'source') list = list.filter(function (e) { return kindOf(e) !== 'unknown'; });
  else if (type === 'unk') list = list.filter(function (e) { return kindOf(e) === 'unknown'; });
  if (search) {
    list = list.filter(function (e) {
      return (e.name || '').toLowerCase().indexOf(search) >= 0 ||
        (e.author || '').toLowerCase().indexOf(search) >= 0 ||
        (e.primaryUrl || '').toLowerCase().indexOf(search) >= 0;
    });
  }
  list.sort(function (a, b) {
    const ord = { ok: 0, suspect: 1, down: 2, unknown: 3, dead: 4 };
    const sa = ord[a.status] != null ? ord[a.status] : 2;
    const sb = ord[b.status] != null ? ord[b.status] : 2;
    if (sa !== sb) return sa - sb;
    // 排序先验（借鉴原版）：来源仓库最后 push 时间——长期不维护的仓，其音源后端大概率已失效
    const pa = a.repoPushAt || 0, pb = b.repoPushAt || 0;
    if (pa !== pb) return pb - pa;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  return list;
}

// ---- 路由 ----
async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  const db = store.getDb();
  const ua = clientUa(req);

  // ---- 任务进度（公开，首页也要展示） ----
  if (req.method === 'GET' && p === '/api/task/current') {
    const t = core.task;
    return json(res, 200, {
      running: t.running, type: t.type, phase: t.phase, msg: t.msg,
      done: t.done, total: t.total,
      elapsed: t.running ? (Date.now() - t.startedAt) : (t.endedAt ? t.endedAt - t.startedAt : 0),
      stats: t.stats, logs: t.logs.slice(-8),
      result: t.running ? null : t.result
    });
  }
  if (req.method === 'POST' && p === '/api/task/cancel') {
    if (!checkSession(req)) return json(res, 401, { error: 'unauthorized' });
    if (!core.task.running) return json(res, 409, { error: '当前没有进行中的任务' });
    core.task.cancel = true;
    store.log('用户请求取消任务: ' + core.task.type);
    return json(res, 200, { ok: true });
  }

  // ---- 公开接口 ----
  if (req.method === 'GET' && p === '/api/overview') {
    const entries = db.entries;
    const accelPrefix = db.config.ghMirror || db.config.accelPrefix || '';
    let accelHost = '';
    if (accelPrefix) {
      try { accelHost = new URL(accelPrefix).hostname; } catch (e) { accelHost = accelPrefix.slice(0, 40); }
    }
    return json(res, 200, {
      total: entries.length,
      ok: entries.filter(function (e) { return e.status === 'ok'; }).length,
      suspect: entries.filter(function (e) { return e.status === 'suspect'; }).length,
      down: entries.filter(function (e) { return e.status === 'down'; }).length,
      dead: entries.filter(function (e) { return e.status === 'dead'; }).length,
      sources: entries.filter(function (e) { return e.isSource; }).length,
      lastCrawlAt: db.lastCrawlAt, lastCrawlRel: relTime(db.lastCrawlAt),
      lastCheckAt: db.lastCheckAt, lastCheckRel: relTime(db.lastCheckAt),
      accelReady: !!accelPrefix,
      accelHost: accelHost,
      accelPrefix: accelPrefix,
      running: core.task.running,
      phase: core.task.phase,
      authed: checkSession(req)
    });
  }
  if (req.method === 'GET' && p === '/api/entries') {
    const list = filterEntries(q);
    return json(res, 200, { items: list.map(entryPublic), total: list.length });
  }
  if (req.method === 'GET' && p === '/api/source/link') {
    const e = db.entries.find(function (x) { return x.id === q.id; });
    if (!e) return json(res, 404, { error: 'not found' });
    let target = e.primaryUrl;
    if (q.accel === '1' && db.config.ghMirror) target = core.accelRewrite(target, db.config.ghMirror);
    return json(res, 200, { url: target });
  }
  if (req.method === 'GET' && p === '/api/source/detail') {
    const e = db.entries.find(function (x) { return x.id === q.id; });
    if (!e) return json(res, 404, { error: 'not found' });
    let url = e.primaryUrl;
    if (q.accel === '1' && db.config.ghMirror) url = core.accelRewrite(url, db.config.ghMirror);
    return json(res, 200, {
      id: e.id, seq: e.seq || 0, name: e.name, author: e.author, version: e.version,
      platforms: e.platforms || [], status: e.status, isSource: !!e.isSource,
      scriptType: kindOf(e), platStatus: e.platStatus || null, deepError: (e.deep && e.deep.loadError) || '',
      confidence: e.confidence || 'low',
      mirrorCount: (e.mirrors || []).length, variantCount: (e.variants || []).length,
      mirrors: e.mirrors || [], variants: e.variants || [],
      urls: e.urls || [e.primaryUrl], url: url,
      origin: e.origin || '', originRepo: e.originRepo || '',
      backendDomains: e.backendDomains || [], backendAlive: e.backendAlive != null ? e.backendAlive : -1,
      httpStatus: e.httpStatus || 0,
      size: e.bodySize || 0, sha256: e.body ? core.sha256(e.body) : '',
      firstSeenAt: e.firstSeenAt, lastCheckAt: e.lastCheckAt, lastOkAt: e.lastOkAt,
      contentUpdatedAt: e.contentUpdatedAt || e.updatedAt,
      bodyHead: e.body ? e.body.slice(0, 4000) : ''
    });
  }

  if (req.method === 'GET' && p === '/api/source/download') {
    const e = db.entries.find(function (x) { return x.id === q.id; });
    if (!e) return json(res, 404, { error: 'not found' });
    let target = e.primaryUrl;
    if (q.accel === '1' && db.config.ghMirror) target = core.accelRewrite(target, db.config.ghMirror);
    const r = await core.crawlFetch(target, { cfg: db.config, ua: ua, timeout: 15000 });
    if (!r.ok || !r.text) return json(res, 502, { error: '拉取失败: ' + (r.error || r.status) });
    const safe = (e.name || 'source').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-disposition': 'attachment; filename="' + encodeURIComponent(safe + '-' + e.id + '.js') + '"'
    });
    return res.end(r.text);
  }

  // ---- 导出 ZIP（公开，对齐原站：只打可用源，文件名 = 脚本原始名，deflate 压缩） ----
  if (req.method === 'GET' && p === '/api/export') {
    // 内容去重（同脚本多仓库收录只导一份）→ 按名字分组 → 每组最新版放根目录，
    // 同名旧版进「疑似早期版本/」子目录（文件名带版本号），版本取舍交给用户
    const seenSha = new Set();
    const groups = new Map(); // 归一名 -> [条目，新的在前]
    for (const e of filterEntries({ status: 'alive', type: 'all', search: (q.search || '') })) {
      if (!e.body) continue;
      if (e.sample) continue; // 测试/示例源不参与导出
      let sha = e.bodySha;
      if (!sha) { sha = crypto.createHash('sha256').update(e.body, 'utf8').digest('hex'); }
      if (seenSha.has(sha)) continue;
      seenSha.add(sha);
      let name = (e.name || 'source').replace(/[\\/:*?"<>|]/g, '_').trim() || 'source';
      if (!/\.js$/i.test(name)) name += '.js';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(e);
    }
    const files = [];
    const OLD_DIR = '疑似早期版本/';
    for (const [name, list] of groups) {
      list.sort(function (a, b) {
        return (b.contentUpdatedAt || b.updatedAt || 0) - (a.contentUpdatedAt || a.updatedAt || 0);
      });
      files.push({ name: name, data: Buffer.from(list[0].body, 'utf8') });
      list.slice(1).forEach(function (e, i) {
        const ver = String(e.version || '').trim().replace(/^v/i, '');
        const stem = name.replace(/\.js$/i, '');
        const sub = ver ? stem + ' (v' + ver + ').js' : stem + ' (' + (i + 2) + ').js';
        files.push({ name: OLD_DIR + sub, data: Buffer.from(e.body, 'utf8') });
      });
    }
    if (!files.length) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('当前没有可用的音源脚本可导出');
    }
    const zip = core.buildZip(files);
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="lx-sources-' + new Date().toISOString().slice(0, 10) + '.zip"'
    });
    return res.end(zip);
  }

  // ---- 登录 ----
  if (req.method === 'POST' && p === '/api/admin/login') {
    const body = await readBody(req);
    if (body.user === ADMIN_USER && body.pass === ADMIN_PASS) {
      res.setHeader('set-cookie', 'lxhub_admin=' + makeSession() + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000'); // 365 天：自部署内网为主，避免频繁重登
      store.log('后台登录成功');
      return json(res, 200, { ok: true });
    }
    await new Promise(function (r) { setTimeout(r, 600); });
    return json(res, 401, { error: '账户名或密码错误' });
  }
  if (req.method === 'POST' && p === '/api/admin/logout') {
    res.setHeader('set-cookie', 'lxhub_admin=; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && p === '/api/admin/session') {
    return json(res, 200, { authed: checkSession(req) });
  }

  // ---- 以下需要登录 ----
  if (p.startsWith('/api/admin/')) {
    if (!checkSession(req)) return json(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && p === '/api/admin/config') {
      const c = db.config;
      return json(res, 200, {
        config: {
          proxy: c.proxy || '', ghMirror: c.ghMirror || '', forceProxy: !!c.forceProxy,
          useJsdelivr: !!c.useJsdelivr, ghTokenSet: !!c.ghToken,
          autoCheck: c.autoCheck !== false, batchSize: Number(c.batchSize) || 60,
          fastMode: !!c.fastMode, debug: !!c.debug,
          externalDeploy: !!c.externalDeploy,
          repos: c.repos || [], blockedRepos: c.blockedRepos || [], seeds: c.seeds || []
        },
        builtinRepos: core.currentBuiltinRepos(db),
        manifest: core.manifestInfo(db),
        repoErrors: db.repoErrors || {},
        mirrorPresets: core.MIRROR_PRESETS
      });
    }
    // 每仓统计（收录来源页「可用音源/包含链接」）：按来源仓分组统计条目
    if (req.method === 'GET' && p === '/api/admin/repo-stats') {
      const stats = {};
      for (const e of db.entries) {
        const repo = e.originRepo || '';
        if (!repo) continue;
        const s = stats[repo] || (stats[repo] = { usable: 0, total: 0, untested: 0 });
        if (kindOf(e) === 'unknown') continue; // 只统计音源 JS（与插件口径一致）
        s.total++;
        if (e.status === 'ok') s.usable++;
        if (!e.deep || !e.deep.checkedAt) s.untested++;
      }
      const errs = db.repoErrors || {};
      for (const k in errs) if (!stats[k]) stats[k] = { usable: 0, total: 0, untested: 0, error: errs[k] };
      return json(res, 200, { ok: true, stats: stats });
    }
    // 屏蔽 / 恢复内置仓库：扫描时自动跳过，已收录的链接不受影响
    if (req.method === 'POST' && p === '/api/admin/repos/block') {
      const body = await readBody(req);
      const repo = String(body.repo || '').trim();
      const blocked = !!body.blocked;
      if (core.currentBuiltinRepos(db).indexOf(repo) < 0) return json(res, 400, { error: '只能屏蔽内置仓库' });
      const c = db.config;
      const list = c.blockedRepos = c.blockedRepos || [];
      const idx = list.indexOf(repo);
      if (blocked && idx < 0) list.push(repo);
      if (!blocked && idx >= 0) list.splice(idx, 1);
      store.saveSoon();
      store.log((blocked ? '屏蔽' : '恢复') + '内置仓库: ' + repo);
      return json(res, 200, { ok: true });
    }
    // 内置仓清单热更新：拉远端 manifest 比对版本号，有新版直接热应用（无需重启/更新镜像）
    if (req.method === 'POST' && p === '/api/admin/manifest/check') {
      const r = await core.checkBuiltinManifest(db.config, ua);
      return json(res, r.ok ? 200 : 502, r);
    }
    // 社区精选（lx-hunter-market 订阅，与插件端同源）
    if (req.method === 'GET' && p === '/api/admin/market') {
      const r = await core.fetchMarketList(db.config, ua, q.force === '1');
      if (!r.ok) return json(res, 502, r);
      const c = db.config;
      const items = (r.items || []).map(function (s) {
        const adopted = s.type === 'repo'
          ? (c.repos || []).indexOf(s.repo) >= 0
          : (c.seeds || []).indexOf(s.url) >= 0;
        return {
          name: s.name, url: s.url || '', repo: s.repo || '', type: s.type,
          notes: String(s.notes || '').slice(0, 120), submitter: s.submitter || '',
          usable: s.stats && typeof s.stats.usable === 'number' ? s.stats.usable : null,
          total: s.stats && typeof s.stats.source === 'number' ? s.stats.source : null,
          adopted: adopted
        };
      });
      return json(res, 200, { ok: true, updatedAt: r.updatedAt, items: items });
    }
    // 采用社区精选条目：repo → 自定义仓库；js/page 直链 → 种子导入
    if (req.method === 'POST' && p === '/api/admin/market/adopt') {
      const body = await readBody(req);
      const item = String(body.item || '');
      if (body.adopt) {
        if (body.type === 'repo' && /^[\w.\-]+\/[\w.\-]+$/.test(item)) {
          if ((db.config.repos || []).indexOf(item) < 0) (db.config.repos = db.config.repos || []).push(item);
          store.log('社区精选采用仓库: ' + item);
        } else if (/^https?:\/\//.test(item)) {
          if ((db.config.seeds || []).indexOf(item) < 0) (db.config.seeds = db.config.seeds || []).push(item);
          store.log('社区精选采用链接: ' + item.slice(0, 90));
        } else return json(res, 400, { error: '条目无效' });
      } else {
        const ri = (db.config.repos || []).indexOf(item);
        if (ri >= 0) db.config.repos.splice(ri, 1);
        const si = (db.config.seeds || []).indexOf(item);
        if (si >= 0) db.config.seeds.splice(si, 1);
        store.log('社区精选移除: ' + item.slice(0, 90));
      }
      store.saveSoon();
      return json(res, 200, { ok: true });
    }
    // 运行日志（每次搜索/检测任务留痕，最近 50 次）
    if (req.method === 'GET' && p === '/api/admin/runs') {
      const runs = (db.runs || []).map(function (r) {
        return { id: r.id, kind: r.kind, trigger: r.trigger, startedAt: r.startedAt, endedAt: r.endedAt, status: r.status, stats: r.stats };
      });
      return json(res, 200, { runs: runs });
    }
    if (req.method === 'GET' && p === '/api/admin/runs/download') {
      const r = (db.runs || []).find(function (x) { return String(x.id) === String(q.id); });
      if (!r) return json(res, 404, { error: '日志不存在' });
      const kind = r.kind === 'crawl' ? '搜索' : '检测';
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('# lx-hub ' + kind + '运行日志\r\n# 触发方式: ' + r.trigger + '\r\n# 状态: ' + r.status + (r.stats ? '（' + r.stats + '）' : '') + '\r\n# ' + '----------------------------------------\r\n' + (r.text || ''));
    }
    if (req.method === 'POST' && p === '/api/admin/config') {
      const body = await readBody(req);
      const c = db.config;
      if (typeof body.proxy === 'string') c.proxy = body.proxy.trim();
      if (typeof body.ghMirror === 'string') c.ghMirror = core.normMirrorBase(body.ghMirror);
      if (typeof body.forceProxy === 'boolean') c.forceProxy = body.forceProxy;
      if (typeof body.useJsdelivr === 'boolean') c.useJsdelivr = body.useJsdelivr;
      if (typeof body.ghToken === 'string' && body.ghToken.trim()) c.ghToken = body.ghToken.trim(); // 留空保持不变
      if (typeof body.autoCheck === 'boolean') c.autoCheck = body.autoCheck;
      if (body.batchSize != null) c.batchSize = Math.min(500, Math.max(1, Number(body.batchSize) || 60));
      if (typeof body.fastMode === 'boolean') c.fastMode = body.fastMode;
      if (typeof body.debug === 'boolean') c.debug = body.debug;
      if (typeof body.externalDeploy === 'boolean') c.externalDeploy = body.externalDeploy;
      if (Array.isArray(body.repos)) c.repos = body.repos.map(function (s) { return String(s).trim(); }).filter(function (s) { return /^[\w.\-]+\/[\w.\-]+$/.test(s); }).slice(0, 50);
      if (Array.isArray(body.seeds)) c.seeds = body.seeds.map(function (s) { return String(s).trim(); }).filter(function (s) { return /^https?:\/\//.test(s); }).slice(0, 100);
      store.saveSoon();
      store.log('配置已更新');
      return json(res, 200, { ok: true });
    }
    // 镜像测试（复刻插件：与搜索同一 mirrorUrlFor 规则）
    if (req.method === 'POST' && p === '/api/admin/mirror-test') {
      const body = await readBody(req);
      const r = await core.testMirror(body.mirror, ua);
      store.log('镜像测试 ' + (r.mirror || body.mirror) + ': ' + (r.ok ? 'OK ' + r.ms + 'ms' : '失败 ' + (r.error || r.status)));
      return json(res, r.ok ? 200 : 502, r);
    }
    // 仓库管理：添加 / 删除自定义仓库（内置仓库只读）；添加也支持音源直链（与插件一致）
    if (req.method === 'POST' && p === '/api/admin/repos') {
      const body = await readBody(req);
      let repo = String(body.repo || '').trim();
      // 支持 owner/repo 或完整 GitHub 仓库地址（github.com/...、.git 后缀）；http 直链归入自定义链接
      const m = repo.match(/github\.com[/:]([\w.\-]+\/[\w.\-]+)/i);
      if (m) repo = m[1];
      repo = repo.replace(/\.git$/i, '').replace(/\/+$/, '');
      if (!/^[\w.\-]+\/[\w.\-]+$/.test(repo)) {
        if (/^https?:\/\//i.test(repo)) {
          const c0 = db.config;
          if ((c0.seeds || []).indexOf(repo) >= 0) return json(res, 400, { error: '该链接已存在' });
          (c0.seeds = c0.seeds || []).push(repo);
          store.saveSoon();
          store.log('添加自定义链接: ' + repo);
          return json(res, 200, { ok: true, url: true });
        }
        return json(res, 400, { error: '仓库格式无效，应为 owner/repo 或 http(s) 链接' });
      }
      if (store.BUILTIN_REPOS.indexOf(repo) >= 0) return json(res, 400, { error: '该仓库已在内置仓库中，无需添加' });
      const c = db.config;
      if ((c.repos || []).indexOf(repo) >= 0) return json(res, 400, { error: '该仓库已存在' });
      (c.repos = c.repos || []).push(repo);
      store.saveSoon();
      store.log('添加自定义仓库: ' + repo);
      return json(res, 200, { ok: true });
    }
    // 删除自定义链接（seeds）
    if (req.method === 'POST' && p === '/api/admin/urls/remove') {
      const body = await readBody(req);
      const url = String(body.url || '').trim();
      const c = db.config;
      const idx = (c.seeds || []).indexOf(url);
      if (idx < 0) return json(res, 404, { error: 'not found' });
      c.seeds.splice(idx, 1);
      store.saveSoon();
      store.log('删除自定义链接: ' + url);
      return json(res, 200, { ok: true });
    }
    // ---- 通用灌入：目标管理（直推内容到各洛雪服务端变种） ----
    if (req.method === 'GET' && p === '/api/admin/push/targets') {
      return json(res, 200, {
        ok: true,
        types: core.pusher.PUSH_TYPES.map(function (k) {
          return { type: k, label: core.pusher.ADAPTERS[k].label, hint: core.pusher.ADAPTERS[k].hint };
        }),
        targets: (db.config.pushTargets || []).map(function (t) {
          return {
            id: t.id, name: t.name, type: t.type, baseUrl: t.baseUrl,
            tokenSet: !!t.token, username: t.username || '',
            enabled: t.enabled !== false,
            pushed: t.pushedMap ? Object.keys(t.pushedMap).length : 0,
            pushedMap: t.pushedMap || {}
          };
        })
      });
    }
    if (req.method === 'POST' && p === '/api/admin/push/targets') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 40);
      const type = String(body.type || '').trim();
      const baseUrl = String(body.baseUrl || '').trim();
      const c = db.config;
      c.pushTargets = c.pushTargets || [];
      let t;
      if (body.id) {
        t = c.pushTargets.find(function (x) { return x.id === body.id; });
        if (!t) return json(res, 404, { error: '目标不存在' });
      } else {
        if (!core.pusher.adapterFor(type)) return json(res, 400, { error: '未知的目标类型: ' + type });
        if (!/^https?:\/\//i.test(baseUrl)) return json(res, 400, { error: '地址必须是 http(s):// 开头' });
        t = { id: 'pt-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36) };
        c.pushTargets.push(t);
      }
      // 更新：留空的字段保持原值（停用/启用等轻量更新不必带全表单）
      if (core.pusher.adapterFor(type)) t.type = type;
      if (/^https?:\/\//i.test(baseUrl)) t.baseUrl = baseUrl.replace(/\/+$/, '');
      if (name) t.name = name;
      if (body.token) t.token = String(body.token); // 留空 = 保持原凭据不变
      if (body.username !== undefined) t.username = String(body.username || '').trim();
      if (typeof body.enabled === 'boolean') t.enabled = body.enabled;
      store.saveSoon();
      store.log((body.id ? '更新' : '添加') + '灌入目标: [' + t.name + '] ' + t.baseUrl);
      return json(res, 200, { ok: true, id: t.id });
    }
    if (req.method === 'POST' && p === '/api/admin/push/targets/delete') {
      const body = await readBody(req);
      const c = db.config;
      const idx = (c.pushTargets || []).findIndex(function (x) { return x.id === body.id; });
      if (idx < 0) return json(res, 404, { error: 'not found' });
      const t = c.pushTargets.splice(idx, 1)[0];
      store.saveSoon();
      store.log('删除灌入目标: [' + (t.name || t.id) + ']');
      return json(res, 200, { ok: true });
    }
    // 连接测试：已保存的传 id（用存储凭据）；表单未保存的传完整对象（token 字段原文）
    if (req.method === 'POST' && p === '/api/admin/push/test') {
      const body = await readBody(req);
      let t;
      if (body.target && body.target.type) {
        t = body.target;
        if (!core.pusher.adapterFor(t.type)) return json(res, 400, { error: '未知的目标类型' });
      } else {
        t = (db.config.pushTargets || []).find(function (x) { return x.id === body.id; });
        if (!t) return json(res, 404, { error: 'not found' });
      }
      const r = await (async function () {
        try {
          return await core.pusher.adapterFor(t.type).test(t);
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
        }
      })();
      store.log('灌入目标连接测试 [' + (t.name || t.type) + ']: ' + (r.ok ? 'OK' : (r.error || '失败')));
      return json(res, r.ok ? 200 : 502, r);
    }
    // 撤回：删除目标内「本系统灌入记录（pushedMap）」中的音源，不碰用户手动添加的
    if (req.method === 'POST' && p === '/api/admin/push/revoke') {
      const body = await readBody(req);
      const t = (db.config.pushTargets || []).find(function (x) { return x.id === body.id; });
      if (!t) return json(res, 404, { error: 'not found' });
      const adapter = core.pusher.adapterFor(t.type);
      if (!adapter.revokeAll) return json(res, 400, { error: '该类型暂不支持撤回' });
      const byId = {};
      db.entries.forEach(function (e) { byId[e.id] = e.name; });
      const names = Object.keys(t.pushedMap || {}).map(function (id) { return byId[id]; }).filter(Boolean);
      if (!names.length) return json(res, 200, { ok: true, removed: [], note: '该目标没有本系统的灌入记录' });
      const r = await (async function () {
        try {
          return await adapter.revokeAll(t, names);
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
        }
      })();
      // 撤回成功的从灌入记录里移除
      if (r.ok && r.removed && r.removed.length) {
        const removedSet = new Set(r.removed.map(function (n) { return String(n).toLowerCase(); }));
        Object.keys(t.pushedMap || {}).forEach(function (id) {
          const n = String(byId[id] || '').toLowerCase();
          if (removedSet.has(n)) delete t.pushedMap[id];
        });
        store.saveSoon();
      }
      store.log('灌入撤回 [' + (t.name || t.type) + ']: 撤下 ' + ((r.removed && r.removed.length) || 0) + ' 个' + (r.failed ? '，失败 ' + r.failed + ' 个' : ''));
      return json(res, r.ok ? 200 : 502, r);
    }
    // 启动灌入任务（走任务通道，进度经 /api/task/current 轮询；fire-and-forget 与搜索/检测一致）
    if (req.method === 'POST' && p === '/api/admin/push/start') {
      if (core.task.running) return json(res, 409, { error: '已有任务进行中' });
      const body = await readBody(req);
      const wantIds = Array.isArray(body.targets) ? body.targets : null;
      const targets = (db.config.pushTargets || []).filter(function (t) {
        return t.enabled !== false && (!wantIds || wantIds.indexOf(t.id) >= 0);
      });
      if (!targets.length) return json(res, 400, { error: '没有可用的灌入目标（先在下方添加并启用）' });
      const wantEntries = Array.isArray(body.entryIds) ? body.entryIds : null;
      const entries = db.entries.filter(function (e) {
        return (!wantEntries || wantEntries.indexOf(e.id) >= 0) &&
          e.status === 'ok' && e.body && kindOf(e) !== 'unknown' && !e.sample;
      });
      if (!entries.length) return json(res, 400, { error: '没有可灌入的音源（需要实测可用且已缓存脚本）' });
      core.pushAll(ua, '手动', { targets: body.targets, entryIds: body.entryIds })
        .catch(function (e) { console.error('[push]', e); });
      return json(res, 200, { ok: true, started: true, targets: targets.length, entries: entries.length });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/admin/repos/')) {
      const repo = decodeURIComponent(p.slice('/api/admin/repos/'.length));
      const c = db.config;
      const idx = (c.repos || []).indexOf(repo);
      if (idx < 0) return json(res, 404, { error: 'not found' });
      c.repos.splice(idx, 1);
      store.saveSoon();
      store.log('删除自定义仓库: ' + repo);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/admin/crawl') {
      if (core.task.running) return json(res, 409, { error: '已有任务进行中' });
      core.crawlAll(ua).catch(function (e) { console.error('[crawl]', e); });
      return json(res, 200, { ok: true, started: true });
    }
    if (req.method === 'POST' && p === '/api/admin/check') {
      if (core.task.running) return json(res, 409, { error: '已有任务进行中' });
      core.checkAll(ua).catch(function (e) { console.error('[check]', e); });
      return json(res, 200, { ok: true, started: true });
    }
    // ---- 定时任务 ----
    if (req.method === 'GET' && p === '/api/admin/schedule') {
      const c = db.config;
      const s = db.sched || {};
      return json(res, 200, {
        cfg: {
          schedEnabled: !!c.schedEnabled,
          schedFreq: c.schedFreq || 'daily', schedInterval: Number(c.schedInterval) || 1,
          schedWeekday: Number(c.schedWeekday) || 1, schedMonthDay: Number(c.schedMonthDay) || 1,
          schedHour: Number(c.schedHour) || 0, schedMinute: Number(c.schedMinute) || 0,
          schedLogKeep: [3, 7, 10, 30].indexOf(Number(c.schedLogKeep)) >= 0 ? Number(c.schedLogKeep) : 10
        },
        state: {
          nextRun: s.nextRun || 0, lastRun: s.lastRun || 0,
          lastResult: s.lastResult || '', lastKind: s.lastKind || '',
          desc: sched.describe(c)
        }
      });
    }
    if (req.method === 'POST' && p === '/api/admin/schedule') {
      const body = await readBody(req);
      const c = db.config;
      if (typeof body.schedEnabled === 'boolean') c.schedEnabled = body.schedEnabled;
      if (typeof body.schedFreq === 'string' && ['daily', 'nday', 'nhour', 'weekly', 'monthly'].indexOf(body.schedFreq) >= 0) c.schedFreq = body.schedFreq;
      if (body.schedInterval != null) c.schedInterval = Math.min(30, Math.max(1, Number(body.schedInterval) || 1));
      if (body.schedWeekday != null) c.schedWeekday = Math.min(6, Math.max(0, Number(body.schedWeekday) || 0));
      if (body.schedMonthDay != null) c.schedMonthDay = Math.min(28, Math.max(1, Number(body.schedMonthDay) || 1));
      if (body.schedHour != null) c.schedHour = Math.min(23, Math.max(0, Number(body.schedHour) || 0));
      if (body.schedMinute != null) c.schedMinute = Math.min(59, Math.max(0, Number(body.schedMinute) || 0));
      if (body.schedLogKeep != null && [3, 7, 10, 30].indexOf(Number(body.schedLogKeep)) >= 0) c.schedLogKeep = Number(body.schedLogKeep);
      store.saveSoon();
      sched.rearm();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/admin/schedule/run') {
      const r = sched.runNow();
      if (r.error) return json(res, 409, r);
      return json(res, 200, r);
    }
    // 定时任务运行日志：分页列表（摘要）/ 单条全文下载（与插件 /api/schedlogs 同构）
    if (req.method === 'GET' && p === '/api/admin/schedlogs') {
      return json(res, 200, sched.listSchedLogs(Number(q.page) || 1));
    }
    if (req.method === 'GET' && p === '/api/admin/schedlogs/download') {
      const text = sched.getSchedLogText(q.id);
      if (text == null) return json(res, 404, { error: '日志不存在' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }
    // 导出 JSON（全部条目公开字段）
    if (req.method === 'GET' && p === '/api/admin/export-json') {
      const items = db.entries.map(function (e) { return entryPublic(e); });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="lx-sources-' + new Date().toISOString().slice(0, 10) + '.json"'
      });
      return res.end(JSON.stringify({ exportedAt: new Date().toISOString(), total: items.length, items: items }, null, 2));
    }
    if (req.method === 'GET' && p === '/api/admin/logs') {
      return json(res, 200, { logs: db.logs.slice(-80).reverse() });
    }
    if (req.method === 'GET' && p === '/api/admin/entries') {
      const list = filterEntries(q);
      return json(res, 200, {
        items: list.map(function (e) {
          return Object.assign(entryPublic(e), { primaryUrl: e.primaryUrl, urls: e.urls, bodySize: e.bodySize, originRepo: e.originRepo || '' });
        })
      });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/admin/entries/')) {
      const id = p.split('/').pop();
      const idx = db.entries.findIndex(function (e) { return e.id === id; });
      if (idx < 0) return json(res, 404, { error: 'not found' });
      store.log('删除条目: ' + (db.entries[idx].name || id));
      db.entries.splice(idx, 1);
      store.saveSoon();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/admin/import') {
      const body = await readBody(req);
      const urlStr = String(body.url || '').trim();
      if (!/^https?:\/\//.test(urlStr)) return json(res, 400, { error: '无效 URL' });
      const r = await core.crawlFetch(urlStr, { cfg: db.config, ua: ua, timeout: 10000 });
      if (!r.ok || !r.text) return json(res, 502, { error: '拉取失败: ' + (r.error || r.status) });
      const fname = decodeURIComponent(urlStr.split('/').pop().split('?')[0]).replace(/\.(js|zip|txt)$/i, '');
      const meta = core.extractMeta(r.text, fname);
        const item = {
          primaryUrl: urlStr,
          name: body.name || meta.name || fname || '(未命名)',
          author: body.author || meta.author || '',
          version: body.version || meta.version || '',
          platforms: (body.platforms && body.platforms.length) ? body.platforms : core.detectPlatforms(r.text),
          isSource: body.isSource !== false && core.isSourceScript(r.text),
          urls: Array.from(new Set([urlStr].concat(core.extractLinks(r.text)))).slice(0, 20),
          origin: '后台导入',
          body: r.text.length > 300000 ? r.text.slice(0, 300000) : r.text
        };
      const e = (function () {
        const dbx = store.getDb();
        const id = core.sha1(urlStr);
        let ex = dbx.entries.find(function (x) { return x.id === id; });
        const now = Date.now();
        if (!ex) {
          ex = { id: id, name: item.name, author: item.author || '', version: item.version || '', platforms: item.platforms, urls: item.urls, primaryUrl: urlStr, isSource: item.isSource, body: item.body, bodySize: item.body.length, status: 'unknown', failStreak: 0, origin: item.origin || '后台导入', firstSeenAt: now, updatedAt: now, lastCheckAt: 0, lastOkAt: 0 };
          dbx.entries.push(ex);
        } else {
          Object.assign(ex, { body: item.body, bodySize: item.body.length, updatedAt: now, isSource: ex.isSource || item.isSource });
        }
        store.saveSoon();
        return ex;
      })();
      store.log('手动导入: ' + (e.name || urlStr));
      return json(res, 200, { ok: true, id: e.id });
    }
    return json(res, 404, { error: 'not found' });
  }

  return json(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let p = url.pathname;
  if (p === '/') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    // 外网部署模式：前台 index.html 在服务端直接剥掉扫描按钮段（<!--scan--> … <!--/scan-->，
    // 含标记本身）——浏览器收到的 HTML 里按钮根本不存在，不是 CSS 隐藏，也无法从前台逆向恢复。
    if (p === '/index.html' && store.getDb().config.externalDeploy) {
      const html = buf.toString('utf8').replace(/<!--scan-->[\s\S]*?<!--\/scan-->/g, '');
      buf = Buffer.from(html, 'utf8');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    Promise.resolve(handleApi(req, res, url)).catch(function (e) {
      console.error('[api]', e);
      try { json(res, 500, { error: e.message }); } catch (_) { /* noop */ }
    });
  } else {
    serveStatic(req, res, url);
  }
});

store.getDb();
// 老数据迁移（一次性）：统一规则「可用 ⟺ 至少一个平台实测取到音频」——零平台的 ok 条目降为存疑
(function () {
  const db = store.getDb();
  let n = 0;
  for (const e of db.entries) {
    if (e.status === 'ok' && !(e.platforms || []).length) { e.status = 'suspect'; n++; }
  }
  if (n) { store.saveSoon(); console.log('[lx-hub] 存疑迁移: ' + n + ' 条零实测平台的条目已降级为存疑'); }
})();
sched.arm(); // 进程内定时任务调度（Docker 长驻进程下持续运行；重启后自动重新布防）

// 内置仓清单热更新：启动后台拉一次 + 每 24 小时自动检查（拉取失败静默用兜底清单，不打扰）
(function manifestLoop() {
  const once = function () {
    core.checkBuiltinManifest(store.getDb().config, core.DEFAULT_UA).then(function (r) {
      if (r.ok && r.applied) console.log('[lx-hub] 内置仓清单已热更新: v' + r.current + ' → v' + r.latest);
    }).catch(function () { /* 网络抖动等下个周期 */ });
  };
  setTimeout(once, 5000);
  setInterval(once, 24 * 3600 * 1000);
})();

server.listen(PORT, HOST, function () {
  console.log('[lx-hub] listening on http://localhost:' + PORT);
  console.log('[lx-hub] data dir: ' + store.DATA_DIR);
  console.log('[lx-hub] admin: ' + ADMIN_USER + ' / ' + (process.env.ADMIN_PASS ? '(env set)' : '(default admin888, 建议用 ADMIN_PASS 覆盖)'));
});
