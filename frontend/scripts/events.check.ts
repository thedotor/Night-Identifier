// Checks for the sky-events calendar (lib/eventsSky, eventsOccult, eventsSmall, eventsSpace, eventScore, eventIcs).
// Run: node --import ./scripts/ts-resolve.mjs scripts/events.check.ts
import * as Astronomy from 'astronomy-engine'
import { eclipseEvents, moonEvents, moonPlanetEvents, planetEvents, seasonEvents, showerEvents, lowestSunAltitude, expectedRate, SHOWERS } from '../src/renderer/src/lib/eventsSky'
import { findOccultations, occultationEvents } from '../src/renderer/src/lib/eventsOccult'
import { asteroidEvents, cometEvents, cometState, conicPosition, type CometElements } from '../src/renderer/src/lib/eventsSmall'
import { auroraEdge, auroraReach, geomagneticLatitude, passEvents, spaceEvents } from '../src/renderer/src/lib/eventsSpace'
import { cloudAt, cloudBetween, nightSummary, ratingOf, scoreEvent, solarNoon, type Outlook } from '../src/renderer/src/lib/eventScore'
import { eventsToIcs, icsEscape, icsFold, icsTime } from '../src/renderer/src/lib/eventIcs'
import type { SkyEvent } from '../src/renderer/src/lib/eventTypes'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
  if (!ok) failed++
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const MIN = 60_000
const H = 3_600_000
const D = 86_400_000
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16)
const london = { latDeg: 51.5074, lonDeg: -0.1278 }
const sydney = { latDeg: -33.87, lonDeg: 151.21 }
const from = Date.UTC(2026, 8, 25)
const to = from + 365 * D

// ---------- well-known dates (UTC) ----------
{
  const moon = moonEvents(london, from, from + 40 * D)
  const full = moon.find((e) => e.title === 'Full Moon')!
  check('the first Full Moon after 25 Sep 2026 is 26 Sep at 16:49 UTC', near(full.peakMs, Date.UTC(2026, 8, 26, 16, 49), 5 * MIN), iso(full.peakMs))
  check('a supermoon is flagged when a full Moon is at perigee (24 Dec 2026)', moonEvents(london, from, to).some((e) => /Supermoon/.test(e.title) && near(e.peakMs, Date.UTC(2026, 11, 24, 1, 28), 2 * H)))
  const planets = planetEvents(london, from, to)
  const opp = (name: string): SkyEvent | undefined => planets.find((e) => e.title === `${name} at opposition`)
  check('Saturn opposition 4 Oct 2026', near(opp('Saturn')!.peakMs, Date.UTC(2026, 9, 4, 12, 0), D), iso(opp('Saturn')!.peakMs))
  check('Neptune opposition 26 Sep 2026, Uranus 25 Nov 2026', near(opp('Neptune')!.peakMs, Date.UTC(2026, 8, 26, 2, 0), D) && near(opp('Uranus')!.peakMs, Date.UTC(2026, 10, 25, 22, 0), D))
  check('Jupiter opposition 11 Feb 2027, Mars 19 Feb 2027', near(opp('Jupiter')!.peakMs, Date.UTC(2027, 1, 11, 0, 0), D) && near(opp('Mars')!.peakMs, Date.UTC(2027, 1, 19, 15, 0), D))
  const seasons = seasonEvents(london, from, to)
  const find = (t: string): SkyEvent => seasons.find((e) => e.title === t)!
  check('winter solstice 21 Dec 2026 20:50 UTC, spring equinox 20 Mar 2027 20:24', near(find('Winter solstice').peakMs, Date.UTC(2026, 11, 21, 20, 50), 5 * MIN) && near(find('Spring equinox').peakMs, Date.UTC(2027, 2, 20, 20, 24), 5 * MIN))
  check('southern hemisphere names are swapped', seasonEvents(sydney, from, to).some((e) => e.title === 'Summer solstice' && /Dec|21/.test(iso(e.peakMs).slice(5, 10)) === false) === false || seasonEvents(sydney, from, to).find((e) => e.title === 'Summer solstice')!.peakMs > Date.UTC(2026, 11, 1))
  check('perihelion falls in early January, aphelion in early July', near(find('Perihelion').peakMs, Date.UTC(2027, 0, 3), 3 * D) && near(find('Aphelion').peakMs, Date.UTC(2027, 6, 5), 3 * D))
  check('London loses astronomical darkness in May and gets it back in July', seasons.some((e) => /ends/.test(e.title) && new Date(e.peakMs).getUTCMonth() === 4) && seasons.some((e) => /returns/.test(e.title) && new Date(e.peakMs).getUTCMonth() === 6))
  check('the Sun never gets 18 degrees down at 51.5 N at the June solstice (declination +23.4), but does in December', lowestSunAltitude(51.5, 23.4) > -18 && lowestSunAltitude(51.5, -23.4) < -18)
  const ecl = eclipseEvents(london, Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31))
  const lunar = ecl.find((e) => /Total lunar/.test(e.title))!
  check('total lunar eclipse 3 Mar 2026 at about 11:33 UTC', near(lunar.peakMs, Date.UTC(2026, 2, 3, 11, 33), 10 * MIN), iso(lunar.peakMs))
  const solar2026 = ecl.find((e) => /Total solar/.test(e.title))!
  check('total solar eclipse 12 Aug 2026 at about 17:46 UTC (global peak)', near(solar2026.peakMs, Date.UTC(2026, 7, 12, 17, 46), 90 * MIN), iso(solar2026.peakMs))
  const luxor = { latDeg: 25.7, lonDeg: 32.6 }
  const luxorEcl = eclipseEvents(luxor, Date.UTC(2027, 6, 1), Date.UTC(2027, 8, 1)).find((e) => /solar/.test(e.title) && new Date(e.peakMs).getUTCDate() === 2)
  check('the 2 Aug 2027 eclipse is total from Luxor, with the Sun high', !!luxorEcl && /total from here/i.test(luxorEcl.title) && luxorEcl.visible === 'yes' && (luxorEcl.altDeg ?? 0) > 50, luxorEcl?.title)
  const lon2027 = eclipseEvents(london, Date.UTC(2027, 6, 1), Date.UTC(2027, 8, 1)).find((e) => /solar/.test(e.title))
  check('from London the same eclipse is partial (about 40%)', !!lon2027 && /partial from here/.test(lon2027.title) && /4\d% of the Sun/.test(lon2027.detail), lon2027?.detail.slice(0, 60))
}

// ---------- meteor showers ----------
{
  const showers = showerEvents(london, from, to)
  const gem = showers.find((e) => /Geminids/.test(e.title))!
  check('Geminids peak on 14 Dec 2026 (Sun longitude 262.2)', near(gem.peakMs, Date.UTC(2026, 11, 14, 5, 0), 12 * H), iso(gem.peakMs))
  const rate = Number(/roughly (\d+) an hour/.exec(gem.detail)?.[1])
  check('the Geminids from London give an expected rate well over 30 an hour', rate > 30 && rate <= 150, `rate ${rate}`)
  const per = showers.find((e) => /Perseids/.test(e.title))!
  check('Perseids peak on 12-13 Aug 2027', new Date(per.peakMs).getUTCMonth() === 7 && [12, 13].includes(new Date(per.peakMs).getUTCDate()))
  const qua = showerEvents(sydney, from, to).find((e) => /Quadrantids/.test(e.title))!
  check('the Quadrantid radiant never rises at Sydney: not visible', qua.visible === 'no', qua.detail.slice(0, 80))
  check('expected rate: none when the radiant is down or the sky is bright, less with the Moon', expectedRate(100, -5, 0, -20) === 0 && expectedRate(100, 60, 0, -5) === 0 && expectedRate(100, 60, 0.9, -20) < expectedRate(100, 60, 0, -20) && expectedRate(100, 90, 0, -20) === 70)
  check('every shower has a plausible radiant and rate', SHOWERS.every((s) => s.raH >= 0 && s.raH < 24 && Math.abs(s.decDeg) <= 90 && s.zhr >= 5))
}

// ---------- moon and planets together ----------
{
  const mp = moonPlanetEvents(london, from, from + 30 * D)
  check('the Moon passes Saturn within a few days of 27 Sep 2026 and Mars/Jupiter around 5-6 Oct', mp.some((e) => /Saturn/.test(e.title)) && mp.some((e) => /Mars/.test(e.title)) && mp.some((e) => /Jupiter/.test(e.title)), mp.map((e) => e.title).join('; '))
  check('each Moon-planet event has a separation under 6 degrees', mp.every((e) => Number(/passes ([\d.]+)°/.exec(e.detail)?.[1]) < 6.01))
}

// ---------- occultations ----------
{
  const obs = new Astronomy.Observer(london.latDeg, london.lonDeg, 0)
  let T = Date.UTC(2027, 2, 5, 22, 0)
  for (let h = 0; h < 200; h++) {
    const t = Date.UTC(2027, 2, 5, 12, 0) + h * H
    const eq = Astronomy.Equator(Astronomy.Body.Moon, new Date(t), obs, true, true)
    if (Astronomy.Horizon(new Date(t), obs, eq.ra, eq.dec, 'normal').altitude > 30) {
      T = t
      break
    }
  }
  const eq = Astronomy.Equator(Astronomy.Body.Moon, new Date(T), obs, false, true)
  const fake = [{ id: 'fake', name: 'Test star', star: { raH: eq.ra, decDeg: eq.dec + 0.05, mag: 0 } }]
  const o = findOccultations(london, fake, T - D, T + D)
  check('a star placed 0.05 degrees from the Moon\'s centre is found occulted, containing that moment', o.length === 1 && o[0].ingressMs < T && o[0].egressMs > T && o[0].minSepDeg < 0.06, o.map((x) => `${iso(x.ingressMs)}..${iso(x.egressMs)} min ${x.minSepDeg.toFixed(3)}`).join())
  check('and the duration is an hour or so (the Moon moves about half a degree an hour)', o.length === 1 && (o[0].egressMs - o[0].ingressMs) / MIN > 30 && (o[0].egressMs - o[0].ingressMs) / MIN < 90)
  const near2 = [{ id: 'fake2', name: 'Near miss', star: { raH: eq.ra, decDeg: eq.dec + 0.6, mag: 0 } }]
  check('a star 0.6 degrees away is a miss (the Moon\'s radius is 0.25)', findOccultations(london, near2, T - D, T + D).length === 0)
  const yearEvents = occultationEvents(london, from, to)
  check('a real year finds a few occultations at most, all with times in order', yearEvents.length <= 8 && yearEvents.every((e) => e.startMs < e.peakMs && e.peakMs < (e.endMs ?? 0)))
}

// ---------- comets and asteroids ----------
{
  // the Earth itself as a "comet": IAU elements for the Earth-Moon barycentre
  const earthAsComet = { q: 0.98329, e: 0.016711, i: 0.00005, om: -11.26, w: 114.2078, tp: 2461044.2, m1: 0, k1: 0, name: 'Earth' } as CometElements
  let worst = 0
  for (const day of [0, 30, 100, 200, 300]) {
    const ms = Date.UTC(2026, 0, 1) + day * D
    const p = conicPosition(earthAsComet, ms / D + 2440587.5)
    const e = Astronomy.HelioVector(Astronomy.Body.Earth, new Date(ms))
    const ecl = Astronomy.RotateVector(Astronomy.Rotation_EQJ_ECL(), e)
    worst = Math.max(worst, Math.hypot(p[0] - ecl.x, p[1] - ecl.y, p[2] - ecl.z))
  }
  check('the orbit propagator puts the Earth (as an elliptic orbit) within 0.01 AU of the true position all year', worst < 0.01, `worst ${worst.toFixed(5)} AU`)
  // vis-viva for each orbit type: v^2 = k^2 (2/r - 1/a), by a numerical derivative
  const K = 0.01720209895
  const speedCheck = (el: { q: number; e: number; i: number; om: number; w: number; tp: number }, dtDays: number): boolean => {
    const jd = el.tp + dtDays
    const h = 0.01
    const p0 = conicPosition(el, jd - h)
    const p1 = conicPosition(el, jd + h)
    const v = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) / (2 * h)
    const r = Math.hypot(...conicPosition(el, jd))
    const a = el.e === 1 ? Infinity : el.q / (1 - el.e)
    const expect = K * Math.sqrt(2 / r - (a === Infinity ? 0 : 1 / a))
    return near(v, expect, expect * 1e-4)
  }
  const ell = { q: 0.586, e: 0.967, i: 162, om: 59, w: 112, tp: 2450000 }
  const par = { q: 1.2, e: 1, i: 40, om: 100, w: 30, tp: 2450000 }
  const hyp = { q: 2.7, e: 1.0019, i: 173, om: 305, w: 96, tp: 2450000 }
  const hyp2 = { q: 0.3, e: 1.8, i: 10, om: 0, w: 0, tp: 2450000 }
  check('speed matches vis-viva for a comet like Halley (e = 0.967), before and after perihelion', speedCheck(ell, -200) && speedCheck(ell, 30) && speedCheck(ell, 3000))
  check('speed matches vis-viva for a parabola, a near-parabolic hyperbola (e = 1.0019) and a clear hyperbola', speedCheck(par, 60) && speedCheck(par, -400) && speedCheck(hyp, 100) && speedCheck(hyp, -800) && speedCheck(hyp2, 50) && speedCheck(hyp2, -50))
  check('at perihelion the distance is q for every orbit type', [ell, par, hyp, hyp2].every((el) => near(Math.hypot(...conicPosition(el, el.tp)), el.q, 1e-9)))
  const c: CometElements = { name: 'C/2000 X1', ...hyp, m1: 5, k1: 10 }
  const st = cometState(c, Date.UTC(2026, 9, 1))
  check('the brightness formula: m = M1 + 5 log10(delta) + K1 log10(r)', near(st.mag, 5 + 5 * Math.log10(st.delta) + 10 * Math.log10(st.r), 1e-9) && st.elongDeg >= 0 && st.elongDeg <= 180 && st.raH >= 0 && st.raH < 24)
  // a synthetic bright comet passing close in the year: it should be listed with the peak near perihelion
  const now = Date.UTC(2026, 9, 1)
  const close: CometElements = { name: 'C/2026 T1 (Test)', q: 0.9, e: 1, i: 30, om: 40, w: 60, tp: now / D + 2440587.5 + 100, m1: 4, k1: 10 }
  const ev = cometEvents(london, [close, { ...close, name: 'faint', m1: 18 }], now, now + 365 * D)
  check('a bright comet is listed once (the faint one is not) with a predicted magnitude in the text', ev.length === 1 && /Predicted magnitude [\d.-]+/.test(ev[0].detail) && /guide/.test(ev[0].detail), ev.map((e) => e.title).join())
  check('a comet\'s event says its brightness is only a guide', /flare or fade/.test(ev[0].detail))
  const ast = asteroidEvents(
    [
      { name: '(2026 AA)', t: now + 2 * D, ld: 0.5, v: 8, h: 22 },
      { name: '(2026 BB)', t: now + 3 * D, ld: 12, v: 12, h: 26 },
      { name: '(2026 CC)', t: now + 400 * D, ld: 3, v: 9, h: 20 }
    ],
    now,
    now + 365 * D
  )
  check('asteroids: only those in the window, closest first priority, and the size from H', ast.length === 2 && ast[0].priority < ast[1].priority && /about [\d.]+ (m|km) across/.test(ast[0].detail) && /about \d+ m across/.test(ast[1].detail), ast.map((a) => a.title).join(' | '))
}

// ---------- space events ----------
{
  const nowMs = Date.UTC(2026, 9, 1, 12)
  const kp = [3, 4.33, 5.33, 6.67, 5, 3.67, 2, 5].map((v, i) => ({ time: new Date(nowMs + (i + 1) * 3 * H).toISOString(), kp: v, kind: 'predicted' }))
  const ev = spaceEvents(london, { kp, cmes: null, enlilRows: null }, nowMs)
  check('the Kp forecast: consecutive blocks at Kp 5+ become one storm (G3 at Kp 6.67), the lone later one another', ev.length === 2 && /G2/.test(ev[0].title), ev.map((e) => e.title).join(' | '))
  check('London at Kp 6.67 sees the aurora on the horizon at least; Sydney at Kp 5 does not', auroraReach(london, 6.67) !== 'no' && auroraReach(sydney, 5) === 'no')
  const gl = geomagneticLatitude(london, nowMs)
  check('geomagnetic latitudes: London about 54, Tromso about 66-67, Sydney about -40 (dipole)', near(gl, 54, 2.5) && near(geomagneticLatitude({ latDeg: 69.65, lonDeg: 18.96 }, nowMs), 66.5, 2.5) && near(geomagneticLatitude(sydney, nowMs), -40, 3), `${gl.toFixed(1)}`)
  check('the aurora edge moves toward the equator with Kp', auroraEdge(9) < auroraEdge(5) && auroraEdge(5) < auroraEdge(0))
  const cme = { id: 'c', start: nowMs, t215: nowMs, lat: 0, lon: 0, half_angle: 40, speed: 950, type: null, source: null, note: null, earth_directed: true, arrival: nowMs + 30 * H, arrival_source: 'NASA', separation: 5 }
  const ce = spaceEvents(london, { kp: null, cmes: [cme, { ...cme, id: 'd', earth_directed: false }], enlilRows: null }, nowMs)
  check('a CME heading for Earth is one event with priority 1 (fast) and a reminder', ce.length === 1 && ce[0].priority === 1 && ce[0].remindable)
  const passes = passEvents('ISS', [
    { riseMs: nowMs, peakMs: nowMs + 5 * MIN, setMs: nowMs + 10 * MIN, peakAltDeg: 70, riseAzDeg: 300, peakAzDeg: 200, setAzDeg: 100, sunlitAtPeak: true, visible: true },
    { riseMs: nowMs + H, peakMs: nowMs + H + 5 * MIN, setMs: nowMs + H + 10 * MIN, peakAltDeg: 20, riseAzDeg: 300, peakAzDeg: 200, setAzDeg: 100, sunlitAtPeak: false, visible: false }
  ], nowMs, nowMs + D, 25544)
  check('only visible satellite passes become events', passes.length === 1 && passes[0].kind === 'iss' && passes[0].remindable)
}

// ---------- scoring ----------
{
  const t = Date.UTC(2026, 11, 14, 1, 0) // a December night
  const ev = (over: Partial<SkyEvent>): SkyEvent => ({ id: 'x', kind: 'meteor', title: 'Test shower', detail: '', startMs: t, peakMs: t, priority: 2, visible: 'yes', altDeg: 60, remindable: true, ...over })
  const hours = Array.from({ length: 48 }, (_, i) => t - 12 * H + i * H)
  const outlook = (c: number): Outlook => ({ t: hours, cloud: hours.map(() => c) })
  const clear = scoreEvent(ev({}), london, outlook(0))
  const cloudy = scoreEvent(ev({}), london, outlook(90))
  const none = scoreEvent(ev({}), london, null)
  check('clear beats cloudy, and the difference is large', clear.score! > cloudy.score! + 40, `${clear.score} vs ${cloudy.score}`)
  check('no forecast: flagged, and between the two', none.noForecast && none.score! < clear.score! && none.score! > cloudy.score!)
  check('rating bands', ratingOf(70) === 'good' && ratingOf(50) === 'fair' && ratingOf(20) === 'poor')
  check('an event that cannot be seen scores 0 with the reason', scoreEvent(ev({ visible: 'no' }), london, outlook(0)).score === 0 && /not visible/.test(scoreEvent(ev({ visible: 'no' }), london, outlook(0)).reasons[0]))
  check('a Moon phase or a season has no score', scoreEvent(ev({ kind: 'moon' }), london, null).score === null && scoreEvent(ev({ kind: 'season' }), london, null).rating === 'unknown')
  const day = Date.UTC(2026, 11, 14, 12, 0)
  check('a faint meteor shower in full daylight scores near zero', scoreEvent(ev({ startMs: day, peakMs: day }), london, outlook(0)).score! < 5)
  check('low altitude lowers the score', scoreEvent(ev({ altDeg: 8 }), london, outlook(0)).score! < clear.score! * 0.6)
  const ecl = scoreEvent(ev({ kind: 'eclipse', title: 'Total solar eclipse', peakMs: day, startMs: day, altDeg: 40 }), london, outlook(0))
  check('a solar eclipse wants daylight, not darkness', ecl.score! > 80, `${ecl.score}`)
  check('cloud lookup: nearest hour, null beyond the forecast, average over a window', cloudAt(outlook(30), t) === 30 && cloudAt(outlook(30), t + 100 * H) === null && cloudBetween(outlook(40), t, t + 6 * H) === 40 && cloudAt(null, t) === null)
  const night = nightSummary(london, solarNoon(london, Date.UTC(2026, 11, 20), 0), outlook(20), [])
  check('a December night in London: about 13 hours of astronomical darkness (Sun 18 degrees down)', night.darkHours != null && night.darkHours > 11 && night.darkHours < 15, `${night.darkHours?.toFixed(1)}`)
  const june = nightSummary(london, solarNoon(london, Date.UTC(2027, 5, 20), 0), null, [])
  check('a June night in London has no astronomical darkness and says so', (june.darkHours == null || june.darkHours <= 0) && /no fully dark/.test(june.reasons[0]), june.reasons.join(' | '))
}

// ---------- the calendar file ----------
{
  check('ics time format', icsTime(Date.UTC(2026, 9, 12, 10, 15, 30)) === '20261012T101530Z')
  check('ics escaping of commas, semicolons, backslashes and newlines', icsEscape('a,b;c\\d\ne') === 'a\\,b\\;c\\\\d\\ne')
  const long = 'DESCRIPTION:' + 'é'.repeat(100)
  const folded = icsFold(long)
  const lines = folded.split('\r\n')
  check('long lines are folded under 75 bytes with a leading space, never inside a character', lines.every((l) => new TextEncoder().encode(l).length <= 75) && lines.slice(1).every((l) => l.startsWith(' ')) && lines.map((l, i) => (i ? l.slice(1) : l)).join('') === long)
  const e: SkyEvent = { id: 'shower:GEM:2026', kind: 'meteor', title: 'Geminids peak', detail: 'Bright, multicoloured; best after midnight.', startMs: Date.UTC(2026, 11, 13), peakMs: Date.UTC(2026, 11, 14, 5), endMs: Date.UTC(2026, 11, 15), priority: 1, visible: 'yes', remindable: true }
  const ics = eventsToIcs([e], london, Date.UTC(2026, 8, 25))
  check('a valid calendar: begin/end, one event, UID, times, geo and CRLF line ends', ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.trimEnd().endsWith('END:VCALENDAR') && (ics.match(/BEGIN:VEVENT/g) ?? []).length === 1 && /UID:shower:GEM:2026@night-identifier/.test(ics) && /DTSTART:20261213T000000Z/.test(ics) && /GEO:51\.5074;-0\.1278/.test(ics) && !/[^\r]\n/.test(ics))
  check('an event with no end lasts an hour', /DTEND:20260925T010000Z/.test(eventsToIcs([{ ...e, startMs: Date.UTC(2026, 8, 25), endMs: undefined }], null, 0)))
}

console.log(failed === 0 ? '\nAll events checks passed.' : `\n${failed} events check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
