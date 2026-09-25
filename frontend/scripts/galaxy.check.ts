// Numerical checks for the galaxy-scale maths.
// Run: node --import ./scripts/ts-resolve.mjs scripts/galaxy.check.ts
import {
  AU_PER_LY,
  AU_PER_PC,
  GALACTIC_CENTRE_AU,
  SUN_GALACTOCENTRIC_KPC,
  absoluteMagnitude,
  distanceToArm,
  equatorialToEcliptic,
  galacticToEquatorial,
  milkyWayPoints,
  parallaxToAU,
  positionAU,
  radecVec,
  starColour,
  starVelocityAU,
  sunGapPhase,
  toGalactic
} from '../src/renderer/src/lib/galaxyMath.ts'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}
const DEG = Math.PI / 180
const len = (v: ArrayLike<number>): number => Math.hypot(v[0], v[1], v[2])
type V = [number, number, number]
const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const raDec = (v: number[]): { ra: number; dec: number } => ({ ra: ((Math.atan2(v[1], v[0]) / DEG) + 360) % 360, dec: Math.asin(v[2] / len(v)) / DEG })

// 1. The galactic frame reproduces well-known positions.
{
  const gc = raDec(galacticToEquatorial([1, 0, 0]))
  check('galactic centre (l=0,b=0) is at RA 266.40, Dec -28.94', Math.abs(gc.ra - 266.405) < 0.01 && Math.abs(gc.dec + 28.936) < 0.01, `${gc.ra.toFixed(3)}, ${gc.dec.toFixed(3)}`)
  const ngp = raDec(galacticToEquatorial([0, 0, 1]))
  check('north galactic pole is at RA 192.86, Dec +27.13', Math.abs(ngp.ra - 192.859) < 0.01 && Math.abs(ngp.dec - 27.128) < 0.01, `${ngp.ra.toFixed(3)}, ${ngp.dec.toFixed(3)}`)
  const anti = raDec(galacticToEquatorial([-1, 0, 0]))
  check('anti-centre is at RA 86.40, Dec +28.94', Math.abs(anti.ra - 86.405) < 0.01 && Math.abs(anti.dec - 28.936) < 0.01)
  const ncp = toGalactic([0, 0, 1])
  check('north celestial pole is at l = 122.93, b = +27.13 (handedness)', Math.abs(ncp.l - 122.932) < 0.01 && Math.abs(ncp.b - 27.128) < 0.01, `l ${ncp.l.toFixed(3)}, b ${ncp.b.toFixed(3)}`)
  const m31 = toGalactic(radecVec(10.6847, 41.2687))
  check('M31 is at l = 121.17, b = -21.57', Math.abs(m31.l - 121.17) < 0.05 && Math.abs(m31.b + 21.57) < 0.05, `l ${m31.l.toFixed(2)}, b ${m31.b.toFixed(2)}`)
  const lmc = toGalactic(radecVec(80.894, -69.756))
  check('LMC is at l = 280.5, b = -32.9', Math.abs(lmc.l - 280.47) < 0.2 && Math.abs(lmc.b + 32.89) < 0.2, `l ${lmc.l.toFixed(2)}, b ${lmc.b.toFixed(2)}`)
}

// 2. Scene positions: distances and directions.
{
  const sirius = positionAU(101.2885, -16.7131, parallaxToAU(379.21))
  check('Sirius (parallax 379.21 mas) is 8.60 light-years away', Math.abs(len(sirius) / AU_PER_LY - 8.6) < 0.02, `${(len(sirius) / AU_PER_LY).toFixed(3)} ly`)
  const m31 = positionAU(10.6847, 41.2687, 783 * 1e3 * AU_PER_PC)
  check('M31 at 783 kpc is 2.55 million light-years away', Math.abs(len(m31) / AU_PER_LY / 1e6 - 2.554) < 0.01, `${(len(m31) / AU_PER_LY / 1e6).toFixed(3)} Mly`)
  const ecl = equatorialToEcliptic(radecVec(0, 90))
  check('celestial north pole is 23.44 deg from ecliptic north', Math.abs(Math.acos(ecl[2]) / DEG - 23.4393) < 1e-3)
  const cen = len(GALACTIC_CENTRE_AU) / AU_PER_PC / 1e3
  check('galactic centre is 8.15 kpc from the Sun', Math.abs(cen - SUN_GALACTOCENTRIC_KPC) < 1e-6, `${cen.toFixed(3)} kpc`)
}

// 3. Stars: absolute magnitude and colour.
{
  const M = absoluteMagnitude(-1.44, 379.21)
  check('Sirius absolute magnitude ~ +1.4', Math.abs(M - 1.45) < 0.05, M.toFixed(2))
  // 1 AU is a parallax of 206,264.8 arcseconds = 2.0626e8 milliarcseconds
  const sun = absoluteMagnitude(-26.74, 206264.806e3)
  check('Sun (1 AU away) has absolute magnitude ~ +4.8', Math.abs(sun - 4.83) < 0.1, sun.toFixed(2))
  const blue = starColour(-0.2)
  const red = starColour(1.8)
  check('hot stars are bluer than cool ones', blue[2] > blue[0] && red[0] > red[2])
  check('star colours stay in 0..1', [starColour(-1), starColour(0.65), starColour(5)].every((c) => c.every((x) => x >= 0 && x <= 1)))
}

// 3b. Proper motion.
{
  // Barnard's Star: 549.0 mas parallax, pm (-797.8, +10326.9) mas/yr -> 10.36 arcsec/yr, ~89 km/s tangential.
  const v = starVelocityAU(269.454, 4.6683, 549.01, -797.8, 10326.9)
  const auPerYr = Math.hypot(...v)
  const kms = auPerYr * 4.74047
  check("Barnard's Star moves ~89 km/s across the sky (tangential)", Math.abs(kms - 89.4) < 1.5, `${kms.toFixed(1)} km/s = ${auPerYr.toFixed(2)} AU/yr`)
  // The motion is perpendicular to the line of sight, so the distance does not change to first order.
  const pos = positionAU(269.454, 4.6683, parallaxToAU(549.01))
  check('proper motion is perpendicular to the line of sight', Math.abs(dot(v, pos) / (len(v) * len(pos))) < 1e-9)
  // After 1 year the star has moved by the proper motion in angle: 10.36 arcsec.
  const moved = positionAU(269.454, 4.6683, parallaxToAU(549.01)).map((c, i) => c + v[i]) as V
  const ang = Math.acos(Math.min(1, dot(moved, pos) / (len(moved) * len(pos)))) * 206264.806
  check('one year of motion is one proper-motion arcsecond-count of angle', Math.abs(ang - 10.36) < 0.05, `${ang.toFixed(3)} arcsec`)
  // Due-north motion for a star on the celestial equator: velocity along ecliptic-transformed north.
  const vn = starVelocityAU(0, 0, 1000, 0, 1000) // 1 pc, 1 arcsec/yr due north = 1 AU/yr
  const northEcl = equatorialToEcliptic([0, 0, 1])
  check('due-north motion of 1 arcsec/yr at 1 pc is 1 AU/yr along celestial north', Math.abs(Math.hypot(...vn) - 1) < 1e-9 && Math.abs(dot(vn, northEcl) - 1) < 1e-9)
}

// 4. The schematic Milky Way.
{
  const phase = sunGapPhase()
  const gap = distanceToArm(-SUN_GALACTOCENTRIC_KPC, 0, phase)
  check('the Sun sits between two arms, ~1.65 kpc from either ridge', gap > 1.0 && gap < 1.8, `${gap.toFixed(2)} kpc`)
  const mw = milkyWayPoints(60000, 7)
  const again = milkyWayPoints(200, 7)
  check('generation is deterministic', mw.positions[0] === again.positions[0] && mw.kpc[100] === again.kpc[100])
  let maxR = 0
  const absZ: number[] = []
  let inBulge = 0
  let allFinite = true
  for (let i = 0; i < mw.count; i++) {
    const x = mw.kpc[3 * i]
    const y = mw.kpc[3 * i + 1]
    const z = mw.kpc[3 * i + 2]
    if (!Number.isFinite(x + y + z)) allFinite = false
    maxR = Math.max(maxR, Math.hypot(x, y))
    absZ.push(Math.abs(z))
    if (Math.hypot(x, y) < 2) inBulge++
  }
  absZ.sort((a, b) => a - b)
  check('all points finite', allFinite)
  check('the disc is ~15 kpc across at most', maxR <= 15.5, `${maxR.toFixed(1)} kpc`)
  check('the disc is thin: median |z| < 0.25 kpc', absZ[Math.floor(absZ.length / 2)] < 0.25, `${absZ[Math.floor(absZ.length / 2)].toFixed(3)} kpc`)
  check('there is a central bulge (10-30% of points within 2 kpc)', inBulge / mw.count > 0.1 && inBulge / mw.count < 0.3, `${((100 * inBulge) / mw.count).toFixed(0)}%`)
  // Arms: points near an arm ridge should be much more common than a uniform disc would give.
  let near = 0
  let total = 0
  for (let i = 0; i < mw.count; i++) {
    const r = Math.hypot(mw.kpc[3 * i], mw.kpc[3 * i + 1])
    if (r < 4 || r > 12) continue
    total++
    if (distanceToArm(mw.kpc[3 * i], mw.kpc[3 * i + 1], phase) < 0.6) near++
  }
  // the band within 0.6 kpc of an arm is ~ 4 * 1.2 * sin(...) share of the ring; uniform would be well under 45%
  check('arms are visibly denser than the gaps between them', near / total > 0.45, `${((100 * near) / total).toFixed(0)}% within 0.6 kpc of an arm ridge`)
  // Scene positions are in AU and in the ecliptic frame: the centre of mass must be near the galactic centre.
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < mw.count; i++) {
    cx += mw.positions[3 * i]
    cy += mw.positions[3 * i + 1]
    cz += mw.positions[3 * i + 2]
  }
  const com = [cx / mw.count, cy / mw.count, cz / mw.count]
  const off = Math.hypot(com[0] - GALACTIC_CENTRE_AU[0], com[1] - GALACTIC_CENTRE_AU[1], com[2] - GALACTIC_CENTRE_AU[2]) / AU_PER_PC / 1e3
  check('the cloud is centred on the galactic centre in scene coordinates', off < 0.6, `${off.toFixed(2)} kpc off`)
}

if (failed) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
