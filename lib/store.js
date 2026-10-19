'use strict';
// lx-hub 数据存储：单 JSON 文件持久化（量级 ~几百条，足够），原子写入
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// 内置仓库兜底清单（与插件「音源猎手」DEFAULT_REPOS 同一套精选，两端口径一致）。
// 运行时以远端清单 builtin-repos.json 为准（热更新），拉不到时才用这份兜底。
const BUILTIN_REPOS = [
  'guoyue2010/lxmusic-',
  'LXJ-George666/LXMusic-Yinyuan',
  'Macrohard0001/lx-ikun-music-sources',
  'NeoDtime/lxmusic-source3',
  'haonanren118/jiexiang-Music-Source',
  'pronii/lx-music-qdy-mini',
  'wzh15802/lxmusic',
  'ShaneLee-9/lx-music-source-merge',
  'kayee0212/lx-music-yinyuan',
  'luanmuc/lx-music-source',
  'Lingeng27/lx-music-1010-source',
  'shiliu6924/lx-music-source',
  'fengs2021/lx-music-merged-source'
];

const DEFAULTS = {
  config: {
    proxy: '',          // 搜索代理 http://host:port（仅 GitHub 搜索链路）
    ghMirror: 'https://proxy.vvvv.ee', // raw 加速镜像（前缀式，新装默认；老配置已有值不受影响）
    forceProxy: false,  // 强制代理：代理权重提前
    useJsdelivr: false, // jsDelivr 加速兜底
    ghToken: '',        // 可选，GitHub Token
    autoCheck: true,    // 搜索后自动可用性检测
    batchSize: 60,      // 检测分批展示粒度
    fastMode: false,    // 极速模式（缩短超时）
    debug: false,       // 调试模式（详细日志 + 落盘 data/logs/日期.log）
    // ---- 定时任务（默认全关，不碰老配置）----
    schedEnabled: false,
    schedFreq: 'daily',     // daily | nday | nhour | weekly | monthly
    schedInterval: 1,       // nday/nhour 的 N
    schedWeekday: 1,        // weekly：0=周日…6=周六
    schedMonthDay: 1,       // monthly：1-28
    schedHour: 3,
    schedMinute: 0,
    schedLogKeep: 10,       // 运行日志保留份数（3/7/10/30）
    accelPrefix: '',    // 兼容旧字段（迁移到 ghMirror 后不再使用）
    repos: [],          // 自定义仓库 owner/repo
    blockedRepos: [],   // 被屏蔽的内置仓库（扫描时跳过，已收录条目不受影响）
    seeds: [],          // 手动导入的直链
    pushTargets: []     // 灌入目标 [{id,name,type,baseUrl,token,username,enabled,pushedMap:{entryId:sha}}]
  },
  repoErrors: {},     // repo -> 上次扫描失败原因（成功后清除，供收录来源页「爬取失败」提示）
  entries: [],
  logs: [],
  sched: {},          // 定时任务运行状态 { nextRun, lastRun, lastResult, lastKind }
  schedLogs: [],      // 定时任务运行日志，新的在前：{ id, at, startedAt, trigger, status, text }
  lastCrawlAt: null,
  lastCheckAt: null,
  secret: ''
};

let db = null;
let saveTimer = null;

function load() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { raw = null; }
  db = Object.assign({}, DEFAULTS, raw || {});
  db.config = Object.assign({}, DEFAULTS.config, (raw && raw.config) || {});
  // 迁移：老配置 accelPrefix → ghMirror（同一含义：raw 加速镜像前缀）
  if (db.config.accelPrefix && !db.config.ghMirror) db.config.ghMirror = db.config.accelPrefix;
  if (!Array.isArray(db.entries)) db.entries = [];
  if (!Array.isArray(db.logs)) db.logs = [];
  // 迁移：给缺 seq 的老条目按发现时间补号
  const missing = db.entries.filter(function (e) { return !e.seq; })
    .sort(function (a, b) { return (a.firstSeenAt || 0) - (b.firstSeenAt || 0); });
  if (missing.length || !db.nextSeq) {
    let top = 0;
    for (const e of db.entries) if (e.seq > top) top = e.seq;
    for (const e of missing) e.seq = ++top;
    db.nextSeq = top;
    if (missing.length) saveNow();
  }
  if (!db.secret) {
    db.secret = crypto.randomBytes(24).toString('hex');
    saveNow();
  }
  return db;
}

function saveNow() {
  if (!db) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    try { saveNow(); } catch (e) { console.error('[store] save failed:', e.message); }
  }, 300);
}

function getDb() { return load(); }

// 日志捕获（复刻插件 logCapture 机制）：定时任务链运行期间捕获所有 log 行，
// 收尾时写入该次运行日志的 .text，供「下载」按钮导出完整过程
let capBuf = null;
function beginCapture() { capBuf = []; }
function endCapture() { const r = capBuf || []; capBuf = null; return r; }

function log(msg) {
  load();
  const line = { t: new Date().toISOString(), msg: String(msg).slice(0, 500) };
  db.logs.push(line);
  if (db.logs.length > 400) db.logs = db.logs.slice(-300);
  if (capBuf) capBuf.push(line);
  if (db.config.debug) appendDebugLog(line);
  saveSoon();
  return line;
}

// 调试模式：日志同步追加到 data/logs/YYYY-MM-DD.log（每天一个文件，按日期命名）
function appendDebugLog(line) {
  try {
    const dir = path.join(DATA_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date(line.t);
    const ymd = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    const hms = [('0' + d.getHours()).slice(-2), ('0' + d.getMinutes()).slice(-2), ('0' + d.getSeconds()).slice(-2)].join(':');
    const msg = String(line.msg);
    const body = msg.startsWith('[') ? msg : (' ' + msg); // 已带 [模块] 前缀的原样，否则补空格
    fs.appendFileSync(path.join(dir, ymd + '.log'), '[' + hms + ']' + body + '\n');
  } catch (e) { /* 落盘失败不影响运行 */ }
}

function maskSensitive(s) {
  return String(s == null ? '' : s)
    .replace(/ghp_[A-Za-z0-9_]{20,}/g, 'ghp_***')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***')
    .replace(/(token=|access_token=)[A-Za-z0-9._\-]{8,}/gi, '$1***');
}

module.exports = { DATA_DIR, DB_FILE, BUILTIN_REPOS, getDb, saveSoon, saveNow, log, beginCapture, endCapture, maskSensitive };
