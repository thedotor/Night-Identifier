import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface MonitorState {
  open: boolean
  fullscreen: boolean
  autoOpen: boolean
}

const api = {
  openPath: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:openPath', path),
  showItemInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:showItemInFolder', path),
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectDirectory'),
  selectFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:selectFiles'),
  // Electron removed File.path for security; this is the replacement for
  // resolving a real filesystem path from a drag-and-dropped File object.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  restartApp: (): Promise<void> => ipcRenderer.invoke('app:restart'),
  showNotification: (opts: { title: string; body: string; silent?: boolean; route?: string }): Promise<boolean> =>
    ipcRenderer.invoke('notify:show', opts),
  /** The second-monitor window: open it (or bring it forward), close it, fullscreen it, and whether it opens by itself at start-up. */
  monitor: {
    open: (): Promise<MonitorState> => ipcRenderer.invoke('monitor:open'),
    close: (): Promise<MonitorState> => ipcRenderer.invoke('monitor:close'),
    toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke('monitor:toggleFullscreen'),
    state: (): Promise<MonitorState> => ipcRenderer.invoke('monitor:state'),
    setAutoOpen: (on: boolean): Promise<MonitorState> => ipcRenderer.invoke('monitor:setAutoOpen', on)
  },
  /** This window's fullscreen, for Live View: set it, ask, and hear when it changes (returns a function that stops listening). */
  window: {
    setFullscreen: (on: boolean): Promise<boolean> => ipcRenderer.invoke('window:setFullscreen', on),
    isFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:isFullscreen'),
    onFullscreen: (cb: (on: boolean) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, on: boolean): void => cb(on)
      ipcRenderer.on('window:fullscreen', handler)
      return () => ipcRenderer.removeListener('window:fullscreen', handler)
    }
  },
  /** Pop-out cards: open one dashboard card alone in a window of its own (or bring it forward if it is already open). */
  card: {
    open: (id: string, title: string): Promise<boolean> => ipcRenderer.invoke('card:open', id, title),
    /** show a page of the app in the main window (from a pop-out window, whose own page must stay put) */
    goto: (route: string): Promise<boolean> => ipcRenderer.invoke('card:goto', route)
  },
  /** Called when a Windows notification with a `route` is clicked; returns a function that stops listening. */
  onNotificationClick: (cb: (route: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, route: string): void => cb(route)
    ipcRenderer.on('notify:click', handler)
    return () => ipcRenderer.removeListener('notify:click', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
