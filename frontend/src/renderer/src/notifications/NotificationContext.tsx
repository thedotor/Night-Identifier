import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { wsUrl } from '@renderer/lib/api'

export type NotificationCategory = 'training' | 'starClassifier' | 'results' | 'import' | 'watchFolder' | 'live'
export type NotificationLevel = 'info' | 'success' | 'error'

export const CATEGORY_INFO: Record<NotificationCategory, { label: string; description: string }> = {
  training: { label: 'Model training', description: 'Object-detection training finished, failed, or stopped' },
  starClassifier: { label: 'Star classifier', description: 'Star classifier training finished, failed, or stopped' },
  results: { label: 'Results processing', description: 'Batch detection over your images finished or failed' },
  import: { label: 'Image import', description: 'A batch import finished' },
  watchFolder: { label: 'Watch folder', description: 'A new image was picked up from the watch folder' },
  live: { label: 'Live View', description: 'Motion or a meteor was detected, a camera was lost or came back, or a capture sequence finished' }
}

export interface NotificationSettings {
  enabled: boolean
  inApp: boolean
  windows: boolean
  /** Only send Windows notifications while the app window isn't focused. */
  windowsOnlyWhenUnfocused: boolean
  sound: boolean
  durationSec: number
  position: 'top-right' | 'bottom-right' | 'bottom-left' | 'top-left'
  categories: Record<NotificationCategory, boolean>
}

const DEFAULT_SETTINGS: NotificationSettings = {
  enabled: true,
  inApp: true,
  windows: true,
  windowsOnlyWhenUnfocused: true,
  sound: false,
  durationSec: 6,
  position: 'bottom-right',
  categories: { training: true, starClassifier: true, results: true, import: true, watchFolder: false, live: true }
}

const STORAGE_KEY = 'night-identifier:notifications'

function readStored(): NotificationSettings {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v) {
      const parsed = JSON.parse(v) as Partial<NotificationSettings>
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        categories: { ...DEFAULT_SETTINGS.categories, ...parsed.categories }
      }
    }
  } catch {
    /* localStorage unavailable or corrupt */
  }
  return DEFAULT_SETTINGS
}

export interface Toast {
  id: number
  title: string
  body: string
  level: NotificationLevel
}

interface NotifyInput {
  category: NotificationCategory | 'test'
  level: NotificationLevel
  title: string
  body: string
}

interface NotificationContextValue {
  settings: NotificationSettings
  setSettings: (s: NotificationSettings) => void
  toasts: Toast[]
  dismiss: (id: number) => void
  sendTest: () => void
}

const NotificationContext = createContext<NotificationContextValue | null>(null)

interface WsEvent {
  type?: string
  status?: string
  error?: string
  processed?: number
  total?: number
  filename?: string
  image?: { filename?: string }
  name?: string
  kind?: string
  frames?: number
  stopped_early?: boolean
}

export function NotificationProvider({ children }: { children: ReactNode }): ReactElement {
  const [settings, setSettingsState] = useState<NotificationSettings>(readStored)
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  // Handlers are registered once per socket; read live settings through a ref.
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const setSettings = useCallback((s: NotificationSettings) => {
    setSettingsState(s)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    } catch {
      /* ignore */
    }
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  const notify = useCallback(
    (n: NotifyInput) => {
      const s = settingsRef.current
      const isTest = n.category === 'test'
      if (!isTest && (!s.enabled || !s.categories[n.category as NotificationCategory])) return

      if (s.inApp) {
        const id = nextId.current++
        setToasts((t) => [...t.slice(-4), { id, title: n.title, body: n.body, level: n.level }])
        window.setTimeout(() => dismiss(id), s.durationSec * 1000)
      }

      if (s.windows && (isTest || !s.windowsOnlyWhenUnfocused || !document.hasFocus())) {
        window.api.showNotification({ title: n.title, body: n.body, silent: !s.sound }).catch(() => {})
      }
    },
    [dismiss]
  )

  useEffect(() => {
    const sockets: WebSocket[] = []
    let closed = false

    const listen = (path: string, onEvent: (e: WsEvent) => void): void => {
      const connect = (): void => {
        if (closed) return
        const ws = new WebSocket(wsUrl(path))
        sockets.push(ws)
        ws.onmessage = (m): void => {
          try {
            onEvent(JSON.parse(m.data) as WsEvent)
          } catch {
            /* malformed frame */
          }
        }
        // The backend may not be up yet, or may restart; keep retrying quietly.
        ws.onclose = (): void => {
          if (!closed) window.setTimeout(connect, 3000)
        }
      }
      connect()
    }

    const runStatus =
      (category: 'training' | 'starClassifier', label: string) =>
      (e: WsEvent): void => {
        if (e.type !== 'status') return
        if (e.status === 'completed')
          notify({ category, level: 'success', title: `${label} complete`, body: 'The run finished successfully.' })
        else if (e.status === 'failed')
          notify({ category, level: 'error', title: `${label} failed`, body: e.error ?? 'The run failed.' })
        else if (e.status === 'stopped')
          notify({ category, level: 'info', title: `${label} stopped`, body: 'The run was stopped.' })
      }

    listen('/training/ws', runStatus('training', 'Training'))
    listen('/star-classifier/ws', runStatus('starClassifier', 'Star classifier training'))

    listen('/results/ws', (e) => {
      if (e.type === 'completed')
        notify({
          category: 'results',
          level: 'success',
          title: 'Results processing complete',
          body: `Processed ${e.processed ?? 0} of ${e.total ?? 0} images.`
        })
      else if (e.type === 'error')
        notify({ category: 'results', level: 'error', title: 'Results processing failed', body: e.error ?? '' })
    })

    listen('/live/ws', (e) => {
      const camera = e.name ?? 'A camera'
      if (e.type === 'motion')
        notify({
          category: 'live',
          level: 'info',
          title: e.kind === 'meteor' ? `Meteor or streak on ${camera}` : `Motion on ${camera}`,
          body: 'A picture of the event was saved in the Live folder.'
        })
      else if (e.type === 'photo') notify({ category: 'live', level: 'success', title: `Photo from ${camera}`, body: 'Saved and added to your library.' })
      else if (e.type === 'lost') notify({ category: 'live', level: 'error', title: `${camera} lost`, body: `${e.error ?? 'The connection dropped.'} Retrying automatically.` })
      else if (e.type === 'reconnected') notify({ category: 'live', level: 'success', title: `${camera} is back`, body: 'The camera reconnected.' })
      else if (e.type === 'sequence_done')
        notify({
          category: 'live',
          level: 'success',
          title: e.stopped_early ? 'Capture sequence stopped' : 'Capture sequence finished',
          body: `${e.frames ?? 0} frame${e.frames === 1 ? '' : 's'} saved from ${camera}.`
        })
    })

    listen('/images/ws', (e) => {
      if (e.type === 'import_progress' && e.total && e.processed === e.total)
        notify({
          category: 'import',
          level: 'success',
          title: 'Import complete',
          body: `Finished importing ${e.total} file${e.total === 1 ? '' : 's'}.`
        })
      else if (e.type === 'imported')
        notify({
          category: 'watchFolder',
          level: 'info',
          title: 'New image from watch folder',
          body: e.image?.filename ?? 'An image was imported.'
        })
    })

    return () => {
      closed = true
      sockets.forEach((s) => s.close())
    }
  }, [notify])

  const sendTest = useCallback(() => {
    notify({
      category: 'test',
      level: 'success',
      title: 'Night Identifier',
      body: 'This is a test notification.'
    })
  }, [notify])

  const value = useMemo(
    () => ({ settings, setSettings, toasts, dismiss, sendTest }),
    [settings, setSettings, toasts, dismiss, sendTest]
  )

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotifications must be used inside NotificationProvider')
  return ctx
}
