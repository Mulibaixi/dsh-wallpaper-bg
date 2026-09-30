/**
 * desktop-capture.js — 桌面壁纸实时捕获（不本地渲染、不落盘）
 * ==========================================================
 * 思路参考 GitHub 上的桌面壁纸同步方案：不去解析 scene.pkg / 烘焙帧，而是直接
 * 抓取 **Wallpaper Engine 正在桌面上渲染的像素**——WE 用自己的引擎（GPU）实时
 * 渲染当前壁纸（场景的粒子 / 着色器 / 骨骼动画都在动），这里只做一次采样：
 *
 *   PrintWindow(Progman, PW_RENDERFULLCONTENT)   ← DWM 合成路径，能拿到 WE 的
 *     WPEDesktopDX11Window(D3D 子窗口) 内容；GDI BitBlt(CAPTUREBLT) 在 DWM 独立
 *     swapchain 合成时拿不到（实测全黑），PrintWindow 才是可靠的桌面壁纸采样。
 *   → 按主屏区域 (虚拟屏偏移) StretchBlt 缩放到目标宽度
 *   → GetDIBits 取原始 BGRA → jpeg-js 编码 JPEG
 *
 * 全程在内存中完成：不写帧文件、不写视频、不创建任何缓存目录。主屏尺寸 /
 * 虚拟屏范围用 GetSystemMetrics 取真实值（Progman 覆盖整个虚拟桌面，主屏在
 * 虚拟坐标 (0,0)，位图偏移 = -SM_XVIRTUALSCREEN）。
 *
 * 已验证（Windows + WE running + DWM on）：
 *   - PrintWindow(Progman) 能拿到含 WE D3D 子窗口的实时桌面画面（帧间有变化）；
 *   - PrintWindow(WE 的 DX11 窗口本身) 返回黑帧（子窗口无独立内容可抓）；
 *   - BitBlt 屏幕/Progman DC 在 DWM 合成下也可能全黑 → PrintWindow 失败时回退。
 *
 * 依赖：koffi（FFI，预编译） + jpeg-js（纯 JS 编码）。
 */
'use strict'

const koffi = require('koffi')
const jpeg = require('jpeg-js')

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')

const FindWindowW = user32.func('void* FindWindowW(str16, str16)')
const GetSystemMetrics = user32.func('int GetSystemMetrics(int)')
const GetDC = user32.func('void* GetDC(void*)')
const ReleaseDC = user32.func('int ReleaseDC(void*, void*)')
const PrintWindow = user32.func('int PrintWindow(void*, void*, uint)')

const CreateCompatibleDC = gdi32.func('void* CreateCompatibleDC(void*)')
const CreateCompatibleBitmap = gdi32.func('void* CreateCompatibleBitmap(void*, int, int)')
const SelectObject = gdi32.func('void* SelectObject(void*, void*)')
const StretchBlt = gdi32.func('int StretchBlt(void*, int, int, int, int, void*, int, int, int, int, uint)')
const BitBlt = gdi32.func('int BitBlt(void*, int, int, int, int, void*, int, int, int, int, uint)')
const GetDIBits = gdi32.func('int GetDIBits(void*, void*, uint, uint, void*, void*, uint)')
const DeleteObject = gdi32.func('int DeleteObject(void*)')
const DeleteDC = gdi32.func('int DeleteDC(void*)')

const PW_RENDERFULLCONTENT = 2
const SRCCOPY = 0x00CC0020
const CAPTUREBLT = 0x40000000
const SM_CXSCREEN = 0
const SM_CYSCREEN = 1
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79

/** 组装 top-down 32bpp BITMAPINFOHEADER（40 字节 + 4 字节调色板占位） */
function makeBmi(width, height) {
  const b = Buffer.alloc(44)
  b.writeUInt32LE(40, 0)
  b.writeInt32LE(width, 4)
  b.writeInt32LE(-height, 8) // 负值 = top-down
  b.writeUInt16LE(1, 12)     // biPlanes
  b.writeUInt16LE(32, 14)    // biBitCount
  return b
}

let lastError = null

/**
 * 捕获当前桌面壁纸的一帧并编码为 JPEG。
 * @param {object} [opts]
 * @param {number} [opts.width=1280] 输出宽度（保持主屏比例）
 * @param {number} [opts.quality=70] JPEG 质量
 * @returns {{ data: Buffer, width: number, height: number, capturedAt: number }}
 * @throws 捕获失败（Progman 不可用 / PrintWindow 与 BitBlt 都失败）
 */
function captureJpeg(opts = {}) {
  const width = Number(opts.width) || 1280
  const quality = Number(opts.quality) || 70
  const progman = FindWindowW('Progman', null)
  if (!progman) {
    lastError = 'Progman 窗口未找到（桌面不可用）'
    throw new Error(lastError)
  }
  const screenW = GetSystemMetrics(SM_CXSCREEN) || 1920
  const screenH = GetSystemMetrics(SM_CYSCREEN) || 1080
  // Progman 覆盖整个虚拟桌面；主屏区域在虚拟坐标 (0,0)，位图偏移 = -虚拟屏原点
  const vmOriginX = GetSystemMetrics(SM_XVIRTUALSCREEN) || 0
  const vmOriginY = GetSystemMetrics(SM_YVIRTUALSCREEN) || 0
  const vmW = GetSystemMetrics(SM_CXVIRTUALSCREEN) || screenW
  const vmH = GetSystemMetrics(SM_CYVIRTUALSCREEN) || screenH
  const offX = Math.max(0, 0 - vmOriginX)
  const offY = Math.max(0, 0 - vmOriginY)
  const dstW = Math.max(160, Math.min(width, screenW))
  const dstH = Math.max(90, Math.round((dstW * screenH) / screenW))

  const memDC = CreateCompatibleDC(null)
  if (!memDC) {
    lastError = 'CreateCompatibleDC 失败'
    throw new Error(lastError)
  }
  const screenDC = GetDC(null)
  if (!screenDC) {
    DeleteDC(memDC)
    lastError = 'GetDC(NULL) 失败'
    throw new Error(lastError)
  }
  try {
    // 虚拟全屏位图：PrintWindow 以窗口自身尺寸绘制（Progman 覆盖整个虚拟桌面）
    const vmBmp = CreateCompatibleBitmap(screenDC, vmW, vmH)
    if (!vmBmp) {
      lastError = 'CreateCompatibleBitmap(虚拟屏) 失败'
      throw new Error(lastError)
    }
    const oldV = SelectObject(memDC, vmBmp)
    let pwOk = PrintWindow(progman, memDC, PW_RENDERFULLCONTENT)
    if (!pwOk) pwOk = PrintWindow(progman, memDC, 0)
    if (!pwOk) {
      // DWM 下 PrintWindow 极少失败：回退到 GDI BitBlt(CAPTUREBLT) 直接采样主屏
      lastError = 'PrintWindow(Progman) 失败，尝试 BitBlt 回退'
    } else {
      lastError = null
    }
    // 输出画布（主屏区域缩放后的大小）
    const outBmp = CreateCompatibleBitmap(screenDC, dstW, dstH)
    if (!outBmp) {
      SelectObject(memDC, oldV)
      DeleteObject(vmBmp)
      DeleteDC(memDC)
      ReleaseDC(null, screenDC)
      lastError = 'CreateCompatibleBitmap(输出) 失败'
      throw new Error(lastError)
    }
    const outDC = CreateCompatibleDC(null)
    const oldO = SelectObject(outDC, outBmp)
    try {
      let bltOk = false
      if (pwOk) {
        // 从虚拟位图 (offX,offY) 处取主屏区域，缩放复制到输出画布
        bltOk = StretchBlt(outDC, 0, 0, dstW, dstH, memDC, offX, offY, screenW, screenH, SRCCOPY)
      } else {
        // 回退：直接从 Progman 的 GDI DC 采主屏区域
        const progmanDC = GetDC(progman)
        if (progmanDC) {
          bltOk = StretchBlt(outDC, 0, 0, dstW, dstH, progmanDC, 0, 0, screenW, screenH, SRCCOPY | CAPTUREBLT)
          ReleaseDC(progman, progmanDC)
        }
      }
      if (!bltOk) {
        lastError = lastError || '桌面采样失败'
        throw new Error(lastError)
      }
      const bmi = makeBmi(dstW, dstH)
      const raw = Buffer.alloc(dstW * dstH * 4)
      if (!GetDIBits(outDC, outBmp, 0, dstH, raw, bmi, 0)) {
        lastError = 'GetDIBits 失败'
        throw new Error(lastError)
      }
      // top-down 32bpp → BGRA，jpeg-js 需要 RGBA
      const rgba = Buffer.alloc(raw.length)
      for (let i = 0; i < raw.length; i += 4) {
        rgba[i] = raw[i + 2]
        rgba[i + 1] = raw[i + 1]
        rgba[i + 2] = raw[i]
        rgba[i + 3] = 255
      }
      // 黑帧检测：抽样判定画面是否为纯黑（WE 暂停渲染 / 桌面被遮盖时如实上报，
      // 客户端据此提示而不是默默黑屏）。像素步长 32 → ≥95% 近黑判定为黑帧。
      let blackSamples = 0
      let blackTotal = 0
      for (let y = 0; y < dstH; y += 32) {
        for (let x = 0; x < dstW; x += 32) {
          const i = (y * dstW + x) * 4
          if (rgba[i] < 18 && rgba[i + 1] < 18 && rgba[i + 2] < 18) blackSamples++
          blackTotal++
        }
      }
      const black = blackTotal > 0 && blackSamples / blackTotal >= 0.95
      const out = jpeg.encode({ data: rgba, width: dstW, height: dstH }, quality)
      lastError = null
      return { data: out.data, width: dstW, height: dstH, capturedAt: Date.now(), black }
    } finally {
      SelectObject(outDC, oldO)
      DeleteObject(outBmp)
      DeleteDC(outDC)
      SelectObject(memDC, oldV)
      DeleteObject(vmBmp)
    }
  } finally {
    ReleaseDC(null, screenDC)
    DeleteDC(memDC)
  }
}

/** 轻量自检：只验证 Progman 与屏幕尺寸（不占带宽），供 /health 上报能力位 */
function probe() {
  const progman = FindWindowW('Progman', null)
  return {
    desktopCapture: progman ? 1 : 0,
    captureError: progman ? lastError : 'Progman 窗口未找到（桌面不可用）',
    primary: progman ? { w: GetSystemMetrics(SM_CXSCREEN), h: GetSystemMetrics(SM_CYSCREEN) } : null,
  }
}

module.exports = { captureJpeg, probe }