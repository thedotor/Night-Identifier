// What a galaxy is shaped like, from the catalogues: its morphological type, how tilted it is, and where it sits in space.
// Pure maths (no drawing), shared by the catalogue cloud and the detailed models.
import { AU_PER_PC, equatorialToEcliptic } from './galaxyMath'

const DEG = Math.PI / 180

export type Vec3 = [number, number, number]

/** What a galaxy looks like: T is the RC3 morphological type (-5 to -4 elliptical, -3 to -1 lenticular, 0 to 9 spiral from Sa to Sm, 10 irregular). */
export interface GalaxyShape {
  t: number
  bar: boolean
  /** apparent axis ratio b/a (1: round on the sky) */
  ba: number
  /** position angle of the long axis on the sky, degrees from north through east */
  paDeg: number
  /** a number that fixes the random details, so a galaxy always looks the same */
  seed: number
  /** true when the type is a guess (the catalogue had none) */
  guessed: boolean
}

export type GalaxyClass = 'elliptical' | 'lenticular' | 'spiral' | 'irregular'

export const classOf = (t: number): GalaxyClass => (t <= -4 ? 'elliptical' : t <= -1 ? 'lenticular' : t <= 9 ? 'spiral' : 'irregular')

const SPIRAL_NAMES = ['S0/a', 'Sa', 'Sab', 'Sb', 'Sbc', 'Sc', 'Scd', 'Sd', 'Sdm', 'Sm'] // by RC3 type T = 0 to 9
/** "Barred spiral (SBb)", "Elliptical", "Lenticular (S0)"… */
export function morphName(s: Pick<GalaxyShape, 't' | 'bar' | 'guessed'>): string {
  const c = classOf(s.t)
  const base =
    c === 'elliptical'
      ? 'Elliptical galaxy'
      : c === 'lenticular'
        ? `${s.bar ? 'Barred lenticular' : 'Lenticular'} galaxy (${s.bar ? 'SB0' : 'S0'})`
        : c === 'spiral'
          ? `${s.bar ? 'Barred spiral' : 'Spiral'} galaxy (${s.bar ? 'SB' : 'S'}${SPIRAL_NAMES[Math.max(0, Math.min(9, s.t))].slice(1)})`
          : 'Irregular galaxy'
  return s.guessed ? `${base}, type guessed from its shape` : base
}

/** T and the bar flag from a text morphological type: "SA(s)b", "SBbc", "E2", "S0", "Sc", "IB(s)m", "dE", "Irr", or a plain number. null: not understood. */
export function parseMorph(raw: string | null | undefined): { t: number; bar: boolean } | null {
  const s = (raw ?? '').trim()
  if (!s || s === '?') return null
  if (/^-?\d+$/.test(s)) {
    const n = Number(s)
    return n >= 98 ? null : { t: n, bar: false }
  }
  if (/^dSph|^dE/i.test(s)) return { t: -5, bar: false }
  if (/^dIr/i.test(s)) return { t: 10, bar: false }
  const u = s.replace(/^c/, '')
  if (/^E/i.test(u)) return { t: /S0/.test(u) ? -3 : -5, bar: false }
  if (/^(SB?0|S0|SA0|SAB0)/.test(u)) return { t: -2, bar: /^SB|^SAB/.test(u) }
  if (/^I/.test(u)) return { t: 10, bar: /^IB/.test(u) }
  const m = /^(SAB|SB|SA|S)(?:\([^)]*\))*\s*(ab|bc|cd|dm|a|b|c|d|m)?/i.exec(u)
  if (m) {
    const letter = (m[2] ?? '').toLowerCase()
    const t = ({ a: 1, ab: 2, b: 3, bc: 4, c: 5, cd: 6, d: 7, dm: 8, m: 9 } as Record<string, number>)[letter] ?? 4
    return { t, bar: m[1].toUpperCase() === 'SB' || m[1].toUpperCase() === 'SAB' }
  }
  return null
}

/** A number from a string (the same string always gives the same number). */
export function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** A shape for a galaxy the catalogue says nothing about, from how squashed it looks. */
export function guessShape(ba: number, seed: number): { t: number; bar: boolean } {
  const r = ((seed >>> 8) % 1000) / 1000
  if (ba > 0 && ba < 0.5) return { t: r < 0.25 ? -2 : 3 + Math.floor(r * 4), bar: false } // thin: a disc
  return r < 0.42 ? { t: -5, bar: false } : { t: 2 + Math.floor(r * 5), bar: r > 0.8 }
}

/** Cos of the tilt of a disc from face-on, from its apparent axis ratio and how thick the galaxy really is (q0). */
export function cosTilt(ba: number, q0: number): number {
  const b = Math.min(1, Math.max(q0, ba))
  return Math.sqrt(Math.max(0, (b * b - q0 * q0) / (1 - q0 * q0)))
}

export const thicknessOf = (t: number): number => (classOf(t) === 'elliptical' ? 0.65 : classOf(t) === 'lenticular' ? 0.25 : classOf(t) === 'spiral' ? 0.18 : 0.4)

// ---------- distances from redshift ----------

const H0 = 70 // km/s per Mpc
/** Groups whose members' redshifts are mostly their motion inside the group, not the expansion: all put at the group's distance. */
const CLUSTERS: { ra: number; dec: number; radiusDeg: number; czMin: number; czMax: number; mpc: number }[] = [
  { ra: 187.7, dec: 12.4, radiusDeg: 8, czMin: -500, czMax: 3000, mpc: 16.5 }, // Virgo
  { ra: 194.95, dec: 27.98, radiusDeg: 3.5, czMin: 3500, czMax: 10500, mpc: 99 }, // Coma
  { ra: 54.6, dec: -35.45, radiusDeg: 4, czMin: 0, czMax: 2500, mpc: 19.9 } // Fornax
]

/** Distance in Mpc from a galaxy's velocity (km/s): the Hubble law, with the big nearby clusters put where they are. null: too near for a redshift to say. */
export function distanceMpc(cz: number, raDeg: number, decDeg: number): number | null {
  for (const c of CLUSTERS) {
    if (cz < c.czMin || cz > c.czMax) continue
    const dRa = (raDeg - c.ra) * Math.cos(decDeg * DEG)
    if (Math.hypot(dRa, decDeg - c.dec) < c.radiusDeg) return c.mpc
  }
  return cz < 300 ? null : cz / H0
}
export const mpcToAU = (mpc: number): number => mpc * 1e6 * AU_PER_PC

// ---------- orientation ----------

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

const skyDir = (ra: number, dec: number): Vec3 => {
  const r = ra * DEG
  const d = dec * DEG
  return norm(equatorialToEcliptic([Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)]))
}

/**
 * The axes of a galaxy model in the scene (ecliptic) frame, so that seen from the Sun it has the tilt and position angle it really has:
 * x along the long axis of the disc, z the disc's axis (spin axis, tipped `acos(cosI)` away from us), y completing the set.
 */
export function modelAxes(raDeg: number, decDeg: number, paDeg: number, cosI: number): { x: Vec3; y: Vec3; z: Vec3 } {
  const radial = skyDir(raDeg, decDeg) // from the Sun outwards
  const step = skyDir(raDeg, Math.min(89.99, decDeg + 0.01))
  const along = step[0] * radial[0] + step[1] * radial[1] + step[2] * radial[2]
  const north = norm([0, 1, 2].map((i) => step[i] - along * radial[i]) as Vec3) // the direction of increasing declination, square to the line of sight
  const east = cross(north, radial) // (east, north, outwards) is a right-handed set
  const pa = paDeg * DEG
  const major = norm([0, 1, 2].map((i) => Math.cos(pa) * north[i] + Math.sin(pa) * east[i]) as Vec3)
  const minorOnSky = cross(radial, major)
  const sinI = Math.sqrt(Math.max(0, 1 - cosI * cosI))
  const spin = norm([0, 1, 2].map((i) => cosI * -radial[i] + sinI * minorOnSky[i]) as Vec3)
  const y = cross(spin, major)
  return { x: major, y, z: spin }
}

/** The 2MASS designation of an object from its coordinates: "2MASX J03005158+0048268". */
export function designation(raDeg: number, decDeg: number): string {
  const rs = Math.floor(((raDeg / 15) * 3600 * 100) / 1) // hundredths of a second of time
  const hh = Math.floor(rs / 360000)
  const mm = Math.floor((rs % 360000) / 6000)
  const ss = rs % 6000
  const sign = decDeg < 0 ? '-' : '+'
  const ds = Math.floor(Math.abs(decDeg) * 3600 * 10) // tenths of an arc-second
  const dd = Math.floor(ds / 36000)
  const dm = Math.floor((ds % 36000) / 600)
  const dsec = ds % 600
  const two = (n: number): string => String(n).padStart(2, '0')
  return `2MASX J${two(hh)}${two(mm)}${two(Math.floor(ss / 100))}${two(ss % 100)}${sign}${two(dd)}${two(dm)}${two(Math.floor(dsec / 10))}${dsec % 10}`
}
