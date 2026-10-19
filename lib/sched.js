'use strict';
// lx-hub 定时任务调度器：进程内 setInterval 轮询（30s 一拍）。
// Docker 容器是长驻进程，服务在跑调度就在跑；nextRun/lastRun/lastResult 持久化在 db.sched，
// 容器重启后自动按周期重新布防（错过的到点不补跑，推迟到下一个周期，与插件 onInit 布防行为一致）。
const store = require('./store');
const core = require('./core');

let timer = null;
let ticking = false;
const TICK_MS = 30 * 1000;
const BUSY_RETRY_MS = 10 * 60 * 1000; // 到点正忙：10 分钟后重试

const DAY = 24 * 3600 * 1000;
const SCHEDLOG_PAGE = 5;                 // 日志列表每页条数（与插件一致）
const KEEP_OPTS = [3, 7, 10, 30];

function cfg() { return store.getDb().config; }
function st() { const db = store.getDb(); if (!db.sched) db.sched = {}; return db.sched; }
function slogList() { const db = store.getDb(); if (!Array.isArray(db.schedLogs)) db.schedLogs = []; return db.schedLogs; }
function keepNum() { const k = Number(cfg().schedLogKeep); return KEEP_OPTS.indexOf(k) >= 0 ? k : 10; }

function pad2(n) { return ('0' + n).slice(-2); }
function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

// .log 文件内容：头部元信息 + 本次链路捕获的全部日志行（与插件 schedLogText 同构）
function schedLogText(entry, captured) {
  const lines = [
    '# lx-hub 定时任务运行日志',
    '# 触发方式: ' + (entry.trigger || ''),
    '# 开始时间: ' + fmtTs(entry.startedAt),
    '# 完成时间: ' + fmtTs(entry.at || Date.now()),
    '# 运行状态: ' + entry.status,
    '# ' + '----------------------------------------'
  ];
  for (let i = 0; i < captured.length; i++) {
    const t = new Date(captured[i].t);
    lines.push(pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds()) + ' ' + captured[i].msg);
  }
  return lines.join('\r\n') + '\r\n';
}

// 中断自愈（复刻插件 onInit 逻辑）：服务启动时发现上次链落的「运行中」占位没等到回填
// → 宿主在链运行期间退出/被杀，原地标记，不留悬案
function healInterrupted() {
  const list = slogList();
  if (list.length && list[0] && list[0].status === '运行中') {
    list[0].status = '中断（宿主重启/异常退出）';
    list[0].text = (list[0].text || '') +
      '# 注: 服务在链运行期间退出，本次运行未正常收尾，由下次启动时标记\r\n';
    store.saveNow();
    store.log('[定时任务] 上次运行未正常收尾（服务退出），已标记为中断');
  }
}

// 运行链（定时/手动共用）：链启动即落「运行中」占位并立刻持久化（进程中途被杀也留痕），
// 结束后原地回填这条记录（完成时间 + 状态 + 全部捕获日志行）
async function runChain(trigger) {
  const db = store.getDb();
  const entry = {
    id: Date.now() + '-' + Math.floor(Math.random() * 1e4),
    at: 0, // 完成时间；0 = 仍在运行或未正常收尾
    startedAt: Date.now(),
    trigger: trigger,
    status: '运行中',
    text: ''
  };
  entry.text = schedLogText(entry, []);
  const list = slogList();
  list.unshift(entry);
  const keep = keepNum();
  while (list.length > keep) list.pop();
  store.saveNow(); // 占位立刻落盘
  store.beginCapture();
  store.log('[' + trigger + '] 开始执行：搜索 + 可用性检测');
  try {
    await core.crawlAll(core.DEFAULT_UA, '定时');
    // crawlAll 在「自动检测」开启时内部已跑一轮 checkAll，这里只在关闭时补检，避免重复检测
    if (!cfg().autoCheck) await core.checkAll(core.DEFAULT_UA, '定时');
    entry.status = '完成';
  } catch (e) {
    entry.status = '异常终止';
    store.log('[定时任务] 执行异常: ' + (e && e.message ? e.message : String(e)));
  }
  entry.at = Date.now();
  entry.text = schedLogText(entry, store.endCapture());
  st().lastResult = entry.status === '完成'
    ? (core.task.stats || '完成') + ' · ' + (trigger === '手动' ? '手动触发' : describe(cfg()))
    : entry.status;
  store.log('[' + trigger + '] 执行结束：' + entry.status);
  store.saveNow();
}

async function tick() {
  if (ticking) return;
  const c = cfg();
  if (!c.schedEnabled) return;
  const s = st();
  ticking = true;
  try {
    const now = Date.now();
    if (!s.nextRun) { s.nextRun = computeNext(c); store.saveSoon(); return; }
    if (now < s.nextRun) return;
    if (core.task.running) {
      // 到点正忙（手动任务进行中）：10 分钟后重试
      s.nextRun = now + BUSY_RETRY_MS;
      store.log('[定时任务] 到点但有任务进行中，10 分钟后重试');
      store.saveSoon();
      return;
    }
    s.lastRun = now;
    s.lastKind = 'crawl+check';
    await runChain('定时');
  } finally {
    const s2 = st();
    s2.running = false;
    s2.nextRun = computeNext(cfg());
    store.saveSoon();
    ticking = false;
  }
}

// 计算下一次执行时间（基准 = max(现在, 上次执行)）
function atHm(base, h, m) {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function computeNext(c) {
  const base = Math.max(Date.now(), st().lastRun || 0);
  const h = Math.min(23, Math.max(0, Number(c.schedHour) || 0));
  const m = Math.min(59, Math.max(0, Number(c.schedMinute) || 0));
  const n = Math.max(1, Number(c.schedInterval) || 1);
  const freq = c.schedFreq || 'daily';

  if (freq === 'nhour') return base + n * 3600 * 1000;

  // daily / nday / weekly / monthly：先取「base 之后最近的一个 h:m 时刻」再按周期推
  let cand = atHm(base, h, m);
  if (cand <= base) cand = atHm(base + DAY, h, m);

  if (freq === 'daily') return cand;
  if (freq === 'nday') {
    let t = atHm(st().lastRun ? (st().lastRun + n * DAY) : cand, h, m);
    while (t <= Date.now()) t += n * DAY;
    return t;
  }
  if (freq === 'weekly') {
    const wd = Math.min(6, Math.max(0, Number(c.schedWeekday) || 0));
    let t = cand;
    for (let i = 0; i < 8; i++) { if (new Date(t).getDay() === wd && t > base) break; t = atHm(t + DAY, h, m); }
    return t;
  }
  if (freq === 'monthly') {
    const md = Math.min(28, Math.max(1, Number(c.schedMonthDay) || 1));
    for (let i = 0; i < 13; i++) {
      const d = new Date(base);
      d.setMonth(d.getMonth() + i);
      d.setDate(md);
      const t = atHm(d.getTime(), h, m);
      if (t > base) return t;
    }
    return cand;
  }
  return cand;
}

function describe(c) {
  const n = Math.max(1, Number(c.schedInterval) || 1);
  const hm = (Math.min(23, Math.max(0, Number(c.schedHour) || 0)) + ':' + ('0' + Math.min(59, Math.max(0, Number(c.schedMinute) || 0))).slice(-2));
  const map = {
    daily: '每天 ' + hm,
    nday: '每 ' + n + ' 天 ' + hm,
    nhour: '每 ' + n + ' 小时',
    weekly: '每周' + '日一二三四五六'[Math.min(6, Math.max(0, Number(c.schedWeekday) || 0))] + ' ' + hm,
    monthly: '每月 ' + Math.min(28, Math.max(1, Number(c.schedMonthDay) || 1)) + ' 日 ' + hm
  };
  return map[c.schedFreq || 'daily'] || map.daily;
}

function arm() {
  if (timer) clearInterval(timer);
  timer = setInterval(tick, TICK_MS);
  tick();
}

// 保存设置后重新布防：nextRun 按新周期重算
function rearm() {
  const c = cfg();
  const s = st();
  if (c.schedEnabled) {
    s.nextRun = computeNext(c);
    store.log('[定时任务] 设置已保存并重新布防，下次执行: ' + new Date(s.nextRun).toLocaleString());
  } else {
    s.nextRun = 0;
    store.log('[定时任务] 已停用');
  }
  store.saveSoon();
}

function runNow() {
  if (core.task.running) return { error: '已有任务进行中' };
  const s = st();
  s.lastRun = Date.now();
  s.lastKind = 'crawl+check';
  store.saveSoon();
  runChain('手动').catch(function () { /* runChain 内部已兜底 */ });
  return { ok: true, started: true };
}

// 运行日志分页查询（与插件 GET /api/schedlogs 同构）：列表只给摘要字段，全文走下载接口
function listSchedLogs(page) {
  const list = slogList();
  const pages = Math.max(1, Math.ceil(list.length / SCHEDLOG_PAGE));
  let p = Math.min(pages, Math.max(1, Number(page) || 1));
  const rows = [];
  for (let i = (p - 1) * SCHEDLOG_PAGE; i < list.length && i < p * SCHEDLOG_PAGE; i++) {
    const r = list[i];
    rows.push({ id: r.id, at: r.at, startedAt: r.startedAt, trigger: r.trigger, status: r.status });
  }
  return { total: list.length, page: p, pages: pages, pageSize: SCHEDLOG_PAGE, list: rows, keep: keepNum() };
}

function getSchedLogText(id) {
  const list = slogList();
  for (let i = 0; i < list.length; i++) {
    if (String(list[i].id) === String(id)) return list[i].text || '';
  }
  return null;
}

// 服务启动即自愈：上次「运行中」占位 → 标记中断
healInterrupted();

module.exports = { arm, rearm, runNow, describe, computeNext, listSchedLogs, getSchedLogText };
