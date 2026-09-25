// Keplerian orbits for the small bodies in the solar-system view. Pure functions (no DOM), so they
// run under `node` for scripts/solarSystem.check.ts.
//
// Positions are heliocentric, in the ecliptic J2000 frame, in AU: x towards the March equinox of
// J2000, z towards the ecliptic north pole.

export type Vec3 = [number, number, number]

/** Osculating elements as published by JPL's Small-Body Database. */
export interface Elements {
  a: number // semi-major axis, AU
  e: number // eccentricity (< 1)
  i: number // inclination, degrees
  om: number // longitude of the ascending node, degrees
  w: number // argument of perihelion, degrees
  tp: number // time of perihelion passage, Julian date
  per: number // orbital period, days
}

const DEG = Math.PI / 180
const TWO_PI = 2 * Math.PI

/** Solve Kepler's equation M = E - e sin E for the eccentric anomaly E (Newton's method). */
export function solveKepler(M: number, e: number): number {
  const m = ((M % TWO_PI) + TWO_PI) % TWO_PI
  // A good start for high eccentricity, where plain E = M converges slowly.
  let E = e < 0.8 ? m : Math.PI
  for (let n = 0; n < 40; n++) {
    const d = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E))
    E -= d
    if (Math.abs(d) < 1e-12) break
  }
  return E
}

/** Position for given shape/orientation elements and a mean anomaly (radians), no perihelion time needed. */
export function positionAtMeanAnomaly(el: { a: number; e: number; i: number; om: number; w: number }, meanAnomalyRad: number): Vec3 {
  const full: Elements = { ...el, tp: 0, per: 1 }
  return atEccentric(full, orbitBasis(full), solveKepler(meanAnomalyRad, el.e))
}

export const meanAnomaly = (el: Elements, jd: number): number => (TWO_PI * (jd - el.tp)) / el.per

/** Rotation from the orbit's own plane (x towards perihelion) into the ecliptic frame. */
function orbitBasis(el: Elements): { p: Vec3; q: Vec3 } {
  const co = Math.cos(el.om * DEG)
  const so = Math.sin(el.om * DEG)
  const cw = Math.cos(el.w * DEG)
  const sw = Math.sin(el.w * DEG)
  const ci = Math.cos(el.i * DEG)
  const si = Math.sin(el.i * DEG)
  return {
    p: [co * cw - so * sw * ci, so * cw + co * sw * ci, sw * si],
    q: [-co * sw - so * cw * ci, -so * sw + co * cw * ci, cw * si]
  }
}

/** Position on the orbit for an eccentric anomaly. */
function atEccentric(el: Elements, basis: { p: Vec3; q: Vec3 }, E: number): Vec3 {
  const x = el.a * (Math.cos(E) - el.e)
  const y = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E)
  return [
    basis.p[0] * x + basis.q[0] * y,
    basis.p[1] * x + basis.q[1] * y,
    basis.p[2] * x + basis.q[2] * y
  ]
}

export function keplerPosition(el: Elements, jd: number): Vec3 {
  return atEccentric(el, orbitBasis(el), solveKepler(meanAnomaly(el, jd), el.e))
}

/** The whole orbit as `n + 1` points (the last equals the first). Sampled evenly in eccentric
 * anomaly, which puts the points where the curve bends. */
export function orbitPoints(el: Elements, n: number): Vec3[] {
  const basis = orbitBasis(el)
  const out: Vec3[] = []
  for (let k = 0; k <= n; k++) out.push(atEccentric(el, basis, (k / n) * TWO_PI))
  return out
}

/** Many orbits advanced together, for the belts drawn as point clouds. Rows are
 * [a, e, i, om, w, tp, per] as served by /deepspace/orbits. */
export interface ElementCloud {
  count: number
  /** write the heliocentric positions (AU, x y z per object) for a Julian date into `out` */
  positions(jd: number, out: Float32Array): void
}

export function makeCloud(rows: number[][]): ElementCloud {
  const n = rows.length
  const a = new Float64Array(n)
  const e = new Float64Array(n)
  const tp = new Float64Array(n)
  const per = new Float64Array(n)
  const basis = new Float64Array(6 * n) // p then q per object
  rows.forEach(([ra, re, ri, rom, rw, rtp, rper], k) => {
    a[k] = ra
    e[k] = re
    tp[k] = rtp
    per[k] = rper
    const { p, q } = orbitBasis({ a: ra, e: re, i: ri, om: rom, w: rw, tp: rtp, per: rper })
    basis.set(p, 6 * k)
    basis.set(q, 6 * k + 3)
  })
  return {
    count: n,
    positions(jd, out) {
      for (let k = 0; k < n; k++) {
        const E = solveKepler((TWO_PI * (jd - tp[k])) / per[k], e[k])
        const x = a[k] * (Math.cos(E) - e[k])
        const y = a[k] * Math.sqrt(1 - e[k] * e[k]) * Math.sin(E)
        const b = 6 * k
        out[3 * k] = basis[b] * x + basis[b + 3] * y
        out[3 * k + 1] = basis[b + 1] * x + basis[b + 4] * y
        out[3 * k + 2] = basis[b + 2] * x + basis[b + 5] * y
      }
    }
  }
}

/** Distance from the Sun at perihelion, AU. */
export const perihelion = (el: Elements): number => el.a * (1 - el.e)
export const aphelion = (el: Elements): number => el.a * (1 + el.e)
