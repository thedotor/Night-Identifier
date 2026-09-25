import { contextBridge, ipcRenderer, webUtils } from 'electron'

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
  showNotification: (opts: { title: string; body: string; silent?: boolean }): Promise<boolean> =>
    ipcRenderer.invoke('notify:show', opts)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
