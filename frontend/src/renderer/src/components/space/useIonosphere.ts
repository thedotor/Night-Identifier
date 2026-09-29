import { useEffect, useState } from 'react'
import { api } from '@renderer/lib/api'
import { parseIonosphereGrid, type IonosphereGrid, type IonosphereGridPayload } from '@renderer/lib/ionosphere'

/** Global TEC grid (CODE), refreshed every 20 minutes (the hour-of-day match is the only thing that changes that often). */
export function useIonosphereGrid(enabled: boolean, everyMs = 20 * 60_000): { grid: IonosphereGrid | null; error: string | null } {
  const [state, setState] = useState<{ grid: IonosphereGrid | null; error: string | null }>({ grid: null, error: null })
  useEffect(() => {
    if (!enabled) return
    let live = true
    const load = (): void => {
      api
        .get<IonosphereGridPayload>('/ionosphere/grid')
        .then((p) => live && setState({ grid: parseIonosphereGrid(p), error: null }))
        .catch((e: unknown) => live && setState((s) => ({ ...s, error: e instanceof Error ? e.message.replace(/^\{"detail":"|"\}$/g, '') : 'could not get the ionosphere map' })))
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
