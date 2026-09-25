import { useCallback, useEffect, useState } from 'react'
import { live, type LiveCamera } from '@renderer/lib/liveApi'
import { liveSocket } from '@renderer/lib/liveSocket'

/** The saved cameras with their live status, kept current by the WebSocket's status events. */
export function useLiveCameras(): { cameras: LiveCamera[]; loaded: boolean; error: string | null; refresh: () => Promise<void>; connected: boolean } {
  const [cameras, setCameras] = useState<LiveCamera[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(liveSocket.open)

  const refresh = useCallback(async () => {
    try {
      const list = await live.cameras()
      setCameras(list.map((c) => ({ ...c, status: liveSocket.statuses[c.id] ?? c.status })))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const release = liveSocket.retain()
    const offEvents = liveSocket.onEvent((ev) => {
      if (ev.type === 'status') {
        setCameras((cs) => cs.map((c) => (c.id === ev.id ? { ...c, status: ev } : c)))
      } else if (ev.type === 'hello') {
        setCameras((cs) => cs.map((c) => ({ ...c, status: ev.cameras[c.id] ?? c.status })))
      }
    })
    const offConn = liveSocket.onConnection((open) => {
      setConnected(open)
      if (open) void refresh()
    })
    return () => {
      offEvents()
      offConn()
      release()
    }
  }, [refresh])

  return { cameras, loaded, error, refresh, connected }
}
