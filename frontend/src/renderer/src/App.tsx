import { useEffect, useState, type ReactElement } from 'react'
import { HashRouter, Routes, Route, useLocation } from 'react-router-dom'
import { ThemeProvider } from '@renderer/theme/ThemeContext'
import { NotificationProvider } from '@renderer/notifications/NotificationContext'
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
import { MapPage } from '@renderer/pages/MapPage'
import { Settings } from '@renderer/pages/Settings'
import { Notifications } from '@renderer/pages/Notifications'
import { Log } from '@renderer/pages/Log'
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
  return (
    <div className="flex h-screen flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-hidden">
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
            <Route path="/map" element={<MapPage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/log" element={<Log />} />
          </Routes>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}

export function App(): ReactElement {
  const ready = useStartupReady()

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
        <ToastHost />
      </NotificationProvider>
    </ThemeProvider>
  )
}
