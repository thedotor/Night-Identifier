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
import { inQuietHours, type QuietHours } from './alertLogic'

export type NotificationCategory =
  | 'training'
  | 'starClassifier'
  | 'results'
  | 'import'
  | 'watchFolder'
  | 'live'
  | 'issPass'
  | 'lightningNear'
  | 'stormApproaching'
  | 'clearNight'
  | 'auroraChance'
  | 'geomagneticStorm'
  | 'skyEvent'
  | 'bzSouth'
  | 'shockArrival'
  | 'dstStorm'
  | 'solarFlare'
  | 'cmeEarth'
  | 'quakeNear'
  | 'quakeBig'
  | 'quakeSwarm'
  | 'volcanoAlert'
  | 'cameraHealth'
  | 'dataStale'
  | 'diskSpace'
export type NotificationLevel = 'info' | 'success' | 'error'
export type CategoryGroup = 'Work' | 'Live View' | 'Sky' | 'Earth' | 'System'

export const GROUP_ORDER: CategoryGroup[] = ['Work', 'Live View', 'Sky', 'Earth', 'System']

export const CATEGORY_INFO: Record<NotificationCategory, { label: string; description: string; group: CategoryGroup; page: string }> = {
  training: { label: 'Model training', description: 'Object-detection training finished, failed, or stopped', group: 'Work', page: '/train' },
  starClassifier: { label: 'Star classifier', description: 'Star classifier training finished, failed, or stopped', group: 'Work', page: '/star-classifier' },
  results: { label: 'Results processing', description: 'Batch detection over your images finished or failed', group: 'Work', page: '/results' },
  import: { label: 'Image import', description: 'A batch import finished', group: 'Work', page: '/upload' },
  watchFolder: { label: 'Watch folder', description: 'A new image was picked up from the watch folder', group: 'Work', page: '/upload' },
  live: { label: 'Live View', description: 'Motion or a meteor was detected, a camera was lost or came back, or a capture sequence finished', group: 'Live View', page: '/live' },
  cameraHealth: { label: 'Camera health', description: 'A Canon camera has a low battery or a nearly full memory card, or its mode dial is not on M during a capture sequence', group: 'Live View', page: '/live' },
  issPass: { label: 'ISS pass', description: 'The International Space Station is about to pass over your saved location', group: 'Sky', page: '/' },
  lightningNear: { label: 'Lightning near you', description: 'A lightning strike landed within a set distance of your saved location', group: 'Sky', page: '/deep-space?view=solar&focus=earth' },
  stormApproaching: { label: 'Storm approaching', description: 'A thunderstorm is moving toward your saved location', group: 'Sky', page: '/deep-space?view=solar&focus=earth' },
  auroraChance: { label: 'Aurora at your location', description: 'The aurora forecast for your saved location passes a chance you choose, and it is dark there', group: 'Sky', page: '/deep-space?view=solar&focus=earth' },
  solarFlare: { label: 'Strong solar flare', description: 'A flare of the class you choose or stronger (M5 by default) is seen on the Sun', group: 'Sky', page: '/deep-space?view=solar&focus=sun' },
  cmeEarth: { label: 'CME heading for Earth', description: 'A coronal mass ejection is on its way to Earth, with the predicted arrival time', group: 'Sky', page: '/deep-space?view=solar&focus=sun' },
  bzSouth: { label: 'Southward Bz (aurora fuel)', description: "The solar wind's magnetic field points strongly south for a quarter of an hour, which lets its energy into the Earth's field", group: 'Sky', page: '/deep-space?view=solar&focus=earth' },
  shockArrival: { label: 'Solar wind shock', description: 'A sudden jump in the wind (a shock) has been seen at L1, about an hour before it reaches Earth', group: 'Sky', page: '/deep-space?view=solar&focus=earth' },
  dstStorm: { label: 'Magnetic storm under way', description: "The Dst index (the ring current's effect on the field at the equator) drops to storm level", group: 'Sky', page: '/deep-space?view=solar&focus=earth' },
  skyEvent: { label: 'Sky event reminders', description: 'A few hours before an eclipse, meteor shower, occultation, planet event, bright comet or aurora forecast that suits your sky, and before any event you marked with Remind me', group: 'Sky', page: '/calendar' },
  geomagneticStorm: { label: 'Geomagnetic storm', description: 'The Kp index reaches storm level, which pushes the aurora far from the poles', group: 'Sky', page: '/' },
  clearNight: { label: 'Clear night ahead', description: "Once a day, before sunset, when tonight's forecast is good for stargazing", group: 'Sky', page: '/' },
  quakeNear: { label: 'Earthquake near you', description: 'An earthquake above a size you choose within a distance you choose of your saved location (USGS)', group: 'Earth', page: '/deep-space?view=solar&focus=earth&show=quakes' },
  quakeBig: { label: 'Big earthquake', description: 'An earthquake at or above a size you choose (6.5 by default) anywhere in the world, and any with a tsunami warning', group: 'Earth', page: '/deep-space?view=solar&focus=earth&show=quakes' },
  quakeSwarm: { label: 'Earthquake swarm', description: 'Many earthquakes in one small area within an hour near your saved location, a sign of a bigger event or a volcano waking', group: 'Earth', page: '/deep-space?view=solar&focus=earth&show=quakes' },
  volcanoAlert: { label: 'Volcano activity', description: 'A volcano is newly reported erupting, or its alert level goes up (Smithsonian / USGS weekly report and USGS alert levels), worldwide or only near you', group: 'Earth', page: '/deep-space?view=solar&focus=earth&show=volcanoes' },
  dataStale: { label: 'Data out of date', description: 'Satellite orbit data or the live cloud map could not be refreshed for a while', group: 'System', page: '/settings' },
  diskSpace: { label: 'Disk space low', description: 'The drive the library and Live View captures are saved on is running out of room', group: 'System', page: '/settings' }
}

/** Numbers the alerts are tuned with. */
export interface NotificationParams {
  issLeadMin: number
  issMinElevation: number
  issVisibleOnly: boolean
  lightningKm: number
  lightningCooldownMin: number
  stormKm: number
  stormMinSpeedKmH: number
  clearNightMaxCloud: number
  clearNightLeadMin: number
  auroraChancePct: number
  stormKp: number
  eventLeadH: number
  eventMinScore: number
  bzSouthNt: number
  dstStormNt: number
  flareMinM: number
  batteryPct: number
  shotsLeft: number
  staleDays: number
  diskFreeGB: number
  quakeNearMag: number
  quakeNearKm: number
  quakeBigMag: number
  swarmCount: number
  swarmWithinKm: number
  volcanoKm: number
}

export const DEFAULT_PARAMS: NotificationParams = {
  issLeadMin: 10,
  issMinElevation: 20,
  issVisibleOnly: true,
  lightningKm: 50,
  lightningCooldownMin: 30,
  stormKm: 150,
  stormMinSpeedKmH: 15,
  clearNightMaxCloud: 30,
  clearNightLeadMin: 60,
  auroraChancePct: 20,
  stormKp: 5,
  eventLeadH: 3,
  eventMinScore: 45,
  bzSouthNt: 10,
  dstStormNt: 50,
  flareMinM: 5,
  batteryPct: 20,
  shotsLeft: 100,
  staleDays: 7,
  diskFreeGB: 10,
  quakeNearMag: 3,
  quakeNearKm: 200,
  quakeBigMag: 6.5,
  swarmCount: 6,
  swarmWithinKm: 500,
  volcanoKm: 0
}

/** How one type is delivered, when it differs from the general setting (`undefined`: follow the general setting). */
export interface DeliveryOverride {
  inApp?: boolean
  windows?: boolean
  sound?: boolean
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
  overrides: Partial<Record<NotificationCategory, DeliveryOverride>>
  params: NotificationParams
  /** nothing pops up or makes a sound during these hours; everything still goes to the history */
  quiet: QuietHours
}

const DEFAULT_SETTINGS: NotificationSettings = {
  enabled: true,
  inApp: true,
  windows: true,
  windowsOnlyWhenUnfocused: true,
  sound: false,
  durationSec: 6,
  position: 'bottom-right',
  // the work and camera ones as before; of the new ones, the safety alerts start on and the "nice to know" ones off
  categories: {
    training: true,
    starClassifier: true,
    results: true,
    import: true,
    watchFolder: false,
    live: true,
    cameraHealth: true,
    issPass: false,
    lightningNear: true,
    stormApproaching: true,
    clearNight: false,
    auroraChance: true,
    geomagneticStorm: true,
    skyEvent: true,
    bzSouth: true,
    shockArrival: true,
    dstStorm: true,
    solarFlare: true,
    cmeEarth: true,
    quakeNear: true,
    quakeBig: true,
    quakeSwarm: true,
    volcanoAlert: true,
    dataStale: false,
    diskSpace: true
  },
  overrides: {},
  params: DEFAULT_PARAMS,
  quiet: { enabled: false, start: '23:00', end: '07:00' }
}

const STORAGE_KEY = 'night-identifier:notifications'
const HISTORY_KEY = 'night-identifier:notification-history'
const HISTORY_MAX = 200

function readStored(): NotificationSettings {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v) {
      const parsed = JSON.parse(v) as Partial<NotificationSettings>
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        categories: { ...DEFAULT_SETTINGS.categories, ...parsed.categories },
        overrides: { ...parsed.overrides },
        params: { ...DEFAULT_PARAMS, ...parsed.params },
        quiet: { ...DEFAULT_SETTINGS.quiet, ...parsed.quiet }
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
  /** where clicking it goes (a hash route such as "/live") */
  route?: string
}

export interface HistoryItem {
  id: number
  /** ms since 1970 */
  t: number
  category: NotificationCategory | 'test'
  level: NotificationLevel
  title: string
  body: string
  route?: string
  /** it arrived during quiet hours, so it was not shown */
  quiet?: boolean
  read: boolean
}

function readHistory(): HistoryItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as HistoryItem[]
    return Array.isArray(v) ? v.slice(-HISTORY_MAX) : []
  } catch {
    return []
  }
}

export interface NotifyInput {
  category: NotificationCategory | 'test'
  level: NotificationLevel
  title: string
  body: string
  /** where clicking the notification goes; defaults to the page for its type */
  route?: string
}

interface NotificationContextValue {
  settings: NotificationSettings
  setSettings: (s: NotificationSettings) => void
  toasts: Toast[]
  dismiss: (id: number) => void
  sendTest: (category?: NotificationCategory) => void
  /** send a notification through the user's settings (used by the alert watchers) */
  notify: (n: NotifyInput) => void
  history: HistoryItem[]
  unread: number
  markAllRead: () => void
  clearHistory: () => void
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

/** Go to a page from a notification. The router listens to the hash, so this works from outside it. */
export function goToRoute(route: string): void {
  window.location.hash = `#${route.startsWith('/') ? route : `/${route}`}`
}

export function NotificationProvider({ children }: { children: ReactNode }): ReactElement {
  const [settings, setSettingsState] = useState<NotificationSettings>(readStored)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [history, setHistory] = useState<HistoryItem[]>(readHistory)
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

  const record = useCallback((item: Omit<HistoryItem, 'id' | 'read'>) => {
    setHistory((h) => {
      const next = [...h, { ...item, id: Date.now() * 1000 + (h.length % 1000), read: false }].slice(-HISTORY_MAX)
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const notify = useCallback(
    (n: NotifyInput) => {
      const s = settingsRef.current
      const isTest = n.category === 'test'
      if (!isTest && (!s.enabled || !s.categories[n.category as NotificationCategory])) return
      const route = n.route ?? (isTest ? undefined : CATEGORY_INFO[n.category as NotificationCategory].page)
      const quiet = !isTest && inQuietHours(s.quiet, new Date())
      record({ t: Date.now(), category: n.category, level: n.level, title: n.title, body: n.body, route, quiet })
      if (quiet) return // quiet hours: nothing pops up and nothing makes a sound

      const over = isTest ? undefined : s.overrides[n.category as NotificationCategory]
      const inApp = over?.inApp ?? s.inApp
      const windows = over?.windows ?? s.windows
      const sound = over?.sound ?? s.sound

      if (inApp) {
        const id = nextId.current++
        setToasts((t) => [...t.slice(-4), { id, title: n.title, body: n.body, level: n.level, route }])
        window.setTimeout(() => dismiss(id), s.durationSec * 1000)
      }

      if (windows && (isTest || !s.windowsOnlyWhenUnfocused || !document.hasFocus())) {
        window.api.showNotification({ title: n.title, body: n.body, silent: !sound, route }).catch(() => {})
      }
    },
    [dismiss, record]
  )

  // a click on a Windows notification takes the window to that page
  useEffect(() => window.api.onNotificationClick?.((route) => goToRoute(route)), [])

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

  const sendTest = useCallback(
    (category?: NotificationCategory) => {
      const info = category ? CATEGORY_INFO[category] : null
      notify({
        category: 'test',
        level: 'success',
        title: info ? `Test: ${info.label}` : 'Night Identifier',
        body: info ? 'This is how this type of notification will look. Click it to open its page.' : 'This is a test notification.',
        route: info?.page
      })
    },
    [notify]
  )

  const markAllRead = useCallback(() => {
    setHistory((h) => {
      if (!h.some((x) => !x.read)) return h
      const next = h.map((x) => ({ ...x, read: true }))
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const clearHistory = useCallback(() => {
    setHistory([])
    try {
      localStorage.removeItem(HISTORY_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  const unread = useMemo(() => history.reduce((n, h) => (h.read ? n : n + 1), 0), [history])

  const value = useMemo(
    () => ({ settings, setSettings, toasts, dismiss, sendTest, notify, history, unread, markAllRead, clearHistory }),
    [settings, setSettings, toasts, dismiss, sendTest, notify, history, unread, markAllRead, clearHistory]
  )

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotifications must be used inside NotificationProvider')
  return ctx
}
