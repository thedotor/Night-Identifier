import { useEffect, useState } from 'react'
import { api } from '@renderer/lib/api'
import { parseAqiStations, type AqiPayload, type AqiStation } from '@renderer/lib/aqi'

interface Base {
  status: 'off' | 'loading' | 'live' | 'error'
  message?: string
}

/** Air quality stations (OpenAQ), refreshed every 45 minutes. Empty (not an error) without a saved OpenAQ key. */
export function useAqiStations(enabled: boolean): { stations: AqiStation[] | null; payload: AqiPayload | null } & Base {
  const [state, setState] = useState<{ payload: AqiPayload | null } & Base>({ payload: null, status: 'off' })
  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.status === 'off' ? s : { payload: null, status: 'off' }))
      return
    }
    let live = true
    setState((s) => ({ ...s, status: s.payload ? 'live' : 'loading' }))
    const load = (): void => {
      api
        .get<AqiPayload>('/aqi/stations')
        .then((p) => live && setState({ payload: p, status: 'live' }))
        .catch((e: unknown) => live && setState((s) => ({ ...s, status: 'error', message: e instanceof Error ? e.message.replace(/^\{"detail":"|"\}$/g, '') : 'could not load' })))
    }
    load()
    const t = window.setInterval(load, 45 * 60_000)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [enabled])
  return { ...state, stations: state.payload ? parseAqiStations(state.payload) : null, payload: state.payload }
}
