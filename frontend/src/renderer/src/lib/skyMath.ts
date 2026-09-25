// Camera/lens model, sky transforms and alignment solver for the full-sky overlay.
//
// The overlay is never a pasted image: every catalogue object is a direction on
// the celestial sphere, pushed through a Camera (pose + lens) each frame. Moving,
// rotating, scaling and solving are all just edits to the Camera -- see
// panCamera / rollCamera / scaleFov / solveCamera. Pure functions, no DOM, so the
// same code runs under `node` for scripts/skyMath.check.ts.

export type Vec3 = [number, number, number]
export type Projection = 'rectilinear' | 'stereographic' | 'equidistant' | 'equisolid' | 'orthographic'

export const PROJECTIONS: { id: Projection; label: string }[] = [
  { id: 'rectilinear', label: 'Rectilinear (normal lens)' },
  { id: 'equidistant', label: 'Equidistant fisheye' },
  { id: 'equisolid', label: 'Equisolid fisheye' },
  { id: 'stereographic', label: 'Stereographic' },
  { id: 'orthographic', label: 'Orthographic fisheye' }
]

const DEG = Math.PI / 180
const EPS = 1e-9

// ---------- vectors / rotations ----------

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
]
export const norm = (a: Vec3): number => Math.sqrt(dot(a, a))
export const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const normalize = (a: Vec3): Vec3 => {
  const n = norm(a)
  return n < EPS ? [0, 0, 1] : scale3(a, 1 / n)
}
export const angleBetween = (a: Vec3, b: Vec3): number =>
  Math.atan2(norm(cross(a, b)), dot(a, b))

/** Rodrigues rotation of v about a unit axis by angle (radians). */
export function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const k = cross(axis, v)
  const d = dot(axis, v) * (1 - c)
  return [
    v[0] * c + k[0] * s + axis[0] * d,
    v[1] * c + k[1] * s + axis[1] * d,
    v[2] * c + k[2] * s + axis[2] * d
  ]
}

export function radecToVec(raDeg: number, decDeg: number): Vec3 {
  const a = raDeg * DEG
  const d = decDeg * DEG
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]
}

export function vecToRadec(v: Vec3): { ra: number; dec: number } {
  const n = normalize(v)
  const ra = Math.atan2(n[1], n[0]) / DEG
  return { ra: ((ra % 360) + 360) % 360, dec: Math.asin(Math.max(-1, Math.min(1, n[2]))) / DEG }
}

// ---------- projections ----------

interface ProjectionFns {
  /** radius (in focal lengths) for angle theta off the optical axis */
  g: (theta: number) => number
  /** inverse of g */
  ginv: (r: number) => number
  /** largest theta the lens can image (radians) */
  maxTheta: number
}

const PROJ: Record<Projection, ProjectionFns> = {
  rectilinear: { g: Math.tan, ginv: Math.atan, maxTheta: 89.5 * DEG },
  stereographic: {
    g: (t) => 2 * Math.tan(t / 2),
    ginv: (r) => 2 * Math.atan(r / 2),
    maxTheta: 179 * DEG
  },
  equidistant: { g: (t) => t, ginv: (r) => r, maxTheta: Math.PI },
  equisolid: {
    g: (t) => 2 * Math.sin(t / 2),
    ginv: (r) => 2 * Math.asin(Math.min(1, r / 2)),
    maxTheta: Math.PI
  },
  orthographic: { g: Math.sin, ginv: (r) => Math.asin(Math.min(1, r)), maxTheta: Math.PI / 2 }
}

// ---------- camera ----------

/**
 * Pose + lens. right/up/forward are orthonormal sky-frame directions of the
 * image's +x axis, "up in the image" and the optical axis. Sky view: with
 * roll 0, north is up and east is to the left, so right = -east.
 */
export interface Camera {
  right: Vec3
  up: Vec3
  forward: Vec3
  fovH: number // full horizontal field of view across the image width, radians
  projection: Projection
  k1: number // Brown-Conrady style radial terms on r / (width/2)
  k2: number
  width: number
  height: number
}

export function maxFovH(projection: Projection): number {
  return 2 * PROJ[projection].maxTheta
}

/** Focal length in pixels implied by fovH, width and projection. */
export function focalPx(cam: Camera): number {
  const p = PROJ[cam.projection]
  const half = Math.min(cam.fovH / 2, p.maxTheta * 0.999)
  return cam.width / 2 / Math.max(p.g(half), EPS)
}

export function basisFromRadec(raDeg: number, decDeg: number, rollDeg: number): {
  right: Vec3
  up: Vec3
  forward: Vec3
} {
  const ra = raDeg * DEG
  const dec = decDeg * DEG
  const forward = radecToVec(raDeg, decDeg)
  const east: Vec3 = [-Math.sin(ra), Math.cos(ra), 0]
  const north: Vec3 = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)]
  const r = rollDeg * DEG
  const right = add3(scale3(east, -Math.cos(r)), scale3(north, Math.sin(r)))
  const up = add3(scale3(north, Math.cos(r)), scale3(east, Math.sin(r)))
  return { right, up, forward }
}

export function makeCamera(
  raDeg: number,
  decDeg: number,
  rollDeg: number,
  fovHDeg: number,
  projection: Projection,
  width: number,
  height: number
): Camera {
  return {
    ...basisFromRadec(raDeg, decDeg, rollDeg),
    fovH: fovHDeg * DEG,
    projection,
    k1: 0,
    k2: 0,
    width,
    height
  }
}

/** Pointing (RA/Dec of the image centre) and roll in degrees, for display. */
export function cameraPointing(cam: Camera): { ra: number; dec: number; roll: number } {
  const { ra, dec } = vecToRadec(cam.forward)
  const ref = basisFromRadec(ra, dec, 0)
  // Roll = signed angle from the roll-0 "up" to the camera's up, about forward.
  const roll = Math.atan2(dot(cross(cam.up, ref.up), cam.forward), dot(ref.up, cam.up)) / DEG
  return { ra, dec, roll }
}

function distort(cam: Camera, rIdeal: number): number {
  const rn = rIdeal / (cam.width / 2)
  const rn2 = rn * rn
  return rIdeal * (1 + cam.k1 * rn2 + cam.k2 * rn2 * rn2)
}

function undistort(cam: Camera, rDist: number): number {
  if (cam.k1 === 0 && cam.k2 === 0) return rDist
  let r = rDist
  for (let i = 0; i < 12; i++) {
    const f = distort(cam, r) - rDist
    const h = Math.max(1e-3, r * 1e-4)
    const df = (distort(cam, r + h) - distort(cam, r - h)) / (2 * h)
    if (Math.abs(df) < EPS) break
    r -= f / df
  }
  return r
}

/**
 * Largest ideal image radius (px) the distortion polynomial still maps one-to-one.
 * Past it r*(1 + k1 rn^2 + k2 rn^4) turns back on itself, so a star far off the optical axis
 * (even one behind the camera) would land back inside the frame, on the wrong side of the
 * map. Infinity when the lens has no such limit.
 */
function distortLimit(cam: Camera): number {
  const { k1, k2 } = cam
  // d/dr [r (1 + k1 rn^2 + k2 rn^4)] is 1 + 3 k1 x + 5 k2 x^2 with x = rn^2; find where it hits 0.
  let x = Infinity
  if (Math.abs(k2) < 1e-12) {
    if (k1 < 0) x = -1 / (3 * k1)
  } else {
    const disc = 9 * k1 * k1 - 20 * k2
    if (disc >= 0) {
      const sq = Math.sqrt(disc)
      for (const root of [(-3 * k1 - sq) / (10 * k2), (-3 * k1 + sq) / (10 * k2)])
        if (root > 0 && root < x) x = root
    }
  }
  return Number.isFinite(x) ? Math.sqrt(x) * (cam.width / 2) : Infinity
}

export interface Pixel {
  x: number
  y: number
}

/** Sky direction -> image pixel, or null when the lens can't image it. */
export function project(cam: Camera, v: Vec3): Pixel | null {
  const zc = dot(v, cam.forward)
  const theta = Math.acos(Math.max(-1, Math.min(1, zc)))
  const p = PROJ[cam.projection]
  if (theta > p.maxTheta) return null
  const xc = dot(v, cam.right)
  const yc = dot(v, cam.up)
  const phi = Math.atan2(yc, xc)
  const rIdeal = focalPx(cam) * p.g(theta)
  if (rIdeal >= distortLimit(cam)) return null
  const r = distort(cam, rIdeal)
  return { x: cam.width / 2 + r * Math.cos(phi), y: cam.height / 2 - r * Math.sin(phi) }
}

/** Image pixel -> sky direction (the inverse of project). */
export function unproject(cam: Camera, x: number, y: number): Vec3 {
  const dx = x - cam.width / 2
  const dy = -(y - cam.height / 2)
  const rIdeal = undistort(cam, Math.hypot(dx, dy))
  const theta = PROJ[cam.projection].ginv(rIdeal / focalPx(cam))
  const phi = Math.atan2(dy, dx)
  const st = Math.sin(theta)
  return normalize(
    add3(
      scale3(cam.forward, Math.cos(theta)),
      add3(scale3(cam.right, st * Math.cos(phi)), scale3(cam.up, st * Math.sin(phi)))
    )
  )
}

/** The same direction expressed in camera coordinates (x right, y up, z forward). */
function toCameraFrame(cam: Camera, v: Vec3): Vec3 {
  return [dot(v, cam.right), dot(v, cam.up), dot(v, cam.forward)]
}

/** Apply a rotation given in camera coordinates to the camera's basis (B <- B*Q). */
function rotateBasis(cam: Camera, axisCam: Vec3, angle: number): Camera {
  const a = normalize(axisCam)
  // Columns of B in sky frame are right/up/forward; Q's columns are Q*e_i in camera coordinates.
  const col = (e: Vec3): Vec3 => {
    const q = rotateAbout(e, a, angle)
    return add3(add3(scale3(cam.right, q[0]), scale3(cam.up, q[1])), scale3(cam.forward, q[2]))
  }
  return {
    ...cam,
    right: col([1, 0, 0]),
    up: col([0, 1, 0]),
    forward: col([0, 0, 1])
  }
}

// ---------- interactive edits ----------

/** Drag: choose the camera so the sky point that was under `from` is now under `to`. */
export function panCamera(cam: Camera, from: Pixel, to: Pixel): Camera {
  const c0 = toCameraFrame(cam, unproject(cam, from.x, from.y))
  const c1 = toCameraFrame(cam, unproject(cam, to.x, to.y))
  const axis = cross(c1, c0)
  if (norm(axis) < EPS) return cam
  return rotateBasis(cam, axis, angleBetween(c1, c0))
}

/** Rotate the camera about its optical axis (positive = counter-clockwise on screen). */
export function rollCamera(cam: Camera, deltaDeg: number): Camera {
  return rotateBasis(cam, [0, 0, 1], -deltaDeg * DEG)
}

/** Resize the overlay: factor > 1 shows more sky (smaller figures). */
export function scaleFov(cam: Camera, factor: number): Camera {
  const limit = maxFovH(cam.projection) * 0.999
  return { ...cam, fovH: Math.max(0.05 * DEG, Math.min(limit, cam.fovH * factor)) }
}

/** Re-aim at an RA/Dec, keeping roll. */
export function pointCamera(cam: Camera, raDeg: number, decDeg: number, rollDeg?: number): Camera {
  const roll = rollDeg ?? cameraPointing(cam).roll
  return { ...cam, ...basisFromRadec(raDeg, decDeg, roll) }
}

// ---------- solver ----------

export interface Correspondence {
  pixel: Pixel
  dir: Vec3 // catalogue direction, in the same (precessed) frame as the camera
}

export interface SolveOptions {
  fitFov: boolean
  fitK1: boolean
}

export interface SolveResult {
  camera: Camera
  rmsPx: number
  residuals: number[] // per correspondence, pixels
}

function residualVector(cam: Camera, obs: Correspondence[]): number[] {
  const out: number[] = []
  for (const o of obs) {
    const p = project(cam, o.dir)
    // A star behind the camera is a wildly wrong hypothesis; penalise instead of skipping
    // so the optimiser is pushed away from it.
    out.push(p ? p.x - o.pixel.x : 1e4, p ? p.y - o.pixel.y : 1e4)
  }
  return out
}

const sumSq = (r: number[]): number => r.reduce((s, x) => s + x * x, 0)

/** Solve A x = b (small dense system) by Gaussian elimination with partial pivoting. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-14) return null
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]
    x[r] = s / M[r][r]
  }
  return x
}

/** Right-handed orthonormal frame (columns as vectors) from two non-parallel directions. */
function frameFrom(a: Vec3, b: Vec3): [Vec3, Vec3, Vec3] | null {
  const z = cross(a, b)
  if (norm(z) < 1e-9) return null
  const x = normalize(a)
  const zn = normalize(z)
  return [x, cross(zn, x), zn]
}

/**
 * Closed-form starting pose (TRIAD) from the two most widely separated pairs,
 * given the camera's current lens (fov/projection/distortion).
 */
function triadPose(cam: Camera, obs: Correspondence[]): Camera | null {
  let bi = 0
  let bj = 1
  let best = -1
  for (let i = 0; i < obs.length; i++)
    for (let j = i + 1; j < obs.length; j++) {
      const s = angleBetween(obs[i].dir, obs[j].dir)
      if (s > best) {
        best = s
        bi = i
        bj = j
      }
    }
  // The (right, up, forward) basis is left-handed: seen from inside the sky
  // sphere, east is on the left. Flip z (use "toward the viewer") so the
  // camera frame is right-handed and TRIAD yields a proper rotation.
  const camDirs = obs.map((o) => {
    const c = unproject({ ...cam, right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1] }, o.pixel.x, o.pixel.y)
    return [c[0], c[1], -c[2]] as Vec3
  })
  const fc = frameFrom(camDirs[bi], camDirs[bj])
  const fs = frameFrom(obs[bi].dir, obs[bj].dir)
  if (!fc || !fs) return null
  // Rotation R (camera -> sky) with R*fc[k] = fs[k]; its columns are R*e_x, R*e_y, R*e_z.
  const apply = (e: Vec3): Vec3 => {
    const coords: Vec3 = [dot(e, fc[0]), dot(e, fc[1]), dot(e, fc[2])]
    return add3(add3(scale3(fs[0], coords[0]), scale3(fs[1], coords[1])), scale3(fs[2], coords[2]))
  }
  return { ...cam, right: apply([1, 0, 0]), up: apply([0, 1, 0]), forward: scale3(apply([0, 0, 1]), -1) }
}

function refine(start: Camera, obs: Correspondence[], opts: SolveOptions): SolveResult {
  // Parameters: small rotation about the camera axes (3) [+ ln fov] [+ k1].
  const names: ('rx' | 'ry' | 'rz' | 'fov' | 'k1')[] = ['rx', 'ry', 'rz']
  if (opts.fitFov) names.push('fov')
  if (opts.fitK1) names.push('k1')
  const n = names.length

  const apply = (base: Camera, p: number[]): Camera => {
    let c = base
    if (p[0]) c = rotateBasis(c, [1, 0, 0], p[0])
    if (p[1]) c = rotateBasis(c, [0, 1, 0], p[1])
    if (p[2]) c = rotateBasis(c, [0, 0, 1], p[2])
    const fi = names.indexOf('fov')
    if (fi >= 0) c = { ...c, fovH: Math.min(maxFovH(c.projection) * 0.999, Math.max(0.05 * DEG, c.fovH * Math.exp(p[fi]))) }
    const ki = names.indexOf('k1')
    if (ki >= 0) c = { ...c, k1: base.k1 + p[ki] }
    return c
  }

  let cam = start
  let cost = sumSq(residualVector(cam, obs))
  let lambda = 1e-3
  for (let iter = 0; iter < 60; iter++) {
    const r0 = residualVector(cam, obs)
    const J: number[][] = r0.map(() => new Array<number>(n).fill(0))
    for (let k = 0; k < n; k++) {
      const p = new Array<number>(n).fill(0)
      // Step sizes: ~1e-6 rad (or relative) keeps the finite difference well-conditioned.
      const h = names[k] === 'k1' ? 1e-4 : 1e-6
      p[k] = h
      const r1 = residualVector(apply(cam, p), obs)
      for (let i = 0; i < r0.length; i++) J[i][k] = (r1[i] - r0[i]) / h
    }
    const JtJ = Array.from({ length: n }, (_, a) =>
      Array.from({ length: n }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0))
    )
    const Jtr = Array.from({ length: n }, (_, a) => J.reduce((s, row, i) => s + row[a] * r0[i], 0))

    let improved = false
    for (let attempt = 0; attempt < 8; attempt++) {
      const damped = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)))
      const step = solveLinear(damped, Jtr.map((v) => -v))
      if (!step) {
        lambda *= 10
        continue
      }
      const trial = apply(cam, step)
      const trialCost = sumSq(residualVector(trial, obs))
      if (trialCost < cost) {
        const gain = cost - trialCost
        cam = trial
        cost = trialCost
        lambda = Math.max(lambda / 5, 1e-9)
        improved = true
        if (gain < 1e-9) return finish(cam, obs)
        break
      }
      lambda *= 8
    }
    if (!improved) break
  }
  return finish(cam, obs)
}

function finish(cam: Camera, obs: Correspondence[]): SolveResult {
  const r = residualVector(cam, obs)
  const residuals = obs.map((_, i) => Math.hypot(r[2 * i], r[2 * i + 1]))
  return { camera: cam, rmsPx: Math.sqrt(sumSq(r) / obs.length), residuals }
}

/**
 * Fit the camera to clicked-pixel <-> catalogue-direction pairs.
 *   2 pairs : pointing + roll (field of view taken as given)
 *   3+ pairs: also field of view (multi-start over fov guesses, since a wrong
 *             fov skews the closed-form starting pose)
 *   5+ pairs: optionally a radial distortion term k1
 */
export function solveCamera(
  cam0: Camera,
  obs: Correspondence[],
  opts: Partial<SolveOptions> = {}
): SolveResult | null {
  if (obs.length < 2) return null
  const fitFov = opts.fitFov ?? obs.length >= 3
  const fitK1 = (opts.fitK1 ?? false) && obs.length >= 5
  const options = { fitFov: fitFov && obs.length >= 3, fitK1 }

  const fovGuesses = options.fitFov ? [0.5, 0.7, 1, 1.4, 2, 2.8].map((m) => cam0.fovH * m) : [cam0.fovH]
  let best: SolveResult | null = null
  for (const fov of fovGuesses) {
    const trial = { ...cam0, fovH: Math.min(fov, maxFovH(cam0.projection) * 0.999) }
    const start = triadPose(trial, obs)
    if (!start) continue
    const sol = refine(start, obs, options)
    if (!best || sol.rmsPx < best.rmsPx) best = sol
  }
  return best
}

// ---------- time, location, precession ----------

export function julianDate(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5
}

/** Greenwich mean sidereal time in degrees. */
export function gmstDeg(jd: number): number {
  const d = jd - 2451545.0
  const t = d / 36525
  const g = 280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38710000
  return ((g % 360) + 360) % 360
}

/** J2000 -> of-date precession (IAU 1976), as a 3x3 row-major matrix. */
export function precessionMatrix(jd: number): number[][] {
  const t = (jd - 2451545.0) / 36525
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) / 3600 * DEG
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) / 3600 * DEG
  const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) / 3600 * DEG
  const cz = Math.cos(zeta), sz = Math.sin(zeta)
  const cZ = Math.cos(z), sZ = Math.sin(z)
  const ct = Math.cos(theta), st = Math.sin(theta)
  return [
    [cZ * ct * cz - sZ * sz, -cZ * ct * sz - sZ * cz, -cZ * st],
    [sZ * ct * cz + cZ * sz, -sZ * ct * sz + cZ * cz, -sZ * st],
    [st * cz, -st * sz, ct]
  ]
}

export function applyMatrix(m: number[][], v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]
  ]
}

export interface Observer {
  latDeg: number
  lonDeg: number
  date: Date // UTC instant (ideally the middle of the exposure)
}

/** Altitude/azimuth (degrees, azimuth from north through east) of an of-date direction. */
export function vecAltAz(vDate: Vec3, obs: Observer): { alt: number; az: number } {
  const { ra, dec } = vecToRadec(vDate)
  const lst = (gmstDeg(julianDate(obs.date)) + obs.lonDeg) % 360
  const ha = (lst - ra) * DEG
  const d = dec * DEG
  const phi = obs.latDeg * DEG
  const sinAlt = Math.sin(d) * Math.sin(phi) + Math.cos(d) * Math.cos(phi) * Math.cos(ha)
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)))
  const az = Math.atan2(
    -Math.cos(d) * Math.sin(ha),
    Math.sin(d) * Math.cos(phi) - Math.cos(d) * Math.cos(ha) * Math.sin(phi)
  )
  return { alt: alt / DEG, az: ((az / DEG) % 360 + 360) % 360 }
}

/** Of-date equatorial direction of an alt/az position (used to draw the horizon). */
export function altAzToVec(altDeg: number, azDeg: number, obs: Observer): Vec3 {
  const alt = altDeg * DEG
  const az = azDeg * DEG
  const phi = obs.latDeg * DEG
  const sinDec = Math.sin(alt) * Math.sin(phi) + Math.cos(alt) * Math.cos(phi) * Math.cos(az)
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)))
  const ha = Math.atan2(
    -Math.sin(az) * Math.cos(alt),
    Math.sin(alt) * Math.cos(phi) - Math.cos(alt) * Math.sin(phi) * Math.cos(az)
  )
  const lst = (gmstDeg(julianDate(obs.date)) + obs.lonDeg) * DEG
  return radecToVec((((lst - ha) / DEG) % 360 + 360) % 360, dec / DEG)
}

/**
 * Aim the camera at an alt/az position with the horizon level (image "up" toward
 * the zenith), then tilt by tiltDeg (positive = counter-clockwise on screen).
 * The camera frame is of-date, matching vecAltAz / altAzToVec.
 */
export function cameraFromAltAz(
  cam: Camera,
  altDeg: number,
  azDeg: number,
  tiltDeg: number,
  obs: Observer
): Camera {
  const forward = altAzToVec(Math.min(altDeg, 89.9), azDeg, obs)
  const zenith = altAzToVec(90, 0, obs)
  const up = normalize(add3(zenith, scale3(forward, -dot(zenith, forward))))
  // (right, up, forward) is left-handed: east is on the left when looking out.
  const right = cross(forward, up)
  const level: Camera = { ...cam, right, up, forward }
  return tiltDeg ? rollCamera(level, tiltDeg) : level
}

// ---------- drawing helpers ----------

/**
 * Points along the great circle between two directions, dense enough to bend
 * correctly under a fisheye projection.
 */
export function greatCirclePoints(a: Vec3, b: Vec3, maxStepDeg = 2): Vec3[] {
  const ang = angleBetween(a, b)
  const steps = Math.max(1, Math.min(90, Math.ceil(ang / (maxStepDeg * DEG))))
  const axis = cross(a, b)
  if (norm(axis) < EPS) return [a, b]
  const n = normalize(axis)
  const out: Vec3[] = []
  for (let i = 0; i <= steps; i++) out.push(rotateAbout(a, n, (ang * i) / steps))
  return out
}

export function cameraToJson(cam: Camera): Record<string, unknown> {
  return {
    right: cam.right,
    up: cam.up,
    forward: cam.forward,
    fovHDeg: cam.fovH / DEG,
    projection: cam.projection,
    k1: cam.k1,
    k2: cam.k2
  }
}

export function cameraFromJson(
  raw: Record<string, unknown> | null | undefined,
  width: number,
  height: number
): Camera | null {
  if (!raw) return null
  const isVec = (v: unknown): v is Vec3 =>
    Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
  if (!isVec(raw.right) || !isVec(raw.up) || !isVec(raw.forward)) return null
  const projection = PROJECTIONS.some((p) => p.id === raw.projection)
    ? (raw.projection as Projection)
    : 'rectilinear'
  const fov = typeof raw.fovHDeg === 'number' ? raw.fovHDeg : 60
  return {
    right: raw.right,
    up: raw.up,
    forward: raw.forward,
    fovH: fov * DEG,
    projection,
    k1: typeof raw.k1 === 'number' ? raw.k1 : 0,
    k2: typeof raw.k2 === 'number' ? raw.k2 : 0,
    width,
    height
  }
}
