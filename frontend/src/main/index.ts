import { app, shell, BrowserWindow, ipcMain, Menu, dialog, Notification } from 'electron'
import { join } from 'path'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { closeMonitor, openMonitorIfWanted, registerMonitorIpc } from './monitorWindow'
import { closeCards, registerCardIpc } from './cardWindows'
import { apiToken, installBackendAuth, isSafeToOpen, lockDown } from './security'

let backendProcess: ChildProcessWithoutNullStreams | null = null
let mainWindow: BrowserWindow | null = null

function startBackend(): void {
  // In development, the backend is expected to be started separately (npm run dev:backend)
  // so it can be restarted independently without relaunching Electron.
  if (is.dev) return

  const backendExe = join(process.resourcesPath, 'backend', 'night-identifier-backend.exe')
  backendProcess = spawn(backendExe, [], {
    stdio: 'pipe',
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      // only this app's windows get the matching header (see security.ts), so web pages can't use the API
      NIGHT_ID_API_TOKEN: apiToken ?? ''
    }
  })
  backendProcess.stdout?.on('data', (d) => console.log(`[backend] ${d}`))
  backendProcess.stderr?.on('data', (d) => console.error(`[backend] ${d}`))
}

function stopBackend(): void {
  if (!backendProcess) return
  const { pid } = backendProcess
  // Take the whole tree down: training spawns DataLoader worker processes of its own.
  if (pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  else backendProcess.kill()
  backendProcess = null
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    icon,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0e14',
      symbolColor: '#c9d1d9'
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  Menu.setApplicationMenu(null)

  const win = mainWindow
  // closing the main window ends the app, so the second-monitor window goes with it
  // the page follows the window, so leaving fullscreen some other way (the system, the taskbar) brings its sidebar back
  win.on('enter-full-screen', () => win.webContents.send('window:fullscreen', true))
  win.on('leave-full-screen', () => win.webContents.send('window:fullscreen', false))
  win.on('closed', () => {
    mainWindow = null
    closeMonitor()
    closeCards()
  })
  mainWindow.on('ready-to-show', () => {
    mainWindow?.maximize()
    mainWindow?.show()
    // Windows often refuses to let a newly launched app take the foreground.
    // Briefly marking the window always-on-top forces it above other windows;
    // dropping the flag again leaves it a normal window afterwards.
    mainWindow?.setAlwaysOnTop(true)
    mainWindow?.focus()
    mainWindow?.setAlwaysOnTop(false)
    openMonitorIfWanted()
  })

  lockDown(mainWindow.webContents)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Context-menu IPC handlers (used by the results gallery / image grids)
// The renderer only ever asks for folders and image files. Refusing everything else means a compromised
// page can't use these to launch an executable or script.
ipcMain.handle('shell:openPath', async (_e, path: string) => {
  if (!isSafeToOpen(path)) return false
  const err = await shell.openPath(path)
  return err === ''
})

ipcMain.handle('shell:showItemInFolder', (_e, path: string) => {
  if (isSafeToOpen(path)) shell.showItemInFolder(path)
})

ipcMain.handle('dialog:selectDirectory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('app:restart', () => {
  app.relaunch()
  app.exit(0)
})

// Live View's fullscreen: the whole window fills the screen (the page hides its own sidebar and title bar as well)
ipcMain.handle('window:setFullscreen', (e, on: unknown) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (w) w.setFullScreen(!!on)
  return w ? w.isFullScreen() : false
})
ipcMain.handle('window:isFullscreen', (e) => BrowserWindow.fromWebContents(e.sender)?.isFullScreen() ?? false)

ipcMain.handle(
  'notify:show',
  (_e, opts: { title: string; body: string; silent?: boolean; route?: string }): boolean => {
    if (!Notification.isSupported()) return false
    const n = new Notification({ title: opts.title, body: opts.body, silent: opts.silent ?? true })
    n.on('click', () => {
      const win = mainWindow
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      // take the window to the page the notification is about (the renderer decides how to get there)
      if (opts.route) win.webContents.send('notify:click', opts.route)
    })
    n.show()
    return true
  }
)

ipcMain.handle('dialog:selectFiles', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'raw'] }
    ]
  })
  return result.canceled ? [] : result.filePaths
})

app.whenReady().then(() => {
  // Windows attributes toast notifications to this ID; without it they can be dropped or
  // show up under the wrong name in dev.
  app.setAppUserModelId('com.nightidentifier.app')
  installBackendAuth()
  startBackend()
  registerMonitorIpc()
  registerCardIpc(() => mainWindow)
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopBackend()
})
