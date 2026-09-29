// Checks for lib/fly.ts. Run: node --import ./scripts/ts-resolve.mjs scripts/fly.check.ts
import { KM_PER_AU, MIN_HEIGHT_KM, flySpeed, heightWords, moveWithoutTunnelling, nearestBody, pushOut, speedWords, stopRadius, wheelMultiplier, type Body, type Vec3 } from '../src/renderer/src/lib/fly'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
  if (!ok) failed++
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol

const sun: Body = { id: 'sun', pos: [0, 0, 0], radius: 695_700 / KM_PER_AU }
const earth: Body = { id: 'earth', pos: [1, 0, 0], radius: 6371 / KM_PER_AU }
const moon: Body = { id: 'moon', pos: [1 + 384_400 / KM_PER_AU, 0, 0], radius: 1737.4 / KM_PER_AU }
const bodies = [sun, earth, moon]

// nearest surface
const n1 = nearestBody(bodies, [0.5, 0, 0])!
check('halfway between Sun and Earth: the Earth is nearer by surface? no, equal-ish: the Sun (0.5 AU) vs Earth (0.5 AU) - Earth has the smaller radius so the Sun is nearer', n1.id === 'sun', n1.id)
const n2 = nearestBody(bodies, [1 + 300_000 / KM_PER_AU, 0, 0])!
check('near the Moon: the Moon, and its height excludes its radius', n2.id === 'moon' && near(n2.height * KM_PER_AU, 384_400 - 300_000 - 1737.4, 1), (n2.height * KM_PER_AU).toFixed(0))
check('inside a body: height is zero, not negative', nearestBody(bodies, [0, 0, 0])!.height === 0)
check('no bodies: null', nearestBody([], [0, 0, 0]) === null)

// speed follows height
const fast = flySpeed(0.5), slow = flySpeed(1000 / KM_PER_AU)
check('at 0.5 AU the camera covers 0.3 AU a second, crossing the inner solar system in seconds', near(fast, 0.3, 1e-9), fast.toFixed(3))
check('1000 km up: 600 km/s', near(slow * KM_PER_AU, 600, 1e-6), (slow * KM_PER_AU).toFixed(2))
check('speed never falls under the floor, so it can still creep and leave', near(flySpeed(0) * KM_PER_AU, 0.6 * MIN_HEIGHT_KM, 1e-9), (flySpeed(0) * KM_PER_AU).toFixed(2))
check('wheel multiplier and Shift boost scale it', near(flySpeed(0.5, 2, true), 0.3 * 12, 1e-9))
check('multiplier is clamped', flySpeed(0.5, 1e9) === flySpeed(0.5, 1_000_000) && flySpeed(0.5, 0) === flySpeed(0.5, 0.01))
check('a wheel notch up is faster, down is slower, about 20% each', wheelMultiplier(1, -100) > 1.19 && wheelMultiplier(1, -100) < 1.21 && wheelMultiplier(1, 100) < 0.85 && wheelMultiplier(1, 100) > 0.82)
check('the wheel cannot take the multiplier out of range', wheelMultiplier(999_999, -10_000) === 1_000_000 && wheelMultiplier(0.011, 10_000) === 0.01)
check('above 150 the notches are bigger, so a million times faster is reachable', wheelMultiplier(1000, -100) > 1500 && wheelMultiplier(1000, -100) < 1700)
{
  let m = 1
  let notches = 0
  while (m < 1_000_000 && notches < 200) {
    m = wheelMultiplier(m, -100)
    notches++
  }
  check('from 1 to a million times takes under 60 notches', m === 1_000_000 && notches < 60, `${notches} notches`)
}

// out among the stars and galaxies
{
  const AUly = 63_241.077
  const star: Body = { id: 'star:sirius', pos: [8.6 * AUly, 0, 0], radius: 0.01 }
  const galaxy: Body = { id: 'lg:andromeda', pos: [2.5e6 * AUly, 0, 0], radius: 1.1e5 * AUly, soft: true }
  const from: Vec3 = [6 * AUly, 0, 0]
  const nStar = nearestBody([sun, star, galaxy], from)!
  check('6 light-years out: the nearest thing is Sirius (2.6 ly), not the Sun far behind', nStar.id === 'star:sirius' && near(nStar.height, 2.6 * AUly, AUly * 0.01), (nStar.height / AUly).toFixed(2) + ' ly')
  check('inside a galaxy: it does not count, the stars in it set the speed', nearestBody([galaxy], [2.5e6 * AUly + 1000, 0, 0]) === null)
  const edge = nearestBody([galaxy], [2.5e6 * AUly - 2e5 * AUly, 0, 0])!
  check('outside a galaxy: its height is the distance to its edge', near(edge.height, 0.9e5 * AUly, AUly), (edge.height / AUly).toFixed(0) + ' ly')
  const through = moveWithoutTunnelling([2.5e6 * AUly - 2e5 * AUly, 0, 0], [4e5 * AUly, 0, 0], [galaxy])
  check('a galaxy does not stop the camera: it flies straight through', near(through[0], 2.5e6 * AUly + 2e5 * AUly, AUly))
}
check('speed in words: light-years per second when it is that fast', speedWords(20 * 63_241.077).includes('light-years per second') && speedWords(5e-6).includes('km/s') && speedWords(500).includes('× light'))
check('height in words: light-years far out', heightWords(63_241.077 * 25).includes('light-years') && heightWords(63_241.077 * 3e6).includes('million'), heightWords(63_241.077 * 25))

// falling straight at the Earth from 10,000 km: it slows as it nears the surface, lands on the stop sphere and stays above it
{
  let pos: Vec3 = [1 + (6371 + 10_000) / KM_PER_AU, 0, 0]
  let minHeight = Infinity
  for (let i = 0; i < 60 * 120; i++) {
    const height = Math.max(0, Math.hypot(pos[0] - earth.pos[0], pos[1] - earth.pos[1], pos[2] - earth.pos[2]) - earth.radius)
    pos = moveWithoutTunnelling(pos, [-flySpeed(height) / 60, 0, 0], [earth])
    minHeight = Math.min(minHeight, Math.hypot(pos[0] - earth.pos[0], pos[1] - earth.pos[1], pos[2] - earth.pos[2]) - earth.radius)
  }
  check('120 s straight down from 10,000 km: it lands about the stop height above the ground and never goes through', minHeight * KM_PER_AU >= 3.0 && minHeight * KM_PER_AU < 3.5, (minHeight * KM_PER_AU).toFixed(3) + ' km')
  const soft = flySpeed(3 / KM_PER_AU) * KM_PER_AU
  check('the last kilometres are slow (under 2 km/s at 3 km up)', soft < 2, soft.toFixed(2) + ' km/s')
}

// collisions
const rel: Vec3 = [0.0001 * sun.radius, 0, 0]
check('inside the Sun: put back on the stop radius along the same line', pushOut(rel, sun.radius) && near(Math.hypot(...rel), stopRadius(sun.radius), 1e-12) && rel[1] === 0)
const out: Vec3 = [2 * sun.radius, 0, 0]
check('outside: untouched', !pushOut(out, sun.radius) && out[0] === 2 * sun.radius)
const centre: Vec3 = [0, 0, 0]
check('exactly at the centre: pushed out somewhere (no NaN)', pushOut(centre, sun.radius) && Number.isFinite(centre[0]) && near(Math.hypot(...centre), stopRadius(sun.radius), 1e-12))
check('the stop radius is at least 2 km above a small body', near(stopRadius(earth.radius) * KM_PER_AU - 6371, Math.max(6371 * 0.0005, 2), 1e-6), (stopRadius(earth.radius) * KM_PER_AU - 6371).toFixed(2))

// a fast step straight through the Sun stops on its surface
const stopped = moveWithoutTunnelling([-0.1, 0, 0], [0.2, 0, 0], [sun])
check('a step through the Sun stops on the near side', near(stopped[0], -stopRadius(sun.radius), 1e-12), stopped[0].toFixed(6))
const past = moveWithoutTunnelling([-0.1, 0.05, 0], [0.2, 0, 0], [sun])
check('a step that misses it goes the whole way', near(past[0], 0.1, 1e-12))
check('a step that ends before the body is unchanged', near(moveWithoutTunnelling([-0.1, 0, 0], [0.05, 0, 0], [sun])[0], -0.05, 1e-12))
check('moving away from a body never counts as a hit', near(moveWithoutTunnelling([-0.1, 0, 0], [-0.05, 0, 0], [sun])[0], -0.15, 1e-12))

// words
check('speed words', speedWords(1 / KM_PER_AU) === '1.0 km/s' && speedWords(0.005 / KM_PER_AU) === '5.0 m/s' && speedWords(1) === '499 × light' && speedWords(60000 / KM_PER_AU) === '60,000 km/s', `${speedWords(1 / KM_PER_AU)} | ${speedWords(0.005 / KM_PER_AU)} | ${speedWords(1)} | ${speedWords(60000 / KM_PER_AU)}`)
check('height words', heightWords(0.5 / KM_PER_AU) === '500 m' && heightWords(1000 / KM_PER_AU) === '1,000 km' && heightWords(1) === '1.00 AU', `${heightWords(0.5 / KM_PER_AU)} | ${heightWords(1000 / KM_PER_AU)} | ${heightWords(1)}`)

console.log(failed === 0 ? '\nAll fly checks passed.' : `\n${failed} fly check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
