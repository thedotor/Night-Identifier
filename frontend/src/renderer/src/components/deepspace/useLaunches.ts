import { useEffect, useState } from 'react'
import { api } from '@renderer/lib/api'
import { parseLaunches, type Launch, type LaunchesPayload } from '@renderer/lib/launches'

interface Base {
  status: 'off' | 'loading' | 'live' | 'error'
  message?: string
}

/** Upcoming and recently completed rocket launches (Launch Library 2), refreshed every 5 min (the backend itself throttles further). */
export function useLaunches(enabled: boolean): { launches: Launch[] | null; credit: string | null } & Base {
  const [state, setState] = useState<{ payload: LaunchesPayload | null } & Base>({ payload: null, status: 'off' })
  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.status === 'off' ? s : { payload: null, status: 'off' }))
      return
    }
    let live = true
    setState((s) => ({ ...s, status: s.payload ? 'live' : 'loading' }))
    const load = (): void => {
      api
        .get<LaunchesPayload>('/launches/upcoming')
        .then((p) => live && setState({ payload: p, status: 'live' }))
        .catch((e: unknown) => live && setState((s) => ({ ...s, status: 'error', message: e instanceof Error ? e.message.replace(/^\{"detail":"|"\}$/g, '') : 'could not load' })))
    }
    load()
    const t = window.setInterval(load, 5 * 60_000)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [enabled])
  return { ...state, launches: state.payload ? parseLaunches(state.payload) : null, credit: state.payload?.credit ?? null }
}
