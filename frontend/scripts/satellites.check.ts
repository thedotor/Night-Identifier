// Numerical checks for the satellite maths (lib/satellites.ts).
// Run (in frontend/): node --import ./scripts/ts-resolve.mjs scripts/satellites.check.ts
//
// satellites.reference.json was made by an independent implementation (Python skyfield + sgp4 with
// JPL DE421): the same CelesTrak element sets, the same site, three instants. Regenerate by running
// the same query in skyfield if the element rows in it are ever replaced.
import { readFileSync } from 'node:fs'
import * as S from '../src/renderer/src/lib/skyMath.ts'
import * as T from '../src/renderer/src/lib/satellites.ts'
import * as sat from '../src/renderer/src/lib/satelliteJs.ts'
import { bodyFrame } from '../src/renderer/src/lib/solarSystemEphemeris.ts'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}
const DEG = Math.PI / 180

interface Ref {
  site: { lat: number; lon: number }
  fields: string[]
  rows: (string | number)[][]
  times: string[]
  expect: { norad: number; t: string; alt: number; az: number; range: number; sunlit: boolean; height: number; sublat: number; sublon: number }[]
  sun: { t: string; alt: number; az: number }[]
  passes: Record<string, { rise: number; peak: number; set: number; peakAlt: number }[]>
}
const ref: Ref = JSON.parse(readFileSync(new URL('./satellites.reference.json', import.meta.url), 'utf8'))
const site: T.Site = { latDeg: ref.site.lat, lonDeg: ref.site.lon, heightKm: 0 }
const utc = (s: string): Date => new Date(s + 'Z')
const angDiff = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180)

const cat = await T.buildCatalogue({ fields: ref.fields, rows: ref.rows, fetched_at: 0, stale: false, offline: false, missing: [], credit: '' })
check('every reference row became a satellite', cat.records.length === ref.rows.length, `${cat.records.length}/${ref.rows.length}`)
const byId = new Map(cat.records.map((r) => [r.norad, r]))

// 1. positions against skyfield
{
  let worstAng = 0
  let worstRange = 0
  let worstHeight = 0
  let lit = 0
  const mismatched: string[] = []
  for (const e of ref.expect) {
    const s = T.sampleOne(byId.get(e.norad)!, utc(e.t), site)!
    // angular separation on the sky, not the raw alt/az difference (which blows up near the zenith)
    const a = S.altAzToVec(s.altDeg, s.azDeg, { latDeg: site.latDeg, lonDeg: site.lonDeg, date: utc(e.t) })
    const b = S.altAzToVec(e.alt, e.az, { latDeg: site.latDeg, lonDeg: site.lonDeg, date: utc(e.t) })
    worstAng = Math.max(worstAng, S.angleBetween(a, b) / DEG)
    worstRange = Math.max(worstRange, Math.abs(s.rangeKm - e.range) / e.range)
    worstHeight = Math.max(worstHeight, Math.abs(s.heightKm - e.height))
    if (s.sunlit === e.sunlit) lit++
    else mismatched.push(`${e.norad}@${e.t} shadow ${s.shadow.toFixed(2)}`)
  }
  check('look angles agree with skyfield', worstAng < 0.05, `worst ${worstAng.toFixed(4)} deg over ${ref.expect.length} positions`)
  check('range agrees with skyfield', worstRange < 2e-4, `worst ${(worstRange * 100).toFixed(4)} %`)
  check('height above ground agrees', worstHeight < 0.5, `worst ${worstHeight.toFixed(3)} km`)
  // Shadow edge cases (a satellite crossing the terminator within seconds) may legitimately differ.
  check('sunlit/shadow agrees with skyfield', lit >= ref.expect.length - 1, `${lit}/${ref.expect.length}${mismatched.length ? ' differing: ' + mismatched.join('; ') : ''}`)
}

// 2. the Sun (drives the twilight test for "visible" passes)
{
  let worst = 0
  for (const e of ref.sun) {
    const d = utc(e.t)
    const g = sat.gstime(d)
    const sun = T.sunAt(d, g, { latitude: site.latDeg * DEG, longitude: site.lonDeg * DEG, height: 0 })
    worst = Math.max(worst, Math.abs(sun.altDeg - e.alt), angDiff(sun.azDeg, e.az) * Math.cos(e.alt * DEG))
  }
  check('Sun altitude and azimuth agree with JPL DE421', worst < 0.1, `worst ${worst.toFixed(3)} deg`)
}

// 3. ground-fixed directions: what the overlay draws must convert back to the satellite's own alt/az
{
  const d = utc('2026-09-25T02:00:00')
  const iss = T.sampleOne(byId.get(25544)!, d, site)!
  const frame: S.Observer = { latDeg: site.latDeg, lonDeg: site.lonDeg, date: d }
  const back = S.vecAltAz(T.dirAt(iss.altDeg, iss.azDeg, frame), frame)
  check('alt/az -> sky direction -> alt/az round trip', Math.abs(back.alt - iss.altDeg) < 1e-9 && angDiff(back.az, iss.azDeg) < 1e-9)
  // A still photo taken at `d`: the satellite as it will be 10 minutes later is drawn where the ground-fixed
  // photo would show it, i.e. its later alt/az read back through the photo's own frame.
  const later = new Date(d.getTime() + 600000)
  const s2 = T.sampleOne(byId.get(25544)!, later, site)!
  const dir = T.dirAt(s2.altDeg, s2.azDeg, frame)
  const rb = S.vecAltAz(dir, frame)
  check('a later position read through the photo frame keeps its later alt/az', Math.abs(rb.alt - s2.altDeg) < 1e-9 && angDiff(rb.az, s2.azDeg) < 1e-9)
  // ...and a live camera (frame = now) would draw the same satellite at a different sky direction than the photo frame does
  const liveFrame: S.Observer = { ...frame, date: later }
  const moved = S.angleBetween(dir, T.dirAt(s2.altDeg, s2.azDeg, liveFrame)) / DEG
  // turning about the pole by 10 min of sidereal time (2.5069 deg) moves a point at declination d by that times cos(d)
  const expectMoved = 2.5069 * Math.cos(S.vecToRadec(dir).dec * DEG)
  check('frame time matters: 10 min of Earth turn moves it by 2.507 deg x cos(dec)', Math.abs(moved - expectMoved) < 0.01, `${moved.toFixed(3)} vs ${expectMoved.toFixed(3)} deg`)
}

// 4. tracker (fast path) equals brute force, including after time jumps and a change of site
{
  const all = cat.records
  const brute = (d: Date, st: T.Site): number[] =>
    all.map((r) => T.sampleOne(r, d, st)).filter((s) => s && s.altDeg >= 0).map((s) => s!.rec.norad).sort((a, b) => a - b)
  const tr = new T.SatTracker(all)
  const t0 = utc('2026-09-25T02:00:00').getTime()
  let same = true
  let n = 0
  for (const dt of [0, 0.25, 1, 4.9, 5.1, 20, 21, 600, 601, -3000, 0]) {
    const d = new Date(t0 + dt * 1000)
    const got = tr.sample(d, site).map((s) => s.rec.norad).sort((a, b) => a - b)
    const want = brute(d, site)
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      same = false
      console.log('   differs at dt', dt, 'got', got.length, 'want', want.length)
    }
    n += want.length
  }
  check('tracker matches a full scan (steps, jumps, going back)', same, `${n} sightings compared`)
  const other: T.Site = { latDeg: -33.9, lonDeg: 151.2 }
  const got2 = tr.sample(new Date(t0), other).map((s) => s.rec.norad).sort((a, b) => a - b)
  check('tracker rescans when the site changes', JSON.stringify(got2) === JSON.stringify(brute(new Date(t0), other)))
}

// 5. rising satellites are never missed between full scans (walk 60 s in 0.5 s steps after one scan)
{
  const tr = new T.SatTracker(cat.records)
  const t0 = utc('2026-09-25T08:30:00').getTime()
  tr.sample(new Date(t0), site)
  let missed = 0
  for (let s = 0.5; s <= 4.5; s += 0.5) {
    const d = new Date(t0 + s * 1000)
    const got = new Set(tr.sample(d, site).map((x) => x.rec.norad))
    for (const r of cat.records) {
      const x = T.sampleOne(r, d, site)
      if (x && x.altDeg >= 0 && !got.has(r.norad)) missed++
    }
  }
  check('nothing above the horizon is missed within the rescan interval', missed === 0, `${missed} missed`)
}

// 6. trails: consistent with direct evaluation, cached results identical to a fresh cache, current position on the path
{
  const rec = byId.get(25544)!
  const d = utc('2026-09-25T08:40:00')
  const cache = new T.TrailCache()
  const a = cache.points(rec, d, site, 120, 120, 10)
  check('trail spans the requested window on a 10 s grid', a.length === 24 || a.length === 25, `${a.length} points`)
  let ok = a.length > 0
  for (const p of a) {
    const s = T.sampleOne(rec, new Date(p.ms), site)!
    ok = ok && Math.abs(s.altDeg - p.altDeg) < 1e-9 && angDiff(s.azDeg, p.azDeg) < 1e-9
  }
  check('trail points equal directly computed positions', ok)
  const d2 = new Date(d.getTime() + 37000)
  const cached = cache.points(rec, d2, site, 120, 120, 10)
  const fresh = new T.TrailCache().points(rec, d2, site, 120, 120, 10)
  check('advancing time gives the same trail as a fresh cache', JSON.stringify(cached) === JSON.stringify(fresh))
  const s0 = T.sampleOne(rec, d, site)!
  const frame: S.Observer = { latDeg: site.latDeg, lonDeg: site.lonDeg, date: d }
  const f = T.buildSatFrame({
    samples: [s0], frame, site, date: d, trailCache: new T.TrailCache(), selected: null,
    opts: { ...T.DEFAULT_SAT_OPTIONS, trailSeconds: 120 }
  })
  const tr = f.trails[0]
  check('trail path passes through the satellite dot', !!tr && tr.path[tr.now] !== null && S.angleBetween(tr.path[tr.now]!, f.dots[0].dir) === 0)
}

// 7. passes against skyfield's own event finder
{
  const from = utc('2026-09-25T00:00:00')
  for (const id of ['25544', '48274']) {
    const mine = T.findPasses(byId.get(Number(id))!, site, from, 48, -1)
    const theirs = ref.passes[id]
    let worstRise = 0
    let worstSet = 0
    let worstPeakT = 0
    let worstPeakAlt = 0
    let matched = 0
    for (const t of theirs) {
      const m = mine.find((p) => Math.abs(p.peakMs - t.peak) < 120000)
      if (!m) continue
      matched++
      worstRise = Math.max(worstRise, Math.abs(m.riseMs - t.rise) / 1000)
      worstSet = Math.max(worstSet, Math.abs(m.setMs - t.set) / 1000)
      worstPeakT = Math.max(worstPeakT, Math.abs(m.peakMs - t.peak) / 1000)
      worstPeakAlt = Math.max(worstPeakAlt, Math.abs(m.peakAltDeg - t.peakAlt))
    }
    check(`passes of ${id}: every skyfield pass is found`, matched === theirs.length && mine.length === theirs.length, `${matched}/${theirs.length} (mine ${mine.length})`)
    check(`passes of ${id}: rise/set within 5 s, peak within 5 s and 0.3 deg`, worstRise < 5 && worstSet < 5 && worstPeakT < 5 && worstPeakAlt < 0.3, `rise ${worstRise.toFixed(1)} s, set ${worstSet.toFixed(1)} s, peak ${worstPeakT.toFixed(1)} s / ${worstPeakAlt.toFixed(3)} deg`)
  }
  const iss = T.findPasses(byId.get(25544)!, site, from, 48, 10)
  check('minimum peak elevation filters passes', iss.every((p) => p.peakAltDeg >= 10) && iss.length > 0 && iss.length < ref.passes['25544'].length, `${iss.length} passes >= 10 deg`)
  check('passes are in time order and rise < peak < set', iss.every((p, i) => p.riseMs < p.peakMs && p.peakMs < p.setMs && (i === 0 || iss[i - 1].setMs < p.riseMs)))
}

// 8. stale elements are refused instead of drawn wrongly
{
  const rec = byId.get(25544)!
  check('a photo from a year ago gets no positions', T.sampleOne(rec, new Date('2025-06-01T00:00:00Z'), site) === null)
  check('...and the catalogue reports how stale the orbits are for it', T.elementAgeDays(T.medianEpochMs(cat.records), new Date('2025-06-01T00:00:00Z')) > 300)
  check('elements are trusted on the day they were measured', T.sampleOne(rec, new Date(rec.epochMs), site) !== null)
}

// 8b. statistics for the panel
{
  const samples = cat.records.map((r) => T.sampleOne(r, utc('2026-09-25T08:30:00'), site)!).filter((x) => x && x.altDeg >= 0)
  const st = T.statsOf(samples, samples.length - 1)
  check('stats count per group and in total', st.total === samples.length && st.shown === samples.length - 1 && Object.values(st.perBit).reduce((a, b) => a + b, 0) >= st.total, `${st.total} up, per bit ${JSON.stringify(st.perBit)}`)
}

// 8c. the 3D scene: a satellite converted to the scene's ecliptic frame and read against the scene's own Earth
// orientation (astronomy-engine) must sit over the point on the ground that skyfield says is beneath it.
{
  const toGeocentric = (latDeg: number, hKm: number): number => {
    const a = 6378.137
    const e2 = 0.00669437999014
    const phi = latDeg * DEG
    const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2)
    return Math.atan2((N * (1 - e2) + hKm) * Math.sin(phi), (N + hKm) * Math.cos(phi)) / DEG
  }
  let worstLon = 0
  let worstLat = 0
  let worstR = 0
  for (const e of ref.expect) {
    const d = utc(e.t)
    const rec = byId.get(e.norad)!
    const p = T.eciPosition(rec, d)!
    const jd = S.julianDate(d)
    const q = T.temeToEcliptic(jd)(p)
    const f = bodyFrame('Earth', d)
    const dotv = (a: S.Vec3, b: S.Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const r = Math.hypot(q[0], q[1], q[2])
    const lon = Math.atan2(dotv(f.east, q), dotv(f.prime, q)) / DEG
    const lat = Math.asin(dotv(f.north, q) / r) / DEG
    worstLon = Math.max(worstLon, angDiff(lon, e.sublon) * Math.cos(lat * DEG))
    worstLat = Math.max(worstLat, Math.abs(lat - toGeocentric(e.sublat, e.height)))
    worstR = Math.max(worstR, Math.abs(r - Math.hypot(p.x, p.y, p.z)))
  }
  check('3D frame: satellite sits over the ground point skyfield gives (longitude)', worstLon < 0.05, `worst ${worstLon.toFixed(4)} deg`)
  check('3D frame: ... and latitude', worstLat < 0.05, `worst ${worstLat.toFixed(4)} deg`)
  check('3D frame: the rotation keeps the distance from the centre of the Earth', worstR < 1e-6, `${worstR.toExponential(1)} km`)
  const g = T.globalState(byId.get(25544)!, utc('2026-09-25T02:00:00'))!
  const ex = ref.expect.find((e) => e.norad === 25544 && e.t === '2026-09-25T02:00:00')!
  check('global state (no site needed): height, sub-point and lighting match', Math.abs(g.heightKm - ex.height) < 0.5 && Math.abs(g.latDeg - ex.sublat) < 0.02 && angDiff(g.lonDeg, ex.sublon) < 0.02 && g.sunlit === ex.sunlit, `${g.heightKm.toFixed(1)} km, ${g.latDeg.toFixed(3)}, ${g.lonDeg.toFixed(3)}`)
}

// 9. groups
{
  check('group mask', T.groupMask(['stations', 'starlink']) === 5 && T.groupMask([]) === 0)
  const stations = T.recordsIn(cat, ['stations'])
  check('records in a group', stations.length > 0 && stations.every((r) => r.flags & 1))
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
