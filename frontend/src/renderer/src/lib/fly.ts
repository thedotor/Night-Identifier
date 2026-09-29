// Fly-through camera maths for Deep Space (no THREE, no DOM: checked by scripts/fly.check.ts).
//
// The camera flies freely; its speed follows how close it is to the nearest surface, so it crosses the gap between planets in
// seconds and crawls when it comes down to one. The mouse wheel scales that speed and Shift boosts it.

export type Vec3 = [number, number, number]

export const KM_PER_AU = 149_597_870.7
/** the fastest the camera can be asked to fall toward a surface: it covers this fraction of its height every second */
export const APPROACH_PER_S = 0.6
/** below this height the speed stops falling, so the camera can still creep the last kilometres (and can be flown away again) */
export const MIN_HEIGHT_KM = 1
/** the camera stays this far above a surface, as a fraction of the body's radius (or 2 km, whichever is more) */
export const STOP_FRACTION = 0.0005
export const STOP_MIN_KM = 2
export const BOOST = 6
export const MUL_MIN = 0.01
export const MUL_MAX = 1_000_000
/** beyond this distance from the Sun the camera is turned back: the edge of the scene, about 4.6 billion light-years (the galaxy catalogue ends at about 1.4 billion) */
export const MAX_FLY_AU = 2.9e14
const AU_PER_LY = 63_241.077

export interface Body {
  id: string
  /** heliocentric, AU */
  pos: Vec3
  /** AU */
  radius: number
  /** a galaxy or nebula: the camera flies through it (no collision) and only slows as it comes up to its edge */
  soft?: boolean
}

export interface Nearest {
  id: string
  /** centre to camera, AU */
  centre: number
  /** surface to camera, AU (never below zero) */
  height: number
}

const len = (v: Vec3): number => Math.hypot(v[0], v[1], v[2])

/** The body whose surface is nearest to `p`. */
export function nearestBody(bodies: Body[], p: Vec3): Nearest | null {
  let best: Nearest | null = null
  for (const b of bodies) {
    const centre = len([p[0] - b.pos[0], p[1] - b.pos[1], p[2] - b.pos[2]])
    if (b.soft && centre < b.radius) continue // inside it: the stars in it set the pace
    const height = Math.max(0, centre - b.radius)
    if (!best || height < best.height) best = { id: b.id, centre, height }
  }
  return best
}

/** Speed in AU per second at a given height above the nearest surface. `mul` is the wheel's multiplier, `boost` is Shift. */
export function flySpeed(heightAU: number, mul = 1, boost = false): number {
  const floor = MIN_HEIGHT_KM / KM_PER_AU
  return APPROACH_PER_S * Math.max(heightAU, floor) * Math.min(MUL_MAX, Math.max(MUL_MIN, mul)) * (boost ? BOOST : 1)
}

/** The wheel: each notch (deltaY of 100) changes the speed multiplier by about 20% (about 57% above 150, where the range is huge); up (negative deltaY) is faster. */
export function wheelMultiplier(mul: number, deltaY: number): number {
  const rate = mul >= 150 ? 0.0045 : 0.0018
  return Math.min(MUL_MAX, Math.max(MUL_MIN, mul * Math.exp(-deltaY * rate)))
}

/** How far from a body's centre the camera may come. */
export function stopRadius(radiusAU: number): number {
  return radiusAU + Math.max(radiusAU * STOP_FRACTION, STOP_MIN_KM / KM_PER_AU)
}

/**
 * Keep a camera position (relative to a body's centre) outside the body: if it is inside the stop radius it is put back on it,
 * along the line from the centre. Returns true when it had to be moved.
 */
export function pushOut(rel: Vec3, radiusAU: number): boolean {
  const r = stopRadius(radiusAU)
  const d = len(rel)
  if (d >= r) return false
  if (d < 1e-30) {
    rel[0] = r
    rel[1] = rel[2] = 0
    return true
  }
  const k = r / d
  rel[0] *= k
  rel[1] *= k
  rel[2] *= k
  return true
}

/**
 * One step of forward motion that cannot pass through a body: the camera moves by `step` but if the straight path crosses the
 * stop sphere of any body it stops on the sphere (fast frames would otherwise skip clean through a thin target).
 */
export function moveWithoutTunnelling(from: Vec3, step: Vec3, bodies: Body[]): Vec3 {
  let t = 1
  const L = len(step)
  if (L === 0) return from
  const d: Vec3 = [step[0] / L, step[1] / L, step[2] / L]
  for (const b of bodies) {
    if (b.soft) continue
    const R = stopRadius(b.radius)
    const oc: Vec3 = [from[0] - b.pos[0], from[1] - b.pos[1], from[2] - b.pos[2]]
    const bq = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2]
    const c = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - R * R
    if (c <= 0) continue // already on or inside: pushOut deals with that
    const disc = bq * bq - c
    if (disc < 0) continue
    const hit = -bq - Math.sqrt(disc)
    if (hit >= 0 && hit < L) t = Math.min(t, hit / L)
  }
  return [from[0] + step[0] * t, from[1] + step[1] * t, from[2] + step[2] * t]
}

/** Words for a speed: km/s, then multiples of the speed of light for the very fast (light travels 299,792 km/s). */
export function speedWords(auPerS: number): string {
  const kms = auPerS * KM_PER_AU
  if (kms < 1) return `${(kms * 1000).toFixed(kms < 0.01 ? 1 : 0)} m/s`
  if (kms < 100_000) return `${kms < 100 ? kms.toFixed(1) : Math.round(kms).toLocaleString()} km/s`
  const c = kms / 299_792.458
  const lyPerS = auPerS / AU_PER_LY
  if (lyPerS >= 0.01) return `${lyPerS < 10 ? lyPerS.toFixed(2) : lyPerS < 1e6 ? Math.round(lyPerS).toLocaleString() : lyPerS.toExponential(1).replace('e+', ' × 10^')} light-years per second`
  return c < 100 ? `${c.toFixed(1)} × light` : `${Math.round(c).toLocaleString()} × light`
}

/** Words for a height above a surface. */
export function heightWords(heightAU: number): string {
  const km = heightAU * KM_PER_AU
  if (km < 1) return `${Math.round(km * 1000)} m`
  if (km < 10_000) return `${km < 100 ? km.toFixed(1) : Math.round(km).toLocaleString()} km`
  if (km < 5e7) return `${Math.round(km).toLocaleString()} km`
  if (heightAU >= 6300) {
    const ly = heightAU / AU_PER_LY
    return ly < 1e6 ? `${ly < 10 ? ly.toFixed(2) : Math.round(ly).toLocaleString()} light-years` : ly < 1e9 ? `${ly / 1e6 < 100 ? (ly / 1e6).toPrecision(3) : Math.round(ly / 1e6).toLocaleString()} million light-years` : `${(ly / 1e9).toFixed(1)} billion light-years`
  }
  return `${heightAU.toFixed(heightAU < 10 ? 2 : 0)} AU`
}
