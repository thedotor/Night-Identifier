import { app, shell, BrowserWindow, ipcMain, Menu, dialog, Notification } from 'electron'
import { join } from 'path'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { is } from '@electron-toolkit/utils'

let backendProcess: ChildProcessWithoutNullStreams | null = null

function startBackend(): void {
  // In development, the backend is expected to be started separately (npm run dev:backend)
  // so it can be restarted independently without relaunching Electron.
  if (is.dev) return

  const backendExe = join(process.resourcesPath, 'backend', 'night-identifier-backend.exe')
  backendProcess = spawn(backendExe, [], {
    stdio: 'pipe',
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
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
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0e14',
      symbolColor: '#c9d1d9'
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  Menu.setApplicationMenu(null)

  mainWindow.on('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
    // Windows often refuses to let a newly launched app take the foreground.
    // Briefly marking the window always-on-top forces it above other windows;
    // dropping the flag again leaves it a normal window afterwards.
    mainWindow.setAlwaysOnTop(true)
    mainWindow.focus()
    mainWindow.setAlwaysOnTop(false)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Context-menu IPC handlers (used by the results gallery / image grids)
ipcMain.handle('shell:openPath', async (_e, path: string) => {
  const err = await shell.openPath(path)
  return err === ''
})

ipcMain.handle('shell:showItemInFolder', (_e, path: string) => {
  shell.showItemInFolder(path)
})

ipcMain.handle('dialog:selectDirectory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('app:restart', () => {
  app.relaunch()
  app.exit(0)
})

ipcMain.handle(
  'notify:show',
  (_e, opts: { title: string; body: string; silent?: boolean }): boolean => {
    if (!Notification.isSupported()) return false
    const n = new Notification({ title: opts.title, body: opts.body, silent: opts.silent ?? true })
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
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
  startBackend()
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
