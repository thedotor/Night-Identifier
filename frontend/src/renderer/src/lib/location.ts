import { useCallback, useEffect, useState } from 'react'
import { api } from '@renderer/lib/api'

/**
 * Where you are, from one of three sources:
 *   manual    the place typed in (the default)
 *   internet  found from this computer's internet address (approximate: a city, not a street), at every start and on Refresh
 *   override  coordinates forced by hand; they beat everything else (to look at the sky from another site)
 * Everything else in the app reads ONE value, `night-identifier:last-location`, which this module keeps equal to the chosen source.
 */
export type LocationMode = 'manual' | 'internet' | 'override'

export interface Coords {
  lat: string
  lon: string
}
export interface InternetPlace extends Coords {
  city: string
  region: string
  country: string
  at: number
}

const EFFECTIVE = 'night-identifier:last-location'
const MODE = 'night-identifier:location-mode'
const MANUAL = 'night-identifier:location-manual'
const OVERRIDE = 'night-identifier:location-override'
const INTERNET = 'night-identifier:location-internet'
export const LOCATION_CHANGED = 'night-identifier:location-changed'
const CHANGED = LOCATION_CHANGED

const valid = (c: unknown): c is Coords => {
  const o = c as Coords
  const la = Number(o?.lat)
  const lo = Number(o?.lon)
  return !!o && String(o.lat).trim() !== '' && String(o.lon).trim() !== '' && Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180
}

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* kept for this session only */
  }
}

export const readMode = (): LocationMode => {
  try {
    const m = localStorage.getItem(MODE)
    return m === 'internet' || m === 'override' ? m : 'manual'
  } catch {
    return 'manual'
  }
}
export const readManual = (): Coords | null => {
  const m = read<Coords>(MANUAL)
  return valid(m) ? m : null
}
export const readOverride = (): Coords | null => {
  const m = read<Coords>(OVERRIDE)
  return valid(m) ? m : null
}
export const readInternet = (): InternetPlace | null => {
  const m = read<InternetPlace>(INTERNET)
  return valid(m) ? m : null
}

/** Make the value everyone reads equal to the chosen source, and tell the rest of this window (other windows hear the storage change). */
export function resolveLocation(): void {
  let manual = readManual()
  // A place saved before there were modes is the manual one.
  if (!manual) {
    const old = read<Coords>(EFFECTIVE)
    if (valid(old) && readMode() === 'manual') {
      manual = { lat: String(old.lat), lon: String(old.lon) }
      write(MANUAL, manual)
    }
  }
  const mode = readMode()
  const chosen = mode === 'override' ? (readOverride() ?? manual) : mode === 'internet' ? (readInternet() ?? manual) : manual
  if (chosen) {
    const next = { lat: String(chosen.lat), lon: String(chosen.lon) }
    const cur = read<Coords>(EFFECTIVE)
    if (!cur || String(cur.lat) !== next.lat || String(cur.lon) !== next.lon) write(EFFECTIVE, next)
  }
  window.dispatchEvent(new Event(CHANGED))
}

export function setLocationMode(mode: LocationMode): void {
  try {
    localStorage.setItem(MODE, mode)
  } catch {
    /* kept for this session only */
  }
  resolveLocation()
}

/** A place the user typed. In Override mode it is the override; anywhere else it is the manual place (and the app goes to Manual: typing a place means "this one"). */
export function saveTypedPlace(lat: string, lon: string): boolean {
  const c = { lat: lat.trim(), lon: lon.trim() }
  if (!valid(c)) return false
  if (readMode() === 'override') write(OVERRIDE, c)
  else {
    write(MANUAL, c)
    if (readMode() !== 'manual') {
      try {
        localStorage.setItem(MODE, 'manual')
      } catch {
        /* kept for this session only */
      }
    }
  }
  resolveLocation()
  return true
}

/** A place a page came across (a photo's location): remembered as the manual place only when the app is in Manual mode, so it never fights an override. */
export function rememberPlace(lat: string, lon: string): void {
  if (readMode() !== 'manual') return
  const c = { lat: lat.trim(), lon: lon.trim() }
  if (!valid(c)) return
  const cur = readManual()
  if (cur && cur.lat === c.lat && cur.lon === c.lon) return
  write(MANUAL, c)
  resolveLocation()
}

interface LookupPayload {
  latitude: number
  longitude: number
  city: string
  region: string
  country: string
  looked_up_at: number
}

let inflight: Promise<InternetPlace> | null = null

/** Ask the backend where this computer is (from its internet address) and keep the answer. */
export function lookupInternetPlace(): Promise<InternetPlace> {
  inflight ??= api
    .post<LookupPayload>('/location/lookup', {})
    .then((d) => {
      const p: InternetPlace = { lat: String(d.latitude), lon: String(d.longitude), city: d.city, region: d.region, country: d.country, at: Math.round(d.looked_up_at * 1000) }
      write(INTERNET, p)
      resolveLocation()
      return p
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export const describeInternetPlace = (p: InternetPlace): string => [p.city, p.region, p.country].filter(Boolean).join(', ') || `${p.lat}, ${p.lon}`

/** The mode, the three stored places, and the lookup, for the controls. */
export function useLocationSettings(): {
  mode: LocationMode
  setMode: (m: LocationMode) => void
  internet: InternetPlace | null
  busy: boolean
  error: string | null
  refresh: () => void
} {
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const on = (): void => setTick((n) => n + 1)
    window.addEventListener(CHANGED, on)
    window.addEventListener('storage', on)
    return () => {
      window.removeEventListener(CHANGED, on)
      window.removeEventListener('storage', on)
    }
  }, [])
  const refresh = useCallback((): void => {
    setBusy(true)
    setError(null)
    lookupInternetPlace()
      .catch((e) => setError(e instanceof Error ? e.message.replace(/^\{"detail":"|"\}$/g, '') : 'Could not look up the place'))
      .finally(() => setBusy(false))
  }, [])
  const setMode = useCallback(
    (m: LocationMode): void => {
      setLocationMode(m)
      if (m === 'internet') refresh()
    },
    [refresh]
  )
  void tick
  return { mode: readMode(), setMode, internet: readInternet(), busy, error, refresh }
}
