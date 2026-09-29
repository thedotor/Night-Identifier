// Ships (AIS) for the 3D Earth: rows from the backend in, "where is it now" out. Pure functions, no DOM.
// A row is a position at a moment in the past (the ship's last report). Between reports a ship is carried along its course at its speed.

const DEG = Math.PI / 180
const EARTH_RADIUS_M = 6_371_008.8
const KNOTS_MS = 0.514444
/** Reports older than this are not carried forward: the ship has probably turned. */
const MAX_EXTRAPOLATE_S = 1800

export interface Ship {
  mmsi: number
  latDeg: number
  lonDeg: number
  sogKn: number
  /** degrees clockwise from north (the way it is pointing, or its course when it is under way) */
  courseDeg: number
  cat: number
  /** when the position was reported (ms since 1970) */
  tMs: number
}

export interface ShipsPayload {
  fields: string[]
  rows: number[][]
  fetched_at: number
  has_key: boolean
  sources: {
    digitraffic: { ok: boolean | null; ships: number; error: string | null; at: number | null }
    aisstream: { connected: boolean; messages: number; error: string | null; at: number | null }
  }
  credit: string
}

export interface ShipInfo {
  mmsi: number
  name: string
  type_words: string
  cat: number
  flag: string
  destination: string
  length_m: number | null
  beam_m: number | null
  draught_m: number | null
  imo: number | null
  callsign: string
  lat: number | null
  lon: number | null
  sog_kn: number | null
  cog: number | null
  heading: number | null
  t: number | null
}

export interface ShipHit {
  mmsi: number
  latDeg: number
  lonDeg: number
  sogKn: number
  courseDeg: number
  cat: number
}

/** The six categories the globe colours ships by (the backend's numbers). */
export const SHIP_CATS: { id: number; label: string; colour: string }[] = [
  { id: 1, label: 'Cargo', colour: '#4da3ff' },
  { id: 2, label: 'Tanker', colour: '#ff7a3d' },
  { id: 3, label: 'Passenger', colour: '#ffd84d' },
  { id: 4, label: 'Fishing', colour: '#5ce08a' },
  { id: 5, label: 'Pleasure', colour: '#c88bff' },
  { id: 0, label: 'Other', colour: '#b8c4d6' }
]

export function parseShips(p: ShipsPayload): Ship[] {
  const i = (n: string): number => p.fields.indexOf(n)
  const c = { m: i('mmsi'), lat: i('lat'), lon: i('lon'), sog: i('sog_kn'), cog: i('cog'), cat: i('cat'), t: i('t') }
  const out: Ship[] = []
  for (const r of p.rows) {
    const lat = Number(r[c.lat])
    const lon = Number(r[c.lon])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    out.push({ mmsi: r[c.m], latDeg: lat, lonDeg: lon, sogKn: Number(r[c.sog]) || 0, courseDeg: Number(r[c.cog]) || 0, cat: Number(r[c.cat]) || 0, tMs: Number(r[c.t]) * 1000 })
  }
  return out
}

/** Where the ship is at `ms`, carried along its course from its last report. */
export function advanceShip(s: Ship, ms: number): { latDeg: number; lonDeg: number } {
  const dt = Math.max(-30, Math.min(MAX_EXTRAPOLATE_S, (ms - s.tMs) / 1000))
  if (s.sogKn < 0.5) return { latDeg: s.latDeg, lonDeg: s.lonDeg }
  const d = (s.sogKn * KNOTS_MS * dt) / EARTH_RADIUS_M
  const brg = s.courseDeg * DEG
  const lat1 = s.latDeg * DEG
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg))
  const lon2 = s.lonDeg * DEG + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2))
  return { latDeg: lat2 / DEG, lonDeg: (((lon2 / DEG + 540) % 360) - 180) }
}

/** "12.3 kn (23 km/h)" */
export const speedText = (kn: number): string => `${kn.toFixed(kn < 10 ? 1 : 0)} kn (${Math.round(kn * 1.852)} km/h)`

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
export const headingText = (deg: number): string => `${Math.round(deg)}° ${COMPASS[Math.round(deg / 22.5) % 16]}`
