// Maths for the scales beyond the solar system: turning RA/Dec + distance into positions in the
// scene (ecliptic J2000, AU, centred on the Sun), colours for stars, and a schematic Milky Way.
// Pure functions (no DOM), so they run under `node` for scripts/galaxy.check.ts.

import type { Vec3 } from './kepler'

export const AU_PER_PC = 206_264.806
export const AU_PER_LY = 63_241.077
export const AU_PER_KPC = AU_PER_PC * 1e3
export const LY_PER_PC = 3.261563777

const DEG = Math.PI / 180
const OBLIQUITY = 23.4392911 * DEG
const COS_E = Math.cos(OBLIQUITY)
const SIN_E = Math.sin(OBLIQUITY)

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / n, a[1] / n, a[2] / n]
}

/** Equatorial J2000 unit vector for RA/Dec in degrees. */
export function radecVec(raDeg: number, decDeg: number): Vec3 {
  const a = raDeg * DEG
  const d = decDeg * DEG
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]
}

/** Equatorial J2000 -> ecliptic J2000. */
export const equatorialToEcliptic = (v: Vec3): Vec3 => [v[0], v[1] * COS_E + v[2] * SIN_E, -v[1] * SIN_E + v[2] * COS_E]

/** Position in the scene (AU, ecliptic, Sun at the origin) of something at RA/Dec and a distance. */
export function positionAU(raDeg: number, decDeg: number, distanceAU: number): Vec3 {
  const v = equatorialToEcliptic(radecVec(raDeg, decDeg))
  return [v[0] * distanceAU, v[1] * distanceAU, v[2] * distanceAU]
}

// ---------- the galactic frame ----------
// IAU 1958 definition: the north galactic pole and the direction of the galactic centre (l = b = 0),
// both in J2000. X points at the centre, Y towards l = 90 deg (the direction of the Sun's motion), Z north.

const NGP = radecVec(192.85948, 27.12825)
const GC_DIRECTION = radecVec(266.40499, -28.93617)
const GAL_Z: Vec3 = NGP
const GAL_X: Vec3 = unit([GC_DIRECTION[0] - dot(GC_DIRECTION, NGP) * NGP[0], GC_DIRECTION[1] - dot(GC_DIRECTION, NGP) * NGP[1], GC_DIRECTION[2] - dot(GC_DIRECTION, NGP) * NGP[2]])
const GAL_Y: Vec3 = cross(GAL_Z, GAL_X)

/** Galactic Cartesian (X to the centre, Y to l = 90, Z north) -> equatorial J2000. */
export const galacticToEquatorial = (g: Vec3): Vec3 => [
  GAL_X[0] * g[0] + GAL_Y[0] * g[1] + GAL_Z[0] * g[2],
  GAL_X[1] * g[0] + GAL_Y[1] * g[1] + GAL_Z[1] * g[2],
  GAL_X[2] * g[0] + GAL_Y[2] * g[1] + GAL_Z[2] * g[2]
]

/** Galactic Cartesian -> the scene's ecliptic frame. */
export const galacticToEcliptic = (g: Vec3): Vec3 => equatorialToEcliptic(galacticToEquatorial(g))

/** Equatorial J2000 -> galactic longitude and latitude (degrees). */
export function toGalactic(eq: Vec3): { l: number; b: number } {
  const x = dot(eq, GAL_X)
  const y = dot(eq, GAL_Y)
  const z = dot(eq, GAL_Z)
  return { l: ((Math.atan2(y, x) / DEG) + 360) % 360, b: Math.asin(Math.max(-1, Math.min(1, z))) / DEG }
}

/** Direction (ecliptic) from the Sun to the north galactic pole: the "look down on the Milky Way" axis. */
export const GALACTIC_NORTH_ECLIPTIC: Vec3 = galacticToEcliptic([0, 0, 1])

// ---------- stars ----------

/** Hipparcos positions are for epoch 1991.25; the scene's clock counts years from J2000. */
export const HIPPARCOS_EPOCH_OFFSET_YR = 8.75

/**
 * A star's tangential velocity in the scene frame (ecliptic J2000), in AU per year, from its parallax
 * (mas) and proper motion (mas/yr: pmRA already includes the cos(dec) factor). One arcsecond per
 * year at one parsec is one AU per year, so the speed is just the motion times the distance.
 * Radial velocity is not in Hipparcos, so a star moves across the sky but never nearer or farther.
 */
export function starVelocityAU(raDeg: number, decDeg: number, plxMas: number, pmRaMas: number, pmDecMas: number): Vec3 {
  const distPc = 1000 / plxMas
  const r = radecVec(raDeg, decDeg)
  const east: Vec3 = unit([-r[1], r[0], 0])
  const north = cross(r, east)
  const s = (distPc / 1000)
  const v: Vec3 = [
    (east[0] * pmRaMas + north[0] * pmDecMas) * s,
    (east[1] * pmRaMas + north[1] * pmDecMas) * s,
    (east[2] * pmRaMas + north[2] * pmDecMas) * s
  ]
  return equatorialToEcliptic(v)
}

/** Distances from Hipparcos parallaxes are only trustworthy for reasonably large ones: a star measured at
 * 0.2 +- 0.6 mas is "5 kpc" only by accident. Stars with a small or poorly measured parallax are drawn
 * no farther than this (1 mas = 1 kpc = 3,262 light-years), which keeps constellation figures sane. */
export const PARALLAX_FLOOR_MAS = 1.0

export function effectiveParallax(plxMas: number, errMas: number | undefined): number {
  const poor = plxMas < PARALLAX_FLOOR_MAS || (errMas !== undefined && errMas > 0.35 * plxMas)
  return poor ? Math.max(plxMas, PARALLAX_FLOOR_MAS) : plxMas
}

/** True when the parallax was too poor to trust and the distance was capped. */
export const parallaxCapped = (plxMas: number, errMas: number | undefined): boolean => effectiveParallax(plxMas, errMas) !== plxMas

/** Absolute V magnitude from apparent magnitude and parallax (milliarcseconds). */
export const absoluteMagnitude = (vmag: number, plxMas: number): number => vmag + 5 * Math.log10(plxMas / 100)

/** Distance in AU for a parallax in milliarcseconds. */
export const parallaxToAU = (plxMas: number): number => (1000 / plxMas) * AU_PER_PC

// B-V colour index -> approximate sRGB of the star's light (blackbody, as it looks to the eye).
const COLOUR_STOPS: [number, Vec3][] = [
  [-0.3, [0.61, 0.71, 1.0]],
  [0.0, [0.79, 0.86, 1.0]],
  [0.3, [0.95, 0.95, 1.0]],
  [0.6, [1.0, 0.95, 0.85]],
  [0.9, [1.0, 0.85, 0.65]],
  [1.4, [1.0, 0.7, 0.45]],
  [2.0, [1.0, 0.55, 0.35]]
]

export function starColour(bv: number): Vec3 {
  if (bv <= COLOUR_STOPS[0][0]) return COLOUR_STOPS[0][1]
  for (let i = 1; i < COLOUR_STOPS.length; i++) {
    const [b1, c1] = COLOUR_STOPS[i]
    if (bv <= b1) {
      const [b0, c0] = COLOUR_STOPS[i - 1]
      const t = (bv - b0) / (b1 - b0)
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t]
    }
  }
  return COLOUR_STOPS[COLOUR_STOPS.length - 1][1]
}

// ---------- a schematic Milky Way ----------
// A picture of a barred spiral with four arms, not a survey: log-spiral arms with a 15 degree pitch (each winding about 300 degrees),
// a bar 27 degrees from the Sun-centre line, an exponential disc, and the Sun 8.15 kpc from the centre
// in the gap between two arms (where the real Sun sits, in the Orion spur).

export const SUN_GALACTOCENTRIC_KPC = 8.15
const ARMS = 4
const PITCH = 15 * DEG
const ARM_INNER_KPC = 3.0
const ARM_OUTER_KPC = 12.5
const ARM_SHARE = 0.8 // of disc stars that sit in an arm
const DISC_SCALE_KPC = 3.2
const DISC_EDGE_KPC = 15
const BAR_ANGLE = 27 * DEG

/** Azimuth (radians, from the galactocentric x axis; the Sun is at pi) of arm k at radius r. */
const armAzimuth = (k: number, r: number, phase: number): number => phase + (k * 2 * Math.PI) / ARMS + Math.log(r / ARM_INNER_KPC) / Math.tan(PITCH)

const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))

/** Distance (kpc) from a galactocentric point to the nearest arm ridge. */
export function distanceToArm(x: number, y: number, phase: number): number {
  const r = Math.hypot(x, y)
  if (r < ARM_INNER_KPC || r > ARM_OUTER_KPC) return Math.min(Math.abs(r - ARM_INNER_KPC), Math.abs(r - ARM_OUTER_KPC))
  const theta = Math.atan2(y, x)
  let best = Infinity
  for (let k = 0; k < ARMS; k++) {
    // along the ring, then convert to the perpendicular distance to the spiral (times sin of pitch)
    const gap = Math.abs(wrapPi(theta - armAzimuth(k, r, phase))) * r
    best = Math.min(best, gap * Math.sin(PITCH))
  }
  return best
}

/** The arm phase that puts the Sun midway between two arms. */
export function sunGapPhase(): number {
  let bestPhase = 0
  let bestGap = -1
  for (let i = 0; i < 720; i++) {
    const phase = (i / 720) * 2 * Math.PI
    const gap = distanceToArm(-SUN_GALACTOCENTRIC_KPC, 0, phase)
    if (gap > bestGap) {
      bestGap = gap
      bestPhase = phase
    }
  }
  return bestPhase
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface MilkyWayPoints {
  /** scene positions, AU, ecliptic frame centred on the Sun */
  positions: Float32Array
  colours: Float32Array
  /** the same points as galactocentric kpc (x, y, z), for checks */
  kpc: Float32Array
  count: number
}

export function milkyWayPoints(count: number, seed = 7): MilkyWayPoints {
  const rnd = mulberry32(seed)
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd())
  const phase = sunGapPhase()
  const positions = new Float32Array(count * 3)
  const colours = new Float32Array(count * 3)
  const kpc = new Float32Array(count * 3)
  const bulgeShare = 0.09

  for (let i = 0; i < count; i++) {
    let x: number
    let y: number
    let z: number
    let c: Vec3
    if (rnd() < bulgeShare) {
      // bar plus a round bulge, in the bar's own axes, then rotated into place
      const bar = rnd() < 0.6
      const u = gauss() * (bar ? 1.5 : 0.7)
      const v = gauss() * (bar ? 0.45 : 0.7)
      z = gauss() * (bar ? 0.3 : 0.6)
      const a = Math.PI + BAR_ANGLE // the near end of the bar leads the Sun-centre line
      x = u * Math.cos(a) - v * Math.sin(a)
      y = u * Math.sin(a) + v * Math.cos(a)
      c = [1.0, 0.82 + 0.1 * rnd(), 0.55 + 0.15 * rnd()]
    } else {
      // Radius from an exponential disc (r e^{-r/h}), by inverting a gamma(2) draw.
      let r = 0
      do r = -DISC_SCALE_KPC * (Math.log(1 - rnd()) + Math.log(1 - rnd()))
      while (r < 0.4 || r > DISC_EDGE_KPC)
      const inArm = rnd() < ARM_SHARE && r > ARM_INNER_KPC && r < ARM_OUTER_KPC
      let theta: number
      if (inArm) {
        const k = Math.floor(rnd() * ARMS)
        // ridge plus a spread that widens gently with radius
        theta = armAzimuth(k, r, phase) + (gauss() * (0.26 + 0.02 * r)) / r / Math.sin(PITCH)
      } else theta = rnd() * 2 * Math.PI
      x = r * Math.cos(theta)
      y = r * Math.sin(theta)
      z = -Math.log(1 - rnd()) * 0.16 * (rnd() < 0.5 ? -1 : 1) * (1 + r / 12)
      if (inArm) {
        const pink = rnd() < 0.07
        c = pink ? [1.0, 0.45, 0.65] : [0.62 + 0.15 * rnd(), 0.72 + 0.12 * rnd(), 1.0]
      } else c = [1.0, 0.88 + 0.08 * rnd(), 0.7 + 0.12 * rnd()]
    }
    kpc[3 * i] = x
    kpc[3 * i + 1] = y
    kpc[3 * i + 2] = z
    // galactocentric -> Sun-centred galactic axes (X to the centre), then to the scene frame
    const e = galacticToEcliptic([x + SUN_GALACTOCENTRIC_KPC, y, z])
    positions[3 * i] = e[0] * AU_PER_KPC
    positions[3 * i + 1] = e[1] * AU_PER_KPC
    positions[3 * i + 2] = e[2] * AU_PER_KPC
    colours[3 * i] = c[0]
    colours[3 * i + 1] = c[1]
    colours[3 * i + 2] = c[2]
  }
  return { positions, colours, kpc, count }
}

/** The galactic centre in the scene: where the Milky Way's own label and centre of view sit. */
export const GALACTIC_CENTRE_AU: Vec3 = (() => {
  const e = galacticToEcliptic([SUN_GALACTOCENTRIC_KPC, 0, 0])
  return [e[0] * AU_PER_KPC, e[1] * AU_PER_KPC, e[2] * AU_PER_KPC]
})()
