// Blind plate solving: detected star pixels + catalogue -> full camera pose.
//
// Same idea as Astrometry.net, done on the sphere so it works for any lens model:
//  1. Push detected pixels through the lens (at a guessed field of view) to unit vectors.
//  2. Hash 4-star "quads" -- scale/rotation-invariant codes from the stars' relative
//     positions -- for the image and for a brightness-matched pool of catalogue stars.
//  3. Each code match proposes 4 star correspondences; fit a camera to them
//     (skyMath.solveCamera) and *verify* by counting how many other detected stars land
//     on catalogue stars. Accept only when that count is statistically implausible as chance.
//  4. Refine on every matched star.
// Pure functions (no DOM) so it runs in a worker and under node for scripts/plateSolve.check.ts.

import * as S from './skyMath'

export interface SolveInput {
  ra: Float64Array // J2000 catalogue
  dec: Float64Array
  mag: Float64Array
  jd: number // precess the catalogue to this date; the camera lives in that frame
  detected: [number, number, number][] // x, y, brightness -- brightest first
  camera: S.Camera // lens template: projection, size, k1 and a starting fov guess
  fovKnown: boolean // trust camera.fovH (from EXIF) enough to search only near it
  fitK1?: boolean
}

export interface MatchedStar {
  x: number
  y: number
  star: number // catalogue index
}

export interface SolveOutput {
  camera: S.Camera
  matches: MatchedStar[]
  rmsPx: number
  detectedInFrame: number
  fovGuessUsed: number
}

const DEG = Math.PI / 180
const MAX_DETECTED = 45
const NEIGHBOURS = 10
const MAX_INTERIOR = 8
const CODE_CELL = 0.04
const CODE_TOL = 0.035
const MAX_VERIFY = 500
const MIN_MATCHES = 8

type Quad = { idx: [number, number, number, number]; code: [number, number, number, number] }

/** Scale/rotation-invariant code of 4 unit vectors, and the canonical order of the stars. */
function quadCode(vs: [S.Vec3, S.Vec3, S.Vec3, S.Vec3]): Quad | null {
  // A,B = the most widely separated pair.
  let ia = 0
  let ib = 1
  let best = -2
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++) {
      const c = S.dot(vs[i], vs[j])
      if (best === -2 || c < best) {
        best = c
        ia = i
        ib = j
      }
    }
  const rest = [0, 1, 2, 3].filter((i) => i !== ia && i !== ib)
  const g = S.normalize(S.add3(S.add3(vs[0], vs[1]), S.add3(vs[2], vs[3])))
  const e1 = S.normalize(S.cross(g, Math.abs(g[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]))
  const e2 = S.cross(g, e1)
  const plane = (v: S.Vec3): [number, number] => {
    const w = S.dot(v, g)
    return [S.dot(v, e1) / w, S.dot(v, e2) / w]
  }
  const P = vs.map(plane)
  // Complex t = (p - A) / (B - A): A -> 0, B -> 1.
  const toT = (a: number, b: number, p: number): [number, number] => {
    const dx = P[b][0] - P[a][0]
    const dy = P[b][1] - P[a][1]
    const n = dx * dx + dy * dy
    if (n < 1e-16) return [NaN, NaN]
    const px = P[p][0] - P[a][0]
    const py = P[p][1] - P[a][1]
    return [(px * dx + py * dy) / n, (py * dx - px * dy) / n]
  }
  let t = rest.map((p) => toT(ia, ib, p))
  if (t[0][0] + t[1][0] > 1) {
    // Canonicalise the A<->B ambiguity: swapping them maps t -> 1 - t.
    ;[ia, ib] = [ib, ia]
    t = rest.map((p) => toT(ia, ib, p))
  }
  let c = rest[0]
  let d = rest[1]
  if (t[0][0] > t[1][0]) {
    ;[c, d] = [d, c]
    t = [t[1], t[0]]
  }
  const code: [number, number, number, number] = [t[0][0], t[0][1], t[1][0], t[1][1]]
  if (code.some((x) => !Number.isFinite(x))) return null
  return { idx: [ia, ib, c, d], code }
}

/** All quads worth hashing from a point set: each star with its K nearest neighbours. */
function makeQuads(V: S.Vec3[]): Quad[] {
  const quads: Quad[] = []
  const seen = new Set<string>()
  const n = V.length
  for (let a = 0; a < n; a++) {
    const near: { i: number; c: number }[] = [] // K best by cos, descending
    for (let i = 0; i < n; i++) {
      if (i === a) continue
      const c = S.dot(V[a], V[i])
      if (near.length === NEIGHBOURS && c <= near[NEIGHBOURS - 1].c) continue
      let k = near.length < NEIGHBOURS ? near.length : NEIGHBOURS - 1
      while (k > 0 && near[k - 1].c < c) {
        near[k] = near[k - 1]
        k--
      }
      near[k] = { i, c }
    }
    for (let j = 1; j < near.length; j++) {
      const b = near[j].i
      const mid = S.normalize(S.add3(V[a], V[b]))
      const rCos = Math.cos(Math.acos(Math.max(-1, Math.min(1, near[j].c))) / 2)
      // Stars strictly nearer to A than B is, and inside the circle whose diameter is AB.
      const interior = near
        .slice(0, j)
        .map((x) => x.i)
        .filter((i) => S.dot(V[i], mid) >= rCos)
        .slice(0, MAX_INTERIOR)
      for (let p = 0; p < interior.length; p++)
        for (let q = p + 1; q < interior.length; q++) {
          const four = [a, b, interior[p], interior[q]] as [number, number, number, number]
          const key = [...four].sort((x, y) => x - y).join(',')
          if (seen.has(key)) continue
          seen.add(key)
          const qd = quadCode([V[four[0]], V[four[1]], V[four[2]], V[four[3]]])
          if (!qd) continue
          const idx = qd.idx.map((k) => four[k]) as [number, number, number, number]
          quads.push({ idx, code: qd.code })
        }
    }
  }
  return quads
}

const cellOf = (x: number): number => Math.max(0, Math.min(63, Math.floor((x + 1) / CODE_CELL)))
const keyOf = (a: number, b: number, c: number, d: number): number => ((a * 64 + b) * 64 + c) * 64 + d

function buildIndex(quads: Quad[]): Map<number, number[]> {
  const map = new Map<number, number[]>()
  quads.forEach((q, i) => {
    const k = keyOf(cellOf(q.code[0]), cellOf(q.code[1]), cellOf(q.code[2]), cellOf(q.code[3]))
    const bucket = map.get(k)
    if (bucket) bucket.push(i)
    else map.set(k, [i])
  })
  return map
}

function lookup(index: Map<number, number[]>, code: number[]): number[] {
  const lo = code.map((x) => cellOf(x - CODE_TOL))
  const hi = code.map((x) => cellOf(x + CODE_TOL))
  const out: number[] = []
  for (let a = lo[0]; a <= hi[0]; a++)
    for (let b = lo[1]; b <= hi[1]; b++)
      for (let c = lo[2]; c <= hi[2]; c++)
        for (let d = lo[3]; d <= hi[3]; d++) {
          const bucket = index.get(keyOf(a, b, c, d))
          if (bucket) out.push(...bucket)
        }
  return out
}

/** Nearest-neighbour matching of detected stars to projected catalogue stars, one to one. */
function matchStars(
  cam: S.Camera,
  detected: [number, number, number][],
  candidates: { star: number; vec: S.Vec3 }[],
  tol: number
): { matches: MatchedStar[]; inFrame: number; chance: number } {
  const cell = Math.max(tol, 8)
  const grid = new Map<number, { x: number; y: number; star: number }[]>()
  let nCand = 0
  const key = (cx: number, cy: number): number => cx * 100003 + cy
  for (const c of candidates) {
    const p = S.project(cam, c.vec)
    if (!p || !Number.isFinite(p.x)) continue
    if (p.x < -tol || p.y < -tol || p.x > cam.width + tol || p.y > cam.height + tol) continue
    nCand++
    const k = key(Math.floor(p.x / cell), Math.floor(p.y / cell))
    const b = grid.get(k)
    if (b) b.push({ x: p.x, y: p.y, star: c.star })
    else grid.set(k, [{ x: p.x, y: p.y, star: c.star }])
  }
  const pairs: { d: number; det: number; star: number }[] = []
  detected.forEach(([x, y], di) => {
    const cx = Math.floor(x / cell)
    const cy = Math.floor(y / cell)
    for (let ax = cx - 1; ax <= cx + 1; ax++)
      for (let ay = cy - 1; ay <= cy + 1; ay++)
        for (const s of grid.get(key(ax, ay)) ?? []) {
          const d = Math.hypot(s.x - x, s.y - y)
          if (d <= tol) pairs.push({ d, det: di, star: s.star })
        }
  })
  pairs.sort((p, q) => p.d - q.d)
  const usedDet = new Set<number>()
  const usedStar = new Set<number>()
  const matches: MatchedStar[] = []
  for (const p of pairs) {
    if (usedDet.has(p.det) || usedStar.has(p.star)) continue
    usedDet.add(p.det)
    usedStar.add(p.star)
    matches.push({ x: detected[p.det][0], y: detected[p.det][1], star: p.star })
  }
  // Detected stars the solved frame actually covers (the denominator for "how many matched").
  let inFrame = 0
  for (const [x, y] of detected) if (x >= 0 && y >= 0 && x <= cam.width && y <= cam.height) inFrame++
  // Chance of a random detection landing within tol of *some* candidate, times detections.
  const perStar = Math.min(1, (nCand * Math.PI * tol * tol) / (cam.width * cam.height))
  return { matches, inFrame, chance: inFrame * perStar }
}

/** Matches needed before "this is a real solution" beats "this is luck" by a wide margin. */
function significant(m: { matches: MatchedStar[]; chance: number }): boolean {
  return m.matches.length >= Math.max(MIN_MATCHES, m.chance + 6 * Math.sqrt(m.chance + 1))
}

export function plateSolve(input: SolveInput): SolveOutput | null {
  const { camera: tpl, detected: all } = input
  const detected = all.slice(0, MAX_DETECTED)
  if (detected.length < 6) return null
  const diag = Math.hypot(tpl.width, tpl.height)

  // Catalogue in the camera's (of-date) frame, brightest first.
  const P = S.precessionMatrix(input.jd)
  const n = input.ra.length
  const vecs: S.Vec3[] = new Array(n)
  for (let i = 0; i < n; i++) vecs[i] = S.applyMatrix(P, S.radecToVec(input.ra[i], input.dec[i]))
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => input.mag[a] - input.mag[b])
  const all2500 = order.slice(0, 2500).map((star) => ({ star, vec: vecs[star] }))

  const multipliers = input.fovKnown ? [1, 0.93, 1.08] : [1, 0.8, 1.25, 0.64, 1.56]
  const identity = { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1] } as const

  for (const m of multipliers) {
    const fov = Math.min(tpl.fovH * m, S.maxFovH(tpl.projection) * 0.99)
    const guess: S.Camera = { ...tpl, fovH: fov }
    const fovDeg = fov / DEG

    // Image side: pixels -> directions (z flipped so the frame is a proper rotation of the sky).
    const imgDirs = detected.map(([x, y]) => {
      const c = S.unproject({ ...guess, ...identity } as S.Camera, x, y)
      return [c[0], c[1], -c[2]] as S.Vec3
    })
    const imgQuads = makeQuads(imgDirs)

    // Catalogue side: as many bright stars as the frame would hold if every detection were real.
    const frameArea = Math.min(41253 * 0.6, fovDeg * fovDeg * (tpl.height / tpl.width))
    const poolSize = Math.max(250, Math.min(2600, Math.round(detected.length * (41253 / frameArea) * 1.4)))
    const pool = order.slice(0, poolSize)
    const catQuads = makeQuads(pool.map((i) => vecs[i]))
    const index = buildIndex(catQuads)

    // Propose in order of how well the codes agree.
    const proposals: { qi: number; ci: number; d: number }[] = []
    imgQuads.forEach((q, qi) => {
      for (const ci of lookup(index, q.code)) {
        const c = catQuads[ci].code
        const d = Math.hypot(c[0] - q.code[0], c[1] - q.code[1], c[2] - q.code[2], c[3] - q.code[3])
        if (d <= CODE_TOL) proposals.push({ qi, ci, d })
      }
    })
    proposals.sort((a, b) => a.d - b.d)

    const tol = Math.max(4, 0.004 * diag)
    const tried = new Set<string>()
    let verified = 0
    for (const { qi, ci } of proposals) {
      if (verified >= MAX_VERIFY) break
      const iq = imgQuads[qi].idx
      const cq = catQuads[ci].idx.map((k) => pool[k])
      const dedupe = `${cq.join(',')}`
      if (tried.has(dedupe)) continue
      tried.add(dedupe)
      verified++

      const obs = iq.map((di, k) => ({
        pixel: { x: detected[di][0], y: detected[di][1] },
        dir: vecs[cq[k]]
      }))
      const sol = S.solveCamera(guess, obs, { fitFov: true, fitK1: false })
      if (!sol || sol.rmsPx > 0.015 * diag) continue
      // Solved field of view has to stay in a believable range of the guess.
      const ratio = sol.camera.fovH / fov
      const [lo, hi] = input.fovKnown ? [0.75, 1.35] : [0.5, 2]
      if (ratio < lo || ratio > hi) continue

      const first = matchStars(sol.camera, detected, all2500, tol)
      if (!significant(first) || first.matches.length < 0.2 * first.inFrame) continue

      const refined = refine(input, sol.camera, detected, all2500, diag, fov)
      // Re-verify at the tight tolerance the refined camera earns; luck rarely survives that.
      if (significant(refined.check)) return refined.out
    }
  }
  return null
}

function refine(
  input: SolveInput,
  start: S.Camera,
  detected: [number, number, number][],
  candidates: { star: number; vec: S.Vec3 }[],
  diag: number,
  fovGuess: number
): { out: SolveOutput; check: { matches: MatchedStar[]; chance: number } } {
  let cam = start
  let best = matchStars(cam, detected, candidates, Math.max(4, 0.004 * diag))
  let rms = 0
  for (const tolFrac of [0.004, 0.0025, 0.0015, 0.0015]) {
    const tol = Math.max(2.5, tolFrac * diag)
    const cur = matchStars(cam, detected, candidates, tol)
    if (cur.matches.length < 4) break
    const vecOf = new Map(candidates.map((c) => [c.star, c.vec]))
    const obs = cur.matches.map((m) => ({ pixel: { x: m.x, y: m.y }, dir: vecOf.get(m.star)! }))
    const sol = S.solveCamera(cam, obs, { fitFov: true, fitK1: !!input.fitK1 && obs.length >= 10 })
    if (!sol) break
    cam = sol.camera
    rms = sol.rmsPx
    best = cur
  }
  // Final association at the tightest tolerance with the refined camera.
  const final = matchStars(cam, detected, candidates, Math.max(2.5, 0.0015 * diag * 1.5))
  if (final.matches.length >= best.matches.length * 0.8) best = final
  return {
    out: {
      camera: cam,
      matches: best.matches,
      rmsPx: rms,
      detectedInFrame: best.inFrame,
      fovGuessUsed: fovGuess / DEG
    },
    check: best
  }
}
