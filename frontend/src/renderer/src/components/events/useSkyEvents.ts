import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@renderer/lib/api'
import type { Place } from '@renderer/lib/skyTonight'
import type { SkyEvent } from '@renderer/lib/eventTypes'
import { computeEvents, NO_INPUTS, scoreEvents, type CalendarInputs } from '@renderer/lib/skyCalendar'
import { nightSummaries, type NightSummary, type Outlook } from '@renderer/lib/eventScore'
import type { CometElements, AsteroidPass } from '@renderer/lib/eventsSmall'
import type { SpaceWeather } from '@renderer/lib/aurora'
import { kpRows } from '@renderer/lib/aurora'
import type { SunActivity } from '@renderer/lib/sun'
import { findPasses } from '@renderer/lib/satellites'
import { useSatCatalogue } from '@renderer/components/sky/useSatellites'

export interface SkyEventsState {
  /** scored, sorted by time */
  events: SkyEvent[]
  /** the next 14 nights */
  nights: NightSummary[]
  loading: boolean
  stage: string
  error: string | null
  hasForecast: boolean
  /** ms when the events were computed */
  at: number | null
}

const DAY = 86_400_000
const HORIZON_DAYS = 365
const NIGHTS = 14

interface Base {
  key: string
  events: SkyEvent[]
  at: number
}

// one computation is shared by every widget and the Calendar page
let cache: Base | null = null
const listeners = new Set<() => void>()
let running: string | null = null
const shared: { state: SkyEventsState } = { state: { events: [], nights: [], loading: false, stage: '', error: null, hasForecast: false, at: null } }
const publish = (s: Partial<SkyEventsState>): void => {
  shared.state = { ...shared.state, ...s }
  listeners.forEach((l) => l())
}

const placeKey = (p: Place): string => `${p.latDeg.toFixed(2)},${p.lonDeg.toFixed(2)}`
const tick = (): Promise<void> => new Promise((r) => window.setTimeout(r, 0))

/** A source that fails, or is slower than `ms`, is simply left out: the calendar does not wait for it. */
const safe = async <T,>(p: Promise<T>, ms = 12_000): Promise<T | null> => {
  try {
    return await Promise.race([p, new Promise<null>((r) => window.setTimeout(() => r(null), ms))])
  } catch {
    return null
  }
}

/**
 * Nightly, weekly and yearly sky events for a place: everything computed here from real astronomy, plus NASA's comet and asteroid
 * lists, NOAA's space-weather forecast and Open-Meteo's cloud forecast. Shared: the first caller starts the work.
 */
export function useSkyEvents(place: Place | null): SkyEventsState {
  const [, force] = useState(0)
  const sat = useSatCatalogue(['stations'], !!place)
  const satRef = useRef(sat.cat)
  satRef.current = sat.cat
  useEffect(() => {
    const l = (): void => force((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])

  const key = place ? `${placeKey(place)}:${Math.floor(Date.now() / DAY)}:${sat.cat ? 'sat' : 'nosat'}` : null
  useEffect(() => {
    if (!place || !key) {
      publish({ events: [], nights: [], loading: false, stage: '', error: null, at: null })
      return
    }
    if (cache?.key === key || running === key) return
    running = key
    // a shared computation: it carries on if the component that started it goes away, and is dropped only if the place changed
    const stale = (): boolean => running !== key
    ;(async () => {
      publish({ loading: true, stage: 'starting', error: null })
      const from = Math.floor(Date.now() / DAY) * DAY
      const to = from + HORIZON_DAYS * DAY
      const [cometsR, astR, outlookR, swR, sunR, enlilR] = await Promise.all([
        safe(api.get<{ comets: CometElements[] }>('/events/comets')),
        safe(api.get<{ asteroids: AsteroidPass[] }>('/events/asteroids')),
        safe(api.get<Outlook>(`/events/outlook?lat=${place.latDeg}&lon=${place.lonDeg}`)),
        safe(api.get<SpaceWeather>('/aurora/space-weather')),
        safe(api.get<SunActivity>('/sun/activity')),
        safe(api.get<{ rows: number[][] }>('/space/enlil/earth'))
      ])
      const passes: CalendarInputs['passes'] = []
      const cat = satRef.current
      if (cat) {
        for (const [norad, name] of [[25544, 'ISS'], [48274, 'Tiangong']] as const) {
          const rec = cat.records.find((r) => r.norad === norad)
          if (rec) passes.push({ name, norad, passes: findPasses(rec, place, new Date(from), 10 * 24, 20) })
        }
      }
      const inputs: CalendarInputs = {
        comets: cometsR?.comets ?? null,
        asteroids: astR?.asteroids ?? null,
        kp: swR ? kpRows(swR).map((r) => ({ time: r.time, kp: r.kp, kind: r.kind })) : null,
        cmes: sunR?.cmes ?? null,
        enlilRows: enlilR?.rows ?? null,
        passes
      }
      try {
        const events = await computeEvents(place, from, to, inputs, { heavy: true, onStage: (s) => !stale() && publish({ stage: s }), yieldNow: tick })
        if (stale()) return
        const scored = scoreEvents(events, place, outlookR)
        cache = { key, events: scored, at: Date.now() }
        // nights
        // counted from 8 hours ago, so after midnight "tonight" is still the night that began yesterday evening
        const nights = nightSummaries(place, Date.now() - 8 * 3_600_000, NIGHTS, outlookR, scored)
        publish({ events: scored, nights, loading: false, stage: '', error: null, hasForecast: !!outlookR, at: Date.now() })
      } catch (e) {
        publish({ loading: false, error: e instanceof Error ? e.message : 'could not work out the events' })
      } finally {
        if (running === key) running = null
      }
    })()
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => shared.state, [shared.state])
}
