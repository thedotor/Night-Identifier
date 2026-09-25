// Blind plate-solve regression. Run: node scripts/plateSolve.check.ts
// Renders real catalogue stars through a random known camera, degrades the detections
// (jitter, missing stars, false stars), solves from a wrong field-of-view guess and
// compares with the truth.
import { readFileSync } from 'node:fs'
import * as S from '../src/renderer/src/lib/skyMath.ts'
import { plateSolve } from '../src/renderer/src/lib/plateSolve.ts'

const raw = JSON.parse(readFileSync(new URL('../../backend/app/data/sky/catalogue.json', import.meta.url), 'utf-8'))
const n = raw.stars.length / 3
const ra = new Float64Array(n), dec = new Float64Array(n), mag = new Float64Array(n)
for (let i = 0; i < n; i++) [ra[i], dec[i], mag[i]] = [raw.stars[3 * i], raw.stars[3 * i + 1], raw.stars[3 * i + 2]]

let seed = 4242
const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
const DEG = Math.PI / 180
const jd = S.julianDate(new Date(Date.UTC(2026, 8, 20, 22, 0, 0)))
const P = S.precessionMatrix(jd)
const vecs = Array.from({ length: n }, (_, i) => S.applyMatrix(P, S.radecToVec(ra[i], dec[i])))
const byMag = Array.from({ length: n }, (_, i) => i).sort((a, b) => mag[a] - mag[b])

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

function trial(projection: S.Projection, fov: number, fovKnown: boolean, fovOff: number, missing: number, falseStars: number, jitter: number) {
  const W = 6000, H = 4000
  const truth = S.makeCamera(rnd() * 360, rnd() * 120 - 60, rnd() * 360 - 180, fov, projection, W, H)
  const seen: { x: number; y: number; b: number }[] = []
  for (const i of byMag) {
    if (mag[i] > 6.2) break
    const p = S.project(truth, vecs[i])
    if (p && p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H) seen.push({ x: p.x, y: p.y, b: -mag[i] })
  }
  const kept = seen.filter(() => rnd() > missing).slice(0, 40)
  const det = kept.map((s) => ({ x: s.x + (rnd() - 0.5) * 2 * jitter, y: s.y + (rnd() - 0.5) * 2 * jitter, b: s.b }))
  for (let i = 0; i < falseStars; i++) det.push({ x: rnd() * W, y: rnd() * H, b: -5 - rnd() * 1.5 })
  det.sort((a, b) => b.b - a.b)
  const tpl = { ...S.makeCamera(0, 0, 0, fov * fovOff, projection, W, H) }
  const t0 = Date.now()
  const out = plateSolve({ ra, dec, mag, jd, detected: det.map((d) => [d.x, d.y, d.b]), camera: tpl, fovKnown })
  const ms = Date.now() - t0
  if (!out) return { ok: false, ms, seen: seen.length, det: det.length }
  const centreErr = S.angleBetween(truth.forward, out.camera.forward) / DEG
  const fovErr = Math.abs(out.camera.fovH / truth.fovH - 1)
  return { ok: centreErr < 0.25 && fovErr < 0.02, centreErr, fovErr, ms, matches: out.matches.length, seen: seen.length, det: det.length, rms: out.rmsPx }
}

const cases: [string, S.Projection, number, boolean, number][] = [
  ['rectilinear 60deg, EXIF fov +12% off', 'rectilinear', 60, true, 1.12],
  ['rectilinear 35deg, EXIF fov -8% off', 'rectilinear', 35, true, 0.92],
  ['rectilinear 90deg, fov unknown (guess 30% off)', 'rectilinear', 90, false, 1.3],
  ['equidistant fisheye 180deg, fov known', 'equidistant', 180, true, 1.05],
  ['equisolid fisheye 160deg, fov unknown', 'equisolid', 160, false, 0.8]
]
for (const [name, proj, fov, known, off] of cases) {
  const runs = 8
  let ok = 0, worstC = 0, worstF = 0, maxMs = 0, minMatches = 99
  for (let i = 0; i < runs; i++) {
    const r = trial(proj, fov, known, off, 0.2, 10, 1.0)
    maxMs = Math.max(maxMs, r.ms)
    if (r.ok) {
      ok++
      worstC = Math.max(worstC, r.centreErr!)
      worstF = Math.max(worstF, r.fovErr!)
      minMatches = Math.min(minMatches, r.matches!)
    }
  }
  check(`auto-solve ${name}`, ok >= runs - 1, `${ok}/${runs} ok, worst centre ${worstC.toFixed(3)} deg, fov ${(worstF * 100).toFixed(2)}%, min matches ${minMatches}, slowest ${maxMs} ms`)
}

// Garbage in must not produce a confident wrong answer.
{
  let falsePositives = 0
  const W = 6000, H = 4000
  for (let i = 0; i < 6; i++) {
    const det = Array.from({ length: 40 }, () => [rnd() * W, rnd() * H, 100 - i] as [number, number, number])
    const out = plateSolve({ ra, dec, mag, jd, detected: det, camera: S.makeCamera(0, 0, 0, 60, 'rectilinear', W, H), fovKnown: true })
    if (out) falsePositives++
  }
  check('random points are rejected (no false solve)', falsePositives === 0, `${falsePositives}/6 false solves`)
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
