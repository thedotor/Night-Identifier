import { useEffect, useState } from 'react'
import { api } from '@renderer/lib/api'

export interface Asteroid {
  id: string
  name: string
  close_approach_time: number
  miss_distance_km: number
  miss_distance_ld: number
  relative_velocity_kmps: number
  diameter_min_m: number
  diameter_max_m: number
  is_hazardous: boolean
  jpl_url: string | null
}

export interface AsteroidsPayload {
  rows: Asteroid[]
  credit: string
  nasa_key: boolean
}

interface Base {
  status: 'off' | 'loading' | 'live' | 'error'
  message?: string
}

/** Near-Earth asteroids passing close to Earth in the coming week (NASA NeoWs), refreshed hourly. */
export function useAsteroids(enabled: boolean): { asteroids: Asteroid[] | null; payload: AsteroidsPayload | null } & Base {
  const [state, setState] = useState<{ payload: AsteroidsPayload | null } & Base>({ payload: null, status: 'off' })
  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.status === 'off' ? s : { payload: null, status: 'off' }))
      return
    }
    let live = true
    setState((s) => ({ ...s, status: s.payload ? 'live' : 'loading' }))
    const load = (): void => {
      api
        .get<AsteroidsPayload>('/neows/close-approaches')
        .then((p) => live && setState({ payload: p, status: 'live' }))
        .catch((e: unknown) => live && setState((s) => ({ ...s, status: 'error', message: e instanceof Error ? e.message.replace(/^\{"detail":"|"\}$/g, '') : 'could not load' })))
    }
    load()
    const t = window.setInterval(load, 60 * 60_000)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [enabled])
  return { ...state, asteroids: state.payload?.rows ?? null }
}
