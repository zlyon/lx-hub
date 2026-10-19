'use strict';
// lx-hub 核心逻辑：扫描 / 识别 / 检测 / 加速前缀重写 / ZIP 导出 / 任务系统
const crypto = require('crypto');
const store = require('./store');
const sandbox = require('./sandbox');

const PLATFORM_MAP = [
  { key: 'wy', re: /['"]wy['"]|网易云|netease|163\.com/i, label: '网易云' },
  { key: 'tx', re: /['"]tx['"]|qq ?音乐|\bqq\b|u\.y\.qq\.com|qq\.com/i, label: 'QQ' },
  { key: 'kw', re: /['"]kw['"]|酷我|kuwo\.cn/i, label: '酷我' },
  { key: 'kg', re: /['"]kg['"]|酷狗|kugou\.com/i, label: '酷狗' },
  { key: 'mg', re: /['"]mg['"]|咪咕|migu/i, label: '咪咕' }
];

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 lx-hub/0.1';

// 后端域名探测时排除的「非后端」托管/镜像域
const NON_BACKEND_HOSTS = /raw\.githubusercontent\.com|github\.com|gist\.githubusercontent\.com|objects\.githubusercontent\.com|jsdelivr\.net|ghproxy|gh-proxy|ghps\.cc|ghfast\.top|cloudflare\.com|workers\.dev$/i;

function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12); }
function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function fetchText(url, opts) {
  opts = opts || {};
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, opts.timeout || 8000);
  const headers = { 'user-agent': opts.ua || DEFAULT_UA, 'accept': '*/*' };
  if (opts.headers) Object.assign(headers, opts.headers);
  return fetch(url, { signal: ctl.signal, headers: headers, redirect: 'follow' })
    .then(function (res) {
      return res.text().then(function (text) {
        clearTimeout(timer);
        return { ok: res.ok, status: res.status, text: text };
      });
    })
    .catch(function (e) {
      clearTimeout(timer);
      return { ok: false, status: 0, error: (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'fetch error' };
    });
}

// ---- 镜像预设与候选链（复刻插件）----
// 五个主流镜像站 2026-10 实测均只接受「前缀式」：mbase + '/' + 完整原始 URL
const MIRROR_PRESETS = ['https://proxy.vvvv.ee', 'https://ghproxy.net', 'https://gh-proxy.com', 'https://ghfast.top', 'https://gh1.lhl.one'];
const JSD_HOST = 'https://jsdelivr.b-cdn.net';
function normMirrorBase(s) {
  const b = String(s == null ? '' : s).trim().replace(/\/+$/, '');
  if (!b) return '';
  return /^https?:\/\//i.test(b) ? b : 'https://' + b;
}
function mirrorUrlFor(mbase, rawUrl) {
  const base = normMirrorBase(mbase);
  return base ? base + '/' + rawUrl : null;
}
// raw/owner/repo/ref/path → jsDelivr gh/owner/repo@ref/path（ref 原样保留，HEAD 也支持）
function jsdelivrUrlFor(rawUrl) {
  const rest = String(rawUrl).slice('https://raw.githubusercontent.com/'.length);
  const m = rest.match(/^([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  return m ? JSD_HOST + '/gh/' + m[1] + '/' + m[2] + '@' + m[3] + '/' + m[4] : null;
}
// 默认：直连 → 代理（填了才有）→ 镜像（选了才有）→ jsDelivr（勾了才有）
// 强制代理：代理 → 直连 → 镜像 → jsDelivr（仅把代理权重提前到第一位）
function buildCandidates(url, cfg) {
  cfg = cfg || {};
  const proxy = cfg.proxy || '';
  const out = [];
  let mirror = null, jsd = null;
  if (url.indexOf('https://raw.githubusercontent.com/') === 0) {
    if (cfg.ghMirror) mirror = mirrorUrlFor(cfg.ghMirror, url);
    if (cfg.useJsdelivr) jsd = jsdelivrUrlFor(url);
  }
  const force = !!(cfg.forceProxy && proxy);
  function add(u, useProxy) { if (u) out.push({ url: u, useProxy: useProxy }); }
  if (force) { add(url, true); add(url, false); }
  else { add(url, false); if (proxy) add(url, true); }
  add(mirror, false);
  add(jsd, false);
  return out.length ? out : [{ url: url, useProxy: false }];
}

// ---- HTTP(S) over 代理：CONNECT 隧道（零依赖）----
const http = require('http');
const https = require('https');
function proxyTunnelFetch(targetUrl, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    let proxy;
    try { proxy = new URL(opts.proxy); } catch (e) { return resolve({ ok: false, status: 0, error: '代理地址无效' }); }
    const target = new URL(targetUrl);
    const isHttps = target.protocol === 'https:';
    const port = proxy.port || (proxy.protocol === 'https:' ? 443 : 80);
    const done = function (r) { clearTimeout(timer); resolve(r); };
    const timer = setTimeout(function () { done({ ok: false, status: 0, error: 'timeout' }); }, opts.timeout || 8000);
    const connectReq = http.request({
      host: proxy.hostname, port: Number(port),
      method: 'CONNECT', path: target.hostname + ':' + (target.port || (isHttps ? 443 : 80)),
      headers: { 'user-agent': opts.ua || DEFAULT_UA }
    });
    connectReq.on('connect', function (res, socket) {
      if (res.statusCode !== 200) {
        socket.destroy();
        return done({ ok: false, status: 0, error: '代理 CONNECT 失败 HTTP ' + res.statusCode });
      }
      const reqOpts = {
        host: target.hostname, port: target.port || (isHttps ? 443 : 80), path: target.pathname + target.search,
        method: 'GET', headers: Object.assign({ 'user-agent': opts.ua || DEFAULT_UA, accept: '*/*' }, opts.headers || {}),
        createConnection: function () { return isHttps ? require('tls').connect({ socket: socket, servername: target.hostname }) : socket; }
      };
      const lib = isHttps ? https : http;
      const req = lib.request(reqOpts, function (resp) {
        let body = '';
        resp.setEncoding('utf8');
        resp.on('data', function (c) { if (body.length < 2e6) body += c; });
        resp.on('end', function () { done({ ok: resp.statusCode >= 200 && resp.statusCode < 300, status: resp.statusCode, text: body }); });
      });
      req.on('error', function (e) { done({ ok: false, status: 0, error: e.message }); });
      req.end();
    });
    connectReq.on('error', function (e) { done({ ok: false, status: 0, error: '代理连接失败: ' + e.message }); });
    connectReq.end();
  });
}

// 搜索链路统一入口：按候选链逐个尝试（直连/代理/镜像/jsDelivr）
async function crawlFetch(url, opts) {
  opts = opts || {};
  const cfg = opts.cfg || {};
  const cands = buildCandidates(url, cfg);
  let lastErr = null;
  for (const c of cands) {
    if (opts.cancelled && opts.cancelled()) return { ok: false, status: 0, error: 'cancelled' };
    let r;
    if (c.useProxy) r = await proxyTunnelFetch(c.url, { proxy: cfg.proxy, ua: opts.ua, timeout: opts.timeout, headers: opts.headers });
    else r = await fetchText(c.url, { ua: opts.ua, timeout: opts.timeout, headers: opts.headers });
    if (r.ok) {
      if (opts.debug && c.url !== url) taskLog('候选命中 [' + candKind(c, url) + '] ' + url.slice(0, 90));
      return r;
    }
    lastErr = r;
    if (opts.debug && cands.length > 1) taskLog('候选失败 [' + candKind(c, url) + '] ' + (r.error || r.status));
  }
  return lastErr || { ok: false, status: 0, error: 'no candidates' };
}
function candKind(c, originalUrl) {
  if (c.useProxy) return '代理';
  if (c.url === originalUrl) return '直连';
  if (String(c.url).indexOf(JSD_HOST) === 0) return 'jsDelivr';
  const m = String(c.url).match(/^https?:\/\/([^/]+)/);
  return '镜像 ' + (m ? m[1] : '');
}

// ---- 加速前缀（gh-proxy 形态：整条原 URL 拼在前缀后面） ----
function accelRewrite(url, prefix) {
  if (!prefix || !url) return url;
  const p = String(prefix).trim().replace(/\/+$/, '');
  if (!p) return url;
  if (!/^https?:\/\//i.test(p)) return 'https://' + p + '/' + url;
  return p + '/' + url;
}

// ---- 识别 ----
function detectPlatforms(text) {
  const out = [];
  for (const p of PLATFORM_MAP) if (p.re.test(text)) out.push(p.label);
  return out.slice(0, 5);
}

function isSourceScript(text) {
  return /MUSIC_SOURCE|EVENT_NAMES|globalThis\.lx|lx\s*:\s*\{|on\(\s*['"]request['"]|支持平台|音源/.test(text);
}

// ---- 混淆脚本识别：字面量被藏进字符串表，词面匹配全部失效 ----
// javascript-obfuscator 产物特征：_0x 十六进制标识符、长 \x 转义串
function isObfuscated(text) {
  const head = String(text || '').slice(0, 20000);
  const ids = head.match(/\b_0x[a-f0-9]{4,}\b/g);
  if (ids && ids.length >= 10) return true;
  const esc = head.match(/(?:\\x[0-9a-fA-F]{2}){6,}/g);
  return !!(esc && esc.length >= 3);
}

// 通用文件名（无 @name 时不当作音源）：模板/脚手架/客户端脚本
const GENERIC_FILENAMES = /^(index|main|app|utils|config|setup)$/i;
// 测试/示例源特征：真实音源脚本但属测试样本，不进深测队列、不参与导出
const NAME_SAMPLE_HINT = /测试|示例|样例|演示|试用|废弃|弃用|失效|过期|demo|test|sample|example|mock|fake|dummy|练手/i;

function extractMeta(text, fallbackName) {
  const cut = text.slice(0, 8000);
  function pick(re) {
    const m = cut.match(re);
    return m ? m[1].trim().slice(0, 60) : '';
  }
  const name = pick(/@name\s+([^\r\n]{1,60})/) ||
    pick(/['"]?name['"]?\s*[:=]\s*['"]([^'"]{1,50})['"]/) || fallbackName || '';
  const version = pick(/@version\s+([^\r\n]{1,30})/) ||
    pick(/['"]?version['"]?\s*[:=]\s*['"]([\w.\-]{1,20})['"]/) || '';
  const author = pick(/@author\s+([^\r\n]{1,50})/) ||
    pick(/['"]?author['"]?\s*[:=]\s*['"]([^'"]{1,40})['"]/) || '';
  const updateUrl = pick(/@update[_a-z]*\s+([^\r\n]{1,200})/i) || '';
  return { name: name, version: version, author: author, updateUrl: updateUrl };
}

function extractLinks(text) {
  const out = new Set();
  const re = /https?:\/\/[^\s"'<>()\\]+/g;
  let m;
  while ((m = re.exec(text))) {
    const u = m[0].replace(/[),.;'"]+$/, '');
    if (/\.(js|zip)(\?|$)/i.test(u) || /raw\.githubusercontent\.com|gist\.githubusercontent\.com|\/raw\/|\/releases\/download\//.test(u)) {
      out.add(u);
    }
    if (out.size >= 30) break;
  }
  return Array.from(out);
}

// 提取脚本里「声明的后端域名」（排除托管/镜像域），最多 6 个
function extractBackends(text) {
  const hosts = new Set();
  const re = /['"](https?:\/\/[^'"\s]{4,120}?)['"]/g;
  let m;
  while ((m = re.exec(text.slice(0, 60000)))) {
    try {
      const h = new URL(m[1]).hostname;
      if (!NON_BACKEND_HOSTS.test(h)) hosts.add(h);
    } catch (e) { /* 忽略非法 URL */ }
    if (hosts.size >= 6) break;
  }
  return Array.from(hosts);
}

// 置信度：结构完整（request 处理器 / 平台表 / 元数据）→ 高；否则低（混淆或结构不全）
function detectConfidence(text, meta) {
  let score = 0;
  if (/on\(\s*['"]request['"]|EVENT_NAMES\.request/.test(text)) score += 2;
  if (/MUSIC_SOURCE|MUSIC_QUALITIES|PLATFORMS\s*=/.test(text)) score += 1;
  if (meta && meta.name) score += 1;
  if (meta && meta.version) score += 1;
  return score >= 3 ? 'high' : 'low';
}

// ---- 任务系统（单任务：crawl 或 check） ----
const task = {
  type: null, running: false, cancel: false, trigger: '手动',
  phase: '', msg: '', done: 0, total: 0,
  startedAt: 0, endedAt: 0,
  stats: '', logs: [], allLogs: [], result: null
};
function taskLog(msg) {
  task.logs.push(String(msg).slice(0, 300));
  task.allLogs.push({ t: new Date().toISOString(), msg: String(msg).slice(0, 500) });
  if (task.logs.length > 40) task.logs = task.logs.slice(-30);
  store.log(msg);
}
function taskReset(type, total, trigger) {
  task.type = type; task.running = true; task.cancel = false;
  task.trigger = trigger || '手动';
  task.phase = type === 'crawl' ? '搜索' : (type === 'push' ? '灌入' : '检测');
  task.msg = ''; task.done = 0; task.total = total || 0;
  task.startedAt = Date.now(); task.endedAt = 0; task.stats = ''; task.logs = []; task.result = null;
  task.allLogs = [];
}
function taskFinish(result) {
  task.running = false; task.endedAt = Date.now(); task.result = result || null;
  // ---- 运行留痕：每次搜索/检测任务都写一条历史（含完整日志），后台「运行日志」页可查可下载 ----
  try {
    const db = store.getDb();
    if (!Array.isArray(db.runs)) db.runs = [];
    const r = result || {};
    db.runs.unshift({
      id: task.startedAt + '-' + Math.floor(Math.random() * 1e4),
      kind: task.type, trigger: task.trigger || '手动',
      startedAt: task.startedAt, endedAt: task.endedAt,
      status: r.cancelled ? '已取消' : (r.error ? '异常终止' : '完成'),
      stats: task.stats || '',
      text: (task.allLogs || []).map(function (l) {
        const t = new Date(l.t);
        const p = function (n) { return ('0' + n).slice(-2); };
        return p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds()) + ' ' + l.msg;
      }).join('\r\n') + '\r\n'
    });
    while (db.runs.length > 50) db.runs.pop(); // 留最近 50 次
  } catch (e) { /* 留痕失败不影响任务 */ }
}

// ---- 条目合并 ----
function nextSeq(db) {
  db.nextSeq = (db.nextSeq || 0) + 1;
  return db.nextSeq;
}

function upsertEntry(item) {
  const db = store.getDb();
  const key = item.primaryUrl;
  const id = sha1(key);
  let e = db.entries.find(function (x) { return x.id === id; });
  const now = Date.now();
  const newSha = item.bodySha || sha256hex(item.body || '');
  if (!e) {
    e = {
      id: id, seq: nextSeq(db),
      name: item.name || '(未命名)', author: item.author || '', version: item.version || '',
      platforms: item.platforms || [], urls: item.urls || [key], primaryUrl: key,
      isSource: !!item.isSource, confidence: item.confidence || 'low',
      obfuscated: !!item.obfuscated, sample: !!item.sample,
      body: item.body || '', bodySize: (item.body || '').length, bodySha: newSha,
      mirrors: item.mirrors || [], variants: item.variants || [],
      origin: item.origin || '', originRepo: item.originRepo || '',
      repoPushAt: item.repoPushAt || 0, backendDomains: [], backendAlive: -1, httpStatus: 0,
      status: 'unknown', failStreak: 0,
      firstSeenAt: now, updatedAt: now, contentUpdatedAt: now, lastCheckAt: 0, lastOkAt: 0
    };
    db.entries.push(e);
    taskLog('发现新源: ' + (e.name || e.primaryUrl));
  } else {
    e.name = item.name || e.name;
    e.author = item.author || e.author;
    e.version = item.version || e.version;
    if (item.platforms && item.platforms.length) e.platforms = item.platforms;
    e.urls = Array.from(new Set([].concat(e.urls, item.urls || [key]))).slice(0, 20);
    e.isSource = e.isSource || !!item.isSource;
    e.confidence = item.confidence || e.confidence;
    e.obfuscated = !!item.obfuscated; // 随内容重判（本次分析结果为准）
    e.sample = !!item.sample;
    if (item.body) {
      e.body = item.body; e.bodySize = item.body.length;
      if (e.bodySha !== newSha) { e.bodySha = newSha; e.contentUpdatedAt = now; }
    }
    if (item.mirrors && item.mirrors.length) {
      e.mirrors = Array.from(new Set([].concat(e.mirrors || [], item.mirrors))).slice(0, 10);
    }
    if (item.variants && item.variants.length) {
      const seen = new Set((e.variants || []).map(function (v) { return v.src + '|' + v.ver; }));
      for (const v of item.variants) {
        const k = v.src + '|' + v.ver;
        if (!seen.has(k)) { seen.add(k); (e.variants = e.variants || []).push(v); }
      }
      e.variants = e.variants.slice(0, 10);
    }
    if (item.origin && !e.origin) e.origin = item.origin;
    if (item.originRepo) e.originRepo = item.originRepo;
    if (item.repoPushAt) e.repoPushAt = item.repoPushAt;
    e.updatedAt = now;
  }
  store.saveSoon();
  return e;
}

// ---- 批量扫描 ----
async function fetchRepoTree(repo, cfg, ua) {
  const headers = { 'accept': 'application/vnd.github+json', 'user-agent': ua || DEFAULT_UA };
  if (cfg.ghToken) headers.authorization = 'Bearer ' + cfg.ghToken;
  const url = 'https://api.github.com/repos/' + repo + '/git/trees/HEAD?recursive=1';
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, 15000);
  try {
    const res = await fetch(url, { headers: headers, signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    return (j.tree || []).filter(function (t) { return t.type === 'blob'; });
  } catch (e) {
    clearTimeout(timer);
    // 配了代理时走 CONNECT 隧道重试
    if (cfg.proxy) {
      const r = await proxyTunnelFetch(url, { proxy: cfg.proxy, ua: ua, timeout: 15000, headers: headers });
      if (r.ok) {
        try { return JSON.parse(r.text).tree.filter(function (t) { return t.type === 'blob'; }); } catch (e2) { /* fallthrough */ }
      }
    }
    throw e;
  }
}

async function fetchRepoPushAt(repo, cfg, ua) {
  try {
    const headers = { 'accept': 'application/vnd.github+json', 'user-agent': ua || DEFAULT_UA };
    if (cfg.ghToken) headers.authorization = 'Bearer ' + cfg.ghToken;
    const ctl = new AbortController();
    const timer = setTimeout(function () { ctl.abort(); }, 10000);
    const res = await fetch('https://api.github.com/repos/' + repo, { headers: headers, signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return 0;
    const j = await res.json();
    return j.pushed_at ? new Date(j.pushed_at).getTime() : 0;
  } catch (e) { return 0; }
}

function analyzeOne(url, text, ctx) {
  ctx = ctx || {};
  const fname = decodeURIComponent((url.split('?')[0].split('/').pop() || '')).replace(/\.(js|zip|txt|json)$/i, '');
  const meta = extractMeta(text, fname);
  const links = extractLinks(text);
  // 结构识别 → 混淆兜底：混淆脚本字面量全不可信，改凭明文头注释 @name + @version/@update_url 识别
  let isSource = isSourceScript(text);
  let obfuscated = false;
  if (!isSource && isObfuscated(text)) {
    obfuscated = true;
    if (meta.name && meta.name !== fname && (meta.version || meta.updateUrl)) isSource = true;
  }
  // 无 @name（meta.name 是文件名兜底）且文件名通用：模板/脚手架，不当音源
  const noRealName = !meta.name || meta.name === fname;
  if (isSource && noRealName && GENERIC_FILENAMES.test(fname)) isSource = false;
  // 测试/示例源：真实脚本但属样本，不进深测、不导出
  const sample = !!(meta.name && meta.name !== fname && NAME_SAMPLE_HINT.test(meta.name));
  return {
    primaryUrl: url,
    name: meta.name || fname || '(未命名)',
    author: meta.author || ctx.repoOwner || '',
    version: meta.version || '',
    platforms: detectPlatforms(text),
    isSource: isSource,
    obfuscated: obfuscated,
    sample: sample,
    confidence: detectConfidence(text, meta),
    urls: Array.from(new Set([url].concat(links))).slice(0, 20),
    origin: ctx.repo || ctx.origin || '',
    originRepo: ctx.repo || '',
    body: text.length > 300000 ? text.slice(0, 300000) : text
  };
}

function hostOf(u) {
  try { return new URL(u).hostname; } catch (e) { return u.slice(0, 40); }
}

async function crawlAll(triggerUa, trigger) {
  if (task.running) return { error: '已有任务进行中' };
  taskReset('crawl', 0, trigger);
  const db = store.getDb();
  const cfg = db.config;
  const crawlTimeout = cfg.fastMode ? 5000 : 8000;
  const fetchOpts = { cfg: cfg, ua: triggerUa, debug: !!cfg.debug, cancelled: function () { return task.cancel; } };
  try {
    const seen = new Map(); // url -> item|null(占位)
    const repoPush = {};    // repo -> pushed_at
    // 仓库 = 内置仓库（远端清单热更新，拉不到用内置兜底）+ 自定义仓库（去重）；屏蔽的内置仓库扫描时自动跳过
    const blocked = cfg.blockedRepos || [];
    const allRepos = Array.from(new Set([].concat(currentBuiltinRepos(db), cfg.repos || [])))
      .filter(function (r) { return blocked.indexOf(r) < 0; });
    if (!db.repoErrors) db.repoErrors = {};
    for (const repo of allRepos) {
      if (task.cancel) break;
      task.phase = '扫描仓库 ' + repo;
      taskLog('开始扫描仓库: ' + repo);
      let tree = [];
      try {
        tree = await fetchRepoTree(repo, cfg, triggerUa);
      } catch (e) {
        db.repoErrors[repo] = String((e && e.message) || e).slice(0, 200);
        taskLog('仓库扫描失败 ' + repo + ': ' + (e.message || e));
        continue;
      }
      delete db.repoErrors[repo]; // 本次扫描成功，清除上次失败记录
      repoPush[repo] = await fetchRepoPushAt(repo, cfg, triggerUa);
      const cand = tree.filter(function (t) {
        const p = t.path || '';
        return /\.(js|txt|json)$/i.test(p) && !/node_modules|\.min\.js$|dist\//i.test(p) && t.size !== 0 && (t.size == null || t.size < 500000);
      }).slice(0, 250);
      task.total += cand.length;
      taskLog('仓库 ' + repo + ' 候选文件 ' + cand.length + ' 个');
      let done = 0;
      for (const t of cand) {
        if (task.cancel) break;
        done++; task.done++;
        task.msg = '仓库 ' + repo + ': ' + done + '/' + cand.length;
        const raw = 'https://raw.githubusercontent.com/' + repo + '/HEAD/' + t.path;
        const r = await crawlFetch(raw, Object.assign({ timeout: crawlTimeout }, fetchOpts));
        if (!r.ok || !r.text) continue;
        const owner = repo.split('/')[0];
        try {
          const item = analyzeOne(raw, r.text, { repoOwner: owner, repo: repo });
          if (item.isSource || item.urls.length > 1) seen.set(raw, item);
          // 二级跟进：聚合页里的直链（深度 1）
          for (const u of item.urls.slice(1, 8)) {
            if (seen.has(u)) continue;
            if (!/\.js(\?|$)|\.zip(\?|$)/i.test(u)) continue;
            seen.set(u, null); // 占位防重复
            const r2 = await crawlFetch(u, Object.assign({ timeout: crawlTimeout }, fetchOpts));
            if (r2.ok && r2.text && isSourceScript(r2.text)) {
              seen.set(u, analyzeOne(u, r2.text, { repoOwner: owner, repo: repo }));
            }
          }
        } catch (e) { /* 单文件解析失败忽略 */ }
      }
    }
    // 2) 手动种子
    if (!task.cancel) {
      const seeds = cfg.seeds || [];
      task.total += seeds.length;
      for (const u of seeds) {
        if (task.cancel) break;
        task.done++; task.msg = '种子 ' + u;
        const r = await crawlFetch(u, Object.assign({ timeout: crawlTimeout }, fetchOpts));
        if (!r.ok || !r.text) { taskLog('种子扫描失败: ' + u); continue; }
        const item = analyzeOne(u, r.text, { origin: '种子导入' });
        seen.set(u, item);
        for (const su of item.urls.slice(1, 8)) {
          if (seen.has(su) || !/\.js(\?|$)|\.zip(\?|$)/i.test(su)) continue;
          seen.set(su, null);
          const r2 = await crawlFetch(su, Object.assign({ timeout: crawlTimeout }, fetchOpts));
          if (r2.ok && r2.text && isSourceScript(r2.text)) seen.set(su, analyzeOne(su, r2.text, { origin: '种子导入' }));
        }
      }
    }
    if (task.cancel) {
      taskLog('搜索已取消');
      taskFinish({ cancelled: true });
      return { ok: true, cancelled: true };
    }
    // 3) 聚合：内容哈希相同 → 镜像；同名同作者不同内容 → 变体
    task.phase = '聚合去重';
    let validCount = 0;
    const shaGroups = new Map(); // bodySha -> {primary, mirrors:[]}
    for (const item of seen.values()) {
      if (!item || !item.body) continue;
      validCount++;
      const sha = sha256hex(item.body);
      if (shaGroups.has(sha)) {
        shaGroups.get(sha).mirrors.push(item.primaryUrl);
      } else {
        item.bodySha = sha;
        shaGroups.set(sha, { primary: item, mirrors: [item.primaryUrl] });
      }
    }
    const groups = new Map(); // name|author -> {primary, urls, mirrors, variants}
    for (const g of shaGroups.values()) {
      const p = g.primary;
      const gk = (p.name + '|' + p.author).toLowerCase();
      if (!groups.has(gk)) {
        groups.set(gk, { primary: p, urls: [p.primaryUrl], mirrors: [], variants: [] });
      }
      const grp = groups.get(gk);
      const vLabel = p.originRepo || p.origin || hostOf(p.primaryUrl);
      if (grp.primary !== p) {
        grp.variants.push({ src: vLabel, ver: p.version || '' });
      }
      for (const u of p.urls.slice(1)) if (grp.urls.indexOf(u) < 0) grp.urls.push(u);
      for (const u of g.mirrors) if (u !== grp.primary.primaryUrl && grp.urls.indexOf(u) < 0 && grp.mirrors.indexOf(u) < 0) grp.mirrors.push(u);
    }
    let created = 0;
    for (const grp of groups.values()) {
      const p = grp.primary;
      const before = db.entries.length;
      const e = upsertEntry({
        primaryUrl: p.primaryUrl, name: p.name, author: p.author,
        version: p.version, platforms: p.platforms, isSource: p.isSource,
        confidence: p.confidence, urls: grp.urls, body: p.body, bodySha: p.bodySha,
        mirrors: grp.mirrors.slice(0, 10),
        variants: grp.variants.slice(0, 10),
        origin: p.origin, originRepo: p.originRepo,
        repoPushAt: p.originRepo ? (repoPush[p.originRepo] || 0) : 0
      });
      if (db.entries.length > before) created++;
    }
    store.saveSoon();
    db.lastCrawlAt = Date.now();
    store.saveSoon();
    task.stats = '候选 ' + shaGroups.size + ' 内容组，新增 ' + created + '，总条目 ' + db.entries.length;
    taskLog('扫描完成：有效 ' + validCount + '，' + task.stats);
    taskFinish({ ok: true, total: db.entries.length, created: created });
    // 搜索后自动可用性检测（复刻插件「沙箱可用性检测」行为；勾选才执行）
    if (!task.cancel && cfg.autoCheck) {
      taskLog('自动执行可用性检测…');
      await checkAll(triggerUa, (trigger || '手动') + '·自动');
    }
    return { ok: true, total: db.entries.length, created: created };
  } catch (e) {
    taskLog('任务异常: ' + (e.message || e));
    taskFinish({ error: e.message });
    return { error: e.message };
  }
}

// ---- 批量检测 ----
async function probeHosts(hosts, ua) {
  let alive = 0;
  await Promise.all(hosts.map(async function (h) {
    const r = await fetchText('http://' + h + '/', { ua: ua, timeout: 4000 });
    if (r.status > 0 && r.status < 500) alive++;
    else {
      const r2 = await fetchText('https://' + h + '/', { ua: ua, timeout: 4000 });
      if (r2.status > 0 && r2.status < 500) alive++;
    }
  }));
  return alive;
}

// ---- 沙箱深检结果缓存与落地（内容 SHA 相同 = 同一份脚本，直接复用结果） ----
function deepCacheGet(db, sha) {
  if (!db.deepCache) db.deepCache = {};
  const d = db.deepCache[sha];
  // 缓存 24 小时：过期重测（脚本内容和后端都可能变）
  if (d && Date.now() - d.checkedAt < 24 * 3600 * 1000) return d;
  return null;
}
function deepCacheSet(db, sha, deep) {
  if (!db.deepCache) db.deepCache = {};
  db.deepCache[sha] = deep;
  const keys = Object.keys(db.deepCache);
  if (keys.length > 400) { // 防膨胀：只留最新 300 份
    keys.sort(function (a, b) { return db.deepCache[a].checkedAt - db.deepCache[b].checkedAt; });
    for (let i = 0; i < keys.length - 300; i++) delete db.deepCache[keys[i]];
  }
}
function applyDeep(e, deep) {
  e.deep = { checkedAt: deep.checkedAt, loadable: deep.loadable, loadError: deep.loadError, inited: deep.inited };
  e.platStatus = deep.platforms;
  const usable = [];
  for (const p of sandbox.PLATFORMS) {
    if (deep.platforms[p] && deep.platforms[p].status === 'usable') {
      const m = PLATFORM_MAP.find(function (x) { return x.key === p; });
      usable.push(m ? m.label : p);
    }
  }
  e.platforms = usable; // 平台标签只显示实测可用的
  e.scriptType = deep.inited ? 'source' : 'unknown'; // source=音源 / unknown=存疑
}

async function checkAll(triggerUa, trigger) {
  if (task.running) return { error: '已有任务进行中' };
  const db = store.getDb();
  const cfg = db.config;
  const list = db.entries.slice();
  taskReset('check', list.length, trigger);
  const okTimeout = cfg.fastMode ? 4500 : 8000;
  const altTimeout = cfg.fastMode ? 3500 : 6000;
  const batch = Math.max(1, Number(cfg.batchSize) || 60);
  let okCount = 0, downCount = 0, deadCount = 0, suspectCount = 0;
  try {
    let i = 0;
    for (const e of list) {
      if (task.cancel) break;
      i++; task.done++;
      if ((i - 1) % batch === 0) taskLog('检测批次开始：第 ' + i + ' ~ ' + Math.min(i + batch - 1, list.length) + ' 条');
      task.msg = e.name || e.primaryUrl;
      const r = await fetchText(e.primaryUrl, { ua: triggerUa, timeout: okTimeout });
      const now = Date.now();
      e.lastCheckAt = now;
      e.httpStatus = r.status || 0;
      if (r.ok && r.text && r.text.length > 30) {
        // 脚本可达：探测脚本声明的后端域名 → ok / down
        const domains = extractBackends(e.body || r.text);
        e.backendDomains = domains;
        let alive = -1;
        if (domains.length) alive = await probeHosts(domains, triggerUa);
        e.backendAlive = alive;
        if (domains.length && alive === 0) { e.status = 'down'; downCount++; }
        else { e.status = 'ok'; e.lastOkAt = now; okCount++; }
        e.failStreak = 0;
        if (!e.body || e.bodySize < r.text.length) { e.body = r.text.slice(0, 300000); e.bodySize = r.text.length; }
        // 沙箱深检（复刻插件）：脚本真正加载 + 逐平台实测取链 + L2 无损核验。
        // 只对可达的疑似音源做；结果按内容 SHA 缓存，镜像条目直接复用。
        // 测试/示例源（@name 命中样本特征）不进沙箱：省预算，状态按可达记 ok 但不计音源
        if (e.status === 'ok' && e.body && isSourceScript(e.body) && !e.sample) {
          const sha = sha256hex(e.body);
          e.bodySha = sha;
          let deep = deepCacheGet(db, sha);
          if (!deep) {
            deep = await sandbox.deepCheckSafe(e.body); // 子进程隔离：混淆脚本崩溃不伤主服务
            deepCacheSet(db, sha, deep);
            // 单行实测结果（参考原版后台）：[实测] 名称 wy:usable kw:failed mg:failed
            const stParts = Object.keys(deep.platforms || {})
              .map(function (p) { return p + ':' + ((deep.platforms[p] || {}).status || '?'); });
            taskLog('[实测] ' + (e.name || e.primaryUrl) +
              (deep.inited ? '' : ' · 加载失败(' + (deep.loadError || '未初始化') + ')') +
              (stParts.length ? ' ' + stParts.join(' ') : ' 无平台结果'));
          }
          applyDeep(e, deep);
        }
        // 存疑判定（统一规则）：可用 ⟺ 至少一个平台实测取到音频。
        // 深检零平台、或脚本不像音源没进深检（如更新日志/测试脚本）→ 一律存疑。
        if (e.status === 'ok' && !(e.platforms || []).length) {
          e.status = 'suspect'; okCount--; suspectCount++;
        }
      } else {
        // 源站失败：条目多链接时尝试备用链接
        let saved = false;
        for (const u of (e.urls || []).slice(1, 4)) {
          if (task.cancel) break;
          const r2 = await fetchText(u, { ua: triggerUa, timeout: altTimeout });
          if (r2.ok && r2.text && r2.text.length > 30) {
            e.primaryUrl = u; e.status = 'ok'; e.lastOkAt = now; e.failStreak = 0;
            e.httpStatus = r2.status || 0; okCount++; saved = true;
            break;
          }
        }
        if (!saved) { e.status = 'dead'; e.failStreak = (e.failStreak || 0) + 1; deadCount++; }
      }
      store.saveSoon();
    }
    db.lastCheckAt = Date.now();
    store.saveSoon();
    if (task.cancel) {
      taskLog('检测已取消（处理到 ' + i + '/' + list.length + '）');
      taskFinish({ cancelled: true });
      return { ok: true, cancelled: true };
    }
    task.stats = '可用 ' + okCount + '，存疑 ' + suspectCount + '，后端挂 ' + downCount + '，失效 ' + deadCount;
    taskLog('检测完成：' + task.stats);
    taskFinish({ ok: true, okCount: okCount, suspectCount: suspectCount, downCount: downCount, deadCount: deadCount });
    return { ok: true, okCount: okCount, suspectCount: suspectCount, downCount: downCount, deadCount: deadCount };
  } catch (e) {
    taskLog('任务异常: ' + (e.message || e));
    taskFinish({ error: e.message });
    return { error: e.message };
  }
}

// ---- ZIP 导出（对齐原站：deflate 压缩 + 按需 UTF-8 标志，零外部依赖，zlib 为 Node 内置） ----
const zlib = require('zlib');
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function buildZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const needUtf8 = /[^\x00-\x7F]/.test(f.name);
    const flags = needUtf8 ? 0x0800 : 0;
    let method = 8, data = f.data, comp = zlib.deflateRawSync(f.data, { level: 9 });
    if (comp.length >= data.length) { method = 0; comp = data; } // 压不进去就 store
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([].concat(chunks, [cdBuf, eocd]));
}

// ---- 镜像测试（复刻插件 test-mirror：走与搜索完全相同的 mirrorUrlFor）----
const MIRROR_PROBE_RAW = 'https://raw.githubusercontent.com/pdone/lx-music-source/HEAD/README.md';
async function testMirror(mbase, ua) {
  const base = normMirrorBase(mbase);
  if (!base) return { ok: false, error: '缺少 mirror 参数' };
  const testUrl = mirrorUrlFor(base, MIRROR_PROBE_RAW);
  const t0 = Date.now();
  const r = await fetchText(testUrl, { ua: ua, timeout: 10000 });
  return { mirror: base, ok: !!r.ok, status: r.status || 0, ms: Date.now() - t0 };
}

// ---- 内置仓清单热更新（数据与代码分离，借鉴宿主「检查服务端更新」思路）----
// 清单文件随仓库发布；服务端运行时拉取比对版本号，有新版直接热应用（无需重启容器/更新镜像）。
// 拉取失败永远兜底到随镜像内置的 store.BUILTIN_REPOS，不空仓。
const BUILTIN_MANIFEST_URL = process.env.LXHUB_MANIFEST_URL || 'https://raw.githubusercontent.com/zlyon/lx-hub/main/builtin-repos.json';
function currentBuiltinRepos(db) {
  const m = db.builtinRepos;
  if (m && Array.isArray(m.repos) && m.repos.length) {
    return m.repos.filter(function (r) { return /^[\w.\-]+\/[\w.\-]+$/.test(r); });
  }
  return store.BUILTIN_REPOS;
}
function manifestInfo(db) {
  const m = db.builtinRepos;
  if (m && m.version) {
    return { version: m.version, updatedAt: m.updatedAt || '', fetchedAt: m.fetchedAt || 0, count: (m.repos || []).length, source: '远端清单 v' + m.version };
  }
  return { version: 0, updatedAt: '', fetchedAt: 0, count: store.BUILTIN_REPOS.length, source: '内置默认' };
}
async function checkBuiltinManifest(cfg, ua) {
  const db = store.getDb();
  const bustUrl = BUILTIN_MANIFEST_URL + '?nocache=' + Date.now(); // 击穿 raw CDN 缓存
  const r = await crawlFetch(bustUrl, { cfg: cfg, ua: ua, timeout: 10000 });
  if (!r.ok || !r.text) return { ok: false, error: '拉取失败: ' + (r.error || r.status) };
  let j;
  try { j = JSON.parse(r.text); } catch (e) { return { ok: false, error: '清单不是合法 JSON' }; }
  if (!j || !Array.isArray(j.repos) || !Number.isFinite(j.version)) return { ok: false, error: '清单格式无效' };
  const repos = j.repos.map(function (s) { return String(s && (s.repo || s) || '').trim(); })
    .filter(function (s) { return /^[\w.\-]+\/[\w.\-]+$/.test(s); });
  if (!repos.length) return { ok: false, error: '清单里没有有效仓库' };
  const cur = (db.builtinRepos && db.builtinRepos.version) || 0;
  const info = { latest: j.version, current: cur, count: repos.length };
  if (j.version <= cur) return Object.assign({ ok: true, applied: false, upToDate: true }, info);
  db.builtinRepos = {
    version: j.version, updatedAt: j.updatedAt || '', repos: repos.slice(0, 200),
    fetchedAt: Date.now(), source: BUILTIN_MANIFEST_URL
  };
  store.saveSoon();
  store.log('内置仓清单已热更新: v' + cur + ' → v' + j.version + '（' + repos.length + ' 个仓库）');
  return Object.assign({ ok: true, applied: true }, info);
}

// ---- 社区精选（lx-hunter-market 订阅，与插件端同源同构）----
const MARKET_URL = 'https://raw.githubusercontent.com/zlyon/lx-hunter-market/main/data/community.json';
const MARKET_CACHE_MS = 30 * 60 * 1000;
let marketCache = null;
async function fetchMarketList(cfg, ua, force) {
  if (marketCache && !force && Date.now() - marketCache.at < MARKET_CACHE_MS) {
    return { ok: true, updatedAt: marketCache.data.updatedAt, items: marketCache.data.sources };
  }
  const bustUrl = force ? MARKET_URL + '?nocache=' + Date.now() : MARKET_URL;
  const r = await crawlFetch(bustUrl, { cfg: cfg, ua: ua, timeout: 10000 });
  if (!r.ok || !r.text) return { ok: false, error: '拉取失败: ' + (r.error || r.status) };
  let j;
  try { j = JSON.parse(r.text); } catch (e) { return { ok: false, error: '数据不是合法 JSON' }; }
  if (!j || !Array.isArray(j.sources)) return { ok: false, error: '数据格式无效' };
  marketCache = { at: Date.now(), data: j };
  return { ok: true, updatedAt: j.updatedAt, items: j.sources };
}

// ---- 通用灌入：把实测可用的音源脚本直推到各洛雪服务端变种（lib/pusher.js 适配器） ----
const pusher = require('./pusher');

async function pushAll(triggerUa, trigger, opts) {
  opts = opts || {};
  if (task.running) return { error: '已有任务进行中' };
  const db = store.getDb();
  const cfg = db.config;
  const allTargets = cfg.pushTargets || [];
  const wantIds = Array.isArray(opts.targets) ? opts.targets : null;
  const targets = allTargets.filter(function (t) {
    return t.enabled !== false && (!wantIds || wantIds.indexOf(t.id) >= 0) && pusher.adapterFor(t.type);
  });
  if (!targets.length) return { error: '没有可用的灌入目标（先在灌入页添加并启用）' };
  // 条目集：默认 = 全部实测可用且有脚本缓存（排除存疑 / 示例源）；可指定 entryIds
  const wantEntries = Array.isArray(opts.entryIds) ? opts.entryIds : null;
  const list = db.entries.filter(function (e) {
    // kindOf 对齐 server.js：深检过的按实测，未深检的按文本识别兜底
    const st = e.scriptType || (e.isSource ? 'source' : 'unknown');
    return (!wantEntries || wantEntries.indexOf(e.id) >= 0) &&
      e.status === 'ok' && e.body && st !== 'unknown' && !e.sample;
  });
  if (!list.length) return { error: '没有可灌入的音源（需要实测可用且已缓存脚本）' };

  taskReset('push', list.length * targets.length, trigger);
  try {
    store.log('灌入任务启动: ' + targets.length + ' 个目标 × ' + list.length + ' 个音源');
    let okCount = 0, skipCount = 0, failCount = 0, replacedCount = 0;
    for (const t of targets) {
      if (task.cancel) break;
      const ad = pusher.adapterFor(t.type);
      const tName = t.name || ad.label;
      const pushedMap = t.pushedMap = t.pushedMap || {};
      let tOk = 0, tSkip = 0, tFail = 0;
      taskLog('→ 目标 [' + tName + ']（' + ad.label + '）开始灌入');
      for (const e of list) {
        if (task.cancel) break;
        task.phase = '灌入 → ' + tName;
        task.msg = e.name || e.id;
        const sha = e.bodySha || (e.bodySha = sha256hex(e.body));
        if (pushedMap[e.id] === sha) {
          tSkip++; skipCount++; task.done++;
          taskLog('  = 跳过（已灌入同版本）: ' + (e.name || e.id));
          continue;
        }
        const script = { name: String(e.name || e.id).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.js', content: e.body };
        let r;
        try {
          r = await ad.push(t, script);
        } catch (err) {
          r = { ok: false, error: pusher.errText(err) };
        }
        if (r.ok) {
          pushedMap[e.id] = sha;
          tOk++; okCount++;
          if (r.replaced) { replacedCount++; taskLog('  ✓ 已覆盖灌入: ' + (e.name || e.id)); }
          else taskLog('  ✓ 已灌入: ' + (e.name || e.id));
        } else {
          tFail++; failCount++;
          taskLog('  ✘ 灌入失败 ' + (e.name || e.id) + ': ' + (r.error || '未知'));
        }
        task.done++;
      }
      taskLog('← 目标 [' + tName + '] 完成: 成功 ' + tOk + ' · 跳过 ' + tSkip + ' · 失败 ' + tFail);
    }
    task.stats = '成功 ' + okCount + ' · 跳过 ' + skipCount + ' · 失败 ' + failCount + (task.cancel ? ' · 已取消' : '');
    store.log('灌入任务结束: ' + task.stats);
    taskFinish({ ok: true, cancelled: task.cancel });
    store.saveSoon();
    return { ok: true };
  } catch (e) {
    taskFinish({ error: String((e && e.message) || e) });
    store.log('灌入任务异常: ' + String((e && e.message) || e));
    return { error: String((e && e.message) || e) };
  }
}

module.exports = {
  DEFAULT_UA, task, sha1, sha256: sha256hex,
  MIRROR_PRESETS, normMirrorBase, mirrorUrlFor, jsdelivrUrlFor, buildCandidates, crawlFetch, testMirror,
  fetchText, accelRewrite, detectPlatforms, isSourceScript, isObfuscated, extractMeta, extractLinks, extractBackends, detectConfidence,
  crawlAll, checkAll, buildZip, crc32,
  BUILTIN_MANIFEST_URL, currentBuiltinRepos, manifestInfo, checkBuiltinManifest,
  MARKET_URL, fetchMarketList,
  pusher, pushAll
};
