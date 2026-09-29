// Hardening for the Electron main process: what a window may open or navigate to, which local files
// the renderer may ask the OS to open, and the per-launch token that lets only this app's windows use the backend.
import { randomBytes } from 'crypto'
import { existsSync, statSync } from 'fs'
import { extname, isAbsolute } from 'path'
import { session, shell, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'

const BACKEND_ORIGINS = ['http://127.0.0.1:8765/*', 'ws://127.0.0.1:8765/*']

/** Random per launch; null in development, where the backend is started by hand and doesn't check. */
export const apiToken: string | null = is.dev ? null : randomBytes(32).toString('hex')

/** Adds the token to every request a window makes to the local backend (including images and WebSockets, which can't set headers themselves). */
export function installBackendAuth(): void {
  if (!apiToken) return
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: BACKEND_ORIGINS }, (details, done) => {
    done({ requestHeaders: { ...details.requestHeaders, 'X-NI-Token': apiToken } })
  })
}

/** Only web links go to the user's browser; file:, ms-*:, custom protocols and the like are refused. */
export function openExternalSafe(url: string): void {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url)
  } catch {
    /* not a URL */
  }
}

/** The app is one page: links open in the browser, and the window itself never navigates away from the app. */
export function lockDown(contents: WebContents): void {
  contents.setWindowOpenHandler((details) => {
    openExternalSafe(details.url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (e, url) => {
    // hash-route changes and the dev server's reloads stay inside the app
    const allowed = is.dev && process.env['ELECTRON_RENDERER_URL'] ? process.env['ELECTRON_RENDERER_URL'] : 'file://'
    if (!url.startsWith(allowed)) {
      e.preventDefault()
      openExternalSafe(url)
    }
  })
  // nothing in the app needs a camera, microphone, geolocation, etc. from the web layer
  contents.session.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'fullscreen' || permission === 'notifications'))
}

// Files the gallery/library open in the user's default viewer. Anything else (an .exe, .bat, .lnk, .msi...) would run.
const OPENABLE = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.raw', '.webp', '.bmp'])

/** True when `path` is an absolute path to an existing folder or a plain image file. */
export function isSafeToOpen(path: unknown): path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || !existsSync(path)) return false
  if (statSync(path).isDirectory()) return true
  return OPENABLE.has(extname(path).toLowerCase())
}
