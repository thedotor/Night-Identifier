import { useEffect, useState } from 'react'
import { api } from '@renderer/lib/api'
import { parseHeat, parseQuakes, parseVolcanoes, type HeatPayload, type HeatSpot, type Quake, type QuakesPayload, type Volcano, type VolcanoActive, type VolcanoesPayload } from '@renderer/lib/hazards'

interface Base {
  status: 'off' | 'loading' | 'live' | 'error'
  message?: string
}

function usePolled<P>(path: string, enabled: boolean, everyMs: number): { payload: P | null } & Base {
  const [state, setState] = useState<{ payload: P | null } & Base>({ payload: null, status: 'off' })
  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.status === 'off' ? s : { payload: null, status: 'off' }))
      return
    }
    let live = true
    setState((s) => ({ ...s, status: s.payload ? 'live' : 'loading' }))
    const load = (): void => {
      api
        .get<P>(path)
        .then((p) => live && setState({ payload: p, status: 'live' }))
        .catch((e: unknown) => live && setState((s) => ({ ...s, status: 'error', message: e instanceof Error ? e.message.replace(/^\{"detail":"|"\}$/g, '') : 'could not load' })))
    }
    load()
    // the first answer can come before the backend has fetched anything: ask again soon
    const early = window.setTimeout(load, 9000)
    const t = window.setInterval(load, everyMs)
    return () => {
      live = false
      window.clearTimeout(early)
      window.clearInterval(t)
    }
  }, [path, enabled, everyMs])
  return state
}

/** Every earthquake of the last 30 days at magnitude 1 and up (the globe filters by magnitude and age itself), refreshed every minute. */
export function useQuakes(enabled: boolean): { quakes: Quake[] | null; payload: QuakesPayload | null } & Base {
  const s = usePolled<QuakesPayload>('/hazards/quakes?min_mag=1&hours=720', enabled, 60_000)
  const [quakes, setQuakes] = useState<Quake[] | null>(null)
  useEffect(() => {
    setQuakes(s.payload ? parseQuakes(s.payload) : null)
  }, [s.payload])
  return { ...s, quakes }
}

/** The volcanoes, and the ones with activity now. The reports change weekly, the alert levels now and then: every 10 minutes is plenty. */
export function useVolcanoes(enabled: boolean): { volcanoes: Volcano[] | null; active: VolcanoActive[]; payload: VolcanoesPayload | null } & Base {
  const s = usePolled<VolcanoesPayload>('/hazards/volcanoes', enabled, 10 * 60_000)
  const [volcanoes, setVolcanoes] = useState<Volcano[] | null>(null)
  useEffect(() => {
    setVolcanoes(s.payload && s.payload.rows.length ? parseVolcanoes(s.payload) : null)
  }, [s.payload])
  return { ...s, volcanoes, active: s.payload?.active ?? [] }
}

/** NASA FIRMS heat detections (empty without a key). */
export function useHeat(enabled: boolean): { spots: HeatSpot[] | null; payload: HeatPayload | null } & Base {
  const s = usePolled<HeatPayload>('/hazards/heat', enabled, 30 * 60_000)
  const [spots, setSpots] = useState<HeatSpot[] | null>(null)
  useEffect(() => {
    setSpots(s.payload ? parseHeat(s.payload) : null)
  }, [s.payload])
  return { ...s, spots }
}
