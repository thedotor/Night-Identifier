import { useEffect, useRef, useState } from 'react'
import { api, deepspaceSrc } from '@renderer/lib/api'
import type { SunActivity } from '@renderer/lib/sun'

/** The scene shows about now: pictures and reports are the latest. Otherwise it is history, and they are as of the scene's date. */
const LIVE_WINDOW_MS = 45 * 60_000
/** at most one request per kind this often while the date is moving (playing or dragging the slider) */
const MIN_GAP_MS = 5000

const errText = (e: unknown, fallback: string): string => (e instanceof Error ? e.message.replace(/^\{"detail":"|"\}$/g, '') : fallback)

/** Live (null) or the scene's date, to the hour for pictures and the day for reports, so a moving date does not ask for something new every frame. */
function historyKey(sceneMs: number, stepMs: number): { key: string; dateIso: string | null } {
  if (Math.abs(sceneMs - Date.now()) < LIVE_WINDOW_MS) return { key: 'live', dateIso: null }
  const snapped = Math.floor(sceneMs / stepMs) * stepMs
  return { key: String(snapped), dateIso: new Date(sceneMs).toISOString() }
}

/**
 * One kind of solar picture (visual, magnetogram, euv..., c2, c3) for the scene's date, handed to `onBitmap` as it arrives.
 * `time` is when the picture was actually taken (SDO's visible-light pictures run a few hours behind, SOHO's about half an hour).
 */
export function useSunPicture(kind: string, enabled: boolean, sceneMs: number, onBitmap: (b: ImageBitmap) => void): { time: string | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ time: string | null; loading: boolean; error: string | null }>({ time: null, loading: false, error: null })
  const { key, dateIso } = historyKey(sceneMs, 3_600_000)
  const dateRef = useRef(dateIso)
  dateRef.current = dateIso
  const cb = useRef(onBitmap)
  cb.current = onBitmap
  const lastAt = useRef(0)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!enabled || key !== 'live') return
    const t = window.setInterval(() => setTick((n) => n + 1), 15 * 60_000)
    return () => window.clearInterval(t)
  }, [enabled, key])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const wait = Math.max(0, lastAt.current + MIN_GAP_MS - Date.now())
    const timer = window.setTimeout(async () => {
      lastAt.current = Date.now()
      setState((s) => ({ ...s, loading: true }))
      try {
        const q = new URLSearchParams({ kind })
        if (dateRef.current) q.set('date', dateRef.current)
        const res = await fetch(deepspaceSrc(`/sun/image?${q}`))
        if (!res.ok) throw new Error(res.status === 502 ? 'no connection to the solar image service' : `HTTP ${res.status}`)
        const taken = res.headers.get('X-Image-Time')
        const bitmap = await createImageBitmap(await res.blob())
        if (cancelled) return bitmap.close()
        cb.current(bitmap)
        setState({ time: taken, loading: false, error: null })
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: errText(e, 'could not get the solar picture') }))
      }
    }, wait)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [enabled, kind, key, tick])

  return state
}

/** Flares, X-rays, sunspot groups and CMEs: now (refreshed every 5 minutes) or as of the scene's date. */
export function useSunActivity(enabled: boolean, sceneMs: number): { data: SunActivity | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ data: SunActivity | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false })
  const { key, dateIso } = historyKey(sceneMs, 86_400_000)
  const dateRef = useRef(dateIso)
  dateRef.current = dateIso
  const lastAt = useRef(0)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!enabled || key !== 'live') return
    const t = window.setInterval(() => setTick((n) => n + 1), 5 * 60_000)
    return () => window.clearInterval(t)
  }, [enabled, key])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const wait = Math.max(0, lastAt.current + MIN_GAP_MS - Date.now())
    const timer = window.setTimeout(() => {
      lastAt.current = Date.now()
      setState((s) => ({ ...s, loading: true }))
      api
        .get<SunActivity>(`/sun/activity${dateRef.current ? `?date=${encodeURIComponent(dateRef.current)}` : ''}`)
        .then((d) => !cancelled && setState({ data: d, error: null, loading: false }))
        .catch((e) => !cancelled && setState((s) => ({ ...s, loading: false, error: errText(e, 'could not get solar activity') })))
    }, wait)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [enabled, key, tick])

  return state
}
