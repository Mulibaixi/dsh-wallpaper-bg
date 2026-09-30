// 重建后的 WE API 服务验收：列表字段 / 桌面壁纸捕获（/capture）/
// 网页文件路由（ETag·Range·垫片·Referer 兜底）
const BASE = 'http://127.0.0.1:8088';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); } else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); } };

const health = await (await fetch(BASE + '/health')).json();
console.log('health:', JSON.stringify(health).slice(0, 220));
ok('health version 0.4.0', health.version === '0.4.0');
ok('health webShim', health.webShim === 1);
const CAPTURE_ON = health.desktopCapture === 1;
ok('health desktopCapture is 0 or 1', CAPTURE_ON || health.desktopCapture === 0, `desktopCapture=${health.desktopCapture}`);
ok('no sceneRender field (renderer removed)', health.sceneRender === undefined);

const list = await (await fetch(BASE + '/api/wallpapers')).json();
ok('list count > 0', list.wallpapers.length > 0, `${list.wallpapers.length} items`);
ok('list has no sceneRender field (renderer removed)', list.sceneRender === undefined);
const scene = list.wallpapers.find((w) => w.type === 'scene');
const web = list.wallpapers.find((w) => w.type === 'web');
const video = list.wallpapers.find((w) => w.type === 'video');
ok('scene previewFile absolute', !!(scene && scene.previewFile && /^[A-Za-z]:\\/.test(scene.previewFile)));
ok('scene has no hasFrame field (renderer removed)', scene && scene.hasFrame === undefined);
ok('video item present', !!video);

// 桌面壁纸捕获（/capture）：内存采样桌面画面，JPEG 直出，不出 /scene-frame、/scene-anim
const cap = await fetch(`${BASE}/capture?w=960`);
ok('capture 200 image/jpeg', cap.status === 200 && cap.headers.get('content-type') === 'image/jpeg',
  `type=${cap.headers.get('content-type')}`);
const capBuf = Buffer.from(await cap.arrayBuffer());
ok('capture bytes > 5KB (real picture)', capBuf.length > 5000, `${(capBuf.length / 1024).toFixed(0)}KB`);
ok('capture cache no-store', cap.headers.get('cache-control') === 'no-store' || cap.headers.get('cache-control') === 'no-cache');
ok('capture CORS *', cap.headers.get('access-control-allow-origin') === '*');
ok('capture black-frame header', cap.headers.get('x-capture-black') === '0' || cap.headers.get('x-capture-black') === '1',
  `x-capture-black=${cap.headers.get('x-capture-black')}`);
const capH = await fetch(`${BASE}/capture?w=1280`, { method: 'HEAD' });
ok('capture HEAD', capH.status === 200 && capH.headers.get('content-length') > 0);
const cap2 = await fetch(`${BASE}/capture`);
ok('capture default width works', cap2.status === 200 && (await cap2.arrayBuffer()).byteLength > 0);

// 旧的本地渲染路由必须彻底消失（不产生任何图片/视频垃圾）
for (const old of ['/scene-frame/3422426571', '/scene-anim/3422426571', '/scene-anim/status']) {
  const r = await fetch(`${BASE}${old}`);
  ok(`${old} → 404 (removed)`, r.status === 404, `status=${r.status}`);
}

// 网页文件路由
if (web) {
  const idx = web.entry || 'index.html';
  const url = `${BASE}/files/${web.id}/${idx.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
  const h = await fetch(url, { headers: { 'sec-fetch-dest': 'iframe' } });
  const body = await h.text();
  ok('web index 200', h.status === 200, `bytes=${body.length}`);
  ok('web shim injected', body.includes('__wbgWeShim'), `etag=${h.headers.get('etag')} cache=${h.headers.get('cache-control')}`);
  const etag = h.headers.get('etag');
  const h304 = await fetch(url, { headers: { 'if-none-match': etag } });
  ok('web conditional 304', h304.status === 304);

  const probe = await fetch(`${BASE}/files/${web.id}/`);
  const names = [...(await probe.text()).matchAll(/"([^"]+\.(?:png|jpg|jpeg|gif|webp|mp3|ogg|wav|js|css|woff2?|ttf))"/gi)].map((m) => m[1]);
  if (names.length) {
    const a = `${BASE}/files/${web.id}/${names[0].split(/[\\/]/).map(encodeURIComponent).join('/')}`;
    const hr = await fetch(a, { headers: { Range: 'bytes=0-99' } });
    ok('asset range 206', hr.status === 206, `${names[0]} len=${(await hr.arrayBuffer()).byteLength}`);
  } else {
    console.log('  (no static asset listed to test Range)');
  }

  const hr2 = await fetch(`${BASE}/files/assets/definitely-missing.png`, { headers: { Referer: `http://127.0.0.1:8088/files/${web.id}/index.html` } });
  ok('referer fallback handled (404 file, not 400 id)', hr2.status === 404, `status=${hr2.status}`);
} else {
  console.log('  (no web wallpaper to test)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;