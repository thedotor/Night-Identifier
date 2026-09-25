// Areas of a photo fenced off from detection (string lights, trees, reflections ...).
// One list per image, stored by the backend and shared by Annotate and the Sky Overlay;
// every detector skips anything inside them.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'

export type Region = [number, number][]

export function pointInPolygon(x: number, y: number, poly: Region): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[j]
    if (y1 > y !== y2 > y && x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside
  }
  return inside
}

export const inAnyRegion = (x: number, y: number, regions: Region[]): boolean =>
  regions.some((r) => r.length >= 3 && pointInPolygon(x, y, r))

/** Index of the topmost region containing the point, or -1. */
export function regionAt(x: number, y: number, regions: Region[]): number {
  for (let i = regions.length - 1; i >= 0; i--) if (pointInPolygon(x, y, regions[i])) return i
  return -1
}

export function useBlockedAreas(imageId: number | null): {
  regions: Region[]
  add: (r: Region) => void
  remove: (index: number) => void
  clear: () => void
  error: string | null
} {
  const [regions, setRegions] = useState<Region[]>([])
  const [error, setError] = useState<string | null>(null)
  const latest = useRef<Region[]>([])

  useEffect(() => {
    latest.current = []
    setRegions([])
    setError(null)
    if (imageId == null) return
    let cancelled = false
    api
      .get<{ regions: Region[] }>(`/images/${imageId}/blocked-areas`)
      .then((r) => {
        if (cancelled) return
        latest.current = r.regions
        setRegions(r.regions)
      })
      .catch(() => !cancelled && setError('Could not load blocked areas.'))
    return () => {
      cancelled = true
    }
  }, [imageId])

  const commit = useCallback(
    (next: Region[]) => {
      latest.current = next
      setRegions(next)
      if (imageId == null) return
      api
        .put(`/images/${imageId}/blocked-areas`, { regions: next })
        .then(() => setError(null))
        .catch(() => setError('Could not save blocked areas.'))
    },
    [imageId]
  )

  return {
    regions,
    add: (r) => commit([...latest.current, r]),
    remove: (i) => commit(latest.current.filter((_, j) => j !== i)),
    clear: () => commit([]),
    error
  }
}
