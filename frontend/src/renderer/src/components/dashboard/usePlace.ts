import { useCallback, useEffect, useState } from 'react'
import type { Place } from '@renderer/lib/skyTonight'
import { LOCATION_CHANGED, saveTypedPlace } from '@renderer/lib/location'

// The same key the Sky Overlay and Live View remember the last location under, so a place entered
// anywhere in the app is already here.
const KEY = 'night-identifier:last-location'

function read(): { lat: string; lon: string } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { lat?: unknown; lon?: unknown } | null
    return raw && raw.lat !== undefined && raw.lon !== undefined ? { lat: String(raw.lat), lon: String(raw.lon) } : null
  } catch {
    return null
  }
}

export const parsePlace = (lat: string, lon: string): Place | null => {
  const a = Number(lat)
  const b = Number(lon)
  return lat.trim() !== '' && lon.trim() !== '' && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 ? { latDeg: a, lonDeg: b } : null
}

/**
 * Coordinates as people write them: "51.5074", "-0.1278", "51.5074 N", "0.1278 W", "51°30'26\" N", or both together
 * ("51.5074, -0.1278", as copied from a map) in the first box. Returns the two boxes' text as plain decimal degrees.
 */
export function tidyCoordinates(lat: string, lon: string): { lat: string; lon: string } {
  const one = (t: string, pos: string, neg: string): string => {
    const s = t.trim().toUpperCase()
    if (!s) return ''
    const m = s.match(/^([NSEW])?\s*(-?\d+(?:\.\d+)?)\s*(?:[°D]\s*(\d+(?:\.\d+)?)?\s*(?:['′M]\s*(\d+(?:\.\d+)?)?\s*(?:["″S])?)?)?\s*([NSEW])?$/)
    if (!m) return t.trim()
    const letter = m[1] ?? m[5]
    let v = Math.abs(Number(m[2])) + (m[3] ? Number(m[3]) / 60 : 0) + (m[4] ? Number(m[4]) / 3600 : 0)
    if (Number(m[2]) < 0 || m[2].startsWith('-')) v = -v
    if (letter === neg) v = -Math.abs(v)
    else if (letter === pos) v = Math.abs(v)
    return String(Math.round(v * 1e6) / 1e6)
  }
  const both = lat.split(/[,;]\s*|\s{2,}|	/).map((x) => x.trim()).filter(Boolean)
  if (lon.trim() === '' && both.length === 2) return { lat: one(both[0], 'N', 'S'), lon: one(both[1], 'E', 'W') }
  return { lat: one(lat, 'N', 'S'), lon: one(lon, 'E', 'W') }
}

/** The observer's place, shared with the other pages through localStorage. */
export function usePlace(): { place: Place | null; raw: { lat: string; lon: string } | null; save: (lat: string, lon: string) => boolean } {
  const [raw, setRaw] = useState(read)
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === KEY) setRaw(read())
    }
    const onChanged = (): void => setRaw(read()) // a change made in this window (the mode, an internet lookup, a typed place)
    window.addEventListener('storage', onStorage)
    window.addEventListener(LOCATION_CHANGED, onChanged)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(LOCATION_CHANGED, onChanged)
    }
  }, [])
  /** A place typed in: it becomes the override in Override mode, otherwise the manual place. */
  const save = useCallback((lat: string, lon: string): boolean => {
    if (!parsePlace(lat, lon)) return false
    const ok = saveTypedPlace(lat, lon)
    setRaw(read())
    return ok
  }, [])
  return { place: raw ? parsePlace(raw.lat, raw.lon) : null, raw, save }
}

/** A tick box remembered between sessions. */
export function useStoredFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      const v = localStorage.getItem(key)
      return v === null ? initial : v === '1'
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (v: boolean) => {
      setOn(v)
      try {
        localStorage.setItem(key, v ? '1' : '0')
      } catch {
        /* not remembered */
      }
    },
    [key]
  )
  return [on, set]
}


/** The saved location as it is right now (read from storage each time, so a change made on another page is seen). */
export function readStoredPlace(): Place | null {
  const raw = read()
  return raw ? parsePlace(raw.lat, raw.lon) : null
}
