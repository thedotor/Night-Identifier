// Numerical checks for the Live View star overlay maths.
// Run (in frontend/): node --import ./scripts/ts-resolve.mjs scripts/liveSky.check.ts
import * as S from '../src/renderer/src/lib/skyMath.ts'
import * as L from '../src/renderer/src/lib/liveSky.ts'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}
const DEG = Math.PI / 180
const jdOf = (iso: string): number => S.julianDate(new Date(iso))
const dist = (a: S.Vec3, b: S.Vec3): number => S.angleBetween(a, b) / DEG

// 1. the Earth turns 360.98564736629 deg per day, and a sidereal day comes back round
const t0 = jdOf('2026-09-24T20:00:00Z')
check('one hour is 15.041 deg', Math.abs(L.earthTurnDeg(t0, t0 + 1 / 24) - 15.0411) < 1e-3, `${L.earthTurnDeg(t0, t0 + 1 / 24).toFixed(4)}`)
check('one sidereal day is a full turn (wraps to ~0)', Math.abs(L.earthTurnDeg(t0, t0 + 0.9972695663)) < 1e-3)
check('going back in time turns the other way', L.earthTurnDeg(t0 + 0.01, t0) < 0)

// 2. THE key property: a camera fixed to the ground, turned by the Earth's rotation, is exactly the
//    camera you would get by aiming at the same altitude/azimuth at the later time.
{
  const obs0 = { latDeg: 51.5, lonDeg: -0.1, date: new Date('2026-09-24T20:00:00Z') }
  for (const [alt, az, tilt] of [[35, 180, 0], [60, 90, 12], [20, 300, -5], [85, 10, 0]] as const) {
    for (const minutes of [1, 10, 60, 300, 1300]) {
      const later = new Date(obs0.date.getTime() + minutes * 60000)
      const base = S.makeCamera(0, 0, 0, 70, 'rectilinear', 1920, 1080)
      const c0 = S.cameraFromAltAz(base, alt, az, tilt, obs0)
      const predicted = L.cameraAfter(c0, L.earthTurnDeg(S.julianDate(obs0.date), S.julianDate(later)))
      const truth = S.cameraFromAltAz(base, alt, az, tilt, { ...obs0, date: later })
      const err = Math.max(dist(predicted.forward, truth.forward), dist(predicted.up, truth.up), dist(predicted.right, truth.right))
      check(`fixed camera alt ${alt} az ${az} after ${minutes} min`, err < 1e-6, `axes differ by ${err.toExponential(1)} deg`)
    }
  }
}

// 3. direction of motion: facing east, stars rise (move up the picture); facing west they set (move down);
//    facing north in the northern hemisphere they circle anticlockwise about Polaris.
{
  const obs = { latDeg: 51.5, lonDeg: -0.1, date: new Date('2026-09-24T20:00:00Z') }
  const base = S.makeCamera(0, 0, 0, 70, 'rectilinear', 1920, 1080)
  const jd = S.julianDate(obs.date)
  const moves = (az: number): { dx: number; dy: number } => {
    const c = S.cameraFromAltAz(base, 30, az, 0, obs)
    const star = S.unproject(c, 960 + 100, 540 - 50) // a star in the frame at t0
    const p0 = S.project(c, star)!
    const p1 = S.project(L.cameraAfter(c, L.earthTurnDeg(jd, jd + 10 / 1440)), star)!
    return { dx: p1.x - p0.x, dy: p1.y - p0.y }
  }
  const east = moves(90)
  const west = moves(270)
  check('facing east the stars rise', east.dy < -5, `moved ${east.dy.toFixed(1)} px in y`)
  check('facing west the stars set', west.dy > 5, `moved ${west.dy.toFixed(1)} px in y`)
  // The rate: 10 minutes is 2.507 deg of sky; near the celestial equator that is ~all on-screen motion.
  const speed = Math.hypot(east.dx, east.dy) / S.focalPx(base)
  check('east speed is close to 2.5 deg in 10 minutes', Math.abs(Math.atan(speed) / DEG - 2.507) < 0.6, `${(Math.atan(speed) / DEG).toFixed(2)} deg`)
  // Facing north the tracks are arcs about the pole: the pole itself stays put.
  const north = S.cameraFromAltAz(base, 51.5, 0, 0, obs) // aimed at the pole (altitude = latitude)
  const pole: S.Vec3 = [0, 0, 1]
  const poleNow = S.project(north, pole)!
  const poleLater = S.project(L.cameraAfter(north, L.earthTurnDeg(jd, jd + 0.3)), pole)!
  check('the celestial pole does not move in the picture', Math.hypot(poleNow.x - poleLater.x, poleNow.y - poleLater.y) < 0.01, `${Math.hypot(poleNow.x - poleLater.x, poleNow.y - poleLater.y).toExponential(1)} px`)
  // ...while a star near it circles it: anticlockwise on screen when looking north from the northern hemisphere
  const near = S.unproject(north, 960 + 200, 540)
  const q0 = S.project(north, near)!
  const q1 = S.project(L.cameraAfter(north, L.earthTurnDeg(jd, jd + 0.02)), near)!
  const cross = (q0.x - poleNow.x) * (q1.y - poleNow.y) - (q0.y - poleNow.y) * (q1.x - poleNow.x)
  check('stars near the north pole circle anticlockwise on screen', cross < 0, `cross ${cross.toFixed(1)} (negative = anticlockwise with y down)`)
}

// 4. tracking mount: the turn is cancelled
{
  const align: L.SkyAlignment = { camera: S.cameraToJson(S.makeCamera(83.8, -5.4, 3, 20, 'rectilinear', 100, 100)), jd0: t0, frameJd: t0, how: 'manual' }
  const still = L.cameraAt(align, t0 + 0.2, 1920, 1080, true)!
  const drift = L.cameraAt(align, t0 + 0.2, 1920, 1080, false)!
  const base = S.cameraFromJson(align.camera, 1920, 1080)!
  check('tracking mount holds the alignment', dist(still.forward, base.forward) < 1e-9)
  check('a fixed camera is turned by the sky', dist(drift.forward, base.forward) > 1)
  check('the size of the frame is taken from the live picture', still.width === 1920 && still.height === 1080)
}

// 5. clicks made at different times combine into one consistent fit
{
  const cam0 = S.makeCamera(200, 30, 7, 60, 'rectilinear', 1920, 1080)
  const jdFit = t0 + 60 / 1440 // the moment the user presses Fit
  const truthAt = (jd: number): S.Camera => L.cameraAfter(cam0, L.earthTurnDeg(t0, jd))
  const stars: S.Vec3[] = [S.radecToVec(190, 25), S.radecToVec(215, 38), S.radecToVec(203, 20), S.radecToVec(180, 40), S.radecToVec(222, 28)]
  // click each star at a different minute, at the pixel where the sky really put it then
  const clicks = stars.map((v, i) => {
    const jd = t0 + (i * 12) / 1440
    return { jd, pixel: S.project(truthAt(jd), v)!, dir: v }
  })
  const start = truthAt(jdFit)
  // a fit that ignores the drift (the naive way) versus one that carries each star to the fit time
  const naive = S.solveCamera({ ...start, fovH: start.fovH * 1.02 }, clicks.map((c) => ({ pixel: c.pixel, dir: c.dir })), { fitFov: true, fitK1: false })!
  const carried = S.solveCamera({ ...start, fovH: start.fovH * 1.02 }, clicks.map((c) => ({ pixel: c.pixel, dir: L.carryDirection(c.dir, c.jd, jdFit) })), { fitFov: true, fitK1: false })!
  check('carried fit reproduces the true camera', dist(carried.camera.forward, start.forward) < 0.01 && carried.rmsPx < 0.2, `rms ${carried.rmsPx.toFixed(3)} px, axis off ${dist(carried.camera.forward, start.forward).toFixed(4)} deg`)
  check('ignoring the drift would have been visibly wrong', naive.rmsPx > 10 * Math.max(carried.rmsPx, 0.05), `naive rms ${naive.rmsPx.toFixed(1)} px`)
}

// 6. precession rebase: a star drawn in the old frame lands on the same pixel in the new frame
{
  const jdA = jdOf('2026-01-01T00:00:00Z')
  const jdB = jdOf('2034-06-01T00:00:00Z')
  const star = S.radecToVec(101.287, -16.716) // Sirius, J2000
  const camA = S.makeCamera(100, -17, 0, 30, 'rectilinear', 1920, 1080)
  const camB = L.rebaseFrame(camA, jdA, jdB)
  const pa = S.project(camA, S.applyMatrix(S.precessionMatrix(jdA), star))!
  const pb = S.project(camB, S.applyMatrix(S.precessionMatrix(jdB), star))!
  check('rebase keeps stars on the same pixels', Math.hypot(pa.x - pb.x, pa.y - pb.y) < 1e-6, `${Math.hypot(pa.x - pb.x, pa.y - pb.y).toExponential(1)} px`)
  const back = L.rebaseFrame(camB, jdB, jdA)
  check('rebase round-trips', dist(back.forward, camA.forward) < 1e-9 && dist(back.up, camA.up) < 1e-9)
}

// 7. a stored alignment survives JSON and a change of frame
{
  const align: L.SkyAlignment = { camera: S.cameraToJson(S.makeCamera(10, 20, 30, 45, 'equidistant', 10, 10)), jd0: t0, frameJd: t0, how: 'auto', rmsPx: 1.2, matched: 30 }
  const later = L.alignmentInFrame(JSON.parse(JSON.stringify(align)) as L.SkyAlignment, t0 + 400)
  check('alignment round-trips through storage', later !== null && later.frameJd === t0 + 400 && later.how === 'auto' && later.matched === 30)
}

check('parseNumber', L.parseNumber(' 12.5 ') === 12.5 && L.parseNumber('') === null && L.parseNumber('abc') === null)
check('site needs a valid latitude', L.siteFrom('95', '10', new Date()) === null && L.siteFrom('45', '-75', new Date()) !== null)

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
