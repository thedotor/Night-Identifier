// Earthquakes, volcanoes and satellite heat spots for the 3D Earth: rows from the backend in, words and colours out. Pure functions, no DOM.

export interface Quake {
  id: string
  tMs: number
  latDeg: number
  lonDeg: number
  depthKm: number
  mag: number
  tsunami: boolean
}

export interface QuakesPayload {
  fields: string[]
  rows: (string | number)[][]
  updated_at: number | null
  status: { ok: boolean | null; count: number; error: string | null; at: number | null }
  credit: string
}

export interface QuakeInfo {
  id: string
  t: number
  lat: number
  lon: number
  depth: number
  mag: number
  tsunami: number
  place: string
  url: string
  mag_type: string
  sig: number | null
  alert: string | null
  felt: number | null
}

export interface Volcano {
  vnum: number
  latDeg: number
  lonDeg: number
  /** 0 nothing unusual, 1 unrest or advisory, 2 watch, 3 erupting or warning */
  level: number
}

export interface VolcanoActive {
  vnum: number
  name: string
  country: string
  lat: number
  lon: number
  level: number
  category: string
  usgs_color: string
  usgs_level: string
  summary: string
}

export interface VolcanoesPayload {
  fields: string[]
  rows: number[][]
  active: VolcanoActive[]
  updated_at: number | null
  status: { ok: boolean | null; count: number; error: string | null; at: number | null }
  credit: string
}

export interface VolcanoInfo {
  vnum: number
  name: string
  country: string
  lat: number
  lon: number
  elevation: number | null
  type: string
  level: number
  level_words: string
  last_eruption: string
  category: string
  report: string
  summary: string
  usgs_color: string
  usgs_level: string
  usgs_observatory: string
  usgs_url: string
  heat_within_5km: number | null
  url: string
}

export interface HeatSpot {
  latDeg: number
  lonDeg: number
  frp: number
  tMs: number
}

export interface HeatPayload {
  fields: string[]
  rows: number[][]
  updated_at: number | null
  status: { ok: boolean | null; count: number; error: string | null; at: number | null; has_key: boolean }
  has_key: boolean
  credit: string
}

/** What the globe passes back when a quake or volcano is clicked. */
export interface QuakeHit {
  id: string
  latDeg: number
  lonDeg: number
  mag: number
}
export interface VolcanoHit {
  vnum: number
  latDeg: number
  lonDeg: number
  level: number
}

export function parseQuakes(p: QuakesPayload): Quake[] {
  const i = (n: string): number => p.fields.indexOf(n)
  const c = { id: i('id'), t: i('t'), lat: i('lat'), lon: i('lon'), d: i('depth_km'), m: i('mag'), ts: i('tsunami') }
  return p.rows.map((r) => ({ id: String(r[c.id]), tMs: Number(r[c.t]), latDeg: Number(r[c.lat]), lonDeg: Number(r[c.lon]), depthKm: Number(r[c.d]), mag: Number(r[c.m]), tsunami: Number(r[c.ts]) === 1 }))
}

export function parseVolcanoes(p: VolcanoesPayload): Volcano[] {
  const i = (n: string): number => p.fields.indexOf(n)
  const c = { v: i('vnum'), lat: i('lat'), lon: i('lon'), l: i('level') }
  return p.rows.map((r) => ({ vnum: r[c.v], latDeg: r[c.lat], lonDeg: r[c.lon], level: r[c.l] }))
}

export function parseHeat(p: HeatPayload): HeatSpot[] {
  const i = (n: string): number => p.fields.indexOf(n)
  const c = { lat: i('lat'), lon: i('lon'), f: i('frp'), t: i('t') }
  return p.rows.map((r) => ({ latDeg: r[c.lat], lonDeg: r[c.lon], frp: r[c.f], tMs: r[c.t] * 1000 }))
}

export const VOLCANO_LEVELS: { level: number; label: string; colour: string }[] = [
  { level: 0, label: 'Quiet', colour: '#8fa3c0' },
  { level: 1, label: 'Unrest or advisory', colour: '#ffd84d' },
  { level: 2, label: 'Watch', colour: '#ff9a3d' },
  { level: 3, label: 'Erupting or warning', colour: '#ff4d4d' }
]

/** "5 min ago", "3 h ago", "2 days ago" */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} days ago`
}

const DEG = Math.PI / 180
/** Great-circle distance in km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a = Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(a))
}

/** How strong a magnitude is, in words. */
export function magnitudeWords(m: number): string {
  return m < 2 ? 'micro' : m < 4 ? 'minor' : m < 5 ? 'light' : m < 6 ? 'moderate' : m < 7 ? 'strong' : m < 8 ? 'major' : 'great'
}

export const WINDOWS: { hours: number; label: string }[] = [
  { hours: 1, label: '1 hour' },
  { hours: 6, label: '6 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' }
]
