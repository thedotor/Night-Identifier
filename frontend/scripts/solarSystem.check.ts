// Numerical checks for the solar-system view's maths.
// Run: node --import ./scripts/ts-resolve.mjs scripts/solarSystem.check.ts
import { keplerPosition, orbitPoints, perihelion, aphelion, solveKepler, type Elements } from '../src/renderer/src/lib/kepler.ts'
import { bodyFrame, helioPosition, julianDate, moonFromTable, moonIsReal, moonOffset, moonOrbit, planetOrbit, registerMoonTables, rotation } from '../src/renderer/src/lib/solarSystemEphemeris.ts'
import { KM_PER_AU, MOONS, PLANETS } from '../src/renderer/src/lib/solarSystemData.ts'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}
const len = (v: number[]): number => Math.hypot(v[0], v[1], v[2])
const DEG = Math.PI / 180

// 1. Kepler's equation, including the near-parabolic orbits comets have.
{
  let worst = 0
  for (const e of [0, 0.1, 0.5, 0.9, 0.968, 0.999])
    for (let k = 0; k < 40; k++) {
      const M = (k / 40) * 2 * Math.PI
      const E = solveKepler(M, e)
      worst = Math.max(worst, Math.abs(E - e * Math.sin(E) - M))
    }
  check('Kepler equation residual', worst < 1e-10, `worst ${worst.toExponential(1)}`)
}

// 2. Orbit geometry from JPL elements for Halley and Ceres (values as the backend serves them).
const halley: Elements = { a: 17.9, e: 0.968, i: 162, om: 59.1, w: 112, tp: 2446469.974, per: 27700 }
const ceres: Elements = { a: 2.77, e: 0.0797, i: 10.6, om: 80.2, w: 73.3, tp: 2461599.841, per: 1680 }
check('Halley at perihelion is q from the Sun', Math.abs(len(keplerPosition(halley, halley.tp)) - perihelion(halley)) < 1e-6, `${len(keplerPosition(halley, halley.tp)).toFixed(4)} AU (q = ${perihelion(halley).toFixed(4)})`)
check('Halley at aphelion is Q', Math.abs(len(keplerPosition(halley, halley.tp + halley.per / 2)) - aphelion(halley)) < 1e-6, `${len(keplerPosition(halley, halley.tp + halley.per / 2)).toFixed(2)} AU`)
{
  // Halley is retrograde (i = 162): angular momentum must point to -z.
  const a = keplerPosition(halley, halley.tp + 300)
  const b = keplerPosition(halley, halley.tp + 400)
  check('Halley orbits retrograde', a[0] * b[1] - a[1] * b[0] < 0)
  const c = keplerPosition(ceres, ceres.tp + 100)
  const d = keplerPosition(ceres, ceres.tp + 200)
  check('Ceres orbits prograde', c[0] * d[1] - c[1] * d[0] > 0)
  const pts = orbitPoints(ceres, 128)
  check('orbit outline closes and stays within q..Q', len([pts[0][0] - pts[128][0], pts[0][1] - pts[128][1], pts[0][2] - pts[128][2]]) < 1e-9 && pts.every((p) => len(p) >= perihelion(ceres) - 1e-9 && len(p) <= aphelion(ceres) + 1e-9))
}

// 3. Planets: distances and a known event. 2026-09-24 12:00 UTC.
const date = new Date('2026-09-24T12:00:00Z')
const dist = (name: string): number => len(helioPosition(name, date))
const want: Record<string, [number, number]> = { Mercury: [0.307, 0.467], Venus: [0.718, 0.729], Earth: [0.983, 1.017], Mars: [1.381, 1.666], Jupiter: [4.95, 5.46], Saturn: [9.02, 10.05], Uranus: [18.3, 20.1], Neptune: [29.8, 30.4] }
for (const [n, [lo, hi]] of Object.entries(want)) check(`${n} distance in its orbit's range`, dist(n) >= lo && dist(n) <= hi, `${dist(n).toFixed(3)} AU`)
check('Sun is at the origin', len(helioPosition('Sun', date)) === 0)
{
  // Earth is near the September equinox (~Sep 22-23): heliocentric ecliptic longitude ~ 360 - 180... Sun's geocentric
  // longitude ~180 deg, so Earth's heliocentric longitude ~0 deg.
  const e = helioPosition('Earth', date)
  const lon = ((Math.atan2(e[1], e[0]) / DEG) + 360) % 360
  check('Earth heliocentric longitude ~ 0 deg near the September equinox', lon < 3 || lon > 357, `${lon.toFixed(2)} deg`)
  check('Earth is in the ecliptic plane', Math.abs(e[2]) < 1e-3, `z = ${e[2].toExponential(1)} AU`)
}
{
  const jd = julianDate(Date.UTC(2000, 0, 1, 12))
  check('J2000 epoch is JD 2451545.0', jd === 2451545)
}

// 4. Orbit outlines pass through the planet's current position.
for (const p of PLANETS.filter((x) => ['Mercury', 'Earth', 'Jupiter', 'Neptune'].includes(x.name))) {
  const pts = planetOrbit(p.astro!, p.periodDays!, date)
  const here = helioPosition(p.astro!, date)
  check(`${p.name} orbit outline starts at the planet`, len([pts[0][0] - here[0], pts[0][1] - here[1], pts[0][2] - here[2]]) < 1e-9)
}

// 5. Moons.
{
  const moon = MOONS.find((m) => m.id === 'moon')!
  const d = len(moonOffset(moon, 'Earth', date)) * KM_PER_AU
  check('Moon is 356,000-407,000 km from Earth', d > 356_000 && d < 407_000, `${d.toFixed(0)} km`)
  const io = MOONS.find((m) => m.id === 'io')!
  const dIo = len(moonOffset(io, 'Jupiter', date)) * KM_PER_AU
  check('Io is ~421,700 km from Jupiter', Math.abs(dIo - 421_700) < 5_000, `${dIo.toFixed(0)} km`)
  const titan = MOONS.find((m) => m.id === 'titan')!
  const dT = len(moonOffset(titan, 'Saturn', date)) * KM_PER_AU
  check('Titan (circular model) is at its orbit radius', Math.abs(dT - titan.aKm!) < 1, `${dT.toFixed(0)} km`)
  // Circular orbits lie in the parent's equatorial plane: perpendicular to its rotation axis.
  const n = rotation('Saturn', date).north
  const off = moonOffset(titan, 'Saturn', date)
  check("Titan's orbit is in Saturn's equatorial plane", Math.abs(off[0] * n[0] + off[1] * n[1] + off[2] * n[2]) / len(off) < 1e-9)
  const tri = MOONS.find((m) => m.id === 'triton')!
  const a = moonOffset(tri, 'Neptune', date)
  const b = moonOffset(tri, 'Neptune', new Date(date.getTime() + 86_400_000))
  const nn = rotation('Neptune', date).north
  const h = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  check('Triton orbits retrograde (against Neptune\'s spin)', h[0] * nn[0] + h[1] * nn[1] + h[2] * nn[2] < 0)
  const loop = moonOrbit(moon, 'Earth', date)
  const gap = len([loop[0][0] - loop[96][0], loop[0][1] - loop[96][1], loop[0][2] - loop[96][2]]) * KM_PER_AU
  check('Moon orbit outline nearly closes over one sidereal month', gap < 30_000, `gap ${gap.toFixed(0)} km`)
}

// 6. Rotation axes are unit vectors; Earth's tilt to the ecliptic pole is ~23.4 deg.
{
  const n = rotation('Earth', date).north
  const tilt = Math.acos(Math.max(-1, Math.min(1, n[2]))) / DEG
  check("Earth's axis is a unit vector", Math.abs(len(n) - 1) < 1e-9)
  check("Earth's axial tilt is ~23.4 deg", Math.abs(tilt - 23.44) < 0.1, `${tilt.toFixed(2)} deg`)
}

// 7. Body frames: the texture must sit on the globe the right way round.
{
  const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const unit = (v: number[]): number[] => v.map((x) => x / len(v))
  const f = bodyFrame('Earth', date)
  check('Earth frame axes are orthonormal', Math.abs(dot(f.prime, f.north)) < 1e-9 && Math.abs(dot(f.east, f.north)) < 1e-9 && Math.abs(len(f.prime) - 1) < 1e-9)
  const subsolar = (d: Date): { lon: number; lat: number } => {
    const fr = bodyFrame('Earth', d)
    const sun = unit(helioPosition('Earth', d).map((x) => -x)) // Earth -> Sun
    return { lon: ((Math.atan2(dot(sun, fr.east), dot(sun, fr.prime)) / DEG + 540) % 360) - 180, lat: Math.asin(dot(sun, fr.north)) / DEG }
  }
  // At 12:00 UTC the Sun is over Greenwich, give or take the equation of time (+7.5 min on Sep 24 = ~1.9 deg west).
  const noon = subsolar(date)
  check('Sub-solar longitude at 12:00 UTC on 2026-09-24 is within 3 deg of Greenwich', Math.abs(noon.lon) < 3, `${noon.lon.toFixed(1)} deg`)
  // At 02:00 UTC it has moved 150 deg east.
  const early = subsolar(new Date('2026-09-24T02:00:00Z'))
  check('Sub-solar longitude at 02:00 UTC is ~148 E (over the western Pacific)', Math.abs(early.lon - 148) < 3, `${early.lon.toFixed(1)} E`)
  check('Sub-solar latitude near the September equinox is within 3 deg of the equator', Math.abs(early.lat) < 3, `${early.lat.toFixed(2)} deg`)
  // Sanity of the pole itself: Earth's north pole points towards Polaris' side of the sky, i.e. ecliptic z > 0.
  check("Earth's north pole is on the ecliptic-north side", f.north[2] > 0.9)
  // The Moon keeps one face to Earth: its prime meridian points at Earth to within libration (~8 deg + slop).
  const mf = bodyFrame('Moon', date)
  const moonOff = moonOffset(MOONS.find((m) => m.id === 'moon')!, 'Earth', date)
  const toEarth = unit(moonOff.map((x) => -x))
  const off = Math.acos(Math.max(-1, Math.min(1, dot(mf.prime, toEarth)))) / DEG
  check("Moon's prime meridian faces Earth (tidal lock)", off < 12, `${off.toFixed(1)} deg off`)
  // Across a day Earth turns ~361 deg: the frame must rotate about the pole at the sidereal rate.
  const f2 = bodyFrame('Earth', new Date(date.getTime() + 3_600_000))
  const turn = (Math.atan2(dot(f2.prime, f.east), dot(f2.prime, f.prime)) / DEG + 360) % 360
  check('Earth turns ~15.04 deg per hour', Math.abs(turn - 15.04) < 0.05, `${turn.toFixed(2)} deg`)
}

// 8. Moon element tables (JPL Horizons): propagation from the nearest row.
{
  // A synthetic circular, equatorial orbit: radius a, advancing at the row's mean motion. n = 360/period deg/day.
  const a = 0.008
  const n = 22.5
  const table = { jd0: 2461300, step: 30, rows: [[0, 0, 0, 0, n, 0, a], [0, 0, 0, 0, n, 90, a]] }
  const p0 = moonFromTable(table, 2461300 - 69.2 / 86400)! // exactly at row 0 (Horizons time is TDB)
  check('table row 0: at the row epoch, mean anomaly 0 puts the moon at periapsis (radius a, e = 0)', Math.abs(len(p0) - a) < 1e-9 && Math.abs(p0[0] - a) < 1e-9, `${len(p0).toExponential(4)}`)
  const p1 = moonFromTable(table, 2461300 + 2 - 69.2 / 86400)! // two days on: advance n * 2 = 45 degrees
  const ang = Math.atan2(p1[1], p1[0]) / DEG
  check('advances by its mean motion between rows', Math.abs(ang - 45) < 1e-6 && Math.abs(len(p1) - a) < 1e-9, `${ang.toFixed(3)} deg`)
  check('past the end of the table the table gives nothing', moonFromTable(table, 2461300 + 100) === null && moonFromTable(table, 2461000) === null)
  const titan = MOONS.find((m) => m.id === 'titan')!
  const before = moonOffset(titan, 'Saturn', new Date('2026-09-24T00:00:00Z'))
  registerMoonTables({ titan: { jd0: 2461307.5, step: 30, rows: [[0.0287, 27.7, 169.1, 178.3, 22.57, 237.5, 0.008168]] } })
  const after = moonOffset(titan, 'Saturn', new Date('2026-09-24T00:00:00Z'))
  check('a registered table replaces the circular model, within its span', Math.abs(len(after) * KM_PER_AU - 1_221_800) < 40_000 && Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]) > 1e-4, `Titan ${(len(after) * KM_PER_AU).toFixed(0)} km`)
  check('moonIsReal: inside the table yes, a year outside no, Galilean moons always', moonIsReal(titan, new Date('2026-09-24T00:00:00Z')) && !moonIsReal(titan, new Date('2029-01-01T00:00:00Z')) && moonIsReal(MOONS.find((m) => m.id === 'io')!, new Date('1900-01-01')))
  const far = moonOffset(titan, 'Saturn', new Date('2040-01-01T00:00:00Z')) // outside the one-row table's span
  check('outside the table the circular model still answers', Math.abs(len(far) * KM_PER_AU - titan.aKm!) < 1)
  registerMoonTables({})
}

if (failed) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
