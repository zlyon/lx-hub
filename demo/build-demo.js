'use strict';
// lx-hub 在线演示构建脚本（跑在 GitHub Actions 上，产出纯静态站点 demo/dist/）
// 流程：复用 lib/core.js 完整搜索链路（扫描内置仓库 → 识别聚合）→ 复用 lib/sandbox.js
//      沙箱逐平台实测取链 → 只保留「至少一个平台实测取到音频」的条目 → 生成
//      data.json + sources.zip + 单源下载文件。
// 页面方案：逐字复用真前端 public/{index.html,style.css,app.js}，仅注入 demo/shim.js
//      拦截 /api/* 用静态数据应答——样式与自部署版完全一致，更新/设置按钮自动去除
//      （scan 段剥除 + authed=false 时设置按钮不创建）。
// 注意：本脚本与 Docker 镜像无关（Dockerfile 只 COPY server.js/lib/public）。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(__dirname, 'dist');
// 数据目录隔离：绝不碰真实服务的数据（demo 用独立 .data），Actions 上为一次性临时数据
process.env.DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '.data');

const store = require(path.join(ROOT, 'lib', 'store'));
const core = require(path.join(ROOT, 'lib', 'core'));

const t0 = Date.now();
function log(msg) {
  const el = Math.round((Date.now() - t0) / 1000);
  console.log('[' + String(Math.floor(el / 60)).padStart(2, '0') + ':' + String(el % 60).padStart(2, '0') + '] ' + msg);
}

// 平台 key → 中文标签
const PLAT_LABEL = { wy: '网易云', tx: 'QQ', kw: '酷我', kg: '酷狗', mg: '咪咕' };

(async () => {
  // 冒烟测试支持：DEMO_REPO_LIMIT=N 只扫前 N 个内置仓库
  const repoLimit = Number(process.env.DEMO_REPO_LIMIT) || 0;
  if (repoLimit > 0 && store.BUILTIN_REPOS.length > repoLimit) {
    store.BUILTIN_REPOS.length = repoLimit;
    log('测试模式：只扫前 ' + repoLimit + ' 个仓库');
  }

  const db = store.getDb();
  // Actions 的 GITHUB_TOKEN 提升 GitHub API 限额（60→1000/小时）
  if (process.env.GITHUB_TOKEN) db.config.ghToken = process.env.GITHUB_TOKEN;
  db.config.autoCheck = false; // 搜索与检测分开控制，便于打日志

  // ---- 1. 搜索（扫描仓库 → 下载候选 → 识别 → 聚合去重） ----
  log('开始搜索公开音源…');
  const crawlRes = await core.crawlAll();
  if (crawlRes.error) throw new Error('搜索失败: ' + crawlRes.error);
  log('搜索完成：总条目 ' + db.entries.length + '，新增 ' + (crawlRes.created || 0));

  // ---- 2. 可用性检测（含沙箱深检：逐平台真实取链验证音频） ----
  log('开始可用性检测（沙箱实测）…');
  const checkRes = await core.checkAll();
  if (checkRes.error) throw new Error('检测失败: ' + checkRes.error);
  log('检测完成：可用 ' + checkRes.okCount + '，存疑 ' + checkRes.suspectCount +
    '，后端挂 ' + checkRes.downCount + '，失效 ' + checkRes.deadCount);

  // ---- 3. 收集可用条目（统一规则：至少一个平台沙箱实测取到音频） ----
  const usable = db.entries
    .filter(e => e.status === 'ok' && (e.platforms || []).length > 0 && e.body)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0)); // 与真后端收录顺序一致

  // 同名不同内容 → 文件名加 (n)（ZIP 内唯一）
  const usedNames = new Map();
  const zipFiles = usable.map(e => {
    let base = String(e.name || '未命名').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 60) || '未命名';
    const n = (usedNames.get(base) || 0) + 1;
    usedNames.set(base, n);
    const fname = n === 1 ? base + '.js' : base + ' (' + n + ').js';
    return { name: fname, data: Buffer.from(e.body, 'utf8') };
  });

  // ---- 4. 产出 demo/dist/ ----
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  fs.mkdirSync(path.join(DIST, 's'), { recursive: true });

  // 4a. 全部可用脚本打包（ZIP 零依赖构建，与 /api/export 同源）
  fs.writeFileSync(path.join(DIST, 'sources.zip'), core.buildZip(zipFiles));
  log('打包 sources.zip：' + zipFiles.length + ' 个脚本，' + Math.round(fs.statSync(path.join(DIST, 'sources.zip')).size / 1024) + ' KB');

  // 4b. 单源下载文件 s/<id>.js（shim 把 /api/source/download 映射到这里）
  for (const e of usable) fs.writeFileSync(path.join(DIST, 's', e.id + '.js'), e.body, 'utf8');

  // 4c. data.json：items 字段口径与真后端 entryPublic + detail 完全一致
  const platCount = {};
  for (const e of usable) for (const p of (e.platforms || [])) {
    const key = Object.keys(PLAT_LABEL).find(k => PLAT_LABEL[k] === p) || p;
    platCount[key] = (platCount[key] || 0) + 1;
  }
  const items = usable.map(e => ({
    id: e.id, seq: e.seq || 0, name: e.name || '(未命名)', author: e.author || '',
    version: e.version || '', platforms: e.platforms || [], status: 'ok',
    scriptType: e.scriptType || 'source', platStatus: e.platStatus || null,
    isSource: true, confidence: e.confidence || 'high',
    mirrorCount: (e.mirrors || []).length, variantCount: (e.variants || []).length,
    mirrors: e.mirrors || [], variants: e.variants || [],
    repoPushAt: e.repoPushAt || 0, contentUpdatedAt: e.contentUpdatedAt || e.updatedAt,
    backendAlive: e.backendAlive != null ? e.backendAlive : -1,
    backendDomains: e.backendDomains || [], httpStatus: e.httpStatus || 0,
    updatedAt: e.updatedAt, lastOkAt: e.lastOkAt, hasBody: true,
    url: e.primaryUrl, origin: e.origin || '', originRepo: e.originRepo || '',
    size: e.bodySize || 0, sha256: core.sha256(e.body),
    firstSeenAt: e.firstSeenAt, lastCheckAt: e.lastCheckAt,
    bodyHead: (e.body || '').slice(0, 4000)
  }));
  const data = {
    generatedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - t0) / 1000),
    scannedRepos: store.BUILTIN_REPOS.length,
    totalEntries: db.entries.length,
    usableCount: usable.length,
    platformStats: platCount,
    items: items
  };
  fs.writeFileSync(path.join(DIST, 'data.json'), JSON.stringify(data, null, 1));
  log('生成 data.json：可用 ' + usable.length + ' / 总条目 ' + db.entries.length);

  // 4d. 真前端三件套：style.css / app.js 逐字复制；index.html 做演示适配
  fs.copyFileSync(path.join(ROOT, 'public', 'style.css'), path.join(DIST, 'style.css'));
  fs.copyFileSync(path.join(ROOT, 'public', 'app.js'), path.join(DIST, 'app.js'));

  let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  html = html.replace(/<!--scan-->[\s\S]*?<!--\/scan-->/g, ''); // 剥除「更新」扫描按钮段（与外网部署同一手段）
  // Pages 项目站挂在 /lx-hub/ 子路径下，资源必须用相对路径（绝对 /style.css 会 404 丢样式）
  html = html.split('href="/style.css"').join('href="style.css"');
  html = html.split('src="/app.js"').join('src="app.js"');
  html = html.replace('<title>LX 音源</title>', '<title>LX 音源 · 在线演示</title>');
  html = html.replace('<h1>LX 音源</h1>', '<h1>LX 音源 · 在线演示</h1>');
  html = html.replace(
    '<div class="sub">聚合公开渠道发布的洛雪自定义音源链接 · 只索引可达性与元数据，不提供任何音乐内容</div>',
    '<div class="sub">在线演示 · 由 <a href="https://github.com/zlyon/lx-hub/actions" target="_blank" rel="noopener">GitHub Actions</a> 每日自动搜索公开音源并沙箱实测，只有实测取到音频的脚本才会出现 · 数据非实时 · 完整功能请<a href="https://github.com/zlyon/lx-hub#readme" target="_blank" rel="noopener">自部署 lx-hub</a></div>');
  html = html.replace(
    '暂无数据。点击右上角「立即搜索」开始收集，或在后台配置里添加仓库与种子链接。',
    '本次实测暂无可用音源，等待下一轮自动更新。');
  html = html.replace('<footer>\n', '<footer>\n    🌐 本页为 lx-hub 在线演示（数据每日自动实测更新）· <a href="https://github.com/zlyon/lx-hub" target="_blank" rel="noopener">GitHub 仓库</a><br>\n');
  html = html.replace('<script src="app.js"></script>',
    '<script src="demo-shim.js"></script>\n<script src="app.js"></script>');
  if (html.indexOf('demo-shim.js') < 0 || html.indexOf('<!--scan-->') >= 0 ||
      /href="\//.test(html) || /src="\//.test(html)) {
    throw new Error('index.html 演示适配失败（shim 注入、scan 剥除或绝对路径残留未通过检查）');
  }
  fs.writeFileSync(path.join(DIST, 'index.html'), html);

  // 4e. shim（拦截 /api/* → 静态数据应答）
  fs.copyFileSync(path.join(__dirname, 'shim.js'), path.join(DIST, 'demo-shim.js'));

  console.log('构建完成，耗时 ' + Math.round((Date.now() - t0) / 1000) + 's，产物在 ' + DIST);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
