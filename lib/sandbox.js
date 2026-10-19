'use strict';
// lx-hub 沙箱深检（复刻插件「音源猎手」deepCheck 逻辑）：
// 用 Node 内置 vm 模块当沙箱，注入 lx API 垫片（照抄插件 BOOTSTRAP），把音源脚本
// 真正加载起来，再逐平台用测试歌曲真实取链、验证返回的音频 URL 真能播放。
// 平台标签只认这里测出的 usable —— 不是脚本声明什么就显示什么。
const vm = require('vm');
const nodeCrypto = require('crypto');
const nodeZlib = require('zlib');
const netguard = require('./netguard');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 lx-hub/0.1';
const PLATFORMS = ['wy', 'tx', 'kw', 'kg', 'mg'];
const TEST_SONGS = {
  wy: [{ name: '海阔天空', info: { songmid: '347230' } }],
  tx: [{ name: '晴天', info: { songmid: '0039MnYb0qxYhV' } }],
  kw: [{ name: '晴天', info: { songmid: '838607' } }],
  kg: [{ name: '晴天', info: { hash: '30ece05c17d4e9ec8ba0ef9f96e7a07c' } }],
  mg: [{ name: '晴天', info: { copyrightId: '69984639', songmid: '69984639' } }]
};
const STEP_TIMEOUT = 8000;      // 单步（初始化/单次取链）超时
const DISPATCH_TIMEOUT = 8000;  // 脚本 handler 内部超时（垫片里）

// ---- lx API 垫片（与插件 BOOTSTRAP 同源；fetch/crypto/zlib/Buffer/__hostSend 由宿主注入） ----
const BOOTSTRAP = [
  "'use strict';",
  'var _eventHandlers = new Map();',
  'var _registeredSources = {};',
  'globalThis.lx = {',
  "  version: '2.0.0', env: 'desktop', platform: 'web',",
  '  currentScriptInfo: { name: "", description: "", version: "", author: "", homepage: "", rawScript: "" },',
  '  EVENT_NAMES: { request: "request", inited: "inited", updateAlert: "updateAlert" },',
  '  utils: {',
  '    buffer: {',
  '      from: function(d, e) { return Buffer.from(d, e); },',
  '      bufToString: function(b, f) { return (b !== null && typeof b === "object" && typeof b.toString === "function") ? b.toString(f || "utf8") : Buffer.from(b, "binary").toString(f || "utf8"); }',
  '    },',
  '    crypto: {',
  "      md5: function(s) { return crypto.md5(s || ''); },",
  '      aesEncrypt: function(b, m, k, iv) { return crypto.aesEncrypt(b, m, k, iv); },',
  '      rsaEncrypt: function(b, k) { return crypto.rsaEncrypt(b, k); },',
  '      randomBytes: function(n) { return crypto.randomBytes(n); }',
  '    },',
  '    zlib: {',
  '      inflate: function(b) { return zlib.inflate(b); },',
  '      deflate: function(b) { return zlib.deflate(b); }',
  '    }',
  '  },',
  '  request: function(url, options, callback) {',
  '    if (typeof options === "function") { callback = options; options = {}; }',
  '    options = options || {};',
  '    var method = (options.method || "GET").toUpperCase();',
  '    var headers = options.headers || {};',
  '    var bodyContent = options.body || null;',
  '    if (options.form) {',
  '      bodyContent = options.form;',
  '      if (typeof bodyContent === "object") {',
  '        var parts = [];',
  '        for (var k in bodyContent) parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(bodyContent[k]));',
  '        bodyContent = parts.join("&");',
  '        if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/x-www-form-urlencoded";',
  '      }',
  '    }',
  '    if (bodyContent !== null && typeof bodyContent === "object") {',
  '      bodyContent = JSON.stringify(bodyContent);',
  '      if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";',
  '    }',
  '    var aborted = false, called = false;',
  '    function safe(err, resp, body) {',
  '      if (aborted || called) return; called = true;',
  '      if (typeof callback === "function") { try { callback(err, resp, body); } catch (e) {} }',
  '    }',
  '    fetch(url, { method: method, headers: headers, body: bodyContent }).then(function(resp) {',
  '      if (aborted) return;',
  '      return resp.text().then(function(text) {',
  '        if (aborted) return;',
  '        var body = text; try { body = JSON.parse(text); } catch (_) {}',
  '        safe(null, { statusCode: resp.status, statusMessage: resp.statusText || "", headers: resp.headers || {}, body: body }, body);',
  '      });',
  '    }).catch(function(err) {',
  '      if (aborted) return;',
  '      safe(new Error((err && err.message) ? err.message : String(err)), null, null);',
  '    });',
  '    return function() { aborted = true; };',
  '  },',
  '  send: function(eventName, data) {',
  '    if (eventName === "inited" && data && data.sources) _registeredSources = data.sources;',
  '    if (typeof __hostSend === "function") { try { __hostSend(eventName, JSON.stringify(data)); } catch (e) {} }',
  '  },',
  '  on: function(eventName, handler) { _eventHandlers.set(eventName, handler); },',
  '  _dispatch: function(requestId, eventName, data) {',
  '    var handler = _eventHandlers.get(eventName);',
  '    if (typeof handler !== "function") {',
  '      if (typeof __hostSend === "function") __hostSend("dispatchError", JSON.stringify({ id: requestId, error: "No handler registered for event: " + eventName }));',
  '      return;',
  '    }',
  '    var settled = false;',
  '    function sendResult(v) { if (settled) return; settled = true; if (typeof __hostSend === "function") __hostSend("dispatchResult", JSON.stringify({ id: requestId, result: v })); }',
  '    function sendError(e) { if (settled) return; settled = true; if (typeof __hostSend === "function") __hostSend("dispatchError", JSON.stringify({ id: requestId, error: (e && e.message) ? e.message : String(e) })); }',
  '    try {',
  '      var result = handler(data);',
  '      if (result && typeof result.then === "function") {',
  '        var t = setTimeout(function() { sendError(new Error("dispatch timeout")); }, ' + DISPATCH_TIMEOUT + ');',
  '        result.then(function(v) { clearTimeout(t); sendResult(v); }, function(e) { clearTimeout(t); sendError(e); });',
  '      } else sendResult(result);',
  '    } catch (err) { sendError(err); }',
  '  },',
  '  _getSources: function() { return _registeredSources; }',
  '};',
  'globalThis.window = globalThis;',
  'globalThis.global = globalThis;'
].join('\n');

// ---- 宿主桥接：crypto / zlib（对齐 lx-music-desktop 语义） ----
const hostCrypto = {
  md5(s) {
    const data = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8');
    return nodeCrypto.createHash('md5').update(data).digest('hex');
  },
  aesEncrypt(data, mode, key, iv) {
    const k = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
    const i = (iv == null || /ecb/i.test(String(mode))) ? null : (Buffer.isBuffer(iv) ? iv : Buffer.from(String(iv), 'utf8'));
    const d = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const c = nodeCrypto.createCipheriv(String(mode).toLowerCase(), k, i);
    return Buffer.concat([c.update(d), c.final()]);
  },
  rsaEncrypt(data, key) {
    let pk = String(key).trim();
    if (pk.indexOf('-----BEGIN') < 0) pk = '-----BEGIN PUBLIC KEY-----\n' + pk.replace(/(.{64})/g, '$1\n').trim() + '\n-----END PUBLIC KEY-----';
    const d = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    return nodeCrypto.publicEncrypt({ key: pk, padding: nodeCrypto.constants.RSA_PKCS1_PADDING }, d);
  },
  randomBytes(n) { return nodeCrypto.randomBytes(n); }
};
const hostZlib = {
  inflate(b) { return nodeZlib.inflateSync(Buffer.isBuffer(b) ? b : Buffer.from(b)); },
  deflate(b) { return nodeZlib.deflateSync(Buffer.isBuffer(b) ? b : Buffer.from(b)); }
};

function timeoutWrap(ms, tag) {
  return new Promise(function (_, rej) { const t = setTimeout(function () { rej(new Error(tag + ' 超时(' + ms + 'ms)')); }, ms); if (t.unref) t.unref(); });
}

// 音频魔数 + content-type 校验（照抄插件 verifyUrl/looksAudio）
function looksAudio(headAscii, b0, b1) {
  if (headAscii.slice(0, 3) === 'ID3') return true;
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return true;
  const four = headAscii.slice(0, 4);
  if (four === 'fLaC' || four === 'OggS' || four === 'RIFF') return true;
  if (headAscii.slice(4, 8) === 'ftyp') return true;
  return false;
}

// ---- 音频规格解析（L2 无损核验用；只看头部，不下载全文件） ----
function asciiHead(bytes, n) {
  let s = '';
  for (let i = 0; i < Math.min(bytes.length, n); i++) s += String.fromCharCode(bytes[i]);
  return s;
}
// FLAC STREAMINFO（首个 metadata block，type=0）：采样率/声道/位深/总样本数
function parseFlacSpec(b) {
  if (asciiHead(b, 4) !== 'fLaC') return null;
  const spec = { container: 'flac' };
  if (b.length < 8 + 18) return spec;
  const type = b[4] & 0x7f;
  const o = 8; // STREAMINFO 起始绝对偏移（块头 4 字节之后）
  if (type === 0) {
    spec.sampleRate = (b[o + 10] << 12) | (b[o + 11] << 4) | (b[o + 12] >>> 4);
    spec.channels = ((b[o + 12] >>> 1) & 0x07) + 1;
    spec.bitDepth = (((b[o + 12] & 0x01) << 4) | (b[o + 13] >>> 4)) + 1;
    spec.totalSamples =
      (b[o + 13] & 0x0f) * 2 ** 28 + (b[o + 14] * 2 ** 20) + (b[o + 15] * 2 ** 12) +
      (b[o + 16] * 2 ** 4) + (b[o + 17] >>> 4);
  }
  return spec;
}
// MP3：跳过 ID3v2 后找帧头，读出真实 bitrate / 采样率
function parseMp3Spec(b) {
  let at = 0;
  if (asciiHead(b, 3) === 'ID3' && b.length > 10) {
    const sz = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    at = 10 + sz + ((b[5] & 0x10) !== 0 ? 10 : 0);
  }
  const limit = Math.min(b.length, at + 4096);
  const RATES_V1 = [44100, 48000, 32000], RATES_V2 = [22050, 24000, 16000];
  const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  while (at < limit - 4) {
    if (b[at] === 0xff && (b[at + 1] & 0xe0) === 0xe0) {
      const verBits = (b[at + 1] >>> 3) & 0x03;
      const v1 = verBits === 3;
      return {
        container: 'mp3',
        bitrate: (v1 ? BR_V1 : BR_V2)[(b[at + 2] >>> 4) & 0x0f] || 0,
        sampleRate: (v1 ? RATES_V1 : RATES_V2)[(b[at + 2] >>> 2) & 0x03] || 0
      };
    }
    at++;
  }
  return { container: 'mp3' };
}
function parseAudioSpec(bytes) {
  const b = bytes.subarray ? bytes.subarray(0, Math.min(bytes.length, 4096)) : bytes;
  const h4 = asciiHead(b, 4);
  if (h4 === 'fLaC') return parseFlacSpec(bytes);
  if (h4 === 'OggS') return { container: 'ogg' };
  if (h4 === 'RIFF') return { container: 'wav' };
  if (asciiHead(b.slice(4, 8), 4) === 'ftyp') return { container: 'mp4' };
  if (asciiHead(b, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return parseMp3Spec(bytes);
  return null;
}
// 无损真实性判定（收敛版：只核 flac24bit 声称）：
// matched=真无损（flac 且 24/32bit）；degraded=flac 但 16bit；mismatch=根本不是 flac（套壳）；
// unknown=规格拿不到（流式/头部非标），不做结论
function losslessVerdict(spec) {
  if (!spec) return 'unknown';
  if (spec.container === 'flac') {
    if (spec.bitDepth === 24 || spec.bitDepth === 32) return 'matched';
    if (spec.bitDepth === 16) return 'degraded';
    return 'unknown';
  }
  if (spec.container === 'mp3' || spec.container === 'mp4') return 'mismatch';
  return 'unknown';
}

async function verifyUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { return { ok: false, reason: '无效 URL' }; }
  const HOP = { headers: { 'Range': 'bytes=0-16383', 'User-Agent': UA }, signal: AbortSignal.timeout(6000), redirect: 'manual' };
  try {
    // 每一跳（含首跳）都过私网校验——防「公网入口 302 内网」绕过
    let cur = url;
    let res = null;
    for (let hop = 0; hop < 4; hop++) {
      const curUrl = new URL(cur);
      await netguard.assertPublicHost(curUrl.hostname);
      res = await fetch(cur, HOP);
      if ([301, 302, 303, 307, 308].indexOf(res.status) >= 0 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), cur);
        try { await res.arrayBuffer(); } catch (e) { /* 释放连接 */ }
        cur = next.toString();
        continue;
      }
      break;
    }
    const ct = res.headers.get('content-type') || '';
    if (/json|text\/html|text\/plain/i.test(ct)) return { ok: false, reason: '返回 ' + ct + '，非音频' };
    if (!res.ok && res.status !== 206) return { ok: false, reason: 'HTTP ' + res.status };
    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let ascii = '';
    for (let i = 0; i < Math.min(bytes.length, 16); i++) ascii += String.fromCharCode(bytes[i]);
    const audioOk = looksAudio(ascii, bytes[0], bytes[1]) || /audio|octet-stream/i.test(ct);
    if (!audioOk) return { ok: false, reason: '非音频内容 (' + (ct || '未知') + ')' };
    // 顺带解析音频规格（同一份 16KB 里就有，零额外请求）：total 长度从 Content-Range 取
    let total = 0;
    try {
      const m = (res.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
      if (m) total = parseInt(m[1], 10);
    } catch (e) { /* noop */ }
    let spec = null;
    try { spec = parseAudioSpec(bytes); } catch (e) { /* noop */ }
    if (spec) spec.bytes = total || bytes.length;
    return { ok: true, size: bytes.length, spec: spec };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 80) };
  }
}

// 沙箱内执行一段代码并等待某个事件（复刻 jsenv.executeWait 语义）
function runAndWait(ctx, code, waitEvent, ms) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error(waitEvent + ' 等待超时(' + ms + 'ms)')); }, ms);
    if (timer.unref) timer.unref();
    let r;
    try { r = vm.runInContext(code, ctx, { timeout: 3000, displayErrors: true }); }
    catch (e) { clearTimeout(timer); reject(new Error(String(e && e.message || e).slice(0, 200))); return; }
    function check() {
      const evs = ctx.__events;
      for (let i = 0; i < evs.length; i++) {
        if (evs[i].name === waitEvent) { clearTimeout(timer); resolve({ events: evs, ret: r }); return; }
      }
      setTimeout(check, 30);
    }
    check();
  });
}

// ---- 深检主流程：加载脚本 → 逐平台取链 → 验证音频 → L2 无损核验 ----
async function deepCheck(code) {
  const result = { checkedAt: Date.now(), loadable: false, loadError: null, inited: false, platforms: {}, updateAlert: null };
  const events = [];
  const hostCache = new Map(); // 本轮脚本全部请求共享 DNS 校验缓存
  const ctx = vm.createContext({
    Buffer: Buffer,
    crypto: hostCrypto,
    zlib: hostZlib,
    fetch: function (url, opts) {
      opts = opts || {};
      opts.headers = Object.assign({ 'User-Agent': UA }, opts.headers || {});
      opts.hostCache = hostCache;
      return netguard.safeFetch(url, opts); // 每跳私网校验 + 手动跟随重定向
    },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    console: { log: function () {}, warn: function () {}, error: function () {}, info: function () {} },
    __events: events,
    __hostSend: function (name, dataJson) { events.push({ name: name, data: dataJson }); }
  });
  try {
    // 1) 垫片 + scriptInfo
    vm.runInContext(BOOTSTRAP, ctx, { timeout: 3000 });
    const infoCode = 'globalThis.lx.currentScriptInfo = ' + JSON.stringify({
      name: '', description: '', version: '', author: '', homepage: '', rawScript: String(code).slice(0, 400000)
    }) + ';';
    vm.runInContext(infoCode, ctx, { timeout: 3000 });
    // 2) 脚本初始化：等待 lx.send('inited')
    await runAndWait(ctx, String(code), 'inited', STEP_TIMEOUT);
    result.loadable = true;
    result.inited = true;
    // 3) 逐平台测试（平台间并行，单平台内串行换歌）
    const jobs = PLATFORMS.map(function (src) {
      const songs = TEST_SONGS[src] || [];
      if (!songs.length) { result.platforms[src] = { status: 'skipped', message: '无测试歌曲' }; return Promise.resolve(); }
      return (async function () {
        const song = songs[0];
        const reqId = 'hq_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
        const payload = { source: src, action: 'musicUrl', info: { type: '128k', musicInfo: song.info } };
        const dispatchCode = 'lx._dispatch(' + JSON.stringify(reqId) + ', "request", ' + JSON.stringify(payload) + ');';
        try { vm.runInContext(dispatchCode, ctx, { timeout: 3000 }); }
        catch (e) { result.platforms[src] = { status: 'failed', message: String(e && e.message || e).slice(0, 80) }; return; }
        const deadline = Date.now() + STEP_TIMEOUT;
        while (Date.now() < deadline) {
          const ev = events.find(function (x) {
            if (x.name !== 'dispatchResult' && x.name !== 'dispatchError') return false;
            try { return JSON.parse(x.data).id === reqId; } catch (e) { return false; }
          });
          if (ev) {
            const data = JSON.parse(ev.data);
            if (ev.name === 'dispatchError') { result.platforms[src] = { status: 'failed', message: String(data.error || '脚本失败').slice(0, 80) }; return; }
            const ret = data.result;
            if (typeof ret === 'string' && ret.indexOf('http') === 0) {
              const v = await verifyUrl(ret);
              result.platforms[src] = v.ok
                ? { status: 'usable', message: '测试歌曲「' + song.name + '」返回真实音频' }
                : { status: 'failed', message: '链接不可播: ' + v.reason };
              return;
            }
            result.platforms[src] = { status: 'failed', message: ret == null || ret === '' ? '返回空链接' : '返回异常: ' + String(ret).slice(0, 60) };
            return;
          }
          await new Promise(function (r) { setTimeout(r, 60); }); // 保持事件循环存活（不能 unref，否则沙箱异步等待期进程直接退出）
        }
        result.platforms[src] = { status: 'failed', message: '响应超时' };
      })();
    });
    await Promise.all(jobs);
    // 4) L2 无损核验（收敛版）：仅对实测可用的平台，请求一次 flac24bit 核对真实性
    for (const src of PLATFORMS) {
      const pe = result.platforms[src];
      if (!pe || pe.status !== 'usable') continue;
      const song = (TEST_SONGS[src] || [])[0];
      if (!song) continue;
      const reqId = 'l2_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      const payload = { source: src, action: 'musicUrl', info: { type: 'flac24bit', musicInfo: song.info } };
      const dispatchCode = 'lx._dispatch(' + JSON.stringify(reqId) + ', "request", ' + JSON.stringify(payload) + ');';
      try { vm.runInContext(dispatchCode, ctx, { timeout: 3000 }); } catch (e) { continue; }
      const verdict = await (async function () {
        const deadline = Date.now() + STEP_TIMEOUT;
        while (Date.now() < deadline) {
          const ev = events.find(function (x) {
            if (x.name !== 'dispatchResult' && x.name !== 'dispatchError') return false;
            try { return JSON.parse(x.data).id === reqId; } catch (e) { return false; }
          });
          if (ev) {
            const data = JSON.parse(ev.data);
            if (ev.name === 'dispatchError') return { verdict: 'refused', reason: String(data.error || '脚本失败').slice(0, 60) };
            const ret = data.result;
            if (!(typeof ret === 'string' && ret.indexOf('http') === 0)) return { verdict: 'refused', reason: '未返回有效链接' };
            const v = await verifyUrl(ret);
            if (!v.ok) return { verdict: 'refused', reason: v.reason };
            return { verdict: losslessVerdict(v.spec), spec: v.spec || null };
          }
          await new Promise(function (r) { setTimeout(r, 60); });
        }
        return { verdict: 'refused', reason: '响应超时' };
      })();
      pe.lossless = verdict.verdict;
      if (verdict.reason) pe.losslessReason = verdict.reason;
      if (verdict.spec) {
        pe.losslessSpec = {
          container: verdict.spec.container || '', bitDepth: verdict.spec.bitDepth || 0,
          sampleRate: verdict.spec.sampleRate || 0, bytes: verdict.spec.bytes || 0
        };
      }
    }
    // 5) 更新提醒嗅探：脚本自行 send('updateAlert', …) 的原样带出（催更/引流提示）
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].name === 'updateAlert') {
        try { result.updateAlert = (JSON.parse(events[i].data) || '').toString().slice(0, 200); } catch (e) { result.updateAlert = String(events[i].data).slice(0, 200); }
        break;
      }
    }
    // 整体兜底：平台测试超过上限直接返回已得结果
  } catch (e) {
    result.loadError = String((e && e.message) || e).slice(0, 200);
  }
  return result;
}

function anyUsable(platforms) {
  for (const p in platforms) if (platforms[p] && platforms[p].status === 'usable') return true;
  return false;
}

// ---- 进程隔离版深检：子进程跑沙箱，崩溃/死循环只杀工人不死主服务 ----
const { spawn } = require('child_process');
const WORKER_TIMEOUT = 110 * 1000; // 含 L2 无损核验（每可用平台 +1 次取链），预算放宽

function deepCheckSafe(code) {
  return new Promise(function (resolve) {
    const fallback = { checkedAt: Date.now(), loadable: false, loadError: '深检进程异常', inited: false, platforms: {} };
    let child;
    try {
      child = spawn(process.execPath, [require('path').join(__dirname, 'sandbox-worker.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { resolve(fallback); return; }
    let out = '', done = false;
    const timer = setTimeout(function () {
      if (done) return; done = true;
      try { child.kill('SIGKILL'); } catch (e) {}
      resolve({ checkedAt: Date.now(), loadable: false, loadError: '深检超时(' + (WORKER_TIMEOUT / 1000) + 's)', inited: false, platforms: {} });
    }, WORKER_TIMEOUT);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (d) { out += d; });
    child.on('error', function () { if (!done) { done = true; clearTimeout(timer); resolve(fallback); } });
    child.on('close', function () {
      if (done) return; done = true; clearTimeout(timer);
      try {
        const r = JSON.parse(out);
        resolve(r && r.checkedAt ? r : fallback);
      } catch (e) { resolve(fallback); }
    });
    child.stdin.write(String(code));
    child.stdin.end();
  });
}

module.exports = { deepCheck, deepCheckSafe, anyUsable, PLATFORMS, TEST_SONGS, verifyUrl, parseAudioSpec, losslessVerdict };
