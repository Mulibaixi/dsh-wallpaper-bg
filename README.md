# dsh-wallpaper-bg

> v0.4.1 · MIT License

English | [中文](README.zh.md)

A static two-half plugin that puts an **independent animated wallpaper layer** under the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) interface — the browser UI (`dsh web`) and the 0.2 **desktop app** alike: install it (one command on the CLI, or just a package name in the desktop app's plugin page), and the whole interface sits on a moving wallpaper. Ships with 10 high-res Unsplash images, supports uploading local images / videos, and can read-only connect to your local Wallpaper Engine library — video and web wallpapers render natively in the browser, while **「同步桌面壁纸」 mirrors the desktop wallpaper live** (Wallpaper Engine is already rendering it on your screen; the plugin samples those pixels, so scenes — particles, shaders, character breathing — come alive too, with zero local rendering and zero cache files). In light theme a translucent white fog is layered in automatically, in dark theme a dimming overlay is applied, so fine text stays readable. The background layer is fully independent from the desktop Wallpaper Engine: changing wallpapers inside DSH never touches your desktop wallpaper, and vice versa.

![DSH interface in dark theme](docs/screenshots/overview-dark.jpg)

![More UI previews (1)](docs/screenshots/screenshot-01.jpg)

![Settings panel · Wallpaper tab](docs/screenshots/settings-panel.jpg)

![More UI previews (2)](docs/screenshots/screenshot-02.jpg)

![More UI previews (3)](docs/screenshots/screenshot-03.jpg)

## Features

- **Three wallpaper sources**
  - **Built-in wallpapers**: 10 high-res Unsplash images, ready to use with zero local services;
  - **Custom uploads**: local images / videos, stored in IndexedDB and kept across refreshes. Videos get auto-generated first-frame thumbnails, and extension-based detection covers files whose MIME type the browser leaves empty (e.g. `.mkv` / `.mov`) — they now render as video instead of a black screen;
  - **WE library**: read-only access to locally installed Wallpaper Engine wallpapers (default `http://127.0.0.1:8088`), filtered by the real Steam subscription list — unsubscribed wallpapers never linger.
- **Playback queue (custom uploads + WE library)**: drag wallpapers from either source's grid into its queue and loop-play them, 1–10 minutes per item (both queues share one duration slider). Queue items support drag-to-reorder (with an insertion indicator), click-to-jump, per-item remove, and clear-all; queue contents, toggles and playback positions persist to localStorage. The custom queue accepts images / videos; the WE queue accepts video / scene / web / image wallpapers. Each queue is **sticky at the top of its tab**, so even with hundreds of wallpapers any tile is a short drag away.
- **Three render modes**
  - Static images (cover-fit);
  - Videos (`<video object-fit: cover>`, GPU compositing, no letterboxing or distortion);
  - Scene wallpapers (manual selection shows WE's own workshop preview `preview.gif` / `preview.jpg`; for the **live** scene — particles drifting, water rippling, characters breathing — enable 同步桌面壁纸, which mirrors the image Wallpaper Engine is already rendering on your desktop, ~1 frame/s);
  - Web wallpapers (native iframe rendering of `index.html` in the browser).
- **Zero local rendering, zero cache files**: the plugin never parses `scene.pkg` or bakes videos. Desktop sync samples the wallpaper Wallpaper Engine is already rendering (`PrintWindow(Progman, PW_RENDERFULLCONTENT)`, then an in-memory JPEG) — no `~/.dsh-wallpaper-bg`, no frame files, no MP4s. The local scene renderer and the animation-baking stack were **removed in 0.4.0** together with the `WE_SCENE_RENDER` switch.
- **Four adjustments**: light fog / dark overlay (auto-switching with the DSH theme), background blur (0–20px), background brightness (50–150%), safe zoom (0–10% to crop edge letterboxing).
- **Black-flash-free switching**: every wallpaper change (including queue rotation) cross-fades two stacked layers — the incoming wallpaper preloads and finishes decoding / first-frame playback in its own layer, then blends with the outgoing one over ~0.42s, and the old layer is only removed after it has faded out. Applies to all render modes (image, video, scene preview, web, desktop mirror), so no frame of the transition is ever empty.
- **Next-item warm-up**: while a queue item is on screen, the next one is fetched ahead of time (network images downloaded and decoded, WE videos buffered in a real `<video>` element, custom uploads read from IndexedDB with an objectURL ready), so the cross-fade starts almost immediately instead of waiting on the network.
- **White-intro skipping**: some wallpaper videos literally open with a pure-white intro (e.g. the Arknights "喧闹法则" video is entirely white for its first 2 seconds). The warm-up phase probes for the first non-white frame and playback starts there, so switching to such a wallpaper no longer shows a blank white screen.
- **No leftover background decoding**: when an outgoing layer fades out, its frame-pump interval is stopped and its video is fully released (`pause()` plus detaching `src`), so rotating the queue keeps exactly one decoder alive no matter how many times it switches. Measured over 6 consecutive switches: a steady 58–60 fps (before the fix it decayed from 59.7 to 12.2 fps).
- **4K videos no longer cost performance**: the video layer uses `<video object-fit: cover>` and lets the compositor (GPU) do the scaling, instead of re-drawing every frame onto a viewport-sized canvas (a single 4K frame grab costs 20–40 ms); the 30 fps frame-pump timer is gone too, and an identity filter (`blur(0px) brightness(100%)`) — which silently disables GPU compositing — is no longer applied. Measured on a 4K wallpaper: **22–27 fps → 57–60 fps**, long frames per second from 68–72 down to 3–9.
- **View-only source tabs**: switching between 内置壁纸 / 自定义上传 / WE 壁纸库 only changes what the panel shows — the background stays untouched until you explicitly click a wallpaper, operate a queue, or enable 同步桌面壁纸 (which mutually excludes the WE queue).
- **Sync desktop wallpaper** toggle: **live mirror of the current desktop wallpaper** — the plugin samples what Wallpaper Engine is already rendering on your desktop (~1 frame/s, in-memory JPEG, nothing written to disk), so scenes animate exactly as on your screen, and video / web / image desktop wallpapers are mirrored the same way. A sync status line in the panel shows the followed wallpaper (title / type), last-sync time and mirror state, with a 立即刷新 button; re-focusing the DSH tab re-checks immediately. Read-only: it never changes your desktop wallpaper. Manual selection of a scene wallpaper shows WE's workshop preview (`preview.gif` / `preview.jpg`).
- WE library filters: type (all / video / scene / web) + rating (all / safe / 18+; 18+ cards carry a red badge with live counts). The rating filter resets to **safe** every time the WE tab is opened.
- Settings persist to localStorage; the UI surface auto-turns semi-transparent to reveal the background.

## Installation

### Prerequisites

- **DeepSeek Harness desktop app (0.2 preview or later)** — nothing else to install: the app bundles its own Node.js / pnpm runtime, so no system Node is needed;
- **or a CLI install** (`dsh web`) with Node.js ≥ 20 (`node -v`) and a working DeepSeek Harness;
- only the WE library source needs Windows + a local Wallpaper Engine install (optional, see below).

### Install in the desktop app (no command line)

The 0.2 desktop app ships a plugin page, so installing this plugin never needs a terminal:

1. Open **Settings → Plugins** (设置 → 插件) and type the package name `dsh-wallpaper-bg` into the install box;
2. Confirm, and restart the app (or reload the window) when it asks — the plugin set is applied when DSH starts;
3. Open **Settings → Wallpaper** (设置 → 壁纸) and pick a wallpaper.

The app installs into its own `desktop` profile and lists the plugin on the same page, where you can also disable it, uninstall it, and read its description and source. The desktop app serves that profile on a fixed port (19387), so the page origin never changes — custom uploads (IndexedDB) and settings (localStorage) survive an app restart.

If the app's optional `dsh` command is on your PATH (the app offers to install it), the equivalent command is:

```bash
dsh plugin --profile desktop add dsh-wallpaper-bg
```

> The `desktop` profile belongs to the Electron app: booting it from a terminal is refused with `profile "desktop" is managed exclusively by the Electron application`. That is expected — install / uninstall through the plugin page (or `dsh plugin --profile desktop …`, which does work), and the app applies the plugin itself on startup. This package's own installer skips the `desktop` profile for exactly that reason (see `dsh-wallpaper-bg install` below).

### Install for the CLI / browser install (`dsh web`)

```bash
dsh plugin --profile web add dsh-wallpaper-bg
```

> For local development from a checkout, link the repo instead — both profiles accept a link spec:
> `dsh plugin --profile web add link:<absolute-path-to-repo>` (or `--profile desktop` for the desktop app) — subsequent `lib/client.js` / `lib/host.js` edits apply after a plain page refresh (no server restart).

### Optional: WE library service (Windows)

The WE library source needs the `wallpaper-engine-api/` service, which exposes the installed Wallpaper Engine list as a read-only HTTP API on `127.0.0.1:8088`:

1. `cd wallpaper-engine-api && npm install`;
2. Double-click `启动服务.bat` (the first run asks for the WE install path; `启动服务-静默.vbs` starts it silently);
3. Optional: double-click `设置开机自启.bat` to register the silent starter in the registry (`HKCU\...\Run`) so it starts at login; `取消开机自启.bat` removes it (the scripts reference `启动服务-静默.vbs` in this directory — re-run them after moving the folder);
4. For upgrades / restarts always double-click `重启服务(管理员).bat`: it requests admin rights, stops the old process, restarts silently and waits for the port (full log: `restart-debug.log`).

The service is **read-only**: it only queries the list / current wallpaper, never touches settings or playback, and never launches WE when the runtime is absent. The list is filtered by the real Steam subscription manifest (`431960_subscriptions.vdf`) — unsubscribed or locally disabled wallpapers disappear even if their folders linger, matching the WE UI.

Service **0.4.0** adds **desktop wallpaper capture** for 「同步桌面壁纸」: `GET /capture?w=&q=` returns a single JPEG frame (in-memory, `no-store`) sampled from the image Wallpaper Engine is already rendering on the desktop — `PrintWindow(Progman, PW_RENDERFULLCONTENT)` (the DWM-composited desktop layer, which includes WE's `WPEDesktopDX11Window` D3D child; GDI `BitBlt` can return a black frame under modern independent-swapchain composition, so PrintWindow is the primary path with a BitBlt fallback), downscaled to the primary monitor with `StretchBlt` and encoded with a pure-JS JPEG encoder. **Nothing is rendered locally and nothing is written to disk**: no `scene.pkg` parsing, no frames, no MP4s, no `~/.dsh-wallpaper-bg` folder. A black frame (WE paused / desktop covered) is reported via the `X-Capture-Black: 1` header so the page shows a hint instead of silently going black. The old local scene renderer (`/scene-frame`, `/scene-anim`, `lib/we-renderer/`) and the `WE_SCENE_RENDER` switch were **removed** — the endpoints now return `404`, and `/health` reports `"desktopCapture": 1` (with `"weRunning"`).

> Verify: `http://127.0.0.1:8088/health` is the WE service — a JSON response means it is up, and `"desktopCapture": 1` means the mirror endpoint is ready (0 = no interactive desktop / WE not running). The plugin's own host half reports its version at `<DSH address>/dsh-wallpaper-bg/health`: `http://127.0.0.1:3080/dsh-wallpaper-bg/health` with `dsh web` (default port 3080), or `http://127.0.0.1:19387/dsh-wallpaper-bg/health` in the desktop app — the 0.2 app boots the `desktop` profile with a fixed `--port 19387`. The same check through the UI: **Settings → Plugins** lists `dsh-wallpaper-bg` and **Settings → Wallpaper** opens the panel. Port 8088 is a historical choice (8080 was once taken by Jenkins); switch ports via the `WEAPI_PORT` env var and update the base URL in the plugin settings.

## Settings panel

| Item | Description |
| --- | --- |
| Built-in / Custom upload / WE library | Source tabs: switching tabs only changes the panel view; the background applies only on explicit selection (click a wallpaper, queue actions, or sync desktop) |
| Upload custom wallpapers | Images / videos, stored in IndexedDB; videos get auto-generated first-frame thumbnails |
| Playback queue | Independent queue per source, sticky at the top of its tab: drag wallpapers in, loop-play at 1–10 min per item (shared duration slider), drag-to-reorder, click-to-jump, × to remove, clear to reset |
| WE base URL + refresh | WE API address (default `http://127.0.0.1:8088`) |
| Type filter | all / video / scene / web, by the wallpaper's real type |
| Rating filter | all / safe / 18+ (from `contentrating` in project.json: 18+ = Mature + Questionable), 18+ cards carry a red badge with live counts; resets to **safe** every time the WE tab is entered |
| Sync desktop wallpaper | Live mirror of the current desktop wallpaper: samples what WE is already rendering on screen (~1 frame/s, in-memory, no files); status line shows the followed wallpaper / last-sync time / mirror state, with a refresh-now button; re-checks when the page becomes visible; mutually exclusive with the WE queue |
| Light fog / dark overlay | 0–100%, auto-switching with the DSH theme: translucent white fog in light theme to lift fine text, dark overlay in dark theme |
| Background blur / brightness | 0–20px / 50–150% |
| Safe zoom | 0–10% scale-up to crop edge letterboxing |
| Scene wallpaper note | Manual selection of a scene wallpaper shows WE's workshop preview (`preview.gif` / `preview.jpg`); for the live animated scene enable 同步桌面壁纸 (mirrors the desktop rendering in real time — no baking, no local rendering, no cache files) |
| Reset to defaults | One-click restore of all settings |

## How it works

This package is a DSH **static two-half plugin**, composed into the DSH host plane as a **profile bundle layer**:

| Half | File | Responsibility |
| --- | --- | --- |
| Host half (Node) | `lib/host.js` | Registers same-origin routes: `/dsh-wallpaper-bg/asset` (streaming local-file proxy with Range support), `/dsh-wallpaper-bg/we` (read-only WE API proxy with caching, passes `previewFile` through), `/dsh-wallpaper-bg/health` |
| Browser half | `lib/client.js` | Single-file client bundle (`window.__ModuleLoader__` factory form): injects the background layer and overlay, registers the 壁纸 settings tab; 同步桌面壁纸 mirrors the desktop via the service's `/capture` endpoint (one reused `<img>`, ~1 frame/s) |
| Composition | `cordis.patch.yml` | `dsh.bundle` patch: inserts the plugin row into the profile composition's host plane — active on DSH startup (`dsh web` **or the desktop app**), the first page load already carries the background |
| Desktop wallpaper capture | `wallpaper-engine-api/lib/desktop-capture.js` | Samples the wallpaper Wallpaper Engine is already rendering on the desktop: `PrintWindow(Progman, PW_RENDERFULLCONTENT)` (DWM-composited, includes the WE D3D child; BitBlt fallback) + `StretchBlt` to the primary monitor + in-memory JPEG (koffi FFI + jpeg-js). No local rendering, no disk cache |

Zero build on both ends: `lib/client.js` is a hand-written single-file bundle, no bundler required; a `dsh-wallpaper-bg` CLI (`install` / `status` / `uninstall`) provides one-command setup for a CLI install (it skips the `desktop` profile, which the Electron app owns — install there through **Settings → Plugins**, or with `dsh plugin --profile desktop add dsh-wallpaper-bg`).

## FAQ

- **How do I install this in the DSH desktop app?** No command line needed: **Settings → Plugins** (设置 → 插件) → type `dsh-wallpaper-bg` → install → restart the app when it asks. The app keeps it in its own `desktop` profile and the same page lets you disable / uninstall it and see its description and source. The terminal equivalent (with the app's `dsh` command on PATH) is `dsh plugin --profile desktop add dsh-wallpaper-bg`.
- **Why does `dsh --profile desktop …` fail on the command line?** The desktop app owns that profile: DSH answers `profile "desktop" is managed exclusively by the Electron application`. That is by design — the app composes and boots the profile itself. `dsh plugin --profile desktop <pnpm args>` (install / list / remove) still works, because that path only manages the profile's package manifest. This package's `dsh-wallpaper-bg install` therefore skips `desktop` and points you at the plugin page.
- **Does the desktop app need Node.js, or the `wallpaper-engine-api` service?** Node.js, no — the desktop app bundles its own Node/pnpm runtime, so only a CLI install (`dsh web`) needs Node ≥ 20. The optional WE library source is unaffected: it still needs Windows + a local Wallpaper Engine install + the `wallpaper-engine-api` service on port 8088, exactly as for `dsh web`.
- **How do I verify it loaded on the desktop app?** Open `http://127.0.0.1:19387/dsh-wallpaper-bg/health` — `{"ok":true,"plugin":"dsh-wallpaper-bg","version":"…"}` means the host half is mounted (the 0.2 desktop app serves the `desktop` profile on the fixed port 19387). The rest is visible in the UI: **Settings → Plugins** lists `dsh-wallpaper-bg` as installed/enabled, and **Settings → Wallpaper** opens the panel.
- **How do scene wallpapers show on the page?** Two ways, both **without local rendering**:
  - *Manual selection / queue*: shows WE's own workshop preview (`preview.gif` / `preview.jpg`, the animated preview WE generates for every wallpaper) — a representative look, zero files.
  - *同步桌面壁纸 (desktop mirror)*: the page displays the **live** wallpaper Wallpaper Engine is already rendering on your desktop — particles drift, water ripples, characters breathe, exactly as on the screen — because the plugin samples those pixels (`/capture`, ~1 frame/s, in-memory JPEG). This works for scene wallpapers and every other type.
- **Is there any local scene rendering / baking left?** No. The pure-JS scene renderer (`lib/we-renderer/`, `scene.pkg` parsing, shader effects) and the animation-baking stack (`/scene-anim`, `~/.dsh-wallpaper-bg` frame/MP4 caches) were **removed in 0.4.0**, along with the `WE_SCENE_RENDER` switch. The old endpoints return `404`; nothing writes to `~/.dsh-wallpaper-bg` anymore (an existing folder can be deleted freely).
- **Why does the mirror refresh ~1 frame/s / look choppy?** The capture endpoint is polled once per second to keep CPU and bandwidth near zero; it is a *mirror*, not a video stream. If you need full-fidelity motion for a specific wallpaper, record ~30 s with WE's tray-menu screen recorder (or OBS) and upload it via custom uploads — it then plays 100% faithfully in the browser.
- **Desktop mirror shows nothing / status says capture unavailable?** Make sure Wallpaper Engine is running, this is an interactive desktop session (the service must find the `Progman` window), and the WE API service is 0.4.0+ (`http://127.0.0.1:8088/health` → `"desktopCapture": 1`). The mirror stops after a few consecutive failed frames and the panel shows the reason.
- **Do web-type wallpapers render?** Yes — web wallpapers are plain HTML/JS pages, rendered natively in a full-screen iframe (`index.html` plus relative assets, served read-only by the WE API's `/files/<id>/...` route, restricted to subscribed wallpaper directories). Since WE API 0.2.6 the served document also gets a **WE private-API shim** injected: it feeds the default user properties from `project.json` into `applyUserProperties` (without it, wallpapers that set their background inside that callback leave only a character floating on pure black — which reads as a portrait wallpaper), stubs the audio / media interfaces, and reports when the page has actually painted, so the plugin only cross-fades once there is a real picture instead of a black screen. Note the background layer never intercepts the mouse, so the wallpaper's own interactions (click / drag) don't work — visual only; audio visualizers run on silence (the browser has no WE audio capture).
- **Web wallpaper shows a black screen or takes forever?** First make sure the WE API service is upgraded to 0.2.6 and restarted (`http://127.0.0.1:8088/health` should include `"webShim": 1`) — older services have no shim and also reject `../assets/...` style paths that wallpapers write for a `file://` origin.
- **Web wallpaper assets re-download on every switch?** Fixed in 0.3.8: the service's `/files` route used to read whole files synchronously and answer `no-store`. It now streams with `ETag` / `Last-Modified` conditional requests (HTML `no-cache`, static assets cached 300 s) and supports `Range`.
- **Do web-type wallpapers render?** Yes — web wallpapers are plain HTML/JS pages, rendered natively in a full-screen iframe (`index.html` plus relative assets, served read-only by the WE API's `/files/<id>/...` route, restricted to subscribed wallpaper directories). Note the background layer never intercepts the mouse, so the wallpaper's own interactions (click / drag) don't work — visual only; audio visualizers relying on WE's private JS API may stay silent.
- **Videos have black bars?** Pull 安全放大 (safe zoom) to 2–3% to crop the video's own letterboxing (the cover-crop render already guarantees no self-made bars).
- **My uploaded video shows a black screen / black tile?** Videos whose MIME type the browser leaves empty (common for `.mkv` / `.mov`) are now detected by extension and rendered as video; every video upload also gets an auto-generated first-frame thumbnail. If a specific file is still black, its codec is likely unsupported by the browser.
- **Code changes don't take effect?** For `lib/client.js` / `lib/host.js` content edits, a plain page refresh (F5) is enough — client bundles are read fresh from disk per request (`cache-control: no-cache`), so no server restart is required. A DSH restart is only needed when the plugin set changes (adding / removing plugin rows or editing `dsh.client` declarations): restart `dsh web`, or follow what the desktop app asks for after an install / uninstall from its plugin page (the page applies the change and prompts when a restart is required).
- **WE library errors?** Confirm the `wallpaper-engine-api` service is running on port 8088 (`http://127.0.0.1:8088/health` in a browser) and the base URL in plugin settings matches.
- **Wallpapers removed in WE still show up?** The service filters by the Steam subscription list, so unsubscribed wallpapers disappear; if the service is outdated (`/health` lacks the `subscriptionsFile` field), double-click `重启服务(管理员).bat` to upgrade, then click 刷新 in the plugin.

## License

MIT License, see [LICENSE](LICENSE). Issues / PRs welcome.

### Releasing

The repo ships a one-shot release script, `scripts/release.ps1`, which fixes the whole flow: version check → pack preflight → commit → tag → push → npm publish → GitHub Release (with the tarball attached).

```powershell
.\scripts\release.ps1 -DryRun              # rehearse: checks only, no changes
.\scripts\release.ps1 -Version 0.4.1       # bump version and release
.\scripts\release.ps1                      # release the version in package.json
```

Preflight refuses duplicate releases (tag already present locally or on the remote, version already on npm) and requires a matching `CHANGELOG.md` entry — the Release notes are taken from that entry. Optional flags: `-SkipNpm` / `-SkipGitHub` / `-SkipPush` / `-Yes`.

`legacy/` holds the pre-v0.1.0 dynamic-plugin (Cordis dynamic package) source, archived for reference only.
