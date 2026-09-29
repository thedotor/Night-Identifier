// Checks for lib/lightning.ts. Run: node --import ./scripts/ts-resolve.mjs scripts/lightning.check.ts
import { ageColour, bearingDeg, compassOf, distanceKm, parseStrikes, stormNear, type Strike } from '../src/renderer/src/lib/lightning'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
  if (!ok) failed++
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol

// London -> Paris is about 344 km, bearing about 148 degrees (SSE)
const d = distanceKm(51.5074, -0.1278, 48.8566, 2.3522)
check('London to Paris ~344 km', near(d, 343.6, 2), d.toFixed(1))
const b = bearingDeg(51.5074, -0.1278, 48.8566, 2.3522)
check('London to Paris bearing ~148 deg', near(b, 148.1, 1), b.toFixed(1))
check('compass name', compassOf(148) === 'SSE' && compassOf(359) === 'N' && compassOf(90) === 'E', `${compassOf(148)}`)
check('a quarter of the way round the equator', near(distanceKm(0, 0, 0, 90), 10007.5, 5), distanceKm(0, 0, 0, 90).toFixed(1))
check('antipodes are half the circumference', near(distanceKm(10, 20, -10, -160), 20015, 10), distanceKm(10, 20, -10, -160).toFixed(0))
check('due north is 0, due west is 270', near(bearingDeg(0, 0, 10, 0), 0, 0.001) && near(bearingDeg(0, 0, 0, -10), 270, 0.001))

const now = 1_800_000_000_000
const mk = (seq: number, ageS: number, lat: number, lon: number): Strike => ({ seq, tMs: now - ageS * 1000, lat, lon, polarity: 0, stations: 12, accuracyM: 3000 })
const place = { latDeg: 51.5, lonDeg: 0 }
const strikes = [mk(1, 30, 51.5, 0.7), mk(2, 90, 52.5, 0), mk(3, 3000, 51.5, 0.05), mk(4, 10, -33, 151)]
const s = stormNear(strikes, place, now, 600_000)
check('nearest recent strike is #1 (~49 km east), the old close one is ignored', s.nearest?.strike.seq === 1 && near(s.nearest.km, 48.5, 1) && near(s.nearest.bearing, 90, 1), `${s.nearest?.strike.seq} ${s.nearest?.km.toFixed(1)} km ${s.nearest?.bearing.toFixed(0)} deg`)
check('counts within 50 / 100 / 250 km (#2 is 111 km away)', s.within50 === 1 && s.within100 === 1 && s.within250 === 2, `${s.within50}/${s.within100}/${s.within250}`)
check('nothing near: still names the nearest, far away', stormNear([mk(9, 5, -33, 151)], place, now, 600_000).nearest!.km > 15000)
check('no strikes: no nearest', stormNear([], place, now, 600_000).nearest === null)

const p = parseStrikes({ fields: ['seq', 't_ms', 'lat', 'lon', 'polarity', 'stations', 'accuracy_m'], rows: [[7, 1790358657976, 35.0245, -107.6846, 0, 31, 5482]], seq: 7, credit: '' })
check('rows parse into strikes', p[0].seq === 7 && p[0].stations === 31 && p[0].lon === -107.6846)
const c0 = ageColour(0)
const c1 = ageColour(1)
check('colour runs from pale yellow-white to dark red', c0[0] > 0.9 && c0[1] > 0.9 && c1[0] < 0.6 && c1[1] < 0.1 && ageColour(2)[0] === c1[0])

console.log(failed ? `${failed} FAILED` : 'all passed')
process.exit(failed ? 1 : 0)
