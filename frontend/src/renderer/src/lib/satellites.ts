// Satellites for the sky overlays: orbit elements in, "where is it in this camera's picture" out.
//
// The backend downloads CelesTrak's orbit elements (services/satellites.py) and this module runs
// SGP4 on them (satellite.js). Pure functions and classes, no DOM, so scripts/satellites.check.ts
// can run them under node.
//
// Frames. SGP4 gives a position in an Earth-centred inertial frame; satellite.js turns that into
// look angles (altitude/azimuth) for a site, which already include the satellite's parallax
// (it is tens to thousands of km away, so it is NOT at the same direction for everyone). Those
// angles are fixed to the ground, exactly like the horizon, so they are converted to a sky
// direction with skyMath.altAzToVec for the instant the *camera frame* is defined, not the instant
// the satellite is evaluated. That is what lets a still photo show where a satellite was a few
// minutes later (the photo does not turn) while a live camera shows it where it is now.

import * as sat from './satelliteJs'
import * as S from './skyMath'

const DEG = Math.PI / 180

export type SatGroupId = 'iss' | 'stations' | 'visual' | 'starlink' | 'active'

/** The groups the UI offers; `bit` matches the last column of the backend's rows. */
export const SAT_GROUPS: { id: SatGroupId; bit: number; label: string; hint: string; color: string }[] = [
  { id: 'iss', bit: 16, label: 'International Space Station (ISS)', hint: 'Just the ISS itself, always drawn and named', color: '#ff5c5c' },
  { id: 'stations', bit: 1, label: 'Space stations & docked craft', hint: 'Tiangong and every station module and visiting vehicle, including the ISS', color: '#fb923c' },
  { id: 'visual', bit: 2, label: 'Bright / naked-eye', hint: 'About 150 objects easy to see: Hubble, big rocket bodies, old satellites', color: '#fde047' },
  { id: 'starlink', bit: 4, label: 'Starlink', hint: 'Over 10,000 satellites', color: '#2dd4bf' },
  { id: 'active', bit: 8, label: 'Other active satellites', hint: 'Every other working satellite (several thousand)', color: '#e5e7eb' }
]

export const groupMask = (groups: SatGroupId[]): number =>
  SAT_GROUPS.reduce((m, g) => (groups.includes(g.id) ? m | g.bit : m), 0)

/** Colour of a record: the most specific group it belongs to. */
export function colorOf(flags: number): string {
  for (const g of SAT_GROUPS) if (flags & g.bit) return g.color
  return '#e5e7eb'
}

/** Objects shown with a label even in a crowded sky. */
export const isBright = (flags: number): boolean => (flags & 19) !== 0

// ---------- data ----------

export interface SatPayload {
  fields: string[]
  rows: (string | number)[][]
  fetched_at: number | null
  stale: boolean
  offline: boolean
  missing: string[]
  errors?: Record<string, string>
  credit: string
}

export interface SatRecord {
  norad: number
  name: string
  intl: string
  flags: number
  rec: sat.SatRec
  /** when the elements were measured (ms since 1970); SGP4 drifts the further from this you go */
  epochMs: number
}

export interface SatCatalogue {
  records: SatRecord[]
  fetchedAt: number | null
  stale: boolean
  offline: boolean
  missing: string[]
  errors: Record<string, string>
  credit: string
}

/** Elements this far from the requested time are not trusted: orbits change too much (drag, manoeuvres). */
export const MAX_ELEMENT_AGE_DAYS = 30
const DAY_MS = 86400000

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Rebuild satellites from the backend's rows. Yields to the UI every few thousand (about half a second in all). */
export async function buildCatalogue(p: SatPayload): Promise<SatCatalogue> {
  const idx = (n: string): number => p.fields.indexOf(n)
  const c = {
    norad: idx('norad'), name: idx('name'), intl: idx('intl'), epoch: idx('epoch'), mm: idx('mean_motion'), ecc: idx('ecc'),
    incl: idx('incl'), raan: idx('raan'), argp: idx('argp'), ma: idx('mean_anomaly'), bstar: idx('bstar'), ndot: idx('ndot'),
    nddot: idx('nddot'), revs: idx('revs'), elset: idx('elset'), flags: idx('flags')
  }
  const records: SatRecord[] = []
  for (let i = 0; i < p.rows.length; i++) {
    if (i && i % 3000 === 0) await tick()
    const r = p.rows[i]
    try {
      const rec = sat.json2satrec({
        OBJECT_NAME: String(r[c.name]),
        OBJECT_ID: String(r[c.intl]),
        EPOCH: String(r[c.epoch]),
        MEAN_MOTION: r[c.mm],
        ECCENTRICITY: r[c.ecc],
        INCLINATION: r[c.incl],
        RA_OF_ASC_NODE: r[c.raan],
        ARG_OF_PERICENTER: r[c.argp],
        MEAN_ANOMALY: r[c.ma],
        EPHEMERIS_TYPE: 0,
        CLASSIFICATION_TYPE: 'U',
        NORAD_CAT_ID: r[c.norad],
        ELEMENT_SET_NO: r[c.elset],
        REV_AT_EPOCH: r[c.revs],
        BSTAR: r[c.bstar],
        MEAN_MOTION_DOT: r[c.ndot],
        MEAN_MOTION_DDOT: r[c.nddot]
      })
      records.push({
        norad: Number(r[c.norad]),
        name: String(r[c.name]),
        intl: String(r[c.intl]),
        flags: Number(r[c.flags]),
        rec,
        epochMs: (rec.jdsatepoch - 2440587.5) * DAY_MS
      })
    } catch {
      // a malformed element set: leave that one satellite out
    }
  }
  return {
    records,
    fetchedAt: p.fetched_at,
    stale: p.stale,
    offline: p.offline,
    missing: p.missing,
    errors: p.errors ?? {},
    credit: p.credit
  }
}

/** Records belonging to any of the groups. */
export const recordsIn = (cat: SatCatalogue, groups: SatGroupId[]): SatRecord[] => {
  const mask = groupMask(groups)
  return cat.records.filter((r) => (r.flags & mask) !== 0)
}

/** The middle of the element epochs: what "how old is the orbit data" is measured from. Sorting is done once per data set. */
export function medianEpochMs(records: SatRecord[]): number | null {
  if (!records.length) return null
  const e = records.map((r) => r.epochMs).sort((a, b) => a - b)
  return e[Math.floor(e.length / 2)]
}

/** Days between a moment and the median element epoch (how stale the orbits are for it). */
export const elementAgeDays = (medianEpoch: number | null, date: Date): number =>
  medianEpoch === null ? 0 : Math.abs(date.getTime() - medianEpoch) / DAY_MS

/** What the panel reports about the sky as it is now. */
export interface SatStats {
  /** above the horizon, in the chosen groups */
  total: number
  /** actually drawn (after the sunlit filter) */
  shown: number
  /** above the horizon per group bit */
  perBit: Record<number, number>
}

export const EMPTY_STATS: SatStats = { total: 0, shown: 0, perBit: {} }

export function statsOf(samples: SatSample[], shown: number): SatStats {
  const perBit: Record<number, number> = {}
  for (const g of SAT_GROUPS) perBit[g.bit] = 0
  for (const s of samples) for (const g of SAT_GROUPS) if (s.rec.flags & g.bit) perBit[g.bit]++
  return { total: samples.length, shown, perBit }
}

// ---------- positions ----------

export interface Site {
  latDeg: number
  lonDeg: number
  /** height above sea level, km (a few hundred metres changes nothing visible) */
  heightKm?: number
}

const siteGeo = (s: Site): sat.GeodeticLocation => ({
  latitude: s.latDeg * DEG,
  longitude: s.lonDeg * DEG,
  height: s.heightKm ?? 0
})

export interface SatSample {
  rec: SatRecord
  /** degrees above the horizon (geometric, no refraction) */
  altDeg: number
  /** degrees from north through east */
  azDeg: number
  rangeKm: number
  /** height above the ground under it */
  heightKm: number
  speedKmS: number
  /** 0 fully sunlit .. 1 in Earth's shadow */
  shadow: number
  sunlit: boolean
}

/** Position of one satellite as seen from a site, or null when SGP4 cannot place it (decayed, bad elements). */
export function lookAt(
  rec: SatRecord,
  date: Date,
  gmst: number,
  geo: sat.GeodeticLocation
): { altDeg: number; azDeg: number; rangeKm: number; pv: sat.PositionAndVelocity } | null {
  if (Math.abs(date.getTime() - rec.epochMs) > MAX_ELEMENT_AGE_DAYS * DAY_MS) return null
  const pv = sat.propagate(rec.rec, date)
  if (!pv || typeof pv.position === 'boolean' || typeof pv.velocity === 'boolean') return null
  const look = sat.ecfToLookAngles(geo, sat.eciToEcf(pv.position, gmst))
  return { altDeg: look.elevation / DEG, azDeg: (((look.azimuth / DEG) % 360) + 360) % 360, rangeKm: look.rangeSat, pv }
}

/** Where the Sun is (geocentric, AU) and its look angles from a site: the pass and twilight logic needs both. */
export function sunAt(date: Date, gmst: number, geo: sat.GeodeticLocation): { eci: sat.EciVec3<number>; altDeg: number; azDeg: number } {
  const eci = sat.sunPos(sat.jday(date)).rsun
  // The Sun is ~150 million km away: its look angles from the site equal those from Earth's centre
  // to within a few arcseconds, so the km scale of the ecf helper is irrelevant.
  const km = { x: eci.x * 149597870.7, y: eci.y * 149597870.7, z: eci.z * 149597870.7 }
  const look = sat.ecfToLookAngles(geo, sat.eciToEcf(km, gmst))
  return { eci, altDeg: look.elevation / DEG, azDeg: (((look.azimuth / DEG) % 360) + 360) % 360 }
}

function fullSample(rec: SatRecord, l: NonNullable<ReturnType<typeof lookAt>>, sunEci: sat.EciVec3<number>, gmst: number): SatSample {
  const v = l.pv.velocity as sat.EciVec3<number>
  const shadow = sat.shadowFraction(sunEci, l.pv.position as sat.EciVec3<number>)
  return {
    rec,
    altDeg: l.altDeg,
    azDeg: l.azDeg,
    rangeKm: l.rangeKm,
    heightKm: sat.eciToGeodetic(l.pv.position as sat.EciVec3<number>, gmst).height,
    speedKmS: Math.hypot(v.x, v.y, v.z),
    shadow,
    sunlit: shadow < 0.5
  }
}

/** A single satellite, whatever its elevation (used for the selected one and its passes). */
export function sampleOne(rec: SatRecord, date: Date, site: Site): SatSample | null {
  const gmst = sat.gstime(date)
  const l = lookAt(rec, date, gmst, siteGeo(site))
  return l ? fullSample(rec, l, sat.sunPos(sat.jday(date)).rsun, gmst) : null
}

/** Full scans are the expensive part (~50 ms for every active satellite); in between only what is near the sky is recomputed. */
const RESCAN_MS = 5000
const CANDIDATE_MARGIN_DEG = -6

/**
 * Satellites above the horizon, for a set of records. Remembers which ones were near the sky at the
 * last full scan and only re-propagates those (a few percent of the catalogue) until RESCAN_MS has
 * passed or time jumped, so it can be called several times a second.
 */
export class SatTracker {
  private candidates: SatRecord[] = []
  private scannedAt = NaN
  private scannedSite = ''

  readonly records: SatRecord[]

  constructor(records: SatRecord[]) {
    this.records = records
  }

  sample(date: Date, site: Site): SatSample[] {
    const ms = date.getTime()
    const geo = siteGeo(site)
    const gmst = sat.gstime(date)
    const key = `${site.latDeg},${site.lonDeg},${site.heightKm ?? 0}`
    if (!(Math.abs(ms - this.scannedAt) <= RESCAN_MS) || key !== this.scannedSite) {
      const near: SatRecord[] = []
      for (const r of this.records) {
        const l = lookAt(r, date, gmst, geo)
        if (l && l.altDeg > CANDIDATE_MARGIN_DEG) near.push(r)
      }
      this.candidates = near
      this.scannedAt = ms
      this.scannedSite = key
    }
    const sunEci = sat.sunPos(sat.jday(date)).rsun
    const out: SatSample[] = []
    for (const r of this.candidates) {
      const l = lookAt(r, date, gmst, geo)
      if (l && l.altDeg >= 0) out.push(fullSample(r, l, sunEci, gmst))
    }
    return out
  }
}

// ---------- trails ----------

export interface TrailPoint {
  ms: number
  altDeg: number
  azDeg: number
}

/**
 * Ground-fixed sky positions of a satellite a little before and after `date`. Points sit on an
 * absolute time grid and are remembered, so as time advances only the newest point of each trail
 * is computed rather than the whole trail again.
 */
export class TrailCache {
  private byNorad = new Map<number, Map<number, TrailPoint | null>>()
  private siteKey = ''

  points(rec: SatRecord, date: Date, site: Site, pastS: number, futureS: number, stepS: number): TrailPoint[] {
    const key = `${site.latDeg},${site.lonDeg},${site.heightKm ?? 0},${stepS}`
    if (key !== this.siteKey) {
      this.byNorad.clear()
      this.siteKey = key
    }
    let m = this.byNorad.get(rec.norad)
    if (!m) this.byNorad.set(rec.norad, (m = new Map()))
    const geo = siteGeo(site)
    const stepMs = stepS * 1000
    const t = date.getTime()
    const first = Math.ceil((t - pastS * 1000) / stepMs)
    const last = Math.floor((t + futureS * 1000) / stepMs)
    const out: TrailPoint[] = []
    for (let g = first; g <= last; g++) {
      let p = m.get(g)
      if (p === undefined) {
        const d = new Date(g * stepMs)
        const l = lookAt(rec, d, sat.gstime(d), geo)
        p = l ? { ms: g * stepMs, altDeg: l.altDeg, azDeg: l.azDeg } : null
        m.set(g, p)
      }
      if (p) out.push(p)
    }
    for (const g of m.keys()) if (g < first - 2 || g > last + 2) m.delete(g)
    return out
  }
}

// ---------- drawing input ----------

export interface SatDot {
  s: SatSample
  dir: S.Vec3
}

export interface SatTrail {
  norad: number
  color: string
  /** sky directions along the path, null where it dips below the horizon */
  path: (S.Vec3 | null)[]
  /** index in `path` nearest the satellite's current position, for the arrowhead */
  now: number
}

/** A satellite that is always shown, wherever it is: above the horizon, below it, or out of the frame. */
export interface PinnedSat {
  s: SatSample
  dir: S.Vec3
  /** its track a few minutes either side; `below` marks the part under the horizon */
  path: { dir: S.Vec3; below: boolean }[]
  /** index in `path` nearest the satellite's current position */
  now: number
}

export interface SatFrame {
  dots: SatDot[]
  trails: SatTrail[]
  /** the always-shown satellite (the ISS), or null */
  pinned?: PinnedSat | null
  /** the satellite ring/label highlight the user picked, if it is above the horizon */
  selected: number | null
  labelAll: boolean
}

export interface SatOptions {
  groups: SatGroupId[]
  /** hide satellites that are in Earth's shadow (invisible to a camera); otherwise they are drawn faint */
  sunlitOnly: boolean
  trails: boolean
  /** seconds of trail on each side of the satellite */
  trailSeconds: number
  /** label every satellite (default: only the bright ones and the picked one) */
  labelAll: boolean
  /** Live View: always show the ISS, even under the horizon or out of the frame */
  pinIss: boolean
}

export const DEFAULT_SAT_OPTIONS: SatOptions = {
  groups: ['iss', 'visual'],
  sunlitOnly: false,
  trails: true,
  trailSeconds: 120,
  labelAll: false,
  pinIss: true
}

/**
 * One satellite (the ISS) as the renderer draws it whatever its height: a point in the sky even when it is
 * below the horizon (that is where the camera would have to look), and its track either side of it.
 * `trails` must be a cache used for nothing else, because trail points depend on the step size.
 */
export function buildPinned(rec: SatRecord, date: Date, site: Site, frame: S.Observer, trails: TrailCache, seconds = 420): PinnedSat | null {
  const s = sampleOne(rec, date, site)
  if (!s) return null
  const t = date.getTime()
  const pts = trails.points(rec, date, site, seconds, seconds, 15)
  const path: PinnedSat['path'] = []
  const add = (p: TrailPoint): void => {
    path.push({ dir: dirAt(p.altDeg, p.azDeg, frame), below: p.altDeg < 0 })
  }
  for (const p of pts) if (p.ms < t) add(p)
  const now = path.length
  path.push({ dir: dirAt(s.altDeg, s.azDeg, frame), below: s.altDeg < 0 })
  for (const p of pts) if (p.ms > t) add(p)
  return { s, dir: path[now].dir, path, now }
}

/** Above this many satellites in view, only the bright ones and the picked one keep a trail: a thousand crossing lines hide the sky. */
export const CROWDED_SKY = 250

/** Sky direction of a ground-fixed alt/az, for the instant the camera frame was defined. */
export const dirAt = (altDeg: number, azDeg: number, frame: S.Observer): S.Vec3 => S.altAzToVec(altDeg, azDeg, frame)

/**
 * Turn satellite samples into what the renderer draws. `frame` is the observer whose date defines the
 * camera's frame (photo time, or "now" for a live camera); the samples may be for a different instant.
 */
export function buildSatFrame(a: {
  samples: SatSample[]
  frame: S.Observer
  site: Site
  /** the instant the samples are for */
  date: Date
  opts: SatOptions
  trailCache: TrailCache | null
  selected: number | null
}): SatFrame {
  const { samples, frame, site, date, opts, selected } = a
  const dots: SatDot[] = []
  const trails: SatTrail[] = []
  const step = opts.trailSeconds <= 60 ? 5 : opts.trailSeconds <= 180 ? 10 : 20
  const t = date.getTime()
  const crowded = samples.length > CROWDED_SKY
  for (const s of samples) {
    if (opts.sunlitOnly && !s.sunlit && s.rec.norad !== selected) continue
    dots.push({ s, dir: dirAt(s.altDeg, s.azDeg, frame) })
    if (opts.trails && a.trailCache && (!crowded || isBright(s.rec.flags) || s.rec.norad === selected)) {
      const pts = a.trailCache.points(s.rec, date, site, opts.trailSeconds, opts.trailSeconds, step)
      const path: (S.Vec3 | null)[] = []
      const add = (p: TrailPoint): void => {
        path.push(p.altDeg >= 0 ? dirAt(p.altDeg, p.azDeg, frame) : null)
      }
      for (const p of pts) if (p.ms < t) add(p)
      const now = path.length
      path.push(dirAt(s.altDeg, s.azDeg, frame))
      for (const p of pts) if (p.ms > t) add(p)
      trails.push({ norad: s.rec.norad, color: colorOf(s.rec.flags), path, now })
    }
  }
  return { dots, trails, selected, labelAll: opts.labelAll }
}

// ---------- passes ----------

export interface SatPass {
  riseMs: number
  peakMs: number
  setMs: number
  peakAltDeg: number
  riseAzDeg: number
  peakAzDeg: number
  setAzDeg: number
  /** sunlit at its highest point */
  sunlitAtPeak: boolean
  /** a camera or eye could see it: sunlit while the Sun is well below the horizon (civil twilight or darker) */
  visible: boolean
}

/**
 * Passes over the horizon in the next `hours`, found by stepping 30 s and refining the crossings.
 * Only passes that reach `minPeakDeg` are returned.
 */
export function findPasses(rec: SatRecord, site: Site, from: Date, hours = 24, minPeakDeg = 10): SatPass[] {
  const geo = siteGeo(site)
  const t0 = from.getTime()
  const end = t0 + hours * 3600 * 1000
  const alt = (ms: number): { alt: number; az: number } | null => {
    const d = new Date(ms)
    const l = lookAt(rec, d, sat.gstime(d), geo)
    return l ? { alt: l.altDeg, az: l.azDeg } : null
  }
  const cross = (a: number, b: number): number => {
    // the moment between a (below) and b (above) or vice versa where the altitude is 0
    let lo = a
    let hi = b
    const loUp = (alt(lo)?.alt ?? -90) >= 0
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2
      const up = (alt(mid)?.alt ?? -90) >= 0
      if (up === loUp) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }
  const passes: SatPass[] = []
  const STEP = 30000
  let prev = alt(t0)
  let prevT = t0
  let rise: number | null = prev && prev.alt >= 0 ? t0 : null
  let peak = { t: t0, alt: prev ? prev.alt : -90, az: prev ? prev.az : 0 }
  for (let t = t0 + STEP; t <= end + STEP; t += STEP) {
    const cur = alt(t)
    const up = !!cur && cur.alt >= 0
    const wasUp = !!prev && prev.alt >= 0
    if (up && !wasUp) {
      rise = cross(prevT, t)
      peak = { t, alt: cur!.alt, az: cur!.az }
    } else if (up && cur!.alt > peak.alt) {
      peak = { t, alt: cur!.alt, az: cur!.az }
    } else if (!up && wasUp && rise !== null) {
      const set = cross(prevT, t)
      // Refine the peak: altitude is single-humped inside one pass, so a ternary search on the coarse sample's neighbourhood.
      let lo = peak.t - STEP
      let hi = peak.t + STEP
      for (let i = 0; i < 24; i++) {
        const m1 = lo + (hi - lo) / 3
        const m2 = hi - (hi - lo) / 3
        if ((alt(m1)?.alt ?? -90) < (alt(m2)?.alt ?? -90)) lo = m1
        else hi = m2
      }
      const bt = (lo + hi) / 2
      const at = alt(bt)
      const best = at ? { t: bt, alt: at.alt, az: at.az } : peak
      if (best.alt >= minPeakDeg) {
        const dPeak = new Date(bt)
        const g = sat.gstime(dPeak)
        const l = lookAt(rec, dPeak, g, geo)
        const sun = sunAt(dPeak, g, geo)
        const sunlit = l ? sat.shadowFraction(sun.eci, l.pv.position as sat.EciVec3<number>) < 0.5 : false
        passes.push({
          riseMs: rise,
          peakMs: bt,
          setMs: set,
          peakAltDeg: best.alt,
          riseAzDeg: alt(rise + 1000)?.az ?? 0,
          peakAzDeg: best.az,
          setAzDeg: alt(set - 1000)?.az ?? 0,
          sunlitAtPeak: sunlit,
          visible: sunlit && sun.altDeg < -6
        })
      }
      rise = null
      peak = { t, alt: -90, az: 0 }
    }
    prev = cur
    prevT = t
    if (t > end && !up) break
  }
  return passes
}

// ---------- 3D (ECI) ----------

const OBLIQUITY_J2000 = 23.4392911 * DEG

/**
 * Converts a satellite's position (TEME: true equator, mean equinox of date) to the ecliptic J2000
 * frame the 3D scene uses. Build it once per instant and apply it to every satellite: precession
 * (0.36 degrees in 2026, ~40 km at a satellite's distance) must not be skipped.
 */
export function temeToEcliptic(jd: number): (p: { x: number; y: number; z: number }) => S.Vec3 {
  const m = S.precessionMatrix(jd) // J2000 -> of date; its transpose goes back
  const c = Math.cos(OBLIQUITY_J2000)
  const s = Math.sin(OBLIQUITY_J2000)
  return (p) => {
    const x = m[0][0] * p.x + m[1][0] * p.y + m[2][0] * p.z
    const y = m[0][1] * p.x + m[1][1] * p.y + m[2][1] * p.z
    const z = m[0][2] * p.x + m[1][2] * p.y + m[2][2] * p.z
    return [x, y * c + z * s, -y * s + z * c]
  }
}

/** Where a satellite is in its orbit, in TEME km, for placing it in the 3D scene (null: unusable elements or too far from their epoch). */
export function eciPosition(rec: SatRecord, date: Date): { x: number; y: number; z: number } | null {
  if (Math.abs(date.getTime() - rec.epochMs) > MAX_ELEMENT_AGE_DAYS * DAY_MS) return null
  const pv = sat.propagate(rec.rec, date)
  if (!pv || typeof pv.position === 'boolean') return null
  return pv.position as sat.EciVec3<number>
}

/** What is known about a satellite without a site on the ground: for the 3D view, where nobody has to be standing anywhere. */
export interface SatGlobal {
  rec: SatRecord
  heightKm: number
  speedKmS: number
  sunlit: boolean
  /** the point on the ground beneath it */
  latDeg: number
  lonDeg: number
}

export function globalState(rec: SatRecord, date: Date): SatGlobal | null {
  if (Math.abs(date.getTime() - rec.epochMs) > MAX_ELEMENT_AGE_DAYS * DAY_MS) return null
  const pv = sat.propagate(rec.rec, date)
  if (!pv || typeof pv.position === 'boolean' || typeof pv.velocity === 'boolean') return null
  const gmst = sat.gstime(date)
  const geo = sat.eciToGeodetic(pv.position as sat.EciVec3<number>, gmst)
  const v = pv.velocity as sat.EciVec3<number>
  const shadow = sat.shadowFraction(sat.sunPos(sat.jday(date)).rsun, pv.position as sat.EciVec3<number>)
  return { rec, heightKm: geo.height, speedKmS: Math.hypot(v.x, v.y, v.z), sunlit: shadow < 0.5, latDeg: geo.latitude / DEG, lonDeg: geo.longitude / DEG }
}

/** Whether a satellite is in Earth's shadow, for colouring thousands of dots (cheaper than a full sample). */
export function shadowOf(position: { x: number; y: number; z: number }, sunEci: { x: number; y: number; z: number }): number {
  return sat.shadowFraction(sunEci, position)
}

export const sunEciAU = (date: Date): { x: number; y: number; z: number } => sat.sunPos(sat.jday(date)).rsun

// ---------- formatting ----------

const pad = (n: number): string => String(n).padStart(2, '0')

/** "14:32:05" in the browser's local time. */
export const fmtClock = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
export const compass = (azDeg: number): string => COMPASS[Math.round(azDeg / 22.5) % 16]
