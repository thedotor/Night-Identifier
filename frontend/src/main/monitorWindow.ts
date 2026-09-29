// The second-monitor window: the same app loaded at #/monitor, which shows a dashboard of live monitoring cards of its own.
// It remembers which screen it was on, where and how big, and whether it was fullscreen, so it comes back to the same monitor.
import { app, BrowserWindow, ipcMain, screen, type Rectangle } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { lockDown } from './security'

interface Saved {
  bounds?: Rectangle
  fullscreen?: boolean
  autoOpen?: boolean
}

let win: BrowserWindow | null = null

const file = (): string => join(app.getPath('userData'), 'monitor-window.json')
const read = (): Saved => {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Saved
  } catch {
    return {}
  }
}
const write = (patch: Partial<Saved>): void => {
  try {
    writeFileSync(file(), JSON.stringify({ ...read(), ...patch }))
  } catch {
    /* not remembered */
  }
}

const isOpen = (): boolean => !!win && !win.isDestroyed()

/** The saved position if a good part of it is still on some screen (a monitor may have been unplugged); otherwise the second screen if there is one. */
export function pickBounds(saved: Rectangle | undefined): Rectangle {
  const displays = screen.getAllDisplays()
  if (saved) {
    const onScreen = displays.some((d) => {
      const a = d.workArea
      const w = Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x)
      const h = Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y)
      return w >= 200 && h >= 120
    })
    if (onScreen) return saved
  }
  const primary = screen.getPrimaryDisplay()
  const target = displays.find((d) => d.id !== primary.id) ?? primary
  const a = target.workArea
  const width = Math.min(1280, a.width - 80)
  const height = Math.min(800, a.height - 80)
  return { x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2), width, height }
}

function state(): { open: boolean; fullscreen: boolean; autoOpen: boolean } {
  return { open: isOpen(), fullscreen: isOpen() && win!.isFullScreen(), autoOpen: !!read().autoOpen }
}

export function openMonitor(): void {
  if (isOpen()) {
    if (win!.isMinimized()) win!.restore()
    win!.show()
    win!.focus()
    return
  }
  const saved = read()
  const w = new BrowserWindow({
    ...pickBounds(saved.bounds),
    minWidth: 640,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    icon,
    title: 'Night Identifier Monitor',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0e14', symbolColor: '#c9d1d9' },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // a window on a second monitor is often covered or off to the side: keep its live cards running
      backgroundThrottling: false
    }
  })
  win = w
  w.once('ready-to-show', () => {
    w.show()
    if (saved.fullscreen) w.setFullScreen(true)
  })
  let timer: NodeJS.Timeout | null = null
  const remember = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (!w.isDestroyed() && !w.isFullScreen() && !w.isMinimized()) write({ bounds: w.getNormalBounds() })
    }, 400)
  }
  w.on('resize', remember)
  w.on('move', remember)
  w.on('enter-full-screen', () => write({ fullscreen: true }))
  w.on('leave-full-screen', () => write({ fullscreen: false }))
  w.on('close', () => {
    if (!w.isFullScreen() && !w.isMinimized()) write({ bounds: w.getNormalBounds() })
  })
  w.on('closed', () => {
    if (win === w) win = null
  })
  lockDown(w.webContents)
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) w.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/monitor`)
  else w.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/monitor' })
}

export function closeMonitor(): void {
  if (isOpen()) win!.close()
}

/** Open it at start-up when the user has asked for that. */
export function openMonitorIfWanted(): void {
  if (read().autoOpen) openMonitor()
}

export function registerMonitorIpc(): void {
  ipcMain.handle('monitor:open', () => {
    openMonitor()
    return state()
  })
  ipcMain.handle('monitor:close', () => {
    closeMonitor()
    return state()
  })
  ipcMain.handle('monitor:toggleFullscreen', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) w.setFullScreen(!w.isFullScreen())
    return w ? w.isFullScreen() : false
  })
  ipcMain.handle('monitor:state', () => state())
  ipcMain.handle('monitor:setAutoOpen', (_e, on: boolean) => {
    write({ autoOpen: !!on })
    return state()
  })
}
