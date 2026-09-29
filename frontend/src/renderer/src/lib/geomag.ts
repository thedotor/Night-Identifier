// The Earth's main magnetic field from the IGRF-14 spherical-harmonic model (degree 13), computed here from the published
// coefficients (lib/igrfCoeffs.ts). No network, no THREE: checked against an independent implementation in scripts/geomag.check.ts.
//
// IGRF describes the field made inside the Earth (the core) and crust; it does not include the currents in space, which is
// what a magnetic storm changes. The live disturbance comes from separate data (Dst, Kp, ground stations).
//
// Frame: Earth-fixed, x through (0 N, 0 E), y through (0 N, 90 E), z through the north geographic pole: the same axes as the
// 3D Earth's own mesh, so a point here is a point on (or around) the globe. Lengths are in Earth radii (6371.2 km).

import { IGRF_G_2020, IGRF_G_2025, IGRF_G_SV, IGRF_H_2020, IGRF_H_2025, IGRF_H_SV } from './igrfCoeffs'

export type Vec3 = [number, number, number]

const DEG = Math.PI / 180
/** IGRF's reference radius, km */
export const EARTH_RADIUS_KM = 6371.2
const N = 13
const COUNT = (N * (N + 3)) / 2 // 91 coefficients for n = 1..13, m = 0..n

/** Position of (n, m) in the coefficient arrays. */
const at = (n: number, m: number): number => (n * (n + 1)) / 2 - 1 + m

export interface Gauss {
  g: Float64Array
  h: Float64Array
  /** the decimal year these are for */
  year: number
}

export function decimalYear(ms: number): number {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const start = Date.UTC(y, 0, 1)
  const end = Date.UTC(y + 1, 0, 1)
  return y + (ms - start) / (end - start)
}

/** The Gauss coefficients for a decimal year: a line between 2020 and 2025, and the secular variation after 2025 (and, backwards, the same line). */
export function coefficientsAt(year: number): Gauss {
  const g = new Float64Array(COUNT)
  const h = new Float64Array(COUNT)
  if (year <= 2025) {
    const t = (year - 2020) / 5
    for (let i = 0; i < COUNT; i++) {
      g[i] = IGRF_G_2020[i] + (IGRF_G_2025[i] - IGRF_G_2020[i]) * t
      h[i] = IGRF_H_2020[i] + (IGRF_H_2025[i] - IGRF_H_2020[i]) * t
    }
  } else {
    const dt = year - 2025
    for (let i = 0; i < COUNT; i++) {
      g[i] = IGRF_G_2025[i] + IGRF_G_SV[i] * dt
      h[i] = IGRF_H_2025[i] + IGRF_H_SV[i] * dt
    }
  }
  return { g, h, year }
}

export interface FieldSpherical {
  /** outward, southward and eastward components, nT */
  br: number
  bt: number
  bp: number
}

// scratch space for the Legendre functions, reused by every call
const P = new Float64Array(COUNT + 1)
const dP = new Float64Array(COUNT + 1)

/** The field at radius `rKm` from the centre, colatitude `colat` and east longitude `lon` (radians). */
export function fieldSpherical(c: Gauss, rKm: number, colat: number, lon: number): FieldSpherical {
  const ct = Math.cos(colat)
  const st = Math.max(Math.sin(colat), 1e-12) // the poles themselves are a singular direction for the east component
  // Schmidt semi-normalised associated Legendre functions and their derivatives with respect to colatitude
  P[0] = 1
  dP[0] = 0
  const idx = (n: number, m: number): number => (n === 0 ? 0 : at(n, m) + 1)
  for (let n = 1; n <= N; n++) {
    for (let m = 0; m <= n; m++) {
      const i = idx(n, m)
      if (n === m) {
        if (n === 1) {
          P[i] = st
          dP[i] = ct
        } else {
          const k = Math.sqrt(1 - 1 / (2 * n))
          P[i] = k * st * P[idx(n - 1, n - 1)]
          dP[i] = k * (ct * P[idx(n - 1, n - 1)] + st * dP[idx(n - 1, n - 1)])
        }
      } else {
        const a = (2 * n - 1) / Math.sqrt(n * n - m * m)
        const b = n - 1 > m ? Math.sqrt((n - 1) * (n - 1) - m * m) / Math.sqrt(n * n - m * m) : 0
        const p1 = P[idx(n - 1, m)]
        const d1 = dP[idx(n - 1, m)]
        const p2 = n - 2 >= m ? P[idx(n - 2, m)] : 0
        const d2 = n - 2 >= m ? dP[idx(n - 2, m)] : 0
        P[i] = a * ct * p1 - b * p2
        dP[i] = a * (ct * d1 - st * p1) - b * d2
      }
    }
  }
  let br = 0
  let bt = 0
  let bp = 0
  const ar = EARTH_RADIUS_KM / rKm
  let arn = ar * ar // (a/r)^(n+2), starting at n = 0 -> ar^2, then n = 1 -> ar^3
  for (let n = 1; n <= N; n++) {
    arn *= ar
    for (let m = 0; m <= n; m++) {
      const i = at(n, m)
      const cm = Math.cos(m * lon)
      const sm = Math.sin(m * lon)
      const gh = c.g[i] * cm + c.h[i] * sm
      const p = P[i + 1]
      const d = dP[i + 1]
      br += (n + 1) * arn * gh * p
      bt -= arn * gh * d
      bp += (arn * m * (c.g[i] * sm - c.h[i] * cm) * p) / st
    }
  }
  return { br, bt, bp }
}

/** The field as a vector in the Earth-fixed frame, nT, at a point given in Earth radii. */
export function fieldAt(c: Gauss, p: Vec3): Vec3 {
  const r = Math.hypot(p[0], p[1], p[2])
  const colat = Math.acos(Math.max(-1, Math.min(1, p[2] / r)))
  const lon = Math.atan2(p[1], p[0])
  const f = fieldSpherical(c, r * EARTH_RADIUS_KM, colat, lon)
  const st = Math.sin(colat)
  const ct = Math.cos(colat)
  const sl = Math.sin(lon)
  const cl = Math.cos(lon)
  // unit vectors: r (out), theta (south), phi (east)
  return [f.br * st * cl + f.bt * ct * cl - f.bp * sl, f.br * st * sl + f.bt * ct * sl + f.bp * cl, f.br * ct - f.bt * st]
}

export interface SurfaceField {
  /** total strength, nT */
  f: number
  /** horizontal strength, nT */
  h: number
  /** north, east and down components, nT */
  x: number
  y: number
  z: number
  /** degrees east of true north (declination) and below the horizontal (inclination, positive down in the north) */
  declination: number
  inclination: number
}

/** The field at a latitude and longitude (degrees, geocentric) and a radius (default: the surface), like a compass and a dip needle read it. */
export function surfaceField(c: Gauss, latDeg: number, lonDeg: number, rKm = EARTH_RADIUS_KM): SurfaceField {
  const f = fieldSpherical(c, rKm, (90 - latDeg) * DEG, lonDeg * DEG)
  const x = -f.bt
  const y = f.bp
  const z = -f.br
  const h = Math.hypot(x, y)
  return { f: Math.hypot(x, y, z), h, x, y, z, declination: Math.atan2(y, x) / DEG, inclination: Math.atan2(z, h) / DEG }
}

/** Total strength (nT) on a longitude/latitude grid: row 0 is +90, column 0 is -180, `w` x `h` cells (cell centres). */
export function strengthGrid(c: Gauss, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let j = 0; j < h; j++) {
    const lat = 90 - ((j + 0.5) / h) * 180
    for (let i = 0; i < w; i++) {
      const lon = -180 + ((i + 0.5) / w) * 360
      out[j * w + i] = surfaceField(c, lat, lon).f
    }
  }
  return out
}

/** Declination (degrees east of north) on the same grid. */
export function declinationGrid(c: Gauss, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let j = 0; j < h; j++) {
    const lat = 90 - ((j + 0.5) / h) * 180
    for (let i = 0; i < w; i++) out[j * w + i] = surfaceField(c, lat, -180 + ((i + 0.5) / w) * 360).declination
  }
  return out
}

/**
 * Follow a field line from `start` (Earth radii) along the field (`dir` +1) or against it (-1), in steps of about `baseStep` Earth radii
 * (4th-order Runge-Kutta on the direction of the field). It stops when it comes back to the surface, or after `maxSteps`, or
 * when it has gone further than `maxR` Earth radii out (open field lines near the poles).
 */
export function traceFieldLine(c: Gauss, start: Vec3, dir: 1 | -1, baseStep: number, maxSteps: number, maxR: number): Vec3[] {
  const pts: Vec3[] = [[...start]]
  let p: Vec3 = [...start]
  const unit = (q: Vec3): Vec3 => {
    const b = fieldAt(c, q)
    const l = Math.hypot(b[0], b[1], b[2]) || 1
    return [(dir * b[0]) / l, (dir * b[1]) / l, (dir * b[2]) / l]
  }
  for (let i = 0; i < maxSteps; i++) {
    // the step grows with distance from the Earth (the field changes slowly out there): at least `step`, at least 5% of the radius
    const step = Math.max(baseStep, 0.05 * Math.hypot(p[0], p[1], p[2]))
    const k1 = unit(p)
    const k2 = unit([p[0] + (k1[0] * step) / 2, p[1] + (k1[1] * step) / 2, p[2] + (k1[2] * step) / 2])
    const k3 = unit([p[0] + (k2[0] * step) / 2, p[1] + (k2[1] * step) / 2, p[2] + (k2[2] * step) / 2])
    const k4 = unit([p[0] + k3[0] * step, p[1] + k3[1] * step, p[2] + k3[2] * step])
    p = [p[0] + (step / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]), p[1] + (step / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]), p[2] + (step / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2])]
    const r = Math.hypot(p[0], p[1], p[2])
    if (r < 1) {
      // came back to the ground: put the last point on it
      const q = pts[pts.length - 1]
      const rq = Math.hypot(q[0], q[1], q[2])
      const t = (rq - 1) / Math.max(1e-9, rq - r)
      pts.push([q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t, q[2] + (p[2] - q[2]) * t])
      return pts
    }
    pts.push([...p])
    if (r > maxR) return pts
  }
  return pts
}

/** The geographic position (degrees) of the dipole's north geomagnetic pole for a set of coefficients, from the degree-1 terms. */
export function geomagneticPole(c: Gauss): { latDeg: number; lonDeg: number; momentNT: number } {
  const g10 = c.g[at(1, 0)]
  const g11 = c.g[at(1, 1)]
  const h11 = c.h[at(1, 1)]
  const m = Math.sqrt(g10 * g10 + g11 * g11 + h11 * h11)
  return { latDeg: Math.asin(-g10 / m) / DEG, lonDeg: Math.atan2(-h11, -g11) / DEG, momentNT: m }
}

