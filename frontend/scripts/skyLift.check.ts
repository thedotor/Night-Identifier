// Numerical checks for the photo <-> 3D match used by the merged zoom.
// Run: node --import ./scripts/ts-resolve.mjs scripts/skyLift.check.ts
import * as S from '../src/renderer/src/lib/skyMath.ts'
import { MAX_GROUND_FOV_DEG, dateToEcliptic, liftFade, matchView, matchViewOfDate, nadirBlend, stepAltitude, zenithEcliptic, zoomForFov } from '../src/renderer/src/lib/skyLift.ts'
import { equatorialToEcliptic, radecVec } from '../src/renderer/src/lib/galaxyMath.ts'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}
const DEG = Math.PI / 180
type V = [number, number, number]
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

const jd = S.julianDate(new Date('2026-09-24T02:00:00Z'))
const toDate = S.precessionMatrix(jd)
const size = { w: 1100, h: 760 }

/** A pinhole camera from a LiftView, in whatever frame the view is in: screen position of a direction. */
function pinhole(view: { forward: V; up: V; fovDeg: number; principal: { x: number; y: number } }, v: V): { x: number; y: number } | null {
  const right = cross(view.forward, view.up)
  const z = dot(v, view.forward)
  if (z <= 0) return null
  const f = size.h / 2 / Math.tan((view.fovDeg * DEG) / 2)
  return { x: view.principal.x + (f * dot(v, right)) / z, y: view.principal.y - (f * dot(v, view.up)) / z }
}

// 1. A rectilinear photo, zoomed out: the pinhole view reproduces where the photo puts stars.
for (const roll of [0, 35, -120]) {
  const cam = S.makeCamera(83.8, -5.4, roll, 62, 'rectilinear', 6000, 4000)
  for (const k of [0.13, 0.09, 0.06]) {
    const xf = { k, ox: size.w / 2 - 3000 * k + 20, oy: size.h / 2 - 2000 * k - 15 } // slightly off-centre
    const view = matchViewOfDate(cam, xf, size)
    let worst = 0
    let n = 0
    // stars within the photo, up to ~22 degrees from its centre
    const centre = view.forward
    for (let i = 0; i < 400; i++) {
      const a = (i * 137.5) % 360
      const r = ((i * 0.061) % 1) * 22
      const east = cross([0, 0, 1], centre)
      const north = cross(centre, east)
      const e = east.map((x) => x / Math.hypot(...east)) as V
      const nn = north.map((x) => x / Math.hypot(...north)) as V
      const dir: V = [0, 1, 2].map((j) => centre[j] + Math.tan(r * DEG) * (Math.cos(a * DEG) * e[j] + Math.sin(a * DEG) * nn[j])) as V
      const d = dir.map((x) => x / Math.hypot(...dir)) as V
      const p = S.project(cam, d)
      const q = pinhole(view, d)
      if (!p || !q) continue
      const sx = xf.ox + p.x * xf.k
      const sy = xf.oy + p.y * xf.k
      worst = Math.max(worst, Math.hypot(sx - q.x, sy - q.y))
      n++
    }
    check(`rectilinear roll ${roll} deg, zoom ${k}: 3D lands on the photo's stars`, n > 300 && worst < 3, `worst ${worst.toFixed(2)} px over ${n} stars, fov ${view.fovDeg.toFixed(1)} deg`)
  }
}

// 2. Zooming out widens the field of view in inverse proportion, and zoomForFov inverts it.
{
  const cam = S.makeCamera(10, 30, 0, 74, 'rectilinear', 6000, 4000)
  const fovAt = (k: number): number => matchViewOfDate(cam, { k, ox: size.w / 2 - 3000 * k, oy: size.h / 2 - 2000 * k }, size).fovDeg
  check('zooming out widens the view', fovAt(0.06) > fovAt(0.09) && fovAt(0.09) > fovAt(0.13), `${fovAt(0.13).toFixed(1)} -> ${fovAt(0.09).toFixed(1)} -> ${fovAt(0.06).toFixed(1)} deg`)
  const kMax = zoomForFov(cam, size.h, MAX_GROUND_FOV_DEG)
  const back = fovAt(kMax)
  check(`zoomForFov(${MAX_GROUND_FOV_DEG} deg) gives a ${MAX_GROUND_FOV_DEG} deg view`, Math.abs(back - MAX_GROUND_FOV_DEG) < 0.5, `zoom ${kMax.toFixed(4)} -> ${back.toFixed(2)} deg`)
}

// 3. Frames: J2000 ecliptic conversion, and the zenith agrees with the overlay's own horizon maths.
{
  const ident = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const e = dateToEcliptic(ident, radecVec(90, 23.4392911)) // ecliptic longitude 90, latitude 0
  check('with no precession, RA 90 / Dec +23.44 is on the ecliptic at longitude 90 deg', Math.abs(e[1] - 1) < 1e-6 && Math.abs(e[2]) < 1e-6)
  const viaMatrix = dateToEcliptic(toDate, S.applyMatrix(toDate, radecVec(150, 20)))
  const direct = equatorialToEcliptic(radecVec(150, 20))
  check('of-date -> J2000 undoes the precession', Math.hypot(viaMatrix[0] - direct[0], viaMatrix[1] - direct[1], viaMatrix[2] - direct[2]) < 1e-12)
  const obs = { latDeg: 51.5, lonDeg: -0.13, date: new Date('2026-09-24T02:00:00Z') }
  const zen = zenithEcliptic(toDate, obs)
  // The zenith's declination equals the latitude, whatever the time.
  const zenEq: V = S.altAzToVec(90, 0, obs) // already in the of-date frame
  const dec = Math.asin(zenEq[2] / Math.hypot(...zenEq)) / DEG
  check('the zenith is at declination = latitude', Math.abs(dec - 51.5) < 0.01, `${dec.toFixed(3)} deg`)
  check('the zenith is a unit vector in the scene frame', Math.abs(Math.hypot(...zen) - 1) < 1e-9)
}

// 4. Fade, altitude and the tilt towards the ground.
{
  check('photo fills the window: no 3D yet', liftFade(0.13, 0.13) === 0 && liftFade(0.12, 0.13) === 0)
  check('photo at half size: all 3D', liftFade(0.06, 0.13) === 1)
  check('fade is monotonic', liftFade(0.1, 0.13) < liftFade(0.08, 0.13) && liftFade(0.08, 0.13) < liftFade(0.065, 0.13))
  let a = 0
  for (let i = 0; i < 60; i++) a = stepAltitude(a, 100)
  check('60 wheel clicks up from the ground reach space-scale altitudes', a > 4e5, `${(a / 1000).toFixed(0)} km`)
  let b = a
  for (let i = 0; i < 200; i++) b = stepAltitude(b, -100)
  check('wheeling back down returns to the ground and stays there', b === 0 && stepAltitude(0, -100) === 0)
  check('up then down is symmetric', Math.abs(stepAltitude(stepAltitude(1000, 100), -100) - 1000) < 1e-6)
  check('looking at the sky below 20 km, at the ground by 400 km', nadirBlend(5000) === 0 && nadirBlend(400_000) === 1 && nadirBlend(100_000) > 0.3 && nadirBlend(100_000) < 0.9)
}

if (failed) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
