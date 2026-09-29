// Live lightning strikes (from the backend, which collects them from the Blitzortung network): types,
// the maths for "how far and which way from here", and the colour a strike has at each age.
// Pure functions, no DOM, so scripts/lightning.check.ts can run them under node.

import type { Place } from './skyTonight'

export interface Strike {
  seq: number
  /** when it struck (ms since 1970) */
  tMs: number
  lat: number
  lon: number
  /** 0 when the network does not say */
  polarity: number
  /** how many receivers heard it: more means a better fix */
  stations: number
  /** the network's own estimate of how far off its position may be, metres */
  accuracyM: number
}

export interface StrikePayload {
  fields: string[]
  rows: number[][]
  seq: number
  credit: string
}

export interface LightningStatus {
  enabled: boolean
  connected: boolean
  server: string | null
  per_minute: number
  per_minute_5m: number
  held: number
  seq: number
  last_strike_age_s: number | null
  error: string | null
  credit: string
}

export function parseStrikes(p: StrikePayload): Strike[] {
  const i = (n: string): number => p.fields.indexOf(n)
  const c = { seq: i('seq'), t: i('t_ms'), lat: i('lat'), lon: i('lon'), pol: i('polarity'), sta: i('stations'), acc: i('accuracy_m') }
  return p.rows.map((r) => ({ seq: r[c.seq], tMs: r[c.t], lat: r[c.lat], lon: r[c.lon], polarity: r[c.pol], stations: r[c.sta], accuracyM: r[c.acc] }))
}

const DEG = Math.PI / 180
const EARTH_RADIUS_KM = 6371.0088

/** Great-circle distance between two points, km. */
export function distanceKm(latA: number, lonA: number, latB: number, lonB: number): number {
  const p1 = latA * DEG
  const p2 = latB * DEG
  const dp = p2 - p1
  const dl = (lonB - lonA) * DEG
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Compass bearing from the first point to the second, degrees clockwise from north. */
export function bearingDeg(latA: number, lonA: number, latB: number, lonB: number): number {
  const p1 = latA * DEG
  const p2 = latB * DEG
  const dl = (lonB - lonA) * DEG
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return (((Math.atan2(y, x) / DEG) % 360) + 360) % 360
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
export const compassOf = (deg: number): string => COMPASS[Math.round(deg / 22.5) % 16]

export interface Nearest {
  strike: Strike
  km: number
  bearing: number
}

export interface StormNearYou {
  nearest: Nearest | null
  /** strikes within 50 / 100 / 250 km in the period looked at */
  within50: number
  within100: number
  within250: number
}

/** How close is the lightning to a place? Looks at strikes no older than `windowMs`. */
export function stormNear(strikes: readonly Strike[], place: Place, nowMs: number, windowMs: number): StormNearYou {
  let best: Nearest | null = null
  let w50 = 0
  let w100 = 0
  let w250 = 0
  const from = nowMs - windowMs
  for (const s of strikes) {
    if (s.tMs < from) continue
    const km = distanceKm(place.latDeg, place.lonDeg, s.lat, s.lon)
    if (km <= 250) {
      w250++
      if (km <= 100) w100++
      if (km <= 50) w50++
    }
    if (!best || km < best.km) best = { strike: s, km, bearing: 0 }
  }
  if (best) best.bearing = bearingDeg(place.latDeg, place.lonDeg, best.strike.lat, best.strike.lon)
  return { nearest: best, within50: w50, within100: w100, within250: w250 }
}

/** The colour of a strike as it ages: a white flash, then yellow, orange, red and dark red. `frac` is age / the time window (0..1). */
export const AGE_STOPS: [number, [number, number, number]][] = [
  [0.0, [1.0, 0.95, 0.69]],
  [0.25, [1.0, 0.82, 0.25]],
  [0.5, [1.0, 0.55, 0.1]],
  [0.75, [0.91, 0.25, 0.11]],
  [1.0, [0.48, 0.06, 0.06]]
]

export function ageColour(frac: number): [number, number, number] {
  const f = Math.max(0, Math.min(1, frac))
  for (let i = 1; i < AGE_STOPS.length; i++) {
    const [f1, c1] = AGE_STOPS[i]
    if (f <= f1) {
      const [f0, c0] = AGE_STOPS[i - 1]
      const t = (f - f0) / (f1 - f0)
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t]
    }
  }
  return AGE_STOPS[AGE_STOPS.length - 1][1]
}

export const cssColour = (c: [number, number, number]): string => `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`

export const formatKm = (km: number): string => (km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString()} km`)
