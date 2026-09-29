import { useEffect, useRef, useState } from 'react'
import { api, deepspaceSrc } from '@renderer/lib/api'

export interface DstPayload {
  series: [number, number][]
  now: [number, number]
  forecast: [number, number][]
  credit: string
}

export interface StationPayload {
  id: string
  name: string
  lat: number
  lon: number
  time: number
  x: number
  y: number
  z: number
  f: number
  range_1h: number
  range_3h: number
  max_step: number
  spark: [number, number][]
}

export interface StationsPayload {
  stations: StationPayload[]
  errors: string[]
  fetched_at: number
  credit: string
}

export interface EnlilEarth {
  /** [t_ms, speed km/s, density /cm3, field nT, temperature K] hourly */
  rows: number[][]
  columns: string[]
  credit: string
}

const errText = (e: unknown, fallback: string): string => (e instanceof Error ? e.message.replace(/^\{"detail":"|"\}$/g, '') : fallback)

function usePolled<T>(path: string, enabled: boolean, everyMs: number): { data: T | null; error: string | null } {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null })
  useEffect(() => {
    if (!enabled) return
    let live = true
    const load = (): void => {
      api
        .get<T>(path)
        .then((d) => live && setState({ data: d, error: null }))
        .catch((e) => live && setState((s) => ({ ...s, error: errText(e, 'no connection') })))
    }
    load()
    const t = window.setInterval(load, everyMs)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [path, enabled, everyMs])
  return state
}

/** Dst, the ground magnetometers and NOAA's Enlil forecast at Earth, refreshed as often as they change. */
export function useSpaceEnv(enabled: boolean): { dst: DstPayload | null; stations: StationsPayload | null; enlilEarth: EnlilEarth | null; error: string | null } {
  const dst = usePolled<DstPayload>('/space/dst', enabled, 5 * 60_000)
  const stations = usePolled<StationsPayload>('/space/stations', enabled, 2 * 60_000)
  const enlil = usePolled<EnlilEarth>('/space/enlil/earth', enabled, 30 * 60_000)
  return { dst: dst.data, stations: stations.data, enlilEarth: enlil.data, error: dst.error && stations.error ? dst.error : null }
}

const HOUR = 3_600_000
const MIN_GAP_MS = 4000

export interface EnlilFrameInfo {
  frameMs: number | null
  firstMs: number | null
  lastMs: number | null
  auFraction: number
  loading: boolean
  error: string | null
  /** the scene's date is inside the days NOAA's model covers */
  covered: boolean
}

/**
 * NOAA's WSA-Enlil picture nearest the scene's date (density or velocity panel), handed to `onBitmap` (null when the date is outside
 * the days the model covers). One request at most every few seconds while the date is moving.
 */
export function useEnlilFrame(enabled: boolean, panel: 'density' | 'velocity', sceneMs: number, onBitmap: (b: ImageBitmap | null, auFraction: number) => void): EnlilFrameInfo {
  const [info, setInfo] = useState<EnlilFrameInfo>({ frameMs: null, firstMs: null, lastMs: null, auFraction: 0.5884, loading: false, error: null, covered: true })
  const cb = useRef(onBitmap)
  cb.current = onBitmap
  const bucket = Math.floor(sceneMs / HOUR)
  const lastAt = useRef(0)
  const range = useRef<[number, number] | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // once the covered range is known, dates outside it need no request
    const r = range.current
    if (r && (bucket * HOUR < r[0] - 2 * HOUR || bucket * HOUR > r[1] + 2 * HOUR)) {
      cb.current(null, 0.5884)
      setInfo((s) => ({ ...s, covered: false, loading: false }))
      return
    }
    const wait = Math.max(0, lastAt.current + MIN_GAP_MS - Date.now())
    const timer = window.setTimeout(async () => {
      lastAt.current = Date.now()
      setInfo((s) => ({ ...s, loading: true }))
      try {
        const res = await fetch(deepspaceSrc(`/space/enlil/image?panel=${panel}&t=${bucket * HOUR + HOUR / 2}`))
        if (!res.ok) throw new Error(res.status === 502 ? 'no connection to NOAA' : `HTTP ${res.status}`)
        const frameMs = Number(res.headers.get('X-Frame-Time'))
        const firstMs = Number(res.headers.get('X-First-Frame'))
        const lastMs = Number(res.headers.get('X-Last-Frame'))
        const auFraction = Number(res.headers.get('X-Au-Fraction')) || 0.5884
        range.current = [firstMs, lastMs]
        const covered = sceneMs >= firstMs - 2 * HOUR && sceneMs <= lastMs + 2 * HOUR
        if (!covered) {
          if (!cancelled) {
            cb.current(null, auFraction)
            setInfo({ frameMs, firstMs, lastMs, auFraction, loading: false, error: null, covered: false })
          }
          return
        }
        const bitmap = await createImageBitmap(await res.blob())
        if (cancelled) return bitmap.close()
        cb.current(bitmap, auFraction)
        setInfo({ frameMs, firstMs, lastMs, auFraction, loading: false, error: null, covered: true })
      } catch (e) {
        if (!cancelled) setInfo((s) => ({ ...s, loading: false, error: errText(e, 'could not get the model picture') }))
      }
    }, wait)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [enabled, panel, bucket]) // eslint-disable-line react-hooks/exhaustive-deps
  return info
}
