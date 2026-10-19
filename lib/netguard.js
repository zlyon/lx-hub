'use strict';
// 出网防护（借鉴原版思路、自行实现）：沙箱里跑的是来路不明的音源脚本，
// 必须防止「脚本让服务器请求内网/云元数据」的 SSRF。
// 关键点：redirect 必须手动跟随——fetch 自动跟随不会对 302 的目标重新校验，
// 「公网入口 → 302 内网」是最常见的绕过手法。
const dns = require('dns').promises;

// 私网/保留段（v4）：127/8、10/8、0/8、192.168/16、172.16-31、169.254 链路本地、100.64/10 CGNAT
function isPrivateIp(host) {
  const h = String(host || '').toLowerCase();
  // IPv6：环回 / 未指定 / 唯一本地 fc00::/7 / 链路本地 fe80::/10
  if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  // IPv4 或 IPv4-mapped
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = [m[1], m[2], m[3], m[4]].map(Number);
  if (a.some(function (n) { return n > 255; })) return true; // 非法段按私网处理（拒绝）
  if (a[0] === 127 || a[0] === 10 || a[0] === 0 || a[0] === 100) return true;
  if (a[0] === 192 && a[1] === 168) return true;
  if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
  if (a[0] === 169 && a[1] === 254) return true;
  return false;
}

// 域名 → 全部解析结果都必须是公网 IP（一个私网即拒绝）
const resolveCache = new Map();
async function assertPublicHost(hostname, cache) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) throw new Error('空主机名');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('内网主机名，已拦截: ' + host);
  }
  if (isPrivateIp(host)) throw new Error('私网/保留地址，已拦截: ' + host);
  // 纯数字 IP 已在上面拦完；以下是域名，需要 DNS 解析后复查（防域名指向内网 IP）
  const c = cache || resolveCache;
  if (c.has(host)) {
    const v = c.get(host);
    if (v.private) throw new Error('域名解析到私网地址，已拦截: ' + host);
    return;
  }
  let addrs = [];
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) {
    c.set(host, { private: true });
    throw new Error('DNS 解析失败，已拦截: ' + host);
  }
  let privateHit = false;
  for (const a of addrs) {
    let ip = a.address;
    if (/^::ffff:/.test(ip)) ip = ip.slice(7); // IPv4-mapped
    if (isPrivateIp(ip)) { privateHit = true; break; }
  }
  c.set(host, { private: privateHit });
  if (c.size > 2000) c.clear();
  if (privateHit) throw new Error('域名解析到私网地址，已拦截: ' + host);
}

// 沙箱安全 fetch：手动跟随重定向（最多 4 跳），每一跳目标都过 assertPublicHost。
// 返回与全局 fetch 相同形态的 Response（最后一跳）。
async function safeFetch(url, opts) {
  opts = opts || {};
  const cache = opts.hostCache || resolveCache;
  let cur = String(url);
  let res = null;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(cur);
    await assertPublicHost(u.hostname, cache);
    res = await fetch(cur, Object.assign({}, opts, { redirect: 'manual' }));
    if ([301, 302, 303, 307, 308].indexOf(res.status) >= 0) {
      const loc = res.headers.get('location');
      if (!loc) break;
      const next = new URL(loc, cur);
      // 消费掉响应体，释放连接
      try { await res.arrayBuffer(); } catch (e) { /* noop */ }
      cur = next.toString();
      continue;
    }
    break;
  }
  return res;
}

module.exports = { isPrivateIp, assertPublicHost, safeFetch };
