// Checks for lib/sun.ts. Run: node --import ./scripts/ts-resolve.mjs scripts/sun.check.ts
import { cmeDirection, cmeFront, cmeVisible, discFraction, facesEarth, flareAtLeast, flareFlux, fluxClass, heeqToScene, incomingCmes, radioBlackout, regionLon, relativeTime, strongestFlare, sunFrame, type Cme, type Flare, type Region, type Vec3 } from '../src/renderer/src/lib/sun'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
  if (!ok) failed++
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const DEG = Math.PI / 180
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Meeus, Astronomical Algorithms ch. 29: the Sun's P (position angle of the axis) and B0, from the Sun's apparent longitude. Independent of lib/sun.ts. */
function meeus(jd: number, sunLonDeg: number): { p: number; b0: number } {
  const K = 73.6667 + (1.3958333 * (jd - 2396758)) / 36525
  const I = 7.25 * DEG
  const eps = 23.4392911 * DEG
  const lam = sunLonDeg * DEG
  const x = Math.atan(-Math.cos(lam) * Math.tan(eps))
  const y = Math.atan(-Math.cos(lam - K * DEG) * Math.tan(I))
  return { p: (x + y) / DEG, b0: Math.asin(Math.sin(lam - K * DEG) * Math.sin(I)) / DEG }
}
/** The Sun's ecliptic longitude (low-precision, ~0.01 deg) for a Julian date */
function sunLon(jd: number): number {
  const n = jd - 2451545.0
  const L = (280.46 + 0.9856474 * n) % 360
  const g = (357.528 + 0.9856003 * n) * DEG
  return (((L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) % 360) + 360) % 360
}
const jdOf = (iso: string): number => Date.parse(iso) / 86_400_000 + 2440587.5

// the frame against Meeus on several dates spread over the year (P swings between about -26 and +26 degrees, B0 between -7 and +7)
for (const iso of ['2026-01-05T00:00:00Z', '2026-04-07T00:00:00Z', '2026-07-07T00:00:00Z', '2026-09-07T00:00:00Z', '2026-09-25T00:00:00Z', '2026-10-11T00:00:00Z', '2026-12-07T00:00:00Z']) {
  const jd = jdOf(iso)
  const lam = sunLon(jd)
  const earthFromSun: Vec3 = [Math.cos((lam + 180) * DEG), Math.sin((lam + 180) * DEG), 0]
  const f = sunFrame(earthFromSun)
  const m = meeus(jd, lam)
  check(`${iso.slice(0, 10)}: P ${f.p.toFixed(2)} vs Meeus ${m.p.toFixed(2)}`, near(f.p, m.p, 0.3))
  check(`${iso.slice(0, 10)}: B0 ${f.b0.toFixed(2)} vs Meeus ${m.b0.toFixed(2)}`, near(f.b0, m.b0, 0.15))
}

// the frame is orthonormal, and right / up are what a viewer at Earth sees
const fr = sunFrame([-0.9, 0.42, 0])
check('X, Y, Z are unit and square', near(dot(fr.x, fr.y), 0, 1e-12) && near(dot(fr.y, fr.z), 0, 1e-12) && near(dot(fr.x, fr.z), 0, 1e-12) && near(dot(fr.x, fr.x), 1, 1e-12))
check('up and right are square to the line of sight and to each other', near(dot(fr.up, fr.earth), 0, 1e-12) && near(dot(fr.right, fr.earth), 0, 1e-12) && near(dot(fr.up, fr.right), 0, 1e-12))
check('right = west: a point at 30 W lies to the right of the centre line', dot(heeqToScene(fr, 0, 30), fr.right) > 0.45)
check('point at latitude 30 N is above centre', dot(heeqToScene(fr, 30, 0), fr.up) > 0.3)
check('heliographic (0,0) is toward the Earth', near(dot(heeqToScene(fr, 0, 0), fr.earth), 1, 0.01))
check('a point at longitude 180 is on the far side', dot(heeqToScene(fr, 0, 180), fr.earth) < -0.98)

check('the disc fills 72% of the half-width at 1 AU with the 2.6 arcsec / 1024 px framing', near(discFraction(1, 2.6, 512), 0.7208, 0.001), discFraction(1, 2.6, 512).toFixed(4))
check('and is a little bigger in January (closer)', discFraction(0.983, 2.6, 512) > discFraction(1.017, 2.6, 512))

// sunspot groups rotate west
const reg: Region = { number: 4539, lat: -10, lon: -12, observed: 1_000_000_000_000, area: 10, spots: 1, spot_class: 'Axx', mag_class: 'A', c_prob: 5, m_prob: 1, x_prob: 1 }
check('a group at 12 E moves 13.2 degrees west a day', near(regionLon(reg, reg.observed! + 86_400_000), 1.2, 1e-9))
check('facesEarth: within 90 degrees', facesEarth(80) && facesEarth(-89) && !facesEarth(95) && !facesEarth(-170) && facesEarth(365))

// CMEs
const t0 = 1_800_000_000_000
const cme: Cme = { id: 'a', start: t0 - 3600_000, t215: t0, lat: 10, lon: 5, half_angle: 40, speed: 800, type: 'C', source: null, note: null, earth_directed: true, arrival: t0 + 60 * 3600_000, arrival_source: 'NASA', separation: 11 }
check('a CME is at 21.5 solar radii at its reference time', near(cmeFront(cme, t0), 21.5, 1e-9))
check('800 km/s covers about 1.15 solar radii a minute... (60 s = 48000 km = 0.069 R)', near(cmeFront(cme, t0 + 60_000) - 21.5, 0.06899, 0.001), (cmeFront(cme, t0 + 60_000) - 21.5).toFixed(4))
check('800 km/s takes about 1.94 days to reach 1 AU', near(((149_597_870.7 - 21.5 * 695_700) / 800) / 86_400, 1.94, 0.02))
check('it is shown after it clears the occulter and before it is far away', cmeVisible(cme, t0) && !cmeVisible(cme, t0 - 3 * 86_400_000) && !cmeVisible(cme, t0 + 30 * 86_400_000))
check('words: straight at Earth for a 11 degree offset', /straight at Earth/.test(cmeDirection(cme)), cmeDirection(cme))
check('words: far side', /far side/.test(cmeDirection({ ...cme, earth_directed: false, lon: -144 })))
check('incoming: only Earth-directed with a future arrival, soonest first', incomingCmes([cme, { ...cme, id: 'b', arrival: t0 + 10 * 3600_000 }, { ...cme, id: 'c', earth_directed: false }, { ...cme, id: 'd', arrival: t0 - 1 }], t0).map((c) => c.id).join() === 'b,a')

// flares
check('class to flux', near(flareFlux('M5.2'), 5.2e-5, 1e-12) && near(flareFlux('X1.0'), 1e-4, 1e-12) && flareFlux('') === 0 && flareFlux('zz') === 0)
check('flux to class', fluxClass(5.2e-5) === 'M5.2' && fluxClass(1.23e-6) === 'C1.2' && fluxClass(2.5e-4) === 'X2.5' && fluxClass(4.6e-9) === 'A0.5')
check('M5 threshold: M5.0 and X1 pass, M4.9 and C9 do not', flareAtLeast('M5.0', 'M5') && flareAtLeast('X1.0', 'M5') && !flareAtLeast('M4.9', 'M5') && !flareAtLeast('C9.9', 'M5'))
check('radio blackout scale', radioBlackout('M1.0') === 'R1' && radioBlackout('M5.0') === 'R2' && radioBlackout('X1.0') === 'R3' && radioBlackout('C9') === null)
const fl = (cls: string, peakAgoH: number): Flare => ({ class: cls, begin: t0 - peakAgoH * 3600_000 - 600_000, peak: t0 - peakAgoH * 3600_000, end: null, region: null })
check('strongest flare in the last 6 h ignores older and future ones', strongestFlare([fl('C5.0', 1), fl('M2.0', 3), fl('X1.0', 9), fl('X9.0', -1)], t0, 6)?.class === 'M2.0')
check('relative time', relativeTime(t0 + 5 * 3600_000 + 600_000, t0) === 'in 5 h 10 min' && relativeTime(t0 - 40 * 60_000, t0) === '40 min ago' && relativeTime(t0 + 3 * 86_400_000 + 2 * 3600_000, t0) === 'in 3 days 2 h', `${relativeTime(t0 + 5 * 3600_000 + 600_000, t0)} | ${relativeTime(t0 + 3 * 86_400_000 + 2 * 3600_000, t0)}`)

console.log(failed === 0 ? '\nAll sun checks passed.' : `\n${failed} sun check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
