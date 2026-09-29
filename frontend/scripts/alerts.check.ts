// Checks for notifications/alertLogic.ts. Run: node --import ./scripts/ts-resolve.mjs scripts/alerts.check.ts
import { eventsDue, bzSouthAlert, bzSustainedSouth, dstStormAlert, newShocks, newEarthCmes, newStrongFlares, auroraChanceAlert, stormKpAlert, cameraAlerts, clearNightDue, clearNightVerdict, inQuietHours, issPassToAlert, bigQuakes, quakesNearMe, quakeSwarm, volcanoChanges, lowDisks, staleData, stormApproaching, type CameraSnapshot } from '../src/renderer/src/notifications/alertLogic'
import type { Strike } from '../src/renderer/src/lib/lightning'
import type { SatPass } from '../src/renderer/src/lib/satellites'
import type { Quake } from '../src/renderer/src/lib/hazards'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
  if (!ok) failed++
}
const at = (h: number, m = 0): Date => new Date(2026, 8, 25, h, m)

// quiet hours
const q = { enabled: true, start: '23:00', end: '07:00' }
check('quiet: 23:30 and 03:00 are inside, 07:00 and 12:00 are not', inQuietHours(q, at(23, 30)) && inQuietHours(q, at(3)) && !inQuietHours(q, at(7)) && !inQuietHours(q, at(12)))
check('quiet: a same-day period (13:00-15:00)', inQuietHours({ enabled: true, start: '13:00', end: '15:00' }, at(14)) && !inQuietHours({ enabled: true, start: '13:00', end: '15:00' }, at(16)))
check('quiet: off, or start = end, means never', !inQuietHours({ ...q, enabled: false }, at(3)) && !inQuietHours({ enabled: true, start: '08:00', end: '08:00' }, at(8)))

// ISS
const now = 1_800_000_000_000
const pass = (riseMin: number, peak: number, visible: boolean): SatPass => ({
  riseMs: now + riseMin * 60_000,
  peakMs: now + (riseMin + 3) * 60_000,
  setMs: now + (riseMin + 6) * 60_000,
  peakAltDeg: peak,
  riseAzDeg: 300,
  peakAzDeg: 30,
  setAzDeg: 100,
  sunlitAtPeak: visible,
  visible
})
const cfg = { leadMin: 10, minElevationDeg: 20, visibleOnly: true }
check('ISS: a visible 45 deg pass 8 min away is announced', issPassToAlert([pass(8, 45, true)], now, cfg, null)?.peakAltDeg === 45)
check(
  'ISS: not announced 30 min ahead, when low, when invisible (if asked), or twice',
  issPassToAlert([pass(30, 60, true)], now, cfg, null) === null &&
    issPassToAlert([pass(8, 12, true)], now, cfg, null) === null &&
    issPassToAlert([pass(8, 60, false)], now, cfg, null) === null &&
    issPassToAlert([pass(8, 60, true)], now, cfg, now + 8 * 60_000) === null
)
check('ISS: invisible passes are announced when "visible only" is off', issPassToAlert([pass(8, 60, false)], now, { ...cfg, visibleOnly: false }, null) !== null)
check('ISS: skips a pass that already started', issPassToAlert([pass(-2, 60, true)], now, cfg, null) === null)

// storm approaching: a cluster about 100 km east, 8 minutes ago it was about 110 km east: closing at ~75 km/h
const place = { latDeg: 51.5, lonDeg: 0 }
const mk = (i: number, ageMin: number, kmEast: number): Strike => ({
  seq: i,
  tMs: now - ageMin * 60_000,
  lat: 51.5 + ((i % 5) - 2) * 0.02,
  lon: kmEast / (111.19 * Math.cos((51.5 * Math.PI) / 180)) + ((i % 3) - 1) * 0.02,
  polarity: 0,
  stations: 10,
  accuracyM: 3000
})
const cluster = (recentKm: number, earlierKm: number): Strike[] => {
  const out: Strike[] = []
  for (let i = 0; i < 12; i++) out.push(mk(i, 3 + (i % 3), recentKm + (i % 2) * 2))
  for (let i = 0; i < 12; i++) out.push(mk(100 + i, 11 + (i % 3), earlierKm + (i % 2) * 2))
  return out
}
const a = stormApproaching(cluster(100, 110), place, now, 150, 15)
check('storm approaching: ~100 km east, closing ~75 km/h', !!a && Math.abs(a.distanceKm - 100) < 10 && a.speedKmH > 40 && a.speedKmH < 120 && a.bearing > 80 && a.bearing < 100, a ? `${a.distanceKm.toFixed(0)} km, ${a.speedKmH.toFixed(0)} km/h, eta ${a.etaMin.toFixed(0)} min, bearing ${a.bearing.toFixed(0)}` : 'null')
check('storm moving away is not announced', stormApproaching(cluster(110, 100), place, now, 250, 15) === null)
check('a jump too fast to be a storm (450 km/h) is not announced', stormApproaching(cluster(100, 160), place, now, 150, 15) === null)
check('storm that is not moving is not announced', stormApproaching(cluster(100, 100), place, now, 150, 15) === null)
check('storm beyond the limit is not announced', stormApproaching(cluster(100, 110), place, now, 60, 15) === null)
check('storm already overhead is left to the "near you" alert', stormApproaching(cluster(10, 20), place, now, 150, 15) === null)
check('too few strikes: not announced', stormApproaching(cluster(100, 110).slice(0, 5), place, now, 150, 15) === null)

// clear night
const hours: string[] = []
const cloud: number[] = []
for (let h = 0; h < 30; h++) {
  hours.push(new Date(Date.UTC(2026, 8, 25, h)).toISOString().slice(0, 13) + ':00')
  cloud.push(h >= 18 && h <= 27 ? 10 : 90)
}
const dusk = new Date(Date.UTC(2026, 8, 25, 19))
const dawn = new Date(Date.UTC(2026, 8, 26, 3))
const v = clearNightVerdict({ time: hours, cloud_cover: cloud }, dusk, dawn, 30)
check('clear night: 10% cloud over the dark hours is clear', !!v && v.clear && v.meanCloud < 15, JSON.stringify(v))
const cloudy = clearNightVerdict({ time: hours, cloud_cover: cloud.map(() => 85) }, dusk, dawn, 30)
check('clear night: 85% cloud is not', !!cloudy && !cloudy.clear)
const sunset = at(19, 0)
check(
  'clear night: due from 1 h before sunset, for 30 min, once a day',
  clearNightDue(at(18, 10).getTime(), sunset, 60, null) &&
    !clearNightDue(at(17, 50).getTime(), sunset, 60, null) &&
    !clearNightDue(at(18, 45).getTime(), sunset, 60, null) &&
    !clearNightDue(at(18, 10).getTime(), sunset, 60, at(10).toDateString())
)

// camera
const cam = (o: Partial<CameraSnapshot>): CameraSnapshot => ({ id: 'c', name: '90D', kind: 'canon', running: true, sequence: false, batteryPct: 80, shotsLeft: 5000, modeDial: 'Manual (M)', ...o })
const lim = { batteryPct: 20, shotsLeft: 100 }
const st0 = { lowBattery: false, lowCard: false, dialWarned: false }
const c1 = cameraAlerts(cam({ batteryPct: 15 }), lim, st0)
check('camera: battery 15% under a 20% limit is announced once', c1.alerts.length === 1 && c1.alerts[0].key === 'battery' && cameraAlerts(cam({ batteryPct: 14 }), lim, c1.state).alerts.length === 0)
const c2 = cameraAlerts(cam({ batteryPct: 40 }), lim, c1.state)
check('camera: recovers, then can be announced again', !c2.state.lowBattery && cameraAlerts(cam({ batteryPct: 10 }), lim, c2.state).alerts.length === 1)
check('camera: card nearly full', cameraAlerts(cam({ shotsLeft: 60 }), lim, st0).alerts.some((x) => x.key === 'card'))
check(
  'camera: dial not on M is only mentioned during a sequence (M and B are fine)',
  cameraAlerts(cam({ modeDial: 'Aperture priority (Av)' }), lim, st0).alerts.length === 0 &&
    cameraAlerts(cam({ modeDial: 'Aperture priority (Av)', sequence: true }), lim, st0).alerts[0]?.key === 'dial' &&
    cameraAlerts(cam({ modeDial: 'Bulb (B)', sequence: true }), lim, st0).alerts.length === 0
)
check('camera: a stopped camera says nothing', cameraAlerts(cam({ running: false, batteryPct: 5 }), lim, st0).alerts.length === 0)


// aurora and geomagnetic storm: fire once, wait for it to clear, then it may fire again (3 hours apart)
const fresh = { armed: true, lastSentMs: null as number | null }
const a1 = auroraChanceAlert(35, -30, 20, fresh, now)
check('aurora: 35% in the dark fires once', a1.send && !a1.state.armed)
check('aurora: still 35% a minute later does not repeat', !auroraChanceAlert(35, -30, 20, a1.state, now + 60_000).send)
check('aurora: not dark enough, or too low, does not fire', !auroraChanceAlert(35, -5, 20, fresh, now).send && !auroraChanceAlert(15, -30, 20, fresh, now).send)
const dropped = auroraChanceAlert(5, -30, 20, a1.state, now + 3600_000)
check('aurora: dropping under 60% of the limit re-arms it', dropped.state.armed && !dropped.send)
check('aurora: re-rising 2 h after the last one is too soon, 3 h after is fine', !auroraChanceAlert(40, -30, 20, dropped.state, now + 2 * 3600_000).send && auroraChanceAlert(40, -30, 20, dropped.state, now + 3 * 3600_000 + 1000).send)
check('aurora: daylight re-arms it too (a new night can fire again)', auroraChanceAlert(0, 20, 20, a1.state, now + 3600_000).state.armed)
const s1 = stormKpAlert(5.33, 5, fresh, now)
check('storm: Kp 5.3 fires once, 6 later does not repeat', s1.send && !stormKpAlert(6, 5, s1.state, now + 3600_000).send)
check('storm: 4.5 does not re-arm (within a point of the limit), 3.5 does', !stormKpAlert(4.5, 5, s1.state, now + 3600_000).state.armed && stormKpAlert(3.5, 5, s1.state, now + 3600_000).state.armed)
check('storm: below the limit never fires', !stormKpAlert(4.67, 5, fresh, now).send)


// the Sun: strong flares and CMEs
{
  const fl = (cls: string, begin: number, peakAgoMin: number): { class: string; begin: number; peak: number; end: null; region: null } => ({ class: cls, begin, peak: now - peakAgoMin * 60_000, end: null, region: null })
  const flares = [fl('C9.0', 1, 10), fl('M4.9', 2, 10), fl('M5.0', 3, 20), fl('X1.2', 4, 5), fl('M6.0', 5, 300)]
  const a = newStrongFlares(flares, 5e-5, [], now)
  check('flares: M5 limit announces M5.0 and X1.2 that peaked within the hour, not M4.9, C9 or the 5-hour-old M6', a.fresh.map((f) => f.class).join() === 'M5.0,X1.2', a.fresh.map((f) => f.class).join())
  check('flares: the old M6 is still remembered (so it never announces later)', a.seen.includes(5) && a.seen.includes(3) && a.seen.includes(4) && !a.seen.includes(2))
  check('flares: the same list again announces nothing', newStrongFlares(flares, 5e-5, a.seen, now + 60_000).fresh.length === 0)
  check('flares: a lower limit (M1) counts M4.9 too', newStrongFlares(flares, 1e-5, [], now).fresh.length === 3)
  check('flares: the remembered list is capped', newStrongFlares(Array.from({ length: 100 }, (_, i) => fl('X1.0', i + 1, 1)), 5e-5, [], now).seen.length === 60)
  const cme = (id: string, earth: boolean, arrivalH: number | null): { id: string; start: number; t215: number; lat: number; lon: number; half_angle: number; speed: number; type: null; source: null; note: null; earth_directed: boolean; arrival: number | null; arrival_source: string; separation: number } => ({ id, start: now, t215: now, lat: 0, lon: 0, half_angle: 40, speed: 800, type: null, source: null, note: null, earth_directed: earth, arrival: arrivalH === null ? null : now + arrivalH * 3600_000, arrival_source: 'NASA', separation: 5 })
  const c = newEarthCmes([cme('a', true, 40), cme('b', false, 40), cme('c', true, -5), cme('d', true, null)], [], now)
  check('CMEs: only those heading for Earth with a future arrival', c.fresh.map((x) => x.id).join() === 'a', c.fresh.map((x) => x.id).join())
  check('CMEs: announced once', newEarthCmes([cme('a', true, 40)], c.seen, now + 3600_000).fresh.length === 0)
  check('CMEs: a new one is announced alongside the remembered one', newEarthCmes([cme('a', true, 40), cme('e', true, 30)], c.seen, now).fresh.map((x) => x.id).join() === 'e')
}


// the wind and the field
{
  const pt = (minAgo: number, bz: number | null): { t: string; bz: number | null } => ({ t: new Date(now - minAgo * 60_000).toISOString(), bz })
  const south = Array.from({ length: 12 }, (_, i) => pt(33 - i * 3, -12))
  check('Bz: -12 for 33 minutes is sustained south (limit -10, 15 min)', bzSustainedSouth(south, -10, 15, now))
  check('Bz: one reading above the limit in the window breaks it', !bzSustainedSouth([...south.slice(0, 8), pt(6, -3), ...south.slice(9)], -10, 15, now))
  check('Bz: only 6 minutes of data is not enough', !bzSustainedSouth(south.slice(-2), -10, 15, now))
  check('Bz: readings that start only 5 minutes ago do not count as 15', !bzSustainedSouth([pt(5, -14), pt(2, -14), pt(0, -14)], -10, 15, now))
  const b1 = bzSouthAlert(south, -10, 15, { armed: true, lastSentMs: null }, now)
  check('Bz alert: fires once, not again while it stays south', b1.send && !bzSouthAlert(south, -10, 15, b1.state, now + 60_000).send)
  const later = now + 4 * 3600_000
  const ptAt = (t: number, minAgo: number, bz: number): { t: string; bz: number } => ({ t: new Date(t - minAgo * 60_000).toISOString(), bz })
  const eased = bzSouthAlert([ptAt(later - 3600_000, 3, -2), ptAt(later - 3600_000, 0, -1)], -10, 15, b1.state, later - 3600_000)
  const southAgain = Array.from({ length: 12 }, (_, i) => ptAt(later, 33 - i * 3, -12))
  check('Bz alert: eases (above -5) and re-arms, fires again after 3 h when south again', eased.state.armed && bzSouthAlert(southAgain, -10, 15, eased.state, later).send)
  const d1 = dstStormAlert(-62, 50, { armed: true, lastSentMs: null }, now)
  check('Dst alert: -62 with limit -50 fires once', d1.send && !dstStormAlert(-70, 50, d1.state, now + 3600_000).send)
  check('Dst alert: re-arms only when Dst is 20 nT above the limit', !dstStormAlert(-40, 50, d1.state, now + 3600_000).state.armed && dstStormAlert(-25, 50, d1.state, now + 3600_000).state.armed)
  check('Dst alert: -30 never fires', !dstStormAlert(-30, 50, { armed: true, lastSentMs: null }, now).send)
  const sh = [{ t: now - 10 * 60_000, speedBefore: 400, speedAfter: 520 }, { t: now - 5 * 3600_000, speedBefore: 400, speedAfter: 500 }]
  const n1 = newShocks(sh, (v) => 1_500_000 / v / 60, [], now)
  check('shock alert: the fresh one is announced, the one whose arrival has passed is not', n1.fresh.length === 1 && n1.fresh[0].t === sh[0].t && n1.fresh[0].arrival > now, JSON.stringify(n1.fresh.map((s) => s.t - now)))
  check('shock alert: announced once', newShocks(sh, (v) => 1_500_000 / v / 60, n1.seen, now + 60_000).fresh.length === 0)
}


// sky-event reminders
{
  const ev = (over: Record<string, unknown>): Parameters<typeof eventsDue>[0][number] => ({ id: 'e1', kind: 'meteor', title: 'Geminids peak', detail: '', startMs: now, peakMs: now + 2 * 3600_000, priority: 1, visible: 'yes', remindable: true, score: { score: 70, rating: 'good', reasons: [], noForecast: false }, ...over }) as never
  const r1 = eventsDue([ev({})], now, 3, 45, [], [])
  check('event reminder: due 2 h ahead with a 3 h lead, once', r1.due.length === 1 && eventsDue([ev({})], now + 60_000, 3, 45, r1.seen, []).due.length === 0)
  check('event reminder: not yet due 5 h ahead, and not after it has passed', eventsDue([ev({ peakMs: now + 5 * 3600_000 })], now, 3, 45, [], []).due.length === 0 && eventsDue([ev({ peakMs: now - 60_000 })], now, 3, 45, [], []).due.length === 0)
  check('event reminder: a poor score is skipped, unless you marked the event yourself', eventsDue([ev({ score: { score: 20, rating: 'poor', reasons: [], noForecast: false } })], now, 3, 45, [], []).due.length === 0 && eventsDue([ev({ score: { score: 20, rating: 'poor', reasons: [], noForecast: false } })], now, 3, 45, [], ['e1']).due.length === 1)
  check('event reminder: no forecast yet still reminds', eventsDue([ev({ score: { score: 30, rating: 'poor', reasons: [], noForecast: true } })], now, 3, 45, [], []).due.length === 1)
  check('event reminder: not visible, not remindable, ISS and Moon phases never remind by themselves', eventsDue([ev({ visible: 'no' })], now, 3, 45, [], []).due.length === 0 && eventsDue([ev({ remindable: false })], now, 3, 45, [], []).due.length === 0 && eventsDue([ev({ kind: 'iss' })], now, 3, 45, [], []).due.length === 0 && eventsDue([ev({ kind: 'moon' })], now, 3, 45, [], []).due.length === 0)
  check('event reminder: the best moment counts, not the peak', eventsDue([ev({ peakMs: now - 5 * 3600_000, bestMs: now + 2 * 3600_000 })], now, 3, 45, [], []).due.length === 1)
}

// stale data and disk
check('stale: 9-day-old orbit data is reported at a 7-day limit, 3-day-old is not', staleData({ datasets: { stations: { age_s: 9 * 86400 } } }, null, 7).length === 1 && staleData({ datasets: { stations: { age_s: 3 * 86400 } } }, null, 7).length === 0)
check('stale: never-downloaded data is not "out of date"', staleData({ datasets: { stations: null } }, null, 7).length === 0)
check('stale: a stale cloud map is reported, a missing one is not', staleData(null, { available: true, stale: true, age_s: 5 * 3600 }, 7).length === 1 && staleData(null, { available: false, stale: false, age_s: null }, 7).length === 0)
check('disk: under 10 GB is low, over is not', lowDisks([{ label: 'A', drive: 'C:', free_bytes: 8e9, total_bytes: 3e11 }, { label: 'B', drive: 'D:', free_bytes: 5e10, total_bytes: 1e12 }], 10).length === 1)

// earthquakes and volcanoes
{
  const home = { latDeg: 51.5, lonDeg: -0.1 }
  const qk = (id: string, mag: number, lat: number, lon: number, ageMin: number, tsunami = false): Quake => ({ id, tMs: now - ageMin * 60_000, latDeg: lat, lonDeg: lon, depthKm: 10, mag, tsunami })
  const near = qk('a', 3.4, 51.9, 0.3, 20)
  const r1 = quakesNearMe([near, qk('b', 2.4, 51.6, 0.0, 5), qk('c', 5.5, 40, 30, 5)], home, 3, 200, [], now)
  check('quake near me: a M3.4 quake 50 km away is announced; a M2.4 (too small) and a far M5.5 are not', r1.fresh.length === 1 && r1.fresh[0].id === 'a' && r1.fresh[0].km > 30 && r1.fresh[0].km < 70, JSON.stringify(r1.fresh.map((q) => [q.id, Math.round(q.km)])))
  check('quake near me: not announced twice, and an old one (older than 3 h) is only remembered', quakesNearMe([near], home, 3, 200, r1.seen, now).fresh.length === 0 && quakesNearMe([qk('old', 4, 51.7, 0, 400)], home, 3, 200, [], now).fresh.length === 0)
  check('quake near me: the bearing points the right way (north-east)', r1.fresh[0].bearing > 20 && r1.fresh[0].bearing < 80, String(Math.round(r1.fresh[0].bearing)))
  const big = bigQuakes([qk('x', 6.7, -20, -70, 30), qk('y', 6.0, 10, 10, 30), qk('z', 5.2, 35, 140, 30, true)], 6.5, [], now)
  check('big quake: M6.7 and a tsunami-flagged M5.2 are announced, an M6.0 is not, biggest first', big.fresh.length === 2 && big.fresh[0].id === 'x' && big.fresh[1].id === 'z')
  check('big quake: never twice', bigQuakes([qk('x', 6.7, -20, -70, 30)], 6.5, big.seen, now).fresh.length === 0)

  const vol = (vnum: number, level: number, lat = 0, lon = 0): { vnum: number; name: string; country: string; lat: number; lon: number; level: number } => ({ vnum, name: `V${vnum}`, country: 'X', lat, lon, level })
  const first = volcanoChanges([vol(1, 3), vol(2, 1)], null)
  check('volcano: the first look announces nothing, it only remembers', first.fresh.length === 0 && first.state['1'] === 3 && first.state['2'] === 1)
  const second = volcanoChanges([vol(1, 3), vol(2, 2), vol(3, 3)], first.state)
  check('volcano: a raised level (2 from 1) and a newly erupting volcano (3) are announced, the unchanged one is not, erupting first', second.fresh.length === 2 && second.fresh[0].vnum === 3 && second.fresh[1].vnum === 2 && second.fresh[1].from === 1)
  check('volcano: one that eased and rose again is announced again', volcanoChanges([vol(1, 3)], { '1': 0 }).fresh.length === 1)
  check('volcano: the near-me filter drops far volcanoes', volcanoChanges([vol(1, 3, 60, 100), vol(2, 3, 51, 0)], {}, (v) => Math.abs(v.lat - 51) < 5).fresh.map((v) => v.vnum).join() === '2')

  // a swarm: 7 quakes within a few km near home in the last hour
  const swarmQ = Array.from({ length: 7 }, (_, i) => qk(`s${i}`, 2.6 + i * 0.1, 51.4 + i * 0.01, -0.1, 5 + i * 5))
  const sw = quakeSwarm(swarmQ, now, { count: 6, radiusKm: 60, windowMin: 60, minMag: 2.5, withinKm: 500 }, home, [])
  check('swarm: 7 quakes in one small area within an hour is a swarm of 7, with the biggest magnitude', sw.swarm?.count === 7 && Math.abs((sw.swarm?.maxMag ?? 0) - 3.2) < 1e-9, JSON.stringify(sw.swarm))
  check('swarm: announced once per area (per 6 hours)', quakeSwarm(swarmQ, now, { count: 6, radiusKm: 60, windowMin: 60, minMag: 2.5, withinKm: 500 }, home, sw.seen).swarm === null)
  check('swarm: too few, too old, or too far from me is not a swarm', quakeSwarm(swarmQ.slice(0, 4), now, { count: 6, radiusKm: 60, windowMin: 60, minMag: 2.5, withinKm: 500 }, home, []).swarm === null && quakeSwarm(swarmQ, now + 3 * 3_600_000, { count: 6, radiusKm: 60, windowMin: 60, minMag: 2.5, withinKm: 500 }, home, []).swarm === null && quakeSwarm(swarmQ, now, { count: 6, radiusKm: 60, windowMin: 60, minMag: 2.5, withinKm: 500 }, { latDeg: -30, lonDeg: 150 }, []).swarm === null)
  check('swarm: withinKm 0 means anywhere', quakeSwarm(swarmQ, now, { count: 6, radiusKm: 60, windowMin: 60, minMag: 2.5, withinKm: 0 }, { latDeg: -30, lonDeg: 150 }, []).swarm !== null)
}

console.log(failed ? `${failed} FAILED` : 'all passed')
process.exit(failed ? 1 : 0)
