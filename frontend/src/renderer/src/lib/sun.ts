// The live Sun: geometry and words. Pure maths, no THREE and no network (checked by scripts/sun.check.ts).
//
// Frames (all in the scene's ecliptic J2000 axes, z north):
//  * e     unit vector from the Sun to the Earth
//  * Z     the Sun's rotation axis (north)
//  * X,Y,Z heliographic "HEEQ": X toward the Earth (made square with Z), Y = Z x X which is solar WEST, Z north.
//          A CME or sunspot at "longitude 30 W, latitude 10 N" is 30 degrees toward Y and 10 toward Z from the Earth line.
//  * right/up the picture as seen from Earth with solar north up: up = Z's part across the line of sight, right = west.

export type Vec3 = [number, number, number]

const DEG = Math.PI / 180
export const AU_KM = 149_597_870.7
export const SOLAR_RADIUS_KM = 695_700
export const RSUN_AU = SOLAR_RADIUS_KM / AU_KM
export const AU_RSUN = 1 / RSUN_AU
/** the Sun's apparent radius from 1 AU, arcseconds */
export const SOLAR_RADIUS_ARCSEC = 959.63
export const CME_START_RSUN = 21.5
/** the Carrington rotation as seen from the (moving) Earth: degrees of heliographic longitude per day for sunspots near the equator */
export const SPOT_DEG_PER_DAY = 13.2

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** The Sun's north pole in the ecliptic frame: inclination 7.25 degrees, ascending node 75.76 degrees (IAU / Carrington), i.e. ecliptic longitude 345.76 and latitude 82.75. */
export const SUN_POLE: Vec3 = (() => {
  const i = 7.25 * DEG
  const node = 75.76 * DEG
  return [Math.sin(i) * Math.sin(node), -Math.sin(i) * Math.cos(node), Math.cos(i)] as Vec3
})()

export interface SunFrame {
  /** Sun -> Earth */
  earth: Vec3
  north: Vec3
  x: Vec3
  y: Vec3
  z: Vec3
  right: Vec3
  up: Vec3
  distAU: number
  /** heliographic latitude of the disc centre (positive = north pole tipped toward us), degrees */
  b0: number
  /** position angle of solar north measured east from celestial north, degrees */
  p: number
}

export function sunFrame(earthPos: Vec3): SunFrame {
  const distAU = Math.hypot(...earthPos) || 1
  const e = norm(earthPos)
  const north = SUN_POLE
  const z = north
  const x = norm(sub(e, scale(z, dot(e, z))))
  const y = cross(z, x)
  const up = norm(sub(north, scale(e, dot(north, e))))
  const right = cross(scale(e, -1), up)
  const b0 = Math.asin(Math.max(-1, Math.min(1, dot(e, north)))) / DEG
  // celestial north across the line of sight, and celestial east = celestial north x (toward the observer's view)
  const eps = 23.4392911 * DEG
  const cel: Vec3 = [0, Math.sin(eps), Math.cos(eps)]
  const celUp = norm(sub(cel, scale(e, dot(cel, e))))
  // east is on the LEFT of a north-up sky picture, i.e. -right for that picture
  const celRight = cross(scale(e, -1), celUp)
  const p = Math.atan2(-dot(north, celRight), dot(north, celUp)) / DEG
  return { earth: e, north, x, y, z, right, up, distAU, b0, p }
}

/** Unit vector (scene axes) of a heliographic point given as latitude and longitude, degrees, longitude west-positive from the Sun-Earth line. */
export function heeqToScene(f: SunFrame, latDeg: number, lonDeg: number): Vec3 {
  const la = latDeg * DEG
  const lo = lonDeg * DEG
  const c = Math.cos(la)
  return [
    c * Math.cos(lo) * f.x[0] + c * Math.sin(lo) * f.y[0] + Math.sin(la) * f.z[0],
    c * Math.cos(lo) * f.x[1] + c * Math.sin(lo) * f.y[1] + Math.sin(la) * f.z[1],
    c * Math.cos(lo) * f.x[2] + c * Math.sin(lo) * f.y[2] + Math.sin(la) * f.z[2]
  ]
}

/** Where a point of the disc picture lands: the fraction of the picture's half-width that the Sun's edge takes, at the given Earth distance. */
export function discFraction(distAU: number, arcsecPerPx: number, halfWidthPx: number): number {
  return SOLAR_RADIUS_ARCSEC / distAU / arcsecPerPx / halfWidthPx
}

// ---------- sunspot groups ----------

export interface Region {
  number: number
  lat: number
  lon: number
  observed: number | null
  area: number | null
  spots: number | null
  spot_class: string | null
  mag_class: string | null
  c_prob: number | null
  m_prob: number | null
  x_prob: number | null
}

/** A sunspot group's longitude at `tMs`: NOAA reports it at `observed`; it drifts west at about 13.2 degrees a day. */
export function regionLon(r: Region, tMs: number): number {
  const days = r.observed == null ? 0 : (tMs - r.observed) / 86_400_000
  return r.lon + SPOT_DEG_PER_DAY * days
}

/** Whether a longitude is on the Earth-facing half (within 90 degrees of the centre line). */
export const facesEarth = (lonDeg: number): boolean => Math.abs((((lonDeg + 180) % 360) + 360) % 360 - 180) < 90

// ---------- CMEs ----------

export interface Cme {
  id: string
  start: number
  t215: number
  lat: number
  lon: number
  half_angle: number
  speed: number
  type: string | null
  source: string | null
  note: string | null
  earth_directed: boolean
  arrival: number | null
  arrival_source: string | null
  separation: number
}

/** Distance of a CME's front from the Sun's centre, in solar radii, assuming it keeps the speed measured at 21.5 radii. */
export function cmeFront(c: Cme, tMs: number): number {
  return CME_START_RSUN + (c.speed * (tMs - c.t215)) / 1000 / SOLAR_RADIUS_KM
}

/** A CME shows from when it clears the coronagraph's occulter (about 3 radii) until it is well past Earth's orbit. */
export const CME_MIN_R = 3
export const CME_MAX_R = 1.7 * AU_RSUN

export const cmeVisible = (c: Cme, tMs: number): boolean => {
  const r = cmeFront(c, tMs)
  return r >= CME_MIN_R && r <= CME_MAX_R
}

/** Words for a CME's direction. */
export function cmeDirection(c: Cme): string {
  if (c.earth_directed) return c.separation < 20 ? 'straight at Earth (a "halo" CME)' : 'toward Earth'
  if (Math.abs(c.lon) > 90) return 'away from Earth (from the far side of the Sun)'
  return `${c.lon >= 0 ? 'west' : 'east'} of the Sun-Earth line, not at Earth`
}

// ---------- flares ----------

export interface Flare {
  class: string
  begin: number
  peak: number
  end: number | null
  region: number | null
}

const CLASS_BASE: Record<string, number> = { A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4 }

/** The X-ray flux (W/m2) a class like "M5.2" stands for; 0 when it cannot be read. */
export function flareFlux(cls: string | null | undefined): number {
  if (!cls) return 0
  const base = CLASS_BASE[cls[0]?.toUpperCase()]
  const n = parseFloat(cls.slice(1))
  return base && Number.isFinite(n) ? base * n : 0
}

/** GOES class name for a flux. */
export function fluxClass(flux: number): string {
  if (!(flux > 0)) return 'A0.0'
  for (const [letter, base] of [['X', 1e-4], ['M', 1e-5], ['C', 1e-6], ['B', 1e-7], ['A', 1e-8]] as const) if (flux >= base) return `${letter}${(flux / base).toFixed(1)}`
  return `A${(flux / 1e-8).toFixed(1)}`
}

/** Is flare class `cls` at least as strong as `min` (both like "M5")? */
export const flareAtLeast = (cls: string | null | undefined, min: string): boolean => flareFlux(cls) >= flareFlux(min) - 1e-15

export function flareWords(cls: string | null | undefined): string {
  const f = flareFlux(cls)
  if (f >= 1e-4) return 'X-class: the strongest kind. Can black out shortwave radio on the sunlit side of Earth and set off a radiation storm.'
  if (f >= 1e-5) return 'M-class: a medium flare. Can cause brief radio blackouts near the poles.'
  if (f >= 1e-6) return 'C-class: small. Barely noticeable at Earth.'
  return 'Quiet background level (B or A class).'
}

/** The NOAA R-scale for a flare, or null under M1. */
export function radioBlackout(cls: string | null | undefined): string | null {
  const f = flareFlux(cls)
  if (f >= 2e-3) return 'R5'
  if (f >= 1e-3) return 'R4'
  if (f >= 1e-4) return 'R3'
  if (f >= 5e-5) return 'R2'
  if (f >= 1e-5) return 'R1'
  return null
}

/** Plain-language description of NOAA's S-scale (solar radiation storm), from >=10 MeV proton flux. */
export function radiationStormWords(cls: string | null | undefined): string {
  switch (cls) {
    case 'S5':
      return 'Extreme radiation storm: a real risk to unshielded astronauts and satellite electronics.'
    case 'S4':
      return 'Severe radiation storm: satellite problems and a radiation exposure risk for high-altitude flights.'
    case 'S3':
      return 'Strong radiation storm: increased radiation risk to astronauts and polar flights.'
    case 'S2':
      return 'Moderate radiation storm: minor effects possible on polar radio and satellites.'
    case 'S1':
      return 'Minor radiation storm: little to no impact expected.'
    default:
      return 'No radiation storm in progress.'
  }
}

// ---------- the activity report ----------

export interface SunActivity {
  live: boolean
  time: number
  credit: string
  cmes: Cme[]
  flares: Flare[]
  regions: Region[]
  xray: { flux: number; class: string; time: number; series: [number, number][] } | null
  proton: { flux_pfu: number; class: string | null; time: number } | null
  nasa_key: boolean
}

/** The strongest flare that peaked within `hours` of `nowMs`. */
export function strongestFlare(flares: Flare[], nowMs: number, hours: number): Flare | null {
  let best: Flare | null = null
  for (const f of flares) {
    if (nowMs - f.peak > hours * 3_600_000 || f.peak > nowMs + 60_000) continue
    if (!best || flareFlux(f.class) > flareFlux(best.class)) best = f
  }
  return best
}

/** CMEs that will reach Earth after `nowMs`, soonest first. */
export function incomingCmes(cmes: Cme[], nowMs: number): Cme[] {
  return cmes.filter((c) => c.earth_directed && c.arrival != null && c.arrival > nowMs).sort((a, b) => (a.arrival ?? 0) - (b.arrival ?? 0))
}

/** "in 2 days 3 h", "in 5 h 10 min", "40 min ago" */
export function relativeTime(targetMs: number, nowMs: number): string {
  const d = targetMs - nowMs
  const a = Math.abs(d)
  const mins = Math.round(a / 60_000)
  const text = mins < 1 ? 'now' : mins < 90 ? `${mins} min` : a < 48 * 3_600_000 ? `${Math.floor(mins / 60)} h ${mins % 60 ? `${mins % 60} min` : ''}`.trim() : `${Math.floor(a / 86_400_000)} days ${Math.round((a % 86_400_000) / 3_600_000)} h`
  return mins < 1 ? 'now' : d >= 0 ? `in ${text}` : `${text} ago`
}

/** Which of the picture kinds the surface can show. */
export type SurfaceKind = 'visual' | 'magnetogram' | 'euv' | 'euv304' | 'euv171'
export const SURFACE_KINDS: { kind: SurfaceKind; label: string; help: string }[] = [
  { kind: 'visual', label: 'Visible light', help: 'What the eye would see (with a filter): the photosphere, with sunspots' },
  { kind: 'euv', label: 'Extreme UV 193 Å', help: 'The hot corona at about 1.5 million degrees: loops, coronal holes, flares' },
  { kind: 'euv304', label: 'Extreme UV 304 Å', help: 'The chromosphere and prominences: the Sun\'s edge fire' },
  { kind: 'euv171', label: 'Extreme UV 171 Å', help: 'The quiet corona at about 600,000 degrees' },
  { kind: 'magnetogram', label: 'Magnetic field', help: 'Which way the magnetic field points at the surface (black and white are opposite): where sunspots and flares come from' }
]
