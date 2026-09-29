// The Earth's magnetic bubble and the solar wind that shapes it. Pure maths and words (no THREE, no network):
// scripts/magnetosphere.check.ts.
//
// The wind is measured about 1.5 million km sunward of Earth (the L1 point, by DSCOVR). From its speed, density and magnetic
// field, empirical formulas give the size of the magnetosphere (Shue et al. 1998) and the bow shock in front of it (Farris and
// Russell 1994). These are averages fitted to many crossings: the real boundaries wobble, so the drawn surfaces are the
// typical shape for these conditions, not a measurement of where the boundary is this minute.

import { EARTH_RADIUS_KM, type Vec3 } from './geomag'

export const L1_DISTANCE_KM = 1_500_000
export const AU_KM = 149_597_870.7


export interface WindPoint {
  /** ISO time from the backend */
  t: string
  speed?: number | null
  density?: number | null
  temperature?: number | null
  bz?: number | null
  bt?: number | null
}

/** Solar wind ram pressure, nPa (n in protons per cm3, v in km/s; the usual 1.6726e-6 factor already includes the 4% of helium). */
export const dynamicPressure = (n: number, v: number): number => 1.6726e-6 * n * v * v

const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x))

/** Shue et al. (1998): the magnetopause (the edge of the Earth's magnetic domain) as r = r0 (2 / (1 + cos t)) ^ alpha, t measured from the Sun direction. Lengths in Earth radii. */
export function magnetopause(pdNPa: number, bz: number): { r0: number; alpha: number } {
  const pd = clamp(pdNPa, 0.3, 60)
  const b = clamp(bz, -18, 15)
  return { r0: (10.22 + 1.29 * Math.tanh(0.184 * (b + 8.14))) * Math.pow(pd, -1 / 6.6), alpha: (0.58 - 0.007 * b) * (1 + 0.024 * Math.log(pd)) }
}

/** Distance of the magnetopause from the Earth's centre, in Earth radii, at angle `theta` (radians) from the Sun line. */
export const magnetopauseAt = (m: { r0: number; alpha: number }, theta: number): number => m.r0 * Math.pow(2 / (1 + Math.cos(theta)), m.alpha)

/** Speed of magnetosonic waves (km/s): the fastest signal the wind's plasma can send. Alfven speed from the field and density, sound speed from the temperature (electrons taken as 140,000 K). */
export function magnetosonicSpeed(nCm3: number, btNT: number, tempK: number): number {
  const va = (21.8 * btNT) / Math.sqrt(Math.max(nCm3, 0.1))
  const cs = 0.1173 * Math.sqrt(Math.max(tempK, 1e4) + 1.4e5)
  return Math.hypot(va, cs)
}

/** Farris and Russell (1994): the bow shock's distance in front of the Earth (Earth radii) from the magnetopause distance and the magnetosonic Mach number. */
export function bowShockNose(r0: number, mach: number): number {
  const m2 = Math.max(mach, 1.3) ** 2
  const g = 5 / 3
  return r0 * (1 + (1.1 * ((g - 1) * m2 + 2)) / ((g + 1) * (m2 - 1)))
}

/** A bow shock surface shaped like the magnetopause, but wider: r = nose * (2 / (1 + cos t)) ^ 0.66. */
export const bowShockAt = (nose: number, theta: number): number => nose * Math.pow(2 / (1 + Math.cos(theta)), 0.66)

export interface Magnetosphere {
  pd: number
  r0: number
  alpha: number
  bowNose: number
  mach: number | null
}

/** Everything the drawing needs, from the latest wind. Missing values fall back to the typical quiet wind (400 km/s, 5 per cm3, Bz 0). */
export function magnetosphereFromWind(w: { speed?: number | null; density?: number | null; bz?: number | null; bt?: number | null; temperature?: number | null }): Magnetosphere {
  const v = w.speed ?? 400
  const n = w.density ?? 5
  const bz = w.bz ?? 0
  const pd = dynamicPressure(n, v)
  const mp = magnetopause(pd, bz)
  const mach = w.bt != null ? v / magnetosonicSpeed(n, w.bt, w.temperature ?? 1e5) : null
  return { pd, r0: mp.r0, alpha: mp.alpha, bowNose: bowShockNose(mp.r0, mach ?? 8), mach }
}

// ---------- words ----------

export type Tone = 'quiet' | 'good' | 'great' | 'warn'

export function windWords(v: number | null | undefined): { text: string; tone: Tone } {
  if (v == null) return { text: 'no reading', tone: 'quiet' }
  if (v >= 800) return { text: 'extremely fast', tone: 'warn' }
  if (v >= 600) return { text: 'fast', tone: 'great' }
  if (v >= 500) return { text: 'brisk', tone: 'good' }
  if (v >= 350) return { text: 'typical', tone: 'quiet' }
  return { text: 'slow', tone: 'quiet' }
}

/** Dst, the storm-time index (nT): the ring of current around the Earth weakens the field at the equator in a storm. */
export function dstLevel(dst: number): { label: string; tone: Tone } {
  if (dst <= -250) return { label: 'super-storm', tone: 'warn' }
  if (dst <= -100) return { label: 'intense storm', tone: 'warn' }
  if (dst <= -50) return { label: 'moderate storm', tone: 'great' }
  if (dst <= -30) return { label: 'weak storm', tone: 'good' }
  return { label: 'quiet', tone: 'quiet' }
}

/** Bz southward opens the door: the wind's field joins the Earth's and energy flows in. */
export function bzWords(bz: number | null | undefined): { text: string; tone: Tone } {
  if (bz == null) return { text: 'no reading', tone: 'quiet' }
  if (bz <= -15) return { text: 'strongly southward: a storm is likely', tone: 'warn' }
  if (bz <= -8) return { text: 'southward: energy is getting in', tone: 'great' }
  if (bz <= -3) return { text: 'a little southward', tone: 'good' }
  if (bz < 3) return { text: 'near zero: little energy gets in', tone: 'quiet' }
  return { text: 'northward: the field is shielded', tone: 'quiet' }
}

/**
 * How much a ground magnetometer moved in the last hour (nT, the largest range of its three components). Near the poles the
 * field moves far more for the same storm, so the words are about that station, and the colour is a rough scale for all.
 */
export function stationLevel(range1hNT: number): { label: string; tone: Tone; t: number } {
  if (range1hNT >= 300) return { label: 'severe', tone: 'warn', t: 1 }
  if (range1hNT >= 120) return { label: 'storm', tone: 'warn', t: 0.8 }
  if (range1hNT >= 60) return { label: 'active', tone: 'great', t: 0.55 }
  if (range1hNT >= 30) return { label: 'unsettled', tone: 'good', t: 0.3 }
  return { label: 'quiet', tone: 'quiet', t: 0.05 }
}

// ---------- events in the wind ----------

const parseMs = (t: string): number => Date.parse(t.endsWith('Z') ? t : `${t}Z`)

/** How long after the L1 spacecraft sees a feature it reaches Earth, minutes. */
export const l1LeadMinutes = (speedKms: number): number => L1_DISTANCE_KM / Math.max(speedKms, 100) / 60

export interface Shock {
  /** when the spacecraft at L1 saw it, ms */
  t: number
  speedBefore: number
  speedAfter: number
  densityRatio: number
}

/**
 * Interplanetary shock candidates in a wind series (points a few minutes apart, oldest first): the speed steps up by at least
 * 40 km/s within a quarter of an hour and the density rises by 30% or more. A real shock also changes the field, and this
 * only looks at speed and density, so it is a candidate until confirmed.
 */
export function findShocks(points: WindPoint[], minJump = 40, minDensity = 1.3): Shock[] {
  const pts = points.filter((p) => p.speed != null)
  const out: Shock[] = []
  const mean = (a: (number | null | undefined)[]): number | null => {
    const v = a.filter((x): x is number => x != null)
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null
  }
  for (let i = 4; i < pts.length - 3; i++) {
    const before = mean(pts.slice(i - 4, i).map((p) => p.speed))
    const after = mean(pts.slice(i, i + 3).map((p) => p.speed))
    if (before == null || after == null || after - before < minJump) continue
    const nb = mean(pts.slice(i - 4, i).map((p) => p.density))
    const na = mean(pts.slice(i, i + 3).map((p) => p.density))
    const ratio = nb && na ? na / nb : 1
    if (ratio < minDensity) continue
    // the window found the step a sample or two early: it is where the speed first passes half way
    let k = i
    while (k < i + 2 && (pts[k].speed as number) < before + 0.5 * (after - before)) k++
    const t = parseMs(pts[k].t)
    const last = out[out.length - 1]
    if (last && t - last.t < 30 * 60_000) continue
    const b2 = mean(pts.slice(k - 4, k).map((p) => p.speed)) ?? before
    const a2 = mean(pts.slice(k, k + 3).map((p) => p.speed)) ?? after
    out.push({ t, speedBefore: b2, speedAfter: a2, densityRatio: ratio })
  }
  return out
}

/** A run of hours in NOAA's Enlil forecast at Earth with a fast wind: a high-speed stream (often from a coronal hole) or a CME's arrival. */
export interface Stream {
  startMs: number
  peakMs: number
  endMs: number
  peakSpeed: number
  /** the speed just before it starts */
  baseSpeed: number
}

/** Enlil rows are [t_ms, speed, density, b, temperature]. A stream is at least 3 hours at or above `minSpeed`, starting from a lower speed. */
export function findStreams(rows: number[][], minSpeed = 550): Stream[] {
  const out: Stream[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i][1] >= minSpeed) {
      let j = i
      let peak = i
      while (j + 1 < rows.length && rows[j + 1][1] >= minSpeed - 40) {
        j++
        if (rows[j][1] > rows[peak][1]) peak = j
      }
      if (j - i >= 2) out.push({ startMs: rows[i][0], peakMs: rows[peak][0], endMs: rows[j][0], peakSpeed: rows[peak][1], baseSpeed: rows[Math.max(0, i - 3)][1] })
      i = j + 1
    } else i++
  }
  return out
}

/**
 * How far sunward of the Earth a feature that will arrive at `arrivalMs` is now, in AU, if it keeps `speedKms`. Zero when it is
 * there, 1 when it has just left the Sun (capped at 1.6).
 */
export function distanceToEarthAU(arrivalMs: number, speedKms: number, nowMs: number): number {
  const km = (Math.max(0, arrivalMs - nowMs) / 1000) * speedKms
  return Math.min(1.6, km / AU_KM)
}

// ---------- drawing help ----------

/**
 * A field line drawn for the wind's pressure: in the Sun-Earth frame (x toward the Sun, Earth radii), bend the outer part of a
 * dipole-like line the way the wind does: squashed on the Sun side to fit inside the magnetopause, stretched out into a tail on
 * the night side. `squash` is r0 / 10.2 (below 1 is compressed), `stretch` is about 0.15 (quiet) to 0.8 (a storm). Lines
 * below 3 Earth radii, where the Earth's own field dominates, are not moved. This is a schematic distortion, not a model of the tail.
 */
export function warpPoint(p: Vec3, squash: number, stretch: number): Vec3 {
  const r = Math.hypot(p[0], p[1], p[2])
  const w = clamp((r - 2.5) / 5, 0, 1)
  const smooth = w * w * (3 - 2 * w)
  if (p[0] >= 0) return [p[0] * (1 + (squash - 1) * smooth), p[1], p[2]]
  return [p[0] * (1 + stretch * smooth * 2), p[1] * (1 - 0.15 * stretch * smooth), p[2] * (1 - 0.25 * stretch * smooth)]
}

/** How stretched the night-side field is for these conditions: 0.15 quiet up to 0.8. */
export const tailStretch = (bz: number | null | undefined, kp: number | null | undefined): number => clamp(0.15 + 0.3 * Math.max(0, -(bz ?? 0)) / 10 + 0.25 * ((kp ?? 0) / 9), 0.15, 0.8)

/** Earth radii to AU. */
export const reToAU = (re: number): number => (re * EARTH_RADIUS_KM) / AU_KM


