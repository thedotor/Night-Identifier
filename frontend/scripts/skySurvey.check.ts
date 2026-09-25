// Numerical check that a survey cut-out registers onto the photo.
// Run: node --import ./scripts/ts-resolve.mjs scripts/skySurvey.check.ts
//
// A sky point at a known offset from the cut-out centre sits at a known cut-out pixel (north up,
// east left, tangent plane). surveyMatrix() must carry that pixel to wherever the camera puts the
// same sky point, for any orientation, roll and lens.
import * as S from '../src/renderer/src/lib/skyMath.ts'
import { surveyMatrix, type SurveyPatch } from '../src/renderer/src/lib/skySurvey.ts'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}
const DEG = Math.PI / 180

const jd = S.julianDate(new Date('2026-09-24T02:00:00Z'))
const toDate = S.precessionMatrix(jd)

const cases: { name: string; ra: number; dec: number; roll: number; proj: S.Projection; fov: number; patchFov: number }[] = [
  { name: 'rectilinear, no roll', ra: 10.68, dec: 41.27, roll: 0, proj: 'rectilinear', fov: 20, patchFov: 1 },
  { name: 'rectilinear, rolled 37 deg', ra: 10.68, dec: 41.27, roll: 37, proj: 'rectilinear', fov: 20, patchFov: 1 },
  { name: 'wide fisheye, rolled 200 deg', ra: 83.8, dec: -5.4, roll: 200, proj: 'equidistant', fov: 150, patchFov: 0.5 },
  { name: 'near the pole', ra: 37.9, dec: 89.2, roll: 15, proj: 'rectilinear', fov: 30, patchFov: 1 }
]

for (const c of cases) {
  // Camera pointing at the patch centre (in the of-date frame the overlay uses).
  const centreDate = S.applyMatrix(toDate, S.radecToVec(c.ra, c.dec))
  const { ra, dec } = S.vecToRadec(centreDate)
  const cam = S.pointCamera(S.makeCamera(ra, dec, c.roll, c.fov, c.proj, 6000, 4000), ra, dec, c.roll)
  const patch: SurveyPatch = { ra: c.ra, dec: c.dec, fovDeg: c.patchFov, width: 1024, height: 1024 }
  const m = surveyMatrix(cam, toDate, patch)
  if (!m) {
    check(c.name, false, 'no matrix')
    continue
  }
  // Points on the tangent plane at +-40% of the field, at the survey pixel they would occupy.
  const east = S.normalize(S.cross([0, 0, 1], S.radecToVec(c.ra, c.dec)))
  const north = S.cross(S.radecToVec(c.ra, c.dec), east)
  const half = Math.tan((patch.fovDeg * DEG) / 2)
  let worst = 0
  for (const xi of [-0.4, 0, 0.4])
    for (const eta of [-0.4, 0, 0.4]) {
      // tangent-plane offset (east = xi, north = eta) in units of the field width
      const dir = S.normalize(S.add3(S.radecToVec(c.ra, c.dec), S.add3(S.scale3(east, xi * 2 * half), S.scale3(north, eta * 2 * half))))
      const u = patch.width / 2 - xi * patch.width // east is left
      const v = patch.height / 2 - eta * patch.height // north is up
      const want = S.project(cam, S.applyMatrix(toDate, dir))
      if (!want) continue
      const got = { x: m[0] * u + m[2] * v + m[4], y: m[1] * u + m[3] * v + m[5] }
      worst = Math.max(worst, Math.hypot(got.x - want.x, got.y - want.y))
    }
  // How big is the patch in photo pixels? Error should be a tiny fraction of that.
  const sizePx = Math.hypot(m[0], m[1]) * patch.width
  check(c.name, worst < sizePx * 0.01, `worst error ${worst.toFixed(2)} px over a ${sizePx.toFixed(0)} px patch`)
}

if (failed) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
