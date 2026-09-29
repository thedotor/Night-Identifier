import { useEffect, useState } from 'react'
import { api } from '@renderer/lib/api'
import { parseGrid, type AuroraGrid, type AuroraGridPayload, type SpaceWeather } from '@renderer/lib/aurora'

/** The latest aurora chance grid, refreshed every few minutes (NOAA publishes a new one every 5). */
export function useAuroraGrid(enabled: boolean, everyMs = 5 * 60_000): { grid: AuroraGrid | null; error: string | null } {
  const [state, setState] = useState<{ grid: AuroraGrid | null; error: string | null }>({ grid: null, error: null })
  useEffect(() => {
    if (!enabled) return
    let live = true
    const load = (): void => {
      api
        .get<AuroraGridPayload>('/aurora/grid')
        .then((p) => live && setState({ grid: parseGrid(p), error: null }))
        .catch((e) => live && setState((s) => ({ ...s, error: e instanceof Error ? e.message.replace(/^\{"detail":"|"\}$/g, '') : 'could not get the aurora forecast' })))
    }
    load()
    const t = window.setInterval(load, everyMs)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [enabled, everyMs])
  return state
}

/** Kp, the solar wind and Bz, refreshed every minute or two. */
export function useSpaceWeather(enabled: boolean, everyMs = 90_000): { data: SpaceWeather | null; error: string | null } {
  const [state, setState] = useState<{ data: SpaceWeather | null; error: string | null }>({ data: null, error: null })
  useEffect(() => {
    if (!enabled) return
    let live = true
    const load = (): void => {
      api
        .get<SpaceWeather>('/aurora/space-weather')
        .then((d) => live && setState({ data: d, error: null }))
        .catch((e) => live && setState((s) => ({ ...s, error: e instanceof Error ? e.message.replace(/^\{"detail":"|"\}$/g, '') : 'could not get space weather' })))
    }
    load()
    const t = window.setInterval(load, everyMs)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [enabled, everyMs])
  return state
}
