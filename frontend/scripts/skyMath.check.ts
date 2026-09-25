// Numerical checks for the sky overlay maths. Run: node scripts/skyMath.check.ts
import * as S from '../src/renderer/src/lib/skyMath.ts'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}
let seed = 12345
const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
const DEG = Math.PI / 180

// 1. unproject(project(v)) == v for every projection, across the frame incl. edges/corners
for (const proj of S.PROJECTIONS.map((p) => p.id)) {
  const fov = proj === 'rectilinear' ? 90 : proj === 'orthographic' ? 170 : 180
  const cam = { ...S.makeCamera(123, -20, 15, fov, proj, 6000, 4000), k1: 0.05 }
  let worst = 0
  let n = 0
  for (let ix = 0; ix <= 20; ix++)
    for (let iy = 0; iy <= 20; iy++) {
      const x = (ix / 20) * cam.width
      const y = (iy / 20) * cam.height
      // Orthographic/equisolid lenses only image a disc; corners outside it have no sky.
      if (Math.hypot(x - cam.width / 2, y - cam.height / 2) / S.focalPx(cam) > (proj === 'orthographic' ? 0.98 : 1.9)) continue
      const v = S.unproject(cam, x, y)
      const p = S.project(cam, v)
      if (!p) continue
      worst = Math.max(worst, Math.hypot(p.x - x, p.y - y))
      n++
    }
  check(`round trip ${proj}`, worst < 0.01 && n > 300, `worst ${worst.toExponential(2)} px over ${n} points`)
}

// 2. time / coordinate chain against known values
const j2000 = S.julianDate(new Date(Date.UTC(2000, 0, 1, 12, 0, 0)))
check('JD at J2000', Math.abs(j2000 - 2451545.0) < 1e-9)
check('GMST at J2000 = 280.4606 deg', Math.abs(S.gmstDeg(j2000) - 280.46062) < 1e-4)
{
  // Polaris (RA 37.9546, Dec 89.2641): altitude ~ latitude +/- its 0.74 deg offset, azimuth near north
  const obs = { latDeg: 51.5, lonDeg: -0.1, date: new Date(Date.UTC(2026, 0, 15, 22, 0, 0)) }
  const v = S.radecToVec(37.9546, 89.2641)
  const aa = S.vecAltAz(v, obs)
  check('Polaris altitude ~ latitude', Math.abs(aa.alt - 51.5) < 1.0, `alt ${aa.alt.toFixed(2)}`)
  check('Polaris azimuth near north', aa.az < 3 || aa.az > 357, `az ${aa.az.toFixed(2)}`)
  const back = S.vecToRadec(S.altAzToVec(aa.alt, aa.az, obs))
  check('altAz round trip', Math.abs(back.ra - 37.9546) < 1e-6 && Math.abs(back.dec - 89.2641) < 1e-6)
  // Object on the meridian at Dec = lat is at the zenith
  const lst = (S.gmstDeg(S.julianDate(obs.date)) + obs.lonDeg + 360) % 360
  const zen = S.vecAltAz(S.radecToVec(lst, 51.5), obs)
  check('zenith', zen.alt > 89.99, `alt ${zen.alt.toFixed(3)}`)
}
{
  // Precession over 26 years moves an equatorial star by ~50.3"/yr
  const jd = j2000 + 26 * 365.25
  const v0 = S.radecToVec(0, 0)
  const v1 = S.applyMatrix(S.precessionMatrix(jd), v0)
  const arcmin = (S.angleBetween(v0, v1) / DEG) * 60
  check('precession 26 yr ~ 21.8 arcmin', Math.abs(arcmin - 21.8) < 0.3, `${arcmin.toFixed(2)}'`)
}

// 3. pose parameterisation
{
  const cam = S.makeCamera(200, 35, 30, 60, 'rectilinear', 4000, 3000)
  const p = S.cameraPointing(cam)
  check('pointing round trip', Math.abs(p.ra - 200) < 1e-9 && Math.abs(p.dec - 35) < 1e-9 && Math.abs(p.roll - 30) < 1e-9, JSON.stringify(p))
  const orth = Math.abs(S.dot(cam.right, cam.up)) + Math.abs(S.dot(cam.right, cam.forward)) + Math.abs(S.dot(cam.up, cam.forward))
  check('orthonormal basis', orth < 1e-12)
  const east: S.Vec3 = [-Math.sin(200 * DEG), Math.cos(200 * DEG), 0]
  const cam0 = S.makeCamera(200, 35, 0, 60, 'rectilinear', 4000, 3000)
  check('east is to the left at roll 0', S.dot(east, cam0.right) < -0.99)
}

// 4. drag keeps the grabbed sky point under the cursor
{
  const cam = S.makeCamera(50, 20, 10, 80, 'equidistant', 5000, 3500)
  const from = { x: 1800, y: 900 }
  const to = { x: 2600, y: 1500 }
  const sky = S.unproject(cam, from.x, from.y)
  const moved = S.panCamera(cam, from, to)
  const at = S.project(moved, sky)!
  check('pan keeps sky point under cursor', Math.hypot(at.x - to.x, at.y - to.y) < 1e-6)
  const rolled = S.rollCamera(cam, 20)
  const c = S.cameraPointing(cam).roll
  const c2 = S.cameraPointing(rolled).roll
  check('roll changes pose by |20| deg about the axis', Math.abs(Math.abs(c2 - c) - 20) < 1e-6, `${c.toFixed(2)} -> ${c2.toFixed(2)}`)
  const s = S.scaleFov(cam, 0.5)
  check('scaleFov halves fov', Math.abs(s.fovH / cam.fovH - 0.5) < 1e-12)
}

// 5. solver recovers a known camera from noisy pairs
function trial(projection: S.Projection, fov: number, nPairs: number, noise: number, fitK1 = false, k1 = 0) {
  const truth = { ...S.makeCamera(rnd() * 360, rnd() * 140 - 70, rnd() * 360 - 180, fov, projection, 6000, 4000), k1 }
  const obs: S.Correspondence[] = []
  while (obs.length < nPairs) {
    const px = { x: rnd() * 6000, y: rnd() * 4000 }
    const dir = S.unproject(truth, px.x, px.y)
    obs.push({ pixel: { x: px.x + (rnd() - 0.5) * 2 * noise, y: px.y + (rnd() - 0.5) * 2 * noise }, dir })
  }
  // Start from a wrong guess: right lens family, fov 25% off, arbitrary pointing
  const guess = S.makeCamera(10, 10, 0, fov * (rnd() < 0.5 ? 0.8 : 1.25), projection, 6000, 4000)
  const sol = S.solveCamera(nPairs === 2 ? { ...guess, fovH: truth.fovH } : guess, obs, { fitK1 })
  if (!sol) return null
  const centreErr = S.angleBetween(truth.forward, sol.camera.forward) / DEG
  const fovErr = Math.abs(sol.camera.fovH / truth.fovH - 1)
  const rollErr = Math.abs(((S.cameraPointing(truth).roll - S.cameraPointing(sol.camera).roll + 540) % 360) - 180)
  return { centreErr, fovErr, rollErr, rms: sol.rmsPx }
}
for (const [proj, fov, n, noise] of [
  ['rectilinear', 60, 2, 0.5],
  ['rectilinear', 60, 3, 1],
  ['rectilinear', 100, 6, 1],
  ['equidistant', 180, 4, 1],
  ['equisolid', 150, 5, 1],
  ['stereographic', 140, 4, 1]
] as [S.Projection, number, number, number][]) {
  let worstCentre = 0, worstFov = 0, worstRoll = 0, fails = 0
  const runs = 40
  for (let i = 0; i < runs; i++) {
    const r = trial(proj, fov, n, noise)
    if (!r) { fails++; continue }
    if (r.centreErr > 0.3 || r.fovErr > 0.03) fails++
    worstCentre = Math.max(worstCentre, r.centreErr); worstFov = Math.max(worstFov, r.fovErr); worstRoll = Math.max(worstRoll, r.rollErr)
  }
  check(`solve ${proj} fov${fov} ${n} pairs +-${noise}px`, fails <= 1, `${runs - fails}/${runs} ok, worst centre ${worstCentre.toFixed(3)} deg, fov ${(worstFov * 100).toFixed(2)}%, roll ${worstRoll.toFixed(3)} deg`)
}
{
  let ok = 0
  const runs = 30
  for (let i = 0; i < runs; i++) {
    const r = trial('rectilinear', 90, 9, 0.3, true, 0.08)
    if (r && r.centreErr < 0.2 && r.rms < 1.5) ok++
  }
  check('solve with distortion k1 (9 pairs)', ok >= runs - 2, `${ok}/${runs}`)
}

// 6. cameraFromAltAz: centre lands on the requested alt/az, horizon is level, zenith is up
{
  const obs = { latDeg: 48, lonDeg: 11, date: new Date(Date.UTC(2026, 7, 12, 22, 30, 0)) }
  const base = S.makeCamera(0, 0, 0, 90, 'rectilinear', 6000, 4000)
  const cam = S.cameraFromAltAz(base, 35, 200, 0, obs)
  const aa = S.vecAltAz(cam.forward, obs)
  check('alt/az aim: centre alt/az', Math.abs(aa.alt - 35) < 1e-6 && Math.abs(aa.az - 200) < 1e-6, `alt ${aa.alt.toFixed(4)} az ${aa.az.toFixed(4)}`)
  const w = S.project(cam, S.altAzToVec(35, 215, obs))!
  const e = S.project(cam, S.altAzToVec(35, 185, obs))!
  check('alt/az aim: horizon-parallel row is level', Math.abs(w.y - e.y) < 60, `dy ${(w.y - e.y).toFixed(1)}px`)
  check('alt/az aim: azimuth increases toward the right (facing out)', w.x > 3000 && e.x < 3000, `w.x ${w.x.toFixed(0)} e.x ${e.x.toFixed(0)}`)
  check('alt/az aim: zenith side is up', S.project(cam, S.altAzToVec(60, 200, obs))!.y < 2000)
  const tilted = S.cameraFromAltAz(base, 35, 200, 20, obs)
  check('alt/az aim: tilt rolls about the axis', S.angleBetween(tilted.forward, cam.forward) < 1e-9 && Math.abs(S.cameraPointing(tilted).roll - S.cameraPointing(cam).roll) > 1)
}

// 7. Strong distortion must not fold far-off-axis sky back into the frame
{
  const width = 6000
  const height = 4000
  for (const k1 of [-0.3, -0.15]) {
    const cam = { ...S.makeCamera(100, 20, 0, 70, 'rectilinear', width, height), k1 }
    let leaked = 0
    let visible = 0
    // Walk away from the centre along the sky; nothing past the fold may reappear inside the frame.
    for (let theta = 0; theta < 89; theta += 0.5)
      for (const az of [0, 45, 90, 180, 270]) {
        const v = S.add3(S.scale3(cam.forward, Math.cos(theta * DEG)), S.add3(S.scale3(cam.right, Math.sin(theta * DEG) * Math.cos(az * DEG)), S.scale3(cam.up, Math.sin(theta * DEG) * Math.sin(az * DEG))))
        const p = S.project(cam, v)
        if (!p) continue
        visible++
        // A one-to-one lens only ever puts sky at the radius its angle asks for (never nearer than a smaller angle).
        const inside = p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height
        if (theta > 60 && inside) leaked++
      }
    check(`distortion k1=${k1}: far off-axis sky does not fold into the frame`, leaked === 0 && visible > 0, `${leaked} leaked of ${visible}`)
  }
  const cam = { ...S.makeCamera(100, 20, 0, 70, 'rectilinear', width, height), k1: -0.3 }
  const centre = S.project(cam, cam.forward)!
  check('distortion: centre still projects', Math.abs(centre.x - width / 2) < 1e-6 && Math.abs(centre.y - height / 2) < 1e-6)
}

console.log(failed ?`\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
