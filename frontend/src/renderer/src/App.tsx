import { useEffect, useRef, useState, type ReactElement } from 'react'
import { HashRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { ThemeProvider } from '@renderer/theme/ThemeContext'
import { NotificationProvider } from '@renderer/notifications/NotificationContext'
import { AlertWatchers } from '@renderer/notifications/AlertWatchers'
import { ToastHost } from '@renderer/notifications/ToastHost'
import { Sidebar } from '@renderer/components/Sidebar'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { TitleBar } from '@renderer/components/TitleBar'
import { SplashScreen } from '@renderer/components/SplashScreen'
import { Dashboard } from '@renderer/pages/Dashboard'
import { UploadWatch } from '@renderer/pages/UploadWatch'
import { LiveView } from '@renderer/pages/LiveView'
import { Annotate } from '@renderer/pages/Annotate'
import { ObjectLibrary } from '@renderer/pages/ObjectLibrary'
import { Train } from '@renderer/pages/Train'
import { ResultsGallery } from '@renderer/pages/ResultsGallery'
import { StarClassifier } from '@renderer/pages/StarClassifier'
import { SkyOverlay } from '@renderer/pages/SkyOverlay'
import { DeepSpace } from '@renderer/pages/DeepSpace'
import { EarthPage } from '@renderer/pages/EarthPage'
import { Calendar } from '@renderer/pages/Calendar'
import { MapPage } from '@renderer/pages/MapPage'
import { Settings } from '@renderer/pages/Settings'
import { Notifications } from '@renderer/pages/Notifications'
import { Log } from '@renderer/pages/Log'
import { About } from '@renderer/pages/About'
import { Monitor } from '@renderer/pages/Monitor'
import { CardWindow } from '@renderer/pages/CardWindow'
import { isPopout } from '@renderer/lib/storeNs'
import { useChromeHidden } from '@renderer/lib/appChrome'
import { preloadEarthMaps } from '@renderer/lib/earthPreload'
import { lookupInternetPlace, readMode, resolveLocation } from '@renderer/lib/location'
import { useScrollMemory } from '@renderer/lib/pageState'
import { api } from '@renderer/lib/api'

const MIN_SPLASH_MS = 900
const HEALTH_POLL_MS = 300
const HEALTH_TIMEOUT_MS = 15000

function useStartupReady(): boolean {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    const start = Date.now()

    const tick = async (): Promise<void> => {
      if (cancelled) return
      const elapsed = Date.now() - start
      try {
        await api.health()
        if (cancelled) return
        const remaining = MIN_SPLASH_MS - elapsed
        setTimeout(() => !cancelled && setReady(true), Math.max(remaining, 0))
        return
      } catch {
        if (elapsed > HEALTH_TIMEOUT_MS) {
          // Backend never came up in time; show the app anyway so it isn't
          // stuck forever. Dashboard will surface the connection error.
          setReady(true)
          return
        }
        setTimeout(tick, HEALTH_POLL_MS)
      }
    }
    tick()

    return () => {
      cancelled = true
    }
  }, [])

  return ready
}

function AppShell(): ReactElement {
  const location = useLocation()
  const navigate = useNavigate()
  const chromeHidden = useChromeHidden()
  // every page comes back scrolled to where it was left
  const mainRef = useRef<HTMLElement>(null)
  useScrollMemory(mainRef, location.pathname + (location.search.includes('view=solar') ? '#solar' : ''))
  // A pop-out window shows one thing. A link inside it ("Follow it in 3D") goes to the main window instead, and the pop-out stays where it was.
  const homeHash = useRef(window.location.hash.slice(1))
  const popout = useRef(isPopout())
  useEffect(() => {
    if (!popout.current) return
    const home = homeHash.current.split('?')[0]
    if (location.pathname === home) return
    void window.api.card.goto(location.pathname + location.search)
    navigate(homeHash.current, { replace: true })
  }, [location, navigate])
  // the second-monitor window: just the monitoring cards, no sidebar
  if (location.pathname === '/monitor')
    return (
      <ErrorBoundary>
        <Monitor />
      </ErrorBoundary>
    )
  // a single pop-out card, alone in its own window
  if (location.pathname.startsWith('/card/'))
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/card/:id" element={<CardWindow />} />
        </Routes>
      </ErrorBoundary>
    )
  return (
    <div className="flex h-screen flex-col">
      {!chromeHidden && <TitleBar />}
      <div className="flex min-h-0 flex-1">
        {!chromeHidden && <Sidebar />}
        <main ref={mainRef} className="min-w-0 flex-1 overflow-hidden">
          {/* keyed by page so moving to another page clears a crash */}
          <ErrorBoundary key={location.pathname}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/upload" element={<UploadWatch />} />
            <Route path="/live" element={<LiveView />} />
            <Route path="/annotate" element={<Annotate />} />
            <Route path="/objects" element={<ObjectLibrary />} />
            <Route path="/train" element={<Train />} />
            <Route path="/results" element={<ResultsGallery />} />
            <Route path="/star-classifier" element={<StarClassifier />} />
            <Route path="/sky-overlay" element={<SkyOverlay />} />
            <Route path="/deep-space" element={<DeepSpace />} />
            <Route path="/earth" element={<EarthPage />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/log" element={<Log />} />
            <Route path="/about" element={<About />} />
          </Routes>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}

export function App(): ReactElement {
  const ready = useStartupReady()
  // alerts and toasts belong to the main window: a second window would send every one twice
  const isMonitor = isPopout()
  // the location you chose (manual, internet or override) is what the whole app reads; in Internet mode it is looked up again at every start
  useEffect(() => {
    if (isMonitor || !ready) return
    resolveLocation()
    if (readMode() === 'internet') lookupInternetPlace().catch(() => undefined) // offline: the last place found (or the manual one) stays
  }, [ready]) // eslint-disable-line react-hooks/exhaustive-deps
  // the sharp Earth maps are fetched in the background once the app is up, so the 3D Earth already has them when it opens
  useEffect(() => {
    if (!ready) return
    const t = window.setTimeout(preloadEarthMaps, 2500)
    return () => window.clearTimeout(t)
  }, [ready])

  return (
    <ThemeProvider>
      <NotificationProvider>
        {ready ? (
          <HashRouter>
            <AppShell />
          </HashRouter>
        ) : (
          <SplashScreen />
        )}
        {!isMonitor && <ToastHost />}
        {!isMonitor && <AlertWatchers />}
      </NotificationProvider>
    </ThemeProvider>
  )
}
