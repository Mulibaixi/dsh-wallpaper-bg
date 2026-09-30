# Security Policy / 安全策略

## Supported versions / 维护范围

Only the latest release receives fixes. / 只维护最新版本。

| Version / 版本 | Supported / 是否维护 |
| --- | --- |
| 0.4.x | ✅ |
| ≤ 0.3.x | ❌ |

The WE API service (`wallpaper-engine-api/`) carries its own version number (currently `0.4.0`, visible in `/health`) and moves together with the plugin.
WE API 服务（`wallpaper-engine-api/`）有独立的版本号（当前 `0.4.0`，见 `/health`），随插件一起更新。

## Reporting a vulnerability / 报告漏洞

**Please do not open a public issue.** Use GitHub's private report form:
**请不要开公开 issue**，改用 GitHub 的私密报告入口：

👉 <https://github.com/nishuoyang/dsh-wallpaper-bg/security/advisories/new>

(or the repository's **Security → Report a vulnerability** tab.) If that form is unavailable, contact [@nishuoyang](https://github.com/nishuoyang) on GitHub and ask for a private channel — without putting details in public.
（或在仓库页 **Security → Report a vulnerability**。）表单不可用时，联系 [@nishuoyang](https://github.com/nishuoyang) 要一个私密渠道，别在公开处贴细节。

Please include / 请尽量包含：

- affected version and how you run it (desktop app / `dsh web`) — 受影响版本与运行方式；
- what an attacker could achieve, and the preconditions — 攻击者能达成什么、前提条件；
- steps to reproduce or a proof of concept — 复现步骤或 PoC；
- any suggested fix — 如果有修复建议。

This is a spare-time project: expect an acknowledgement within a few days, and there is no bug bounty. Credit in the advisory / release notes if you want it.
这是业余时间维护的项目：通常几天内会回复，没有赏金；愿意的话会在安全公告和更新日志里署名。

## Scope / 范围

**In scope — 本项目的代码**

- The local WE API service (`wallpaper-engine-api/`, including the `.bat` / `.vbs` scripts): path traversal or arbitrary file read through the file routes, code execution via crafted wallpaper metadata, `we-api.config` parsing, privilege issues in the autostart / restart scripts.
- The DSH plugin (`lib/host.js`, `lib/client.js`, `bin/dsh-wallpaper-bg.js`): XSS in the settings panel, unsafe handling of user-uploaded wallpapers, leaking local paths to a page.
- The release tooling (`scripts/release.ps1`): injection through version / branch / remote input.

**Out of scope — 不属于本项目**

- Wallpaper Engine itself, Steam, or DeepSeek Harness core — please report those upstream.
- Anything that requires an attacker to already have code execution as your user.
- Exposing port 8088 to a network yourself: the service is designed for loopback and a single trusted user, and has no authentication by design.

## Design notes / 设计说明

These are deliberate properties of the project. A report showing that one of them is **not** true is a valid vulnerability:
以下是本项目的既定属性；如果发现其中某条**不成立**，那就是有效漏洞：

- **Read-only with respect to your desktop.** The service lists installed wallpapers, reads their files, and samples the wallpaper Wallpaper Engine is already rendering (`/capture`). It never sets or changes your wallpaper.
  **对桌面只读**：只列列表、读文件、采样 Wallpaper Engine 正在渲染的画面，从不设置或更换壁纸。
- **Loopback only.** The HTTP server binds to `127.0.0.1:8088`; it is not meant to be reachable from other machines.
  **只监听回环地址**：`127.0.0.1:8088`，不面向其他机器。
- **No telemetry.** Nothing is sent anywhere except `127.0.0.1:8088`; there is no analytics and no update ping.
  **无遥测**：除本机 `127.0.0.1:8088` 外不发送任何数据。
- **No writes into the Wallpaper Engine installation.** The service only reads it.
  **不写入 Wallpaper Engine 安装目录**：只读。
