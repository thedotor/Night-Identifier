// Checks for lib/geomag.ts. Run: node --import ./scripts/ts-resolve.mjs scripts/geomag.check.ts
import { readFileSync } from 'node:fs'
import { coefficientsAt, decimalYear, fieldAt, fieldSpherical, geomagneticPole, surfaceField, strengthGrid, traceFieldLine, EARTH_RADIUS_KM, type Vec3 } from '../src/renderer/src/lib/geomag'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
  if (!ok) failed++
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const DEG = Math.PI / 180

// against an independent implementation (pyIGRF's port of the IAGA Fortran synthesis, same IGRF-14 coefficients), geocentric, 192 points
type Ref = { year: number; lat: number; lon: number; r: number; x: number; y: number; z: number; f: number }
const refs = JSON.parse(readFileSync(new URL('./geomag.reference.json', import.meta.url), 'utf-8')) as Ref[]
let worst = 0
let worstAt = ''
for (const r of refs) {
  const s = surfaceField(coefficientsAt(r.year), r.lat, r.lon, r.r)
  const err = Math.max(Math.abs(s.x - r.x), Math.abs(s.y - r.y), Math.abs(s.z - r.z), Math.abs(s.f - r.f))
  if (err > worst) {
    worst = err
    worstAt = `${r.year} ${r.lat},${r.lon} r=${r.r}`
  }
}
check(`${refs.length} points match the reference to under 0.5 nT (of ~50,000)`, worst < 0.5, `worst ${worst.toFixed(4)} nT at ${worstAt}`)

// physical sanity
const c = coefficientsAt(decimalYear(Date.UTC(2026, 8, 25)))
const eq = surfaceField(c, 0, 0)
check('the field at the equator is about 30-40 microtesla', eq.f > 25_000 && eq.f < 42_000, `${(eq.f / 1000).toFixed(1)} uT`)
const np = surfaceField(c, 85, 100)
check('near the poles it is about 55-62 microtesla and points steeply down (north) / up (south)', np.f > 50_000 && np.f < 66_000 && np.inclination > 80, `${(np.f / 1000).toFixed(1)} uT, dip ${np.inclination.toFixed(0)}`)
check('the south pole region points up (negative dip)', surfaceField(c, -80, 120).inclination < -75)
// the South Atlantic Anomaly: the weakest field near the surface is over South America / the South Atlantic
let minF = 1e9
let minAt = ''
for (let lat = -60; lat <= 10; lat += 5) for (let lon = -100; lon <= 20; lon += 5) {
  const f = surfaceField(c, lat, lon).f
  if (f < minF) {
    minF = f
    minAt = `${lat},${lon}`
  }
}
check('the South Atlantic Anomaly is the weakest region (about 22-26 uT) between South America and Africa', minF < 27_000 && minF > 20_000, `${(minF / 1000).toFixed(1)} uT at ${minAt}`)
const pole = geomagneticPole(c)
check('the north geomagnetic pole is near 80 N, 72 W (2026)', near(pole.latDeg, 80.7, 1.2) && near(pole.lonDeg, -72.5, 3), `${pole.latDeg.toFixed(1)}, ${pole.lonDeg.toFixed(1)}`)
check('the dipole moment is about 29,300 nT (7.7e22 A m2)', pole.momentNT > 29_000 && pole.momentNT < 29_800, pole.momentNT.toFixed(0))
check('the field is weakening: the dipole is weaker in 2026 than in 2020', geomagneticPole(c).momentNT < geomagneticPole(coefficientsAt(2020)).momentNT)
check('magnetic declination in London is a few degrees (west to east, near 0 in 2026)', Math.abs(surfaceField(c, 51.5, -0.13).declination) < 5, surfaceField(c, 51.5, -0.13).declination.toFixed(1))

// vector form: the Cartesian field is consistent with the spherical one, and Gauss's law holds in a coarse sense (div B ~ 0)
const p: Vec3 = [1.5, 0.7, 0.9]
const bv = fieldAt(c, p)
const rr = Math.hypot(...p)
const sp = fieldSpherical(c, rr * EARTH_RADIUS_KM, Math.acos(p[2] / rr), Math.atan2(p[1], p[0]))
check('the vector form has the same magnitude as the spherical components', near(Math.hypot(...bv), Math.hypot(sp.br, sp.bt, sp.bp), 1e-6))
const h = 1e-3
const d = (i: number): number => {
  const a: Vec3 = [...p]
  const b: Vec3 = [...p]
  a[i] += h
  b[i] -= h
  return (fieldAt(c, a)[i] - fieldAt(c, b)[i]) / (2 * h)
}
const div = d(0) + d(1) + d(2)
check('the field has no sources: div B is tiny next to the field gradient', Math.abs(div) < 0.002 * Math.hypot(...bv), `div ${div.toExponential(2)} vs |B| ${Math.hypot(...bv).toFixed(0)}`)

// a field line from the ground at 60 N goes out over the equator and lands in the other hemisphere
const start: Vec3 = [Math.cos(60 * DEG), 0, Math.sin(60 * DEG)]
const north = fieldAt(c, start)[2] < 0 // the field points down in the north: follow it backwards to go up and out
const up = traceFieldLine(c, start, north ? -1 : 1, 0.05, 2000, 30)
const last = up[up.length - 1]
const maxR = Math.max(...up.map((q) => Math.hypot(...q)))
check('a mid-latitude field line rises to a few Earth radii and returns to the ground', maxR > 3 && maxR < 6 && Math.abs(Math.hypot(...last) - 1) < 0.02, `peak ${maxR.toFixed(2)} Re, ends at r=${Math.hypot(...last).toFixed(3)}, z=${last[2].toFixed(2)}`)
check('and it lands in the opposite hemisphere', Math.sign(last[2]) === -1)

// the grid
const grid = strengthGrid(c, 72, 36)
check('grid: the extremes are the poles (strong) and the South Atlantic (weak)', Math.max(...grid) > 55_000 && Math.min(...grid) < 27_000 && grid.length === 72 * 36)
check('the field model for a date after 2025 differs from 2025 by the secular variation (g10 rises ~12.6 nT/yr)', near(coefficientsAt(2030).g[0] - coefficientsAt(2025).g[0], 12.6 * 5, 0.01))

console.log(failed === 0 ? '\nAll geomag checks passed.' : `\n${failed} geomag check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
