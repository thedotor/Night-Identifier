// React glue for the satellite overlay: options (shared by every page, remembered), the orbit data,
// a clock, and the frame the renderer draws. The maths lives in lib/satellites.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@renderer/lib/api'
import * as S from '@renderer/lib/skyMath'
import {
  buildCatalogue,
  buildSatFrame,
  DEFAULT_SAT_OPTIONS,
  elementAgeDays,
  medianEpochMs,
  SAT_GROUPS,
  recordsIn,
  statsOf,
  sampleOne,
  SatTracker,
  TrailCache,
  type SatCatalogue,
  type SatFrame,
  type SatGroupId,
  type SatOptions,
  type SatPayload,
  type SatSample,
  type SatStats,
  type Site
} from '@renderer/lib/satellites'

// ---------- options ----------

const OPTIONS_KEY = 'night-identifier:satellites'
const listeners = new Set<(o: SatOptions) => void>()

function readOptions(): SatOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? 'null') as Partial<SatOptions> | null
    if (!raw) return DEFAULT_SAT_OPTIONS
    const groups = Array.isArray(raw.groups) ? raw.groups.filter((g): g is SatGroupId => SAT_GROUPS.some((s) => s.id === g)) : DEFAULT_SAT_OPTIONS.groups
    return { ...DEFAULT_SAT_OPTIONS, ...raw, groups }
  } catch {
    return DEFAULT_SAT_OPTIONS
  }
}

let current = readOptions()

/** Satellite display options, remembered across pages and sessions and shared between every open view. */
export function useSatOptions(): [SatOptions, (patch: Partial<SatOptions>) => void] {
  const [opts, setOpts] = useState(current)
  useEffect(() => {
    listeners.add(setOpts)
    setOpts(current)
    return () => {
      listeners.delete(setOpts)
    }
  }, [])
  const update = useCallback((patch: Partial<SatOptions>) => {
    current = { ...current, ...patch }
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(current))
    } catch {
      /* not remembered */
    }
    listeners.forEach((l) => l(current))
  }, [])
  return [opts, update]
}

// ---------- data ----------

const RELOAD_AFTER_MS = 20 * 60 * 1000
const loads = new Map<string, { at: number; promise: Promise<SatCatalogue> }>()

/** Fetch (once per group set per 20 minutes) and unpack the orbit data. The backend decides when to re-download from CelesTrak. */
export function loadSatellites(groups: SatGroupId[], force = false): Promise<SatCatalogue> {
  const key = [...groups].sort().join(',')
  const hit = loads.get(key)
  if (hit && !force && Date.now() - hit.at < RELOAD_AFTER_MS) return hit.promise
  const promise = api.get<SatPayload>(`/satellites?groups=${key}`).then(buildCatalogue)
  promise.catch(() => loads.delete(key))
  loads.set(key, { at: Date.now(), promise })
  return promise
}

export interface SatCatalogueState {
  cat: SatCatalogue | null
  loading: boolean
  error: string | null
}

export function useSatCatalogue(groups: SatGroupId[], enabled: boolean): SatCatalogueState {
  const key = [...groups].sort().join(',')
  const [state, setState] = useState<SatCatalogueState>({ cat: null, loading: false, error: null })
  useEffect(() => {
    if (!enabled || !key) {
      setState({ cat: null, loading: false, error: null })
      return
    }
    let live = true
    setState((s) => ({ cat: s.cat, loading: true, error: null }))
    loadSatellites(key.split(',') as SatGroupId[])
      .then((cat) => live && setState({ cat, loading: false, error: null }))
      .catch((e) => live && setState({ cat: null, loading: false, error: e instanceof Error ? e.message : 'Could not load satellites' }))
    return () => {
      live = false
    }
  }, [key, enabled])
  return state
}

// ---------- clock ----------

export type SatClockMode = 'photo' | 'live' | 'scrub'

export interface SatClock {
  /** the instant to show satellites at; null when there is nothing to base it on */
  date: Date | null
  mode: SatClockMode
  offsetS: number
  playing: boolean
  speed: number
  setMode: (m: SatClockMode) => void
  setOffsetS: (s: number) => void
  setPlaying: (p: boolean) => void
  setSpeed: (s: number) => void
  /** back to the photo's own moment */
  reset: () => void
}

/**
 * The time satellites are shown at. For a photo: its own moment, "live" (now, ticking), or scrubbed
 * to any time around it, optionally playing forward. `photoDate` null means the photo carries no
 * time, so only live makes sense and is used.
 */
export function useSatClock(photoDate: Date | null, active: boolean): SatClock {
  const [mode, setMode] = useState<SatClockMode>('photo')
  const [offsetS, setOffsetS] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(10)
  const [now, setNow] = useState(() => Date.now())
  const photoMs = photoDate?.getTime() ?? null
  const effective: SatClockMode = photoMs === null ? 'live' : mode

  useEffect(() => {
    if (!active || (effective !== 'live' && !(effective === 'scrub' && playing))) return
    let last = performance.now()
    const id = setInterval(() => {
      const t = performance.now()
      const dt = (t - last) / 1000
      last = t
      if (effective === 'live') setNow(Date.now())
      else setOffsetS((o) => o + dt * speed)
    }, effective === 'live' ? 250 : 100)
    return () => clearInterval(id)
  }, [active, effective, playing, speed])

  const date = useMemo(() => {
    if (effective === 'live') return new Date(now)
    if (photoMs === null) return null
    return new Date(photoMs + (effective === 'scrub' ? offsetS * 1000 : 0))
  }, [effective, now, photoMs, offsetS])

  const reset = useCallback(() => {
    setMode('photo')
    setOffsetS(0)
    setPlaying(false)
  }, [])

  // A different photo starts on its own moment.
  useEffect(reset, [photoMs, reset])

  return {
    date,
    mode: effective,
    offsetS,
    playing,
    speed,
    setMode: (m) => {
      setMode(m)
      if (m === 'live') setNow(Date.now())
      if (m !== 'scrub') setPlaying(false)
      if (m === 'photo') setOffsetS(0)
    },
    setOffsetS,
    setPlaying,
    setSpeed,
    reset
  }
}

// ---------- the frame ----------

export interface SatView {
  frame: SatFrame | null
  /** what is above the horizon, for the panel */
  stats: SatStats
  cat: SatCatalogue | null
  loading: boolean
  error: string | null
  /** days between the chosen time and the orbit data; large means the positions are not trustworthy */
  ageDays: number
  /** the picked satellite, wherever it is (also below the horizon), for its info card */
  selected: SatSample | null
}

/**
 * Everything the overlay needs, recomputed as the time changes.
 * `frameDate` fixes the camera's frame (photo time; "now" for a live camera), `satDate` is when the
 * satellites are evaluated. They differ only when a still photo is scrubbed through time.
 */
export function useSatView(a: {
  enabled: boolean
  options: SatOptions
  site: Site | null
  frameDate: Date | null
  satDate: Date | null
  selected: number | null
}): SatView {
  const { enabled, options, site, frameDate, satDate, selected } = a
  const { cat, loading, error } = useSatCatalogue(options.groups, enabled && !!site)
  const records = useMemo(() => (cat ? recordsIn(cat, options.groups) : []), [cat, options.groups])
  const tracker = useMemo(() => new SatTracker(records), [records])
  const trails = useRef(new TrailCache())

  const satMs = satDate?.getTime() ?? null
  const frameMs = frameDate?.getTime() ?? null
  const siteKey = site ? `${site.latDeg},${site.lonDeg},${site.heightKm ?? 0}` : ''

  const view = useMemo(() => {
    if (!enabled || !site || satMs === null || frameMs === null || !cat)
      return { frame: null, stats: statsOf([], 0), selectedSample: null as SatSample | null }
    const date = new Date(satMs)
    const samples = tracker.sample(date, site)
    const frameObs: S.Observer = { latDeg: site.latDeg, lonDeg: site.lonDeg, date: new Date(frameMs) }
    const frame = buildSatFrame({ samples, frame: frameObs, site, date, opts: options, trailCache: trails.current, selected })
    const picked = selected === null ? null : (samples.find((s) => s.rec.norad === selected) ?? null)
    const rec = selected === null || picked ? null : cat.records.find((r) => r.norad === selected)
    return { frame, stats: statsOf(samples, frame.dots.length), selectedSample: picked ?? (rec ? sampleOne(rec, date, site) : null) }
    // siteKey stands for `site`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, cat, tracker, siteKey, satMs, frameMs, options, selected])

  const median = useMemo(() => medianEpochMs(records), [records])
  const ageDays = useMemo(() => (satMs === null ? 0 : elementAgeDays(median, new Date(satMs))), [median, satMs])

  return { frame: view.frame, stats: view.stats, cat, loading, error, ageDays, selected: view.selectedSample }
}
