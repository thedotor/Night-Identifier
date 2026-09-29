// Pop-out cards: any dashboard card can be opened alone in a window of its own (the same app loaded at #/card/<id>), to drag to another monitor.
// Every card remembers where it was, how big, and whether it was fullscreen, so it comes back to the same monitor.
import { app, BrowserWindow, ipcMain, type Rectangle } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { lockDown } from './security'
import { pickBounds } from './monitorWindow'

interface Saved {
  bounds?: Rectangle
  fullscreen?: boolean
}

const wins = new Map<string, BrowserWindow>()

const file = (): string => join(app.getPath('userData'), 'card-windows.json')
const readAll = (): Record<string, Saved> => {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Record<string, Saved>
  } catch {
    return {}
  }
}
const write = (id: string, patch: Partial<Saved>): void => {
  try {
    const all = readAll()
    writeFileSync(file(), JSON.stringify({ ...all, [id]: { ...all[id], ...patch } }))
  } catch {
    /* not remembered */
  }
}

// a card id is a plain word: it goes into the address of the window, so nothing else is let through
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id)

export function openCard(id: string, title: string): void {
  const open = wins.get(id)
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore()
    open.show()
    open.focus()
    return
  }
  const saved = readAll()[id] ?? {}
  const w = new BrowserWindow({
    ...pickBounds(saved.bounds),
    minWidth: 320,
    minHeight: 220,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    icon,
    title,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0e14', symbolColor: '#c9d1d9' },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // a card on a second monitor is often covered or off to the side: keep it live
      backgroundThrottling: false
    }
  })
  wins.set(id, w)
  w.once('ready-to-show', () => {
    w.show()
    if (saved.fullscreen) w.setFullScreen(true)
  })
  let timer: NodeJS.Timeout | null = null
  const remember = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (!w.isDestroyed() && !w.isFullScreen() && !w.isMinimized()) write(id, { bounds: w.getNormalBounds() })
    }, 400)
  }
  w.on('resize', remember)
  w.on('move', remember)
  w.on('enter-full-screen', () => write(id, { fullscreen: true }))
  w.on('leave-full-screen', () => write(id, { fullscreen: false }))
  w.on('close', () => {
    if (!w.isFullScreen() && !w.isMinimized()) write(id, { bounds: w.getNormalBounds() })
  })
  w.on('closed', () => {
    if (wins.get(id) === w) wins.delete(id)
  })
  lockDown(w.webContents)
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) w.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/card/${id}`)
  else w.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/card/${id}` })
}

/** Closing the main window ends the app, so the pop-out cards go with it. */
export function closeCards(): void {
  for (const w of wins.values()) if (!w.isDestroyed()) w.close()
}

export function registerCardIpc(getMain: () => BrowserWindow | null): void {
  // a link on a pop-out card ("Follow it in 3D") opens its page in the main window, not in the little window
  ipcMain.handle('card:goto', (_e, route: unknown) => {
    const main = getMain()
    if (!main || main.isDestroyed() || typeof route !== 'string' || !route.startsWith('/') || route.length > 300) return false
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    main.webContents.send('notify:click', route)
    return true
  })
  ipcMain.handle('card:open', (_e, id: unknown, title: unknown) => {
    if (!validId(id)) return false
    openCard(id, typeof title === 'string' ? title.slice(0, 80) : 'Night Identifier')
    return true
  })
}
