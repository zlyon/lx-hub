'use strict'
// ---- 通用灌入：把 lx-hub 收录的音源脚本直推到各洛雪服务端变种 ----
// 策略：一律直推脚本内容（服务端无需访问外网），适配器均按各项目源码逐一核实（2026-10-18）：
//   lxserver   XCQ0607/lxserver（gefl24/lxserver 同协议魔改）
//              POST /api/custom-source/upload {filename, content, username?}   鉴权 x-frontend-auth
//              重名报「已存在」→ 按 id（确定性生成 = 名称.js）删除后重传（覆盖语义）
//   hollymusic redcatH/HollyMusic
//              POST /api/admin/sources/upload (multipart: file)                鉴权 登录 Cookie（POST /api/auth/login）
//   ro         leizi914599611-boop/ro
//              POST /api/v1/sources/import/content {name, content}             鉴权 x-api-key
//   （知音插件灌入在 lx-hunter 插件端实现，Docker 版不做——2026-10-19 用户定）

const UA = 'lx-hub/1.0 (universal-source-pusher)'

function trimBase(base) {
  return String(base || '').trim().replace(/\/+$/, '')
}

function baseHeaders(t, extra) {
  const h = Object.assign({ 'User-Agent': UA }, extra || {})
  if (t.type === 'lxserver') {
    if (t.token) h['x-frontend-auth'] = String(t.token)
  } else if (t.type === 'ro') {
    if (t.token) h['x-api-key'] = String(t.token)
  }
  return h
}

async function fetchTimeout(url, opts, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(function () { ac.abort(); }, timeoutMs || 10000)
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ac.signal }))
  } finally {
    clearTimeout(timer)
  }
}

async function readJson(res) {
  try { return await res.json(); } catch (e) { return null; }
}

// ---- 撤回：名字匹配工具（.js 后缀两种形态 + 小写归一） ----
function nameMatchSet(names) {
  const set = new Set()
  for (const n of names || []) {
    const s = String(n || '').trim().toLowerCase()
    if (!s) continue
    set.add(s)
    set.add(s.replace(/\.js$/i, ''))
    set.add(s.replace(/\.js$/i, '') + '.js')
  }
  return set
}
function pickTargets(sources, set) {
  // sources: [{id, name, filename?}...]；返回命中的原元素
  const hits = []
  for (const s of sources || []) {
    const candidates = [s.name, s.id, s.filename].map(function (x) { return String(x || '').trim().toLowerCase() })
    if (candidates.some(function (c) { return c && (set.has(c) || set.has(c.replace(/\.js$/i, ''))) })) hits.push(s)
  }
  return hits
}

function errText(e) {
  return String((e && e.message) || e || 'unknown').slice(0, 160)
}

// ---- HollyMusic：登录换签名 Cookie（holly_user + holly_sig） ----
async function hollyCookie(t) {
  const res = await fetchTimeout(trimBase(t.baseUrl) + '/api/auth/login', {
    method: 'POST',
    headers: baseHeaders(t, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ username: t.username || 'admin', password: t.token || '' })
  }, 10000)
  const j = await readJson(res)
  if (!res.ok || (j && j.success === false)) {
    throw new Error('登录失败 ' + (j && j.error && j.error.message ? j.error.message : 'HTTP ' + res.status))
  }
  const setCookies = (res.headers.getSetCookie && res.headers.getSetCookie()) || []
  const cookie = setCookies.map(function (c) { return c.split(';')[0]; }).join('; ')
  if (!cookie) throw new Error('登录成功但未返回会话 Cookie')
  return cookie
}

// ---- 适配器 ----
const ADAPTERS = {
  lxserver: {
    label: 'LX Server（XCQ0607 / gefl24）',
    hint: '凭据=后台管理密码（ADMIN_PASSWORD）；用户名留空灌入公共源',
    async test(t) {
      const res = await fetchTimeout(trimBase(t.baseUrl) + '/api/custom-source/list', {
        method: 'GET', headers: baseHeaders(t)
      }, 8000)
      if (res.status === 401 || res.status === 403) return { ok: false, error: '鉴权失败（检查管理密码）' }
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status }
      return { ok: true, info: '连接成功（自定义源 API 可用）' }
    },
    async push(t, script) {
      const url = trimBase(t.baseUrl) + '/api/custom-source/upload'
      const body = { filename: script.name, content: script.content }
      if (t.username) body.username = String(t.username)
      const res = await fetchTimeout(url, {
        method: 'POST',
        headers: baseHeaders(t, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
      }, 20000)
      const j = await readJson(res)
      if (res.ok && j && j.success !== false) return { ok: true, id: j.id, name: j.name || j.filename }
      const msg = String((j && (j.error || j.message)) || ('HTTP ' + res.status))
      // 重名（确定性 id = 名称.js）：删除后重传 = 覆盖
      if (/已存在/.test(msg)) {
        const sourceId = script.name
        const del = await fetchTimeout(trimBase(t.baseUrl) + '/api/custom-source/delete', {
          method: 'POST',
          headers: baseHeaders(t, { 'Content-Type': 'application/json' }),
          body: JSON.stringify(Object.assign({ id: sourceId, sourceId: sourceId }, t.username ? { username: String(t.username) } : {}))
        }, 10000)
        if (del.ok) {
          const retry = await fetchTimeout(url, {
            method: 'POST',
            headers: baseHeaders(t, { 'Content-Type': 'application/json' }),
            body: JSON.stringify(body)
          }, 20000)
          const rj = await readJson(retry)
          if (retry.ok && rj && rj.success !== false) return { ok: true, id: rj.id, name: rj.name || rj.filename, replaced: true }
          return { ok: false, error: '覆盖重传失败: ' + String((rj && (rj.error || rj.message)) || ('HTTP ' + retry.status)).slice(0, 120) }
        }
        return { ok: false, error: '目标已存在同名源且删除失败: ' + msg.slice(0, 120) }
      }
      return { ok: false, error: msg.slice(0, 160) }
    },
    async revokeAll(t, names) {
      const set = nameMatchSet(names)
      const lr = await fetchTimeout(trimBase(t.baseUrl) + '/api/custom-source/list', { method: 'GET', headers: baseHeaders(t) }, 15000)
      const lj = await readJson(lr)
      if (!lr.ok) return { ok: false, error: '获取列表失败: HTTP ' + lr.status }
      const arr = Array.isArray(lj) ? lj : ((lj && (lj.sources || lj.data)) || [])
      const hits = pickTargets(arr, set)
      const removed = []
      for (const s of hits) {
        const del = await fetchTimeout(trimBase(t.baseUrl) + '/api/custom-source/delete', {
          method: 'POST',
          headers: baseHeaders(t, { 'Content-Type': 'application/json' }),
          body: JSON.stringify(Object.assign({ id: s.id, sourceId: s.id }, t.username ? { username: String(t.username) } : {}))
        }, 10000)
        if (del.ok) removed.push(s.name || s.id)
      }
      return { ok: true, removed, failed: hits.length - removed.length }
    }
  },

  hollymusic: {
    label: 'HollyMusic',
    hint: '凭据=管理员密码；用户名默认 admin',
    async test(t) {
      try {
        await hollyCookie(t)
        return { ok: true, info: '登录成功' }
      } catch (e) {
        return { ok: false, error: errText(e) }
      }
    },
    async push(t, script) {
      let cookie
      try {
        cookie = await hollyCookie(t)
      } catch (e) {
        return { ok: false, error: errText(e) }
      }
      const fd = new FormData()
      fd.append('file', new Blob([script.content], { type: 'text/javascript' }), script.name)
      const res = await fetchTimeout(trimBase(t.baseUrl) + '/api/admin/sources/upload', {
        method: 'POST',
        headers: baseHeaders(t, { 'Cookie': cookie }),
        body: fd
      }, 20000)
      const j = await readJson(res)
      if (res.ok && j && j.success !== false) return { ok: true, name: j.data && (j.data.name || j.data.id) }
      return { ok: false, error: String((j && j.error && j.error.message) || ('HTTP ' + res.status)).slice(0, 160) }
    }
  },

  ro: {
    label: 'Ro（无头下载服务端）',
    hint: '凭据=API Key（config.yaml auth.apiKey 或环境变量 RO_AUTH_APIKEY）',
    async test(t) {
      const res = await fetchTimeout(trimBase(t.baseUrl) + '/api/v1/sources', {
        method: 'GET', headers: baseHeaders(t)
      }, 8000)
      if (res.status === 401 || res.status === 403) return { ok: false, error: '鉴权失败（检查 API Key）' }
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status }
      return { ok: true, info: '连接成功（音源 API 可用）' }
    },
    async push(t, script) {
      const res = await fetchTimeout(trimBase(t.baseUrl) + '/api/v1/sources/import/content', {
        method: 'POST',
        headers: baseHeaders(t, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: script.name.replace(/\.js$/, ''), content: script.content })
      }, 20000)
      const j = await readJson(res)
      if (res.ok && (!j || j.success !== false)) return { ok: true, name: script.name }
      return { ok: false, error: String((j && (j.error || j.message)) || ('HTTP ' + res.status)).slice(0, 160) }
    }
  }
}

const PUSH_TYPES = Object.keys(ADAPTERS)

function adapterFor(type) {
  return ADAPTERS[type] || null
}

module.exports = { ADAPTERS, PUSH_TYPES, adapterFor, trimBase, errText, UA }
