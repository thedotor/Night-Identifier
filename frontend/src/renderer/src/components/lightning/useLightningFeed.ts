import { useEffect, useRef, useState } from 'react'
import { api } from '@renderer/lib/api'
import { distanceKm, parseStrikes, stormNear, type LightningStatus, type StormNearYou, type Strike, type StrikePayload } from '@renderer/lib/lightning'
import type { Place } from '@renderer/lib/skyTonight'

const POLL_MS = 3000
/** how far back "the nearest storm" looks */
const STORM_LOOKBACK_MS = 15 * 60_000

export interface FeedOptions {
  enabled: boolean
  /** minutes of history to keep */
  windowMin: number
  place: Place | null
  /** strikes that arrived (`reset`: the list was emptied first, because more history was asked for) */
  onRows?: (rows: Strike[], reset: boolean) => void
  /** a new strike landed within `km` of the place */
  onNear?: (strike: Strike, km: number) => void
  /** how near counts as "near" */
  nearKm?: number
}

export interface FeedState {
  status: LightningStatus | null
  error: string | null
  storm: StormNearYou | null
  /** strikes held inside the window */
  inWindow: number
}

/**
 * Polls the backend for new strikes every few seconds and keeps them for `windowMin` minutes. The strikes
 * themselves go to `onRows` (the 3D view, the map) and stay out of React state, because there can be tens of
 * thousands; what the UI needs to show (counts, the nearest storm) is small and is state.
 */
export function useLightningFeed(o: FeedOptions): { state: FeedState; getStrikes: () => Strike[] } {
  const [state, setState] = useState<FeedState>({ status: null, error: null, storm: null, inWindow: 0 })
  const strikes = useRef<Strike[]>([])
  const seq = useRef(0)
  const loadedAgeS = useRef(0)
  const latest = useRef(o)
  latest.current = o
  const { enabled, windowMin } = o

  useEffect(() => {
    if (!enabled) return
    let live = true
    let busy = false
    const wantS = windowMin * 60
    let reset = false
    if (wantS > loadedAgeS.current) {
      // more history than we have: start again from the backend's buffer
      strikes.current = []
      seq.current = 0
      loadedAgeS.current = wantS
      reset = true
    }
    const poll = async (): Promise<void> => {
      if (busy) return
      busy = true
      try {
        const first = seq.current === 0
        const data = await api.get<StrikePayload>(`/lightning/strikes?since=${seq.current}&max_age_s=${loadedAgeS.current}`)
        const status = await api.get<LightningStatus>('/lightning/status').catch(() => null)
        if (!live) return
        const rows = parseStrikes(data)
        seq.current = Math.max(seq.current, data.seq)
        const cutoff = Date.now() - loadedAgeS.current * 1000
        if (rows.length) strikes.current = strikes.current.concat(rows)
        if (strikes.current.length && strikes.current[0].tMs < cutoff) strikes.current = strikes.current.filter((s) => s.tMs >= cutoff)
        const cur = latest.current
        if (rows.length || reset || first) cur.onRows?.(rows, reset || first)
        reset = false
        if (!first && cur.place && cur.onNear) {
          const limit = cur.nearKm ?? 50
          let best: { s: Strike; km: number } | null = null
          for (const s of rows) {
            const km = distanceKm(cur.place.latDeg, cur.place.lonDeg, s.lat, s.lon)
            if (km <= limit && (!best || km < best.km)) best = { s, km }
          }
          if (best) cur.onNear(best.s, best.km)
        }
        const now = Date.now()
        const inWindow = strikes.current.reduce((n, s) => (s.tMs >= now - latest.current.windowMin * 60_000 ? n + 1 : n), 0)
        setState({ status, error: null, storm: cur.place ? stormNear(strikes.current, cur.place, now, STORM_LOOKBACK_MS) : null, inWindow })
      } catch (e) {
        if (live) setState((s) => ({ ...s, error: e instanceof Error ? e.message : 'could not reach the lightning service' }))
      } finally {
        busy = false
      }
    }
    void poll()
    const t = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [enabled, windowMin])

  return { state, getStrikes: () => strikes.current }
}
