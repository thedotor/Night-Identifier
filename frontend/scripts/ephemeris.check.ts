// Run: node --import ./scripts/ts-resolve.mjs scripts/ephemeris.check.ts
// Compares lib/skyEphemeris.ts with astropy's built-in ephemeris (scripts/ephemeris.reference.json,
// geocentric RA/Dec of date). Sun and planets agree to a few arcminutes (Jupiter/Saturn up to
// ~10', a known limit of the simplified elements); the Moon's series is good to about 0.3 degrees.
import { readFileSync } from 'node:fs'
import * as S from '../src/renderer/src/lib/skyMath'
import { solarSystem } from '../src/renderer/src/lib/skyEphemeris'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

interface Ref {
  date: string
  jd: number
  bodies: Record<string, [number, number]>
  moon_topo: [number, number]
}
const refs = JSON.parse(readFileSync(new URL('./ephemeris.reference.json', import.meta.url), 'utf8')) as Ref[]
const sep = (v: S.Vec3, ra: number, dec: number): number => S.angleBetween(v, S.radecToVec(ra, dec)) / (Math.PI / 180)

for (const ref of refs) {
  const bodies = solarSystem(ref.jd, null)
  const by = Object.fromEntries(bodies.map((b) => [b.id, b]))
  const worstPlanet = Math.max(
    ...['sun', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'].map((id) => sep(by[id].vec, ...ref.bodies[id]))
  )
  check(`${ref.date}: Sun + planets within 0.2 deg`, worstPlanet < 0.2, `worst ${(worstPlanet * 60).toFixed(1)}'`)
  const moon = sep(by.moon.vec, ...ref.bodies.moon)
  check(`${ref.date}: Moon (geocentric) within 0.5 deg`, moon < 0.5, `${moon.toFixed(3)} deg`)
  const obs = { latDeg: 48, lonDeg: 11, date: new Date((ref.jd - 2440587.5) * 86400000) }
  const topo = solarSystem(ref.jd, obs).find((b) => b.id === 'moon')!
  const moonTopo = sep(topo.vec, ...ref.moon_topo)
  check(`${ref.date}: Moon (topocentric, 48N 11E) within 0.5 deg`, moonTopo < 0.5, `${moonTopo.toFixed(3)} deg`)
}

const moon = solarSystem(refs[3].jd).find((b) => b.id === 'moon')!
check('Moon angular radius ~0.26 deg', moon.radiusDeg > 0.24 && moon.radiusDeg < 0.29, moon.radiusDeg.toFixed(3))
check('lit fraction is 0..1', moon.lit! >= 0 && moon.lit! <= 1, String(moon.lit))

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
