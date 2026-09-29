// Aurora and space weather (NOAA SWPC, through the backend): types, reading the aurora grid, and the words for
// what the numbers mean. Pure functions, no DOM, so scripts/aurora.check.ts can run them under node.

export interface AuroraGridPayload {
  width: number
  height: number
  /** base64 of width x height bytes: percent chance of aurora, row 0 = latitude -90, column 0 = longitude 0 (east) */
  data: string
  observation_time: string | null
  forecast_time: string | null
  max: number
  fetched_at: number
  stale?: boolean
  credit: string
}

export interface AuroraGrid {
  width: number
  height: number
  data: Uint8Array
  /** when the model output applies (ms since 1970) */
  validMs: number | null
  max: number
  fetchedAt: number
  stale: boolean
  credit: string
}

export function parseGrid(p: AuroraGridPayload): AuroraGrid {
  const bin = atob(p.data)
  const data = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
  return {
    width: p.width,
    height: p.height,
    data,
    validMs: p.forecast_time ? Date.parse(p.forecast_time) : null,
    max: p.max,
    fetchedAt: p.fetched_at * 1000,
    stale: !!p.stale,
    credit: p.credit
  }
}

/** The chance of aurora (0-100) at a point, smoothly between the grid's degree cells. */
export function chanceAt(g: AuroraGrid, latDeg: number, lonDeg: number): number {
  const lon = ((lonDeg % 360) + 360) % 360
  const y = Math.max(0, Math.min(g.height - 1, latDeg + 90))
  const x0 = Math.floor(lon)
  const y0 = Math.min(g.height - 2, Math.floor(y))
  const fx = lon - x0
  const fy = y - y0
  const at = (x: number, yy: number): number => g.data[yy * g.width + (x % g.width)]
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx
  return top * (1 - fy) + bottom * fy
}

/** How far toward the equator the aurora reaches in a hemisphere: the lowest |latitude| with a chance of at least `min` percent anywhere around the pole, or null when there is none. */
export function ovalReach(g: AuroraGrid, hemisphere: 'north' | 'south', min = 10): number | null {
  let best: number | null = null
  for (let row = 0; row < g.height; row++) {
    const lat = row - 90
    if ((hemisphere === 'north') !== (lat > 0) || lat === 0) continue
    for (let col = 0; col < g.width; col++) {
      if (g.data[row * g.width + col] >= min) {
        const a = Math.abs(lat)
        if (best === null || a < best) best = a
        break
      }
    }
  }
  return best
}

export interface KpRow {
  time: string
  kp: number
  kind: 'observed' | 'estimated' | 'predicted'
  scale: string | null
}

export interface SolarWindPoint {
  t: string
  speed?: number | null
  density?: number | null
  temperature?: number | null
  bz?: number | null
  bt?: number | null
}

export interface SpaceWeather {
  kp?: [string, number, string, string | null][]
  kp_now?: number | null
  kp_now_time?: string | null
  solar_wind?: SolarWindPoint[]
  solar_wind_now?: { speed?: number; density?: number; temperature?: number; bz?: number; bt?: number; speed_time?: string }
  hemispheric_power?: { time: string; north_gw: number; south_gw: number } | null
  electron_flux_2mev?: { flux: number; time: string } | null
  errors: string[]
  credit: string
  stale?: boolean
}

export const kpRows = (w: SpaceWeather): KpRow[] => (w.kp ?? []).map(([time, kp, kind, scale]) => ({ time, kp, kind: kind as KpRow['kind'], scale }))

/** NOAA's geomagnetic storm scale: Kp 5 is G1 (minor) up to Kp 9 which is G5 (extreme). */
export function gScale(kp: number): string | null {
  const g = Math.floor(kp + 1e-6) - 4
  return g >= 1 ? `G${Math.min(5, g)}` : null
}

export type Tone = 'quiet' | 'good' | 'great' | 'warn'

export function kpMeaning(kp: number): { text: string; tone: Tone } {
  if (kp >= 7) return { text: 'Strong storm: aurora can reach mid-latitudes', tone: 'great' }
  if (kp >= 5) return { text: 'Geomagnetic storm: aurora reaches well south of the usual oval', tone: 'great' }
  if (kp >= 4) return { text: 'Active: good chances at high latitudes', tone: 'good' }
  if (kp >= 3) return { text: 'Unsettled: aurora at high latitudes', tone: 'good' }
  return { text: 'Quiet: aurora stays near the poles', tone: 'quiet' }
}

/** What the solar wind means for aurora. A southward magnetic field (negative Bz) is what lets the wind's energy in. */
export function windMeaning(bz: number | null | undefined, speed: number | null | undefined): { text: string; tone: Tone } {
  if (bz === null || bz === undefined) return { text: 'No magnetic field reading right now', tone: 'quiet' }
  const fast = (speed ?? 0) >= 500
  if (bz <= -10) return { text: 'Bz strongly southward: very favourable for a display', tone: 'great' }
  if (bz <= -5) return { text: `Bz southward${fast ? ' with a fast wind' : ''}: favourable`, tone: 'good' }
  if (bz < 0) return { text: 'Bz slightly southward: a little energy getting in', tone: 'quiet' }
  return { text: 'Bz northward: the door is closed, aurora stays weak', tone: 'quiet' }
}

/** A plain sentence about the chance of seeing aurora from a place, given how dark it is there. */
export function chanceVerdict(chance: number, sunAltDeg: number | null, latDeg: number): { text: string; tone: Tone } {
  const dark = sunAltDeg === null ? true : sunAltDeg < -12
  const dir = latDeg >= 0 ? 'north' : 'south'
  if (chance < 3) {
    return { text: Math.abs(latDeg) < 45 ? 'Too far from the poles for aurora now' : 'No aurora expected here right now', tone: 'quiet' }
  }
  const strength = chance >= 40 ? 'Very good chance' : chance >= 20 ? 'Good chance' : chance >= 8 ? 'A chance' : 'A small chance'
  if (!dark) return { text: `${strength}, but it is not dark enough yet: look ${dir} once the Sun is well down`, tone: chance >= 20 ? 'good' : 'quiet' }
  return { text: `${strength}: look ${dir}, away from lights${chance >= 30 ? ' (it may be overhead)' : ''}`, tone: chance >= 40 ? 'great' : chance >= 20 ? 'good' : 'quiet' }
}
