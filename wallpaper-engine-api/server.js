/**
 * WE API 只读代理服务
 * ====================
 * 为 dsh-wallpaper-bg 插件提供 Wallpaper Engine 壁纸库的只读 HTTP API。
 *
 * 端点（全部只读 GET，仅绑定 127.0.0.1）：
 *   GET /health、/            → 服务状态（含 webShim / desktopCapture 能力标记）
 *   GET /api/wallpapers       → 已安装壁纸列表（含 /wallpapers 等别名）
 *   GET /api/current          → 当前桌面壁纸（含 /current 等别名）
 *   GET /files/<id>/<rel>     → Web 类壁纸的目录文件（index.html 及其相对资源，
 *                               仅限已订阅壁纸目录内，供插件 iframe 原生渲染；
 *                               HTML 文档注入 WE 私有接口垫片，支持 ETag / Range）
 *   GET /capture?w=&q=        → 桌面壁纸实时捕获（JPEG，内存中生成，不落盘）
 *
 * 隔离原则：
 *   - 只调用 wallpaper-engine-api 的 listWallpapers() / wallpaper().current()，
 *     绝不触碰 load / stop / openProfile 等写入接口，桌面壁纸不受任何影响；
 *   - 调用 current() 前先用 tasklist 确认 WE 正在运行，未运行直接返回 null，
 *     避免 -control 命令意外拉起 Wallpaper Engine 主程序。
 *
 * 桌面壁纸同步（/capture）：
 *   不去解析 scene.pkg、不本地渲染、不烘焙视频、不产生任何缓存文件——Wallpaper
 *   Engine 已经在桌面上用自己的引擎（GPU）实时渲染当前壁纸（场景的粒子 / 着色器 /
 *   骨骼动画都在动），这里只对桌面壁纸层做一次 DWM 采样并就地编码 JPEG 返回：
 *   PrintWindow(Progman, PW_RENDERFULLCONTENT)（DWM 合成路径，含 WE 的
 *   WPEDesktopDX11Window 子窗口；新式独立 swapchain 下 GDI BitBlt 会拿到黑帧，
 *   PrintWindow 才可靠，失败时回退 BitBlt）
 *   → 主屏区域 StretchBlt 缩放 → GetDIBits → jpeg-js。全程内存内完成，
 *   黑帧由 X-Capture-Black 上报（客户端据此提示而不是默默黑屏）。
 *   实现见 lib/desktop-capture.js（需要 koffi / jpeg-js，随 npm install 安装）。
 *
 * 订阅过滤：列表按 Steam UGC 订阅清单（userdata/<id>/ugc/431960_subscriptions.vdf）
 * 过滤，已退订 / 本地禁用但文件夹仍残留的壁纸不会出现在列表里，与 WE 界面一致；
 * 清单读不到时退化为不过滤。可用环境变量 WE_SUBSCRIPTIONS_FILE 或
 * we-api.config 的 WE_SUBSCRIPTIONS_FILE 显式指定清单路径。
 *
 * 路径解析优先级：环境变量 > 同目录 we-api.config（由 启动服务.bat 首次运行
 * 向导写入）> 自动探测（注册表 SteamPath → 常见 Steam 安装位置）。
 *
 * 环境变量（可选）：
 *   WEAPI_PORT        端口，默认 8088（8080 被 Jenkins 占用）
 *   WE_INSTALL_PATH   WE 安装目录（含 wallpaper64.exe / wallpaper32.exe）
 *   WE_WORKSHOP_PATH  创意工坊壁纸库目录（...\steamapps\workshop\content\431960）
 */

'use strict'

const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFile } = require('child_process')
const { createReadStream } = fs
const { WallpaperEngineApi } = require('wallpaper-engine-api')
const { captureJpeg, probe: probeCapture } = require('./lib/desktop-capture.js')

const PORT = Number(process.env.WEAPI_PORT || 8088)
const HOST = '127.0.0.1'

// ---------------------------------------------------------------------------
// 路径解析：环境变量 > we-api.config > 自动探测
// ---------------------------------------------------------------------------

function readConfigFile() {
  try {
    const cfgPath = path.join(__dirname, 'we-api.config')
    const text = fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')
    const lines = {}
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      lines[line.slice(0, eq).trim().toUpperCase()] = line.slice(eq + 1).trim()
    }
    return lines
  } catch {
    return {}
  }
}

/** 候选 Steam 根目录：注册表 SteamPath 优先，其次常见安装位置 */
function candidateSteamRoots() {
  const roots = []
  try {
    const { execFileSync } = require('child_process')
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { windowsHide: true },
    ).toString()
    const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(out)
    if (m) roots.push(path.normalize(m[1].trim().replace(/^"|"$/g, '')))
  } catch {
    /* 注册表读不到就跳过 */
  }
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    roots.push(drive + ':\\Program Files (x86)\\Steam')
    roots.push(drive + ':\\Program Files\\Steam')
    roots.push(drive + ':\\Steam')
  }
  return roots
}

/** 自动探测 WE 安装目录（返回含 wallpaper64/32.exe 的目录，找不到返回 null） */
function detectWeInstallPath() {
  for (const root of candidateSteamRoots()) {
    const weDir = path.join(root, 'steamapps', 'common', 'wallpaper_engine')
    if (fs.existsSync(path.join(weDir, 'wallpaper64.exe')) ||
        fs.existsSync(path.join(weDir, 'wallpaper32.exe'))) {
      return weDir
    }
  }
  return null
}

/** 由安装目录推导创意工坊壁纸库目录（允许被单独覆盖） */
function deriveWorkshopPath(installPath) {
  const steamapps = path.join(installPath, '..', '..')
  return path.normalize(path.join(steamapps, 'workshop', 'content', '431960'))
}

const cfgFile = readConfigFile()

let WE_INSTALL_PATH =
  process.env.WE_INSTALL_PATH ||
  cfgFile.WE_INSTALL_PATH ||
  detectWeInstallPath()
if (!WE_INSTALL_PATH) {
  console.error('[WE-API] 未找到 Wallpaper Engine。请通过 启动服务.bat 填写安装目录，')
  console.error('[WE-API] 或设置环境变量 WE_INSTALL_PATH 指向含 wallpaper64.exe 的目录。')
  process.exit(1)
}

const WE_WORKSHOP_PATH =
  process.env.WE_WORKSHOP_PATH ||
  cfgFile.WE_WORKSHOP_PATH ||
  deriveWorkshopPath(WE_INSTALL_PATH)

// ---------------------------------------------------------------------------
// 初始化 wallpaper-engine-api（构造函数会校验 WE 可执行文件是否存在）
// ---------------------------------------------------------------------------

let we
try {
  we = new WallpaperEngineApi(WE_INSTALL_PATH, WE_WORKSHOP_PATH, false)
} catch (err) {
  console.error('[WE-API] Wallpaper Engine 初始化失败：' + (err && err.message ? err.message : err))
  console.error('[WE-API] 当前使用的安装目录：' + WE_INSTALL_PATH)
  console.error('[WE-API] 请双击 启动服务.bat 重新填写正确的安装目录，')
  console.error('[WE-API] 或用环境变量 WE_INSTALL_PATH / WE_WORKSHOP_PATH 覆盖。')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Steam 订阅过滤（与 WE 界面一致：退订 / 本地禁用的壁纸不再出现在列表里）
// ---------------------------------------------------------------------------

/**
 * 解析 Steam UGC 订阅清单（userdata/<id>/ugc/431960_subscriptions.vdf），
 * 返回仍然订阅且未被本地禁用的 publishedfileid 集合。
 * 背景：从 WE 退订壁纸后，Steam 会立刻把条目从订阅清单移除，但 workshop
 * content 目录下的文件夹删除可能被延迟（文件被占用等），wallpaper-engine-api
 * 只按文件夹列目录，就会把「已退订但文件夹还在」的壁纸列出来——与 WE 界面
 * 不一致。所以这里按真实订阅清单过滤。清单读不到时返回 null（不过滤）。
 */
function parseVisibleIds(text) {
  const visible = new Set()
  const entryRe = /"(\d+)"\s*\{([^}]*)\}/g
  let m
  while ((m = entryRe.exec(text))) {
    const body = m[2]
    const fid = /"publishedfileid"\s+"(\d+)"/.exec(body)
    if (!fid) continue
    const dis = /"disabled_locally"\s+"(\d+)"/.exec(body)
    if (dis && dis[1] === '1') continue
    visible.add(fid[1])
  }
  return visible
}

/** 定位订阅清单文件：显式配置优先，其次从 workshop 路径反推 Steam 根目录扫描 userdata */
function findSubscriptionsFiles() {
  const explicit = [process.env.WE_SUBSCRIPTIONS_FILE, cfgFile.WE_SUBSCRIPTIONS_FILE].filter(Boolean)
  for (const f of explicit) {
    if (fs.existsSync(f)) return [f]
  }
  const files = []
  try {
    const steamRoot = path.normalize(path.join(WE_WORKSHOP_PATH, '..', '..', '..', '..'))
    const userdataDir = path.join(steamRoot, 'userdata')
    if (fs.existsSync(userdataDir)) {
      for (const entry of fs.readdirSync(userdataDir)) {
        const p = path.join(userdataDir, entry, 'ugc', '431960_subscriptions.vdf')
        if (fs.existsSync(p)) files.push(p)
      }
    }
  } catch {
    /* 定位失败则退化为不过滤 */
  }
  return files
}

const VISIBLE_IDS_TTL_MS = 30 * 1000
let visibleIdsCache = { time: 0, ids: null, ready: false }
function loadVisibleIds() {
  if (visibleIdsCache.ready && Date.now() - visibleIdsCache.time < VISIBLE_IDS_TTL_MS) {
    return visibleIdsCache.ids
  }
  const files = findSubscriptionsFiles()
  let visible = null
  if (files.length) {
    const set = new Set()
    for (const f of files) {
      try {
        for (const id of parseVisibleIds(fs.readFileSync(f, 'utf8'))) set.add(id)
      } catch {
        /* 单份清单读不了就跳过 */
      }
    }
    visible = set.size ? set : null
  }
  visibleIdsCache = { time: Date.now(), ids: visible, ready: true }
  return visible
}

// ---------------------------------------------------------------------------
// 只读数据层
// ---------------------------------------------------------------------------

const LIST_TTL_MS = 60 * 1000
let listCache = { time: 0, items: null, hidden: 0 }

function readProjectJson(pjPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 把 wallpaper-engine-api 的列表条目补全为插件可消费的形态：
 *  - filepath：project.json 里 file 字段指向的真实媒体文件（视频/图片/pkg）
 *  - type：project.json 的 type 字段（统一小写）；缺失时按扩展名兜底
 *    （.pkg→scene、.html→web、视频扩展名→video、图片扩展名→image）
 *  - rating：project.json 的 contentrating（everyone/questionable/mature，
 *    缺失为空字符串）——供前端 18+ / 非18+ 筛选使用
 *  - thumbnail：预览图绝对路径
 */
function enrich(w) {
  if (!w || typeof w.path !== 'string') return null
  const pj = readProjectJson(w.path)
  const dir = path.dirname(w.path)
  let filepath = ''
  let type = ''
  if (pj) {
    if (typeof pj.type === 'string' && pj.type) type = pj.type.trim().toLowerCase()
    if (typeof pj.file === 'string' && pj.file) {
      const candidate = path.join(dir, pj.file)
      if (fs.existsSync(candidate)) filepath = candidate
    }
  }
  if (!type && filepath) {
    const ext = path.extname(filepath).toLowerCase()
    if (ext === '.pkg') type = 'scene'
    else if (ext === '.html' || ext === '.htm') type = 'web'
    else if (/\.(mp4|webm|mkv|avi|mov|m4v)$/i.test(ext)) type = 'video'
    else if (/\.(jpe?g|png|webp|gif|bmp)$/i.test(ext)) type = 'image'
  }
  let rating = ''
  if (pj && typeof pj.contentrating === 'string' && pj.contentrating) {
    rating = pj.contentrating.trim().toLowerCase()
  }
  // 缩略图优先取动画 preview.gif（存在时），否则按 project.json 的 preview 字段
  let thumbnail = ''
  const gifPath = path.join(dir, 'preview.gif')
  if (fs.existsSync(gifPath)) {
    thumbnail = gifPath
  } else if (pj && typeof pj.preview === 'string' && pj.preview) {
    thumbnail = path.join(dir, pj.preview)
  } else if (typeof w.preview === 'string') {
    thumbnail = w.preview
  }
  // 工坊预览图（绝对路径，供插件端经本地资源代理展示；通常是 preview.gif / preview.jpg）
  let previewFile = ''
  if (fs.existsSync(gifPath)) previewFile = gifPath
  else if (pj && typeof pj.preview === 'string' && pj.preview) previewFile = path.join(dir, pj.preview)
  else if (typeof w.preview === 'string' && w.preview) previewFile = w.preview
  // 场景壁纸：不再本地渲染（scene.pkg 由 WE 自己在桌面渲染，插件端经 /capture 同步），
  // 这里只声明工坊预览图（preview.gif / preview.jpg）作为手动点选时的展示来源。
  return {
    id: String(w.id),
    title: typeof w.title === 'string' && w.title ? w.title : '未命名壁纸',
    type,
    filepath,
    entry: pj && typeof pj.file === 'string' ? pj.file : '',
    thumbnail,
    previewUrl: '',
    previewFile,
    tags: Array.isArray(w.tags) ? w.tags : [],
    description: typeof w.description === 'string' ? w.description : '',
    rating,
  }
}

async function getWallpapers(refresh) {
  if (!refresh && listCache.items && Date.now() - listCache.time < LIST_TTL_MS) {
    return { items: listCache.items, hidden: listCache.hidden || 0 }
  }
  const raw = await we.listWallpapers()
  let items = raw.map(enrich).filter(Boolean)
  const visibleIds = loadVisibleIds()
  let hidden = 0
  if (visibleIds) {
    const before = items.length
    items = items.filter((it) => visibleIds.has(String(it.id)))
    hidden = before - items.length
  }
  listCache = { time: Date.now(), items, hidden }
  return { items, hidden }
}

/** tasklist 检测 WE 是否在运行（结果缓存 10 秒，仅供 /health 展示） */
let runCache = { time: 0, running: false }
function isWeRunning() {
  return new Promise((resolve) => {
    if (Date.now() - runCache.time < 10000) return resolve(runCache.running)
    execFile('tasklist', ['/NH'], { windowsHide: true }, (err, stdout) => {
      const running =
        !err && /wallpaper(32|64)\.exe|wallpaperservice32\.exe/i.test(String(stdout))
      runCache = { time: Date.now(), running }
      resolve(running)
    })
  })
}

/**
 * 读取当前桌面壁纸（纯只读）。
 *
 * 新版 Wallpaper Engine 把渲染分离到 wallpaperservice32.exe，
 * 命令行 `-control getWallpaper` 不再返回内容，因此这里直接解析
 * WE 安装目录下 config.json 的 general.wallpaperconfig.selectedwallpapers：
 * 该字段由各显示器当前壁纸的文件路径组成，取 Monitor0（缺失时取第一个）。
 */
async function getCurrent() {
  try {
    const cfgPath = path.join(WE_INSTALL_PATH, 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    const userCfg = cfg[os.userInfo().username]
    const wallCfg = userCfg && userCfg.general && userCfg.general.wallpaperconfig
    const selected = wallCfg && wallCfg.selectedwallpapers
    if (!selected || typeof selected !== 'object') return null

    let file = null
    if (selected.Monitor0 && typeof selected.Monitor0.file === 'string') {
      file = selected.Monitor0.file
    } else {
      const key = Object.keys(selected)[0]
      if (key && selected[key] && typeof selected[key].file === 'string') {
        file = selected[key].file
      }
    }
    if (!file) return null

    let norm = path.normalize(file)
    let dir = path.dirname(norm)
    const pjPath = path.join(dir, 'project.json')
    const pj = readProjectJson(pjPath)

    // config 直接指向 project.json 时（本地壁纸），解析其 file 字段
    if (path.basename(norm).toLowerCase() === 'project.json') {
      if (pj && typeof pj.file === 'string' && pj.file) {
        const candidate = path.join(dir, pj.file)
        if (fs.existsSync(candidate)) norm = candidate
      } else {
        return null
      }
    }

    let type = ''
    if (pj && typeof pj.type === 'string' && pj.type) type = pj.type.trim().toLowerCase()
    if (!type) {
      const ext = path.extname(norm).toLowerCase()
      if (ext === '.pkg') type = 'scene'
      else if (ext === '.html' || ext === '.htm') type = 'web'
      else if (/\.(mp4|webm|mkv|avi|mov|m4v)$/i.test(ext)) type = 'video'
      else if (/\.(jpe?g|png|webp|gif|bmp)$/i.test(ext)) type = 'image'
    }

    let rating = ''
    if (pj && typeof pj.contentrating === 'string' && pj.contentrating) {
      rating = pj.contentrating.trim().toLowerCase()
    }

    let thumbnail = ''
    const gifPath = path.join(dir, 'preview.gif')
    if (fs.existsSync(gifPath)) {
      thumbnail = gifPath
    } else if (pj && typeof pj.preview === 'string' && pj.preview) {
      thumbnail = path.join(dir, pj.preview)
    }
    return {
      id: path.basename(dir),
      title: pj && typeof pj.title === 'string' && pj.title ? pj.title : path.basename(dir),
      type,
      filepath: norm,
      entry: pj && typeof pj.file === 'string' ? pj.file : '',
      thumbnail,
      previewUrl: '',
      // 与 enrich() 一致：工坊预览图（绝对路径，preview.gif / preview.jpg），
      // 场景壁纸由插件端经 /capture 同步桌面实时画面，不再本地渲染
      previewFile: fs.existsSync(gifPath)
        ? gifPath
        : (pj && typeof pj.preview === 'string' && pj.preview ? path.join(dir, pj.preview) : ''),
      tags: pj && Array.isArray(pj.tags) ? pj.tags : [],
      description: pj && typeof pj.description === 'string' ? pj.description : '',
      rating,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Web 类壁纸目录文件服务（供插件 iframe 原生渲染 index.html 及其相对资源）
// ---------------------------------------------------------------------------

const WEB_FILE_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
}

// ---------------------------------------------------------------------------
// 网页壁纸兼容垫片（WE 私有接口）
// ---------------------------------------------------------------------------

/**
 * 构造注入到网页壁纸文档里的垫片脚本。
 *
 * 为什么需要：WE 用 `file://` 加载网页壁纸并注入一批私有接口，裸 iframe 里
 * 这些接口都不存在——
 *   - 只在 `applyUserProperties` 回调里设置背景图的壁纸，拿不到属性就只剩
 *     角色立在纯黑底上（观感像一张竖屏壁纸）；
 *   - 部分壁纸会调用媒体 / 音频接口，缺失时抛错卡在初始化；
 *   - 插件需要知道「壁纸真的画出内容了」才好叠化入场，否则黑屏或空等。
 *
 * @param {object} props project.json 的 general.properties（{key: {value,...}}）
 * @param {string} id 壁纸 workshop id（仅用于日志）
 */
function buildWeShim(props, id) {
  const defaults = {}
  for (const [k, v] of Object.entries(props || {})) {
    if (v && typeof v === 'object' && 'value' in v) defaults[k] = v.value
  }
  // 序列化时转义 </script>，避免属性值里的尖括号提前闭合脚本标签
  const json = JSON.stringify(defaults).replace(/</g, '\\u003c')
  return `;(function(){
  if (window.__wbgWeShim) return;
  window.__wbgWeShim = 1;
  var DEFAULTS = ${json};
  var ID = ${JSON.stringify(String(id))};
  function report(type, payload) {
    try { parent.postMessage({ __wbg: 1, type: type, id: ID, payload: payload || null }, '*'); } catch (e) {}
  }
  // ── 用户属性：project.json 默认值 ──
  var listeners = [];
  var props = {};
  Object.keys(DEFAULTS).forEach(function (k) { props[k] = DEFAULTS[k]; });
  window.wallpaperPropertyListener = window.wallpaperPropertyListener || {};
  var origApply = window.wallpaperPropertyListener.applyUserProperties;
  window.wallpaperPropertyListener.applyUserProperties = function (values) {
    try { Object.keys(values || {}).forEach(function (k) { props[k] = values[k]; }); } catch (e) {}
    try { if (typeof origApply === 'function') origApply(values); } catch (e) { report('error', { message: String(e && e.message || e) }); }
    listeners.forEach(function (fn) { try { fn(values || {}) } catch (e) {} });
  };
  // ── 媒体 / 音频接口占位（浏览器里没有 WE 的采集与播放通道）──
  var noop = function () { return { cancel: function () {} }; };
  var mediaNames = ["wallpaperRegisterMediaPlaybackListener","wallpaperRegisterMediaPropertiesListener","wallpaperRegisterMediaThumbnailListener","wallpaperRegisterMediaTimelineListener","wallpaperRegisterMediaStatusListener"];
  mediaNames.forEach(function (n) { if (typeof window[n] !== 'function') window[n] = noop; });
  if (typeof window.wallpaperMediaIntegration !== 'object' || !window.wallpaperMediaIntegration) {
    window.wallpaperMediaIntegration = { enabled: false, requestAllThumbnails: function () {}, requestThumbnail: function () {} };
  }
  if (typeof window.wallpaperRegisterAudioListener !== 'function') {
    // 静音频谱：16 段左右声道全 0，避免壁纸因 undefined 抛错
    window.wallpaperRegisterAudioListener = function (cb) {
      if (typeof cb !== 'function') return;
      var silence = new Array(16).fill(0);
      var tick = function () { try { cb(silence, silence) } catch (e) {} };
      var timer = setInterval(tick, 250);
      tick();
      return { cancel: function () { clearInterval(timer) } };
    };
  }
  // ── 「已画出内容」上报：canvas 像素 / img / video / 元素背景采样 ──
  var painted = false;
  function hasPaint() {
    try {
      var c = document.querySelector('canvas');
      if (c && c.width > 8 && c.height > 8) {
        var cx = c.getContext('2d');
        if (cx) {
          var w = Math.min(c.width, 48), h = Math.min(c.height, 27);
          var d = cx.getImageData(0, 0, w, h).data;
          for (var i = 3; i < d.length; i += 4) { if (d[i] > 8) return true; }
        }
      }
      var imgs = document.querySelectorAll('img');
      for (var j = 0; j < imgs.length; j++) {
        var im = imgs[j];
        if (im.complete && im.naturalWidth > 8 && im.offsetWidth > 8) return true;
      }
      var vids = document.querySelectorAll('video');
      for (var k = 0; k < vids.length; k++) {
        if (vids[k].readyState >= 2 && vids[k].videoWidth > 8) return true;
      }
      var els = document.querySelectorAll('div,section,main,body>canvas');
      for (var m = 0; m < Math.min(els.length, 80); m++) {
        var s = getComputedStyle(els[m]);
        if (s.backgroundImage && s.backgroundImage !== 'none') return true;
      }
    } catch (e) { /* 跨域 canvas 等：忽略，交给兜底 */ }
    return false;
  }
  function check() {
    if (painted) return;
    if (hasPaint()) { painted = true; report('painted'); }
  }
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    check();
    if (painted || tries > 120) clearInterval(timer);   // 30 秒后放弃
  }, 250);
  window.addEventListener('load', function () {
    // 时序对齐 WE：属性在 load 之后喂给壁纸
    try { window.wallpaperPropertyListener.applyUserProperties(props) } catch (e) {}
    setTimeout(check, 60);
    setTimeout(check, 300);
    setTimeout(check, 1200);
  });
  // 页面就绪时也喂一次（load 可能已过）
  if (document.readyState === 'complete') {
    setTimeout(function () { try { window.wallpaperPropertyListener.applyUserProperties(props) } catch (e) {} }, 0);
  }
})();`
}

/** 把垫片注入 HTML：优先插在 <head> 后，其次 <html> 后，最后前置 */
function injectWeShim(html, props, id) {
  const tag = '<script data-wbg-we-shim="1">' + buildWeShim(props, id) + '</script>'
  const headOpen = /<head[^>]*>/i.exec(html)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  const htmlOpen = /<html[^>]*>/i.exec(html)
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  return tag + html
}

/**
 * 只读地服务 workshop 目录里的文件：
 *   GET /files/<workshopId>/<相对路径>
 * 安全约束：id 仅数字、必须在订阅清单内（清单缺失时跳过该检查）、
 * 解析后的绝对路径必须落在 <WE_WORKSHOP_PATH>\<id> 目录内。
 *
 * 性能：大贴图 / 音频 / 视频一律流式发送（不整读进内存），并支持 Range 与
 * ETag / Last-Modified 条件请求——HTML 每次回源校验（改代码立即生效），
 * 静态资源命中缓存后 300 秒内不再回源。
 */
function serveWorkshopFile(req, res, id, relIn) {
  if (!/^\d{1,20}$/.test(String(id || ''))) return sendJson(res, 400, { ok: false, error: '非法壁纸 ID' })
  const visibleIds = loadVisibleIds()
  if (visibleIds && !visibleIds.has(id)) {
    return sendJson(res, 403, { ok: false, error: '该壁纸未订阅或已本地禁用' })
  }
  const root = path.join(WE_WORKSHOP_PATH, id)
  if (!fs.existsSync(root)) return sendJson(res, 404, { ok: false, error: '壁纸目录不存在' })
  const rel = relIn || 'index.html'
  let file
  try {
    file = path.resolve(root, rel)
    if (file !== root && !file.startsWith(root + path.sep)) {
      return sendJson(res, 403, { ok: false, error: '路径越界' })
    }
  } catch {
    return sendJson(res, 400, { ok: false, error: '非法路径' })
  }
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return sendJson(res, 404, { ok: false, error: '文件不存在' })
  }
  if (!st.isFile()) return sendJson(res, 404, { ok: false, error: '不是文件' })

  const ext = path.extname(file).toLowerCase()
  const mime = WEB_FILE_MIME[ext] || 'application/octet-stream'
  const isHtml = ext === '.html' || ext === '.htm'
  const etag = '"' + st.size.toString(16) + '-' + st.mtimeMs.toString(16) + '"'

  // 条件请求：HTML 每次回源校验（改代码立即生效），静态资源命中后不再回源
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300' })
    return res.end()
  }

  const headers = {
    'Content-Type': mime,
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
  }

  // HTML 需要注入垫片，读进内存；其它文件一律流式发送（大贴图 / 音频不再整读进内存）
  if (isHtml) {
    let html
    try {
      html = fs.readFileSync(file, 'utf8')
    } catch {
      return sendJson(res, 500, { ok: false, error: '读取失败' })
    }
    // 只给真正的文档注入：XHR 取走的 .html 数据文件不能被改写
    const dest = String(req.headers['sec-fetch-dest'] || '')
    const asDocument = dest === '' || dest === 'iframe' || dest === 'document' || dest === 'frame'
    const looksDoc = /<body[\s>]/i.test(html) || /<html[\s>]/i.test(html)
    if (asDocument && looksDoc) {
      const pj = readProjectJson(path.join(root, 'project.json'))
      html = injectWeShim(html, pj && pj.general ? pj.general.properties : null, id)
    }
    const buf = Buffer.from(html, 'utf8')
    headers['Content-Length'] = String(buf.length)
    res.writeHead(200, headers)
    if (req.method === 'HEAD') return res.end()
    return res.end(buf)
  }

  let start = 0
  let end = st.size - 1
  let code = 200
  const range = req.headers.range
  if (typeof range === 'string') {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m) {
      let s = m[1] ? parseInt(m[1], 10) : 0
      let e = m[2] ? parseInt(m[2], 10) : st.size - 1
      if (Number.isNaN(s)) s = 0
      if (Number.isNaN(e)) e = st.size - 1
      if (s > e || s >= st.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size })
        return res.end()
      }
      start = s
      end = Math.min(e, st.size - 1)
      code = 206
    }
  }
  headers['Content-Length'] = String(end - start + 1)
  if (code === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size
  res.writeHead(code, headers)
  if (req.method === 'HEAD') return res.end()
  const stream = createReadStream(file, { start, end })
  stream.on('error', () => {
    try { res.destroy() } catch { /* 已断开 */ }
  })
  stream.pipe(res)
  return undefined
}

/** 从 /files/<id>/<rel> 解析壁纸 ID 与相对路径；首段不是纯数字则返回 null */
function parseFilesPath(pathname) {
  let rest
  try {
    rest = decodeURIComponent(pathname.slice('/files/'.length))
  } catch {
    return { badEncoding: true }
  }
  const segs = rest.split('/').filter(Boolean)
  const id = segs.shift() || ''
  if (!/^\d{1,20}$/.test(id)) return null
  return { id, rel: segs.join('/') }
}

/** 取 Referer 里的壁纸 ID：/files/<id>/... 形式的同源页面才能兜底 */
function refererWorkshopId(req) {
  const ref = req.headers.referer || req.headers.referrer
  if (typeof ref !== 'string') return null
  const m = /^https?:\/\/[^/]*\/files\/(\d{1,20})\//i.exec(ref)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

/**
 * GET /capture?w=&q=
 * 桌面壁纸实时捕获（JPEG，单帧，内存生成，不落盘）。
 * 就是「同步桌面壁纸」的核心：不本地渲染、不烘焙——直接采样 Wallpaper Engine
 * 正在桌面上实时渲染的画面（PrintWindow(Progman, PW_RENDERFULLCONTENT)，含 WE
 * D3D 子窗口；DWM 合成下 GDI BitBlt 拿不到时 PrintWindow 才行，失败回退 BitBlt）。
 * 插件端在同步 / 桌面镜像场景下以约 1 秒间隔轮询此端点即可看到会动的桌面壁纸。
 */
function serveCapture(req, res, url) {
  const w = Number(url.searchParams.get('w'))
  const q = Number(url.searchParams.get('q'))
  try {
    const frame = captureJpeg({
      width: Number.isFinite(w) && w >= 160 && w <= 3840 ? w : 1280,
      quality: Number.isFinite(q) && q >= 30 && q <= 95 ? q : 70,
    })
    const headers = {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(frame.data.length),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Capture-W': String(frame.width),
      'X-Capture-H': String(frame.height),
      'X-Capture-Ms': String(Date.now() - frame.capturedAt),
      // 1 = 本帧判定为纯黑（WE 暂停渲染 / 桌面被遮盖），客户端据此提示而不是默默黑屏
      'X-Capture-Black': frame.black ? '1' : '0',
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, headers)
      return res.end()
    }
    res.writeHead(200, headers)
    return res.end(frame.data)
  } catch (err) {
    return sendJson(res, 503, {
      ok: false,
      error: '桌面壁纸捕获失败: ' + String((err && err.message) || err),
      hint: '需要运行中的 Wallpaper Engine 与可用的交互桌面（Progman 窗口）',
    })
  }
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(obj))
}

const server = http.createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'))
  } catch {
    return sendJson(res, 400, { ok: false, error: '非法 URL' })
  }
  const p = url.pathname.replace(/\/+$/, '') || '/'
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: '只读服务，仅支持 GET' })
  }
  try {
    if (p === '/' || p === '/health' || p === '/api/health') {
      const subFiles = findSubscriptionsFiles()
      const cap = probeCapture()
      return sendJson(res, 200, {
        ok: true,
        service: 'we-api-proxy',
        version: '0.4.0',
        // 网页壁纸兼容垫片版本：插件可据此判断服务是否需要升级（0 = 旧版，无垫片）
        webShim: 1,
        // 桌面壁纸实时捕获：1 = /capture 可用（插件「同步桌面壁纸」据此镜像桌面；
        // 不依赖任何本地渲染 / 缓存，纯捕获 WE 在桌面上实时渲染的画面）
        desktopCapture: cap.desktopCapture,
        captureError: cap.captureError,
        primary: cap.primary,
        mode: 'readonly',
        weInstallPath: WE_INSTALL_PATH,
        workshopPath: WE_WORKSHOP_PATH,
        subscriptionsFile: subFiles.length ? subFiles.join('; ') : null,
        weRunning: await isWeRunning(),
        time: new Date().toISOString(),
      })
    }
    if (
      p === '/api/wallpapers' || p === '/wallpapers' ||
      p === '/api/wallpapers/list' || p === '/api/list' || p === '/list'
    ) {
      const refresh = url.searchParams.get('refresh') === '1'
      const { items, hidden } = await getWallpapers(refresh)
      return sendJson(res, 200, {
        ok: true,
        wallpapers: items,
        count: items.length,
        hiddenUnsubscribed: hidden,
      })
    }
    if (
      p === '/api/current' || p === '/current' ||
      p === '/api/wallpapers/current' || p === '/wallpapers/current' || p === '/api/state'
    ) {
      return sendJson(res, 200, { ok: true, current: await getCurrent() })
    }
    if (p === '/capture') {
      return serveCapture(req, res, url)
    }
    if (p.startsWith('/files/')) {
      const parsed = parseFilesPath(p)
      if (parsed && parsed.badEncoding) return sendJson(res, 400, { ok: false, error: '非法路径编码' })
      if (parsed) return serveWorkshopFile(req, res, parsed.id, parsed.rel)
      // 首段不是数字 ID：壁纸按 file:// 写死的 `../assets/...` 会被浏览器折叠成
      // /files/assets/...，这里用 Referer 里的壁纸 ID 兜底（路径仍限制在该目录内）
      const rid = refererWorkshopId(req)
      if (rid) {
        let rel
        try {
          rel = decodeURIComponent(p.slice('/files/'.length))
        } catch {
          return sendJson(res, 400, { ok: false, error: '非法路径编码' })
        }
        return serveWorkshopFile(req, res, rid, rel)
      }
      return sendJson(res, 400, { ok: false, error: '非法壁纸 ID' })
    }
    return sendJson(res, 404, { ok: false, error: '未知端点: ' + p })
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
  }
})

server.listen(PORT, HOST, () => {
  console.log('[WE-API] 只读代理服务已启动: http://' + HOST + ':' + PORT)
  console.log('[WE-API] 端点: /health  /api/wallpapers  /api/current  /files/<id>/...  /capture')
  const cap = probeCapture()
  console.log(
    '[WE-API] 桌面壁纸捕获（/capture）: ' +
    (cap.desktopCapture ? '可用（内存中采样桌面画面，不落盘、不渲染）' : '不可用 — ' + cap.captureError),
  )
  console.log('[WE-API] 壁纸库: ' + WE_WORKSHOP_PATH)
  console.log('[WE-API] 本服务只读，不调用任何设置/播放壁纸的接口，桌面壁纸不受影响。')
})

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('[WE-API] 端口 ' + PORT + ' 已被占用。请关闭占用程序，或设置环境变量 WEAPI_PORT 换端口。')
  } else {
    console.error('[WE-API] 启动失败: ' + (err && err.message ? err.message : err))
  }
  process.exit(1)
})
