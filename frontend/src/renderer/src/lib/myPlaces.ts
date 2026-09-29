import { useCallback, useEffect, useState } from 'react'

/**
 * Places you name yourself (an observing site, home, a dark-sky spot). Kept in localStorage and shared by every window and page that
 * shows a map: the 3D Earth and the photo map.
 */
export interface MyPlace {
  id: string
  name: string
  lat: number
  lon: number
}

const KEY = 'night-identifier:my-places'
const CHANGED = 'night-identifier:my-places-changed'

const isPlace = (p: unknown): p is MyPlace => {
  const o = p as MyPlace
  return !!o && typeof o.id === 'string' && typeof o.name === 'string' && Number.isFinite(o.lat) && Number.isFinite(o.lon) && Math.abs(o.lat) <= 90 && Math.abs(o.lon) <= 360
}

export function readMyPlaces(): MyPlace[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter(isPlace) : []
  } catch {
    return []
  }
}

function write(list: MyPlace[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* kept for this session only */
  }
  window.dispatchEvent(new Event(CHANGED))
}

export function useMyPlaces(): { places: MyPlace[]; add: (name: string, lat: number, lon: number) => void; remove: (id: string) => void; rename: (id: string, name: string) => void } {
  const [places, setPlaces] = useState<MyPlace[]>(readMyPlaces)
  useEffect(() => {
    const sync = (): void => setPlaces(readMyPlaces())
    window.addEventListener(CHANGED, sync) // another part of this window
    window.addEventListener('storage', sync) // another window
    return () => {
      window.removeEventListener(CHANGED, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  const add = useCallback((name: string, lat: number, lon: number): void => {
    const clean = name.trim().slice(0, 60) || 'My place'
    write([...readMyPlaces(), { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: clean, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 }])
  }, [])
  const remove = useCallback((id: string): void => write(readMyPlaces().filter((p) => p.id !== id)), [])
  const rename = useCallback((id: string, name: string): void => write(readMyPlaces().map((p) => (p.id === id ? { ...p, name: name.trim().slice(0, 60) || p.name } : p))), [])
  return { places, add, remove, rename }
}
