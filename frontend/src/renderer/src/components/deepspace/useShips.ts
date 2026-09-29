import { useEffect, useState } from 'react'
import { api } from '@renderer/lib/api'
import { parseShips, type Ship, type ShipsPayload } from '@renderer/lib/ships'

export interface ShipsState {
  ships: Ship[] | null
  status: 'off' | 'loading' | 'live' | 'error'
  message?: string
  payload: ShipsPayload | null
}

const REFRESH_MS = 60_000

/** The ships the backend knows about, refreshed every minute while the layer is on. The last picture stays when the connection drops. */
export function useShips(enabled: boolean): ShipsState {
  const [state, setState] = useState<ShipsState>({ ships: null, status: 'off', payload: null })
  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.status === 'off' ? s : { ships: null, status: 'off', payload: null }))
      return
    }
    let live = true
    setState((s) => ({ ...s, status: s.ships ? 'live' : 'loading' }))
    const load = (): void => {
      api
        .get<ShipsPayload>('/ships/world')
        .then((p) => live && setState({ ships: parseShips(p), status: 'live', payload: p }))
        .catch((e: unknown) => live && setState((s) => ({ ...s, status: 'error', message: e instanceof Error ? e.message.replace(/^\{"detail":"|"\}$/g, '') : 'could not load ships' })))
    }
    load()
    // the first answer can come before the feeds have anything: ask again soon
    const early = window.setTimeout(load, 8000)
    const t = window.setInterval(load, REFRESH_MS)
    return () => {
      live = false
      window.clearTimeout(early)
      window.clearInterval(t)
    }
  }, [enabled])
  return state
}
