// Checks for lib/magnetosphere.ts. Run: node --import ./scripts/ts-resolve.mjs scripts/magnetosphere.check.ts
import { windMarkers } from '../src/renderer/src/lib/windMarkers'
import { bowShockAt, bowShockNose, bzWords, distanceToEarthAU, dstLevel, dynamicPressure, findShocks, findStreams, l1LeadMinutes, magnetopause, magnetopauseAt, magnetosonicSpeed, magnetosphereFromWind, stationLevel, tailStretch, warpPoint, windWords, type WindPoint } from '../src/renderer/src/lib/magnetosphere'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
  if (!ok) failed++
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol

// typical quiet wind: 400 km/s, 5 per cm3 -> about 1.3 nPa
const pd = dynamicPressure(5, 400)
check('quiet wind pressure is about 1.3 nPa', near(pd, 1.34, 0.02), pd.toFixed(2))
// Shue: the textbook nose at 10-11 Earth radii for typical conditions (Pd 2 nPa, Bz 0)
const mp = magnetopause(2.0, 0)
check('the magnetopause nose is ~10.5 Earth radii for Pd = 2 nPa, Bz = 0', near(mp.r0, 10.3, 0.4), mp.r0.toFixed(2))
check('alpha is about 0.58', near(mp.alpha, 0.59, 0.02), mp.alpha.toFixed(3))
check('a stronger wind squeezes it: Pd = 10 nPa gives about 7.6 Re', near(magnetopause(10, 0).r0, 7.7, 0.4), magnetopause(10, 0).r0.toFixed(2))
check('a big storm wind (Pd 30 nPa, Bz -20) pushes it in to about 5.5 Re', magnetopause(30, -20).r0 < 6.2 && magnetopause(30, -20).r0 > 4.5, magnetopause(30, -20).r0.toFixed(2))
check('southward Bz shrinks it a little, northward grows it', magnetopause(2, -10).r0 < mp.r0 && magnetopause(2, 10).r0 > mp.r0)
check('the tail: at 90 degrees the distance is r0 * 2^alpha (about 15 Re); at 150 degrees it is very far out', near(magnetopauseAt(mp, Math.PI / 2), mp.r0 * 2 ** mp.alpha, 1e-9) && magnetopauseAt(mp, (150 * Math.PI) / 180) > 40)
check('inputs are clamped, no NaN for absurd values', Number.isFinite(magnetopause(1e6, 1e3).r0) && Number.isFinite(magnetopause(0, -1e3).r0))

// bow shock
const vms = magnetosonicSpeed(5, 5, 1e5)
check('magnetosonic speed for a typical wind is about 65-80 km/s', vms > 55 && vms < 90, vms.toFixed(1))
const mach = 400 / vms
const bs = bowShockNose(mp.r0, mach)
check('Mach number about 5-7 and the bow shock nose about 13-15 Earth radii', mach > 4 && mach < 8 && bs > 12.5 && bs < 16, `Mach ${mach.toFixed(1)}, nose ${bs.toFixed(1)}`)
check('the bow shock is always outside the magnetopause', bs > mp.r0 && bowShockAt(bs, 1) > magnetopauseAt(mp, 1))
const state = magnetosphereFromWind({ speed: 420, density: 6, bz: -3, bt: 6, temperature: 8e4 })
check('everything from a wind reading, and defaults without one', state.r0 > 8 && state.r0 < 12 && state.bowNose > state.r0 && magnetosphereFromWind({}).r0 > 9 && magnetosphereFromWind({}).mach === null)

// words
check('wind words', windWords(300).text === 'slow' && windWords(420).text === 'typical' && windWords(650).text === 'fast' && windWords(null).text === 'no reading')
check('Dst levels', dstLevel(-10).label === 'quiet' && dstLevel(-35).label === 'weak storm' && dstLevel(-60).label === 'moderate storm' && dstLevel(-120).label === 'intense storm' && dstLevel(-300).label === 'super-storm')
check('Bz words', /strongly/.test(bzWords(-20).text) && /southward/.test(bzWords(-9).text) && /near zero/.test(bzWords(0).text) && /northward/.test(bzWords(6).text))
check('station levels by nT moved in an hour', stationLevel(12).label === 'quiet' && stationLevel(45).label === 'unsettled' && stationLevel(90).label === 'active' && stationLevel(200).label === 'storm' && stationLevel(500).label === 'severe')

// L1 lead time: 1.5 million km at 400 km/s is about an hour
check('L1 lead: about 62 min at 400 km/s, about 42 min at 600', near(l1LeadMinutes(400), 62.5, 0.5) && near(l1LeadMinutes(600), 41.7, 0.5))

// shocks in a wind series
const t0 = Date.UTC(2026, 8, 25, 12, 0, 0)
const mk = (i: number, v: number, n: number): WindPoint => ({ t: new Date(t0 + i * 3 * 60_000).toISOString(), speed: v, density: n, bz: -5, bt: 8 })
const calm = Array.from({ length: 20 }, (_, i) => mk(i, 400 + (i % 3), 5))
const withShock = [...calm, ...Array.from({ length: 20 }, (_, i) => mk(20 + i, 520 + (i % 3), 11))]
const sh = findShocks(withShock)
check('a step from 400 to 520 km/s with double the density is found once, at the right minute', sh.length === 1 && Math.abs(sh[0].t - (t0 + 20 * 3 * 60_000)) <= 3 * 60_000 && sh[0].speedAfter - sh[0].speedBefore > 100, JSON.stringify(sh.map((s) => [(s.t - t0) / 60000, Math.round(s.speedBefore), Math.round(s.speedAfter)])))
check('a calm wind has no shocks', findShocks(calm).length === 0)
check('a speed step without a density rise is not called a shock', findShocks([...calm, ...Array.from({ length: 20 }, (_, i) => mk(20 + i, 520, 5))]).length === 0)
check('a slow drift up is not a shock', findShocks(Array.from({ length: 40 }, (_, i) => mk(i, 400 + i * 4, 5 + i * 0.02))).length === 0)

// streams in the Enlil forecast
const H = 3_600_000
const rows = Array.from({ length: 120 }, (_, i) => [t0 + i * H, i >= 40 && i < 60 ? 620 - Math.abs(50 - i) * 8 : 360, 5, 5, 1e5])
const st = findStreams(rows)
check('one fast stream is found, with its peak and the speed before it', st.length === 1 && near(st[0].peakSpeed, 620, 1) && st[0].baseSpeed === 360 && st[0].startMs >= t0 + 40 * H, JSON.stringify(st.map((s) => [(s.startMs - t0) / H, (s.peakMs - t0) / H, s.peakSpeed])))
check('a 2-hour blip is not a stream', findStreams([[0, 360], [H, 600], [2 * H, 600], [3 * H, 360], [4 * H, 360]].map((r) => [r[0], r[1], 5, 5, 1e5])).length === 0)

// where a feature is on its way
check('a feature due in 2 days at 500 km/s is 0.578 AU from Earth', near(distanceToEarthAU(t0 + 2 * 86_400_000, 500, t0), 0.5775, 0.002), distanceToEarthAU(t0 + 2 * 86_400_000, 500, t0).toFixed(4))
check('and is capped at 1.6 AU, or zero once it has arrived', distanceToEarthAU(t0 + 400 * 86_400_000, 900, t0) === 1.6 && distanceToEarthAU(t0 - 1, 500, t0) === 0)

// field-line warp: the Sun side is squashed, the night side stretched, the inner field untouched
const inner = warpPoint([2, 0, 0], 0.6, 0.5)
check('inside 2.5 Earth radii nothing moves', inner[0] === 2 && inner[1] === 0 && inner[2] === 0)
const day = warpPoint([9, 1, 1], 0.7, 0.4)
const night = warpPoint([-9, 1, 1], 0.7, 0.4)
check('the Sun side is compressed and the night side stretched', day[0] < 9 && day[0] > 9 * 0.65 && night[0] < -9 * 1.4 && night[2] < 1)
check('an unstressed wind leaves the day side alone (squash 1)', warpPoint([9, 1, 1], 1, 0.15)[0] === 9)
check('tail stretch grows with southward Bz and Kp, within bounds', tailStretch(0, 0) === 0.15 && tailStretch(-10, 5) > tailStretch(-2, 1) && tailStretch(-50, 9) === 0.8)

console.log(failed === 0 ? '\nAll magnetosphere checks passed.' : `\n${failed} magnetosphere check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
