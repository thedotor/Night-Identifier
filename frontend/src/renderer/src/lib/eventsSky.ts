// Sky events computed for a place: Moon, planets, meteor showers, eclipses, seasons and darkness milestones.
// Pure functions over astronomy-engine (they run under node for scripts/events.check.ts). Times are ms since 1970 (UTC).

import * as Astronomy from 'astronomy-engine'
import type { Place } from './skyTonight'
import type { SkyEvent } from './eventTypes'

const DEG = Math.PI / 180
export const DAY = 86_400_000
const HOUR = 3_600_000

export const obsOf = (p: Place): Astronomy.Observer => new Astronomy.Observer(p.latDeg, p.lonDeg, 0)
const at = (ms: number): Date => new Date(ms)

export function altAz(body: Astronomy.Body, ms: number, obs: Astronomy.Observer): { alt: number; az: number } {
  const eq = Astronomy.Equator(body, at(ms), obs, true, true)
  const h = Astronomy.Horizon(at(ms), obs, eq.ra, eq.dec, 'normal')
  return { alt: h.altitude, az: h.azimuth }
}

export const sunAlt = (ms: number, obs: Astronomy.Observer): number => altAz(Astronomy.Body.Sun, ms, obs).alt

export const compass = (az: number): string => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round((((az % 360) + 360) % 360) / 22.5) % 16]

/** "Fri 12 Aug, 21:30" style time in the given zone offset (minutes); events are shown in the computer's own time zone by the UI, this is for text inside details. */
export const clockText = (ms: number): string => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
export const timeText = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const PLANET_NAMES: Partial<Record<Astronomy.Body, string>> = {
  [Astronomy.Body.Mercury]: 'Mercury',
  [Astronomy.Body.Venus]: 'Venus',
  [Astronomy.Body.Mars]: 'Mars',
  [Astronomy.Body.Jupiter]: 'Jupiter',
  [Astronomy.Body.Saturn]: 'Saturn',
  [Astronomy.Body.Uranus]: 'Uranus',
  [Astronomy.Body.Neptune]: 'Neptune'
}
export const planetName = (b: Astronomy.Body): string => PLANET_NAMES[b] ?? String(b)
const focusOf = (b: Astronomy.Body): string => String(b).toLowerCase()

/** The best moment within +-12 h of `ms` to look at a body: when the Sun is at least 6 degrees down (or the lowest it gets) and the body is highest. */
export function bestLookTime(body: Astronomy.Body, ms: number, obs: Astronomy.Observer, needDark = true): { ms: number; alt: number; az: number } {
  let best = { ms, alt: -90, az: 0, sun: 90 }
  for (let t = ms - 12 * HOUR; t <= ms + 12 * HOUR; t += 30 * 60_000) {
    const s = sunAlt(t, obs)
    if (needDark && s > -6) continue
    const p = altAz(body, t, obs)
    if (p.alt > best.alt) best = { ms: t, alt: p.alt, az: p.az, sun: s }
  }
  if (best.alt === -90) {
    // never dark within that day: the body's highest point in daylight, so there is still an answer
    const p = altAz(body, ms, obs)
    return { ms, alt: p.alt, az: p.az }
  }
  return { ms: best.ms, alt: best.alt, az: best.az }
}

// ---------- the Moon ----------

const QUARTER_TITLES = ['New Moon', 'First quarter Moon', 'Full Moon', 'Last quarter Moon']

/** Moon phases, and supermoons (a full or new Moon within a day of perigee, closer than 361,000 km). */
export function moonEvents(place: Place, fromMs: number, toMs: number): SkyEvent[] {
  const obs = obsOf(place)
  const out: SkyEvent[] = []
  // perigees for the supermoon test
  const perigees: { ms: number; km: number }[] = []
  let ap = Astronomy.SearchLunarApsis(at(fromMs - 2 * DAY))
  for (let i = 0; i < 40 && ap.time.date.getTime() < toMs + 2 * DAY; i++) {
    if (ap.kind === 0) perigees.push({ ms: ap.time.date.getTime(), km: ap.dist_km })
    ap = Astronomy.NextLunarApsis(ap)
  }
  let mq = Astronomy.SearchMoonQuarter(at(fromMs))
  for (let i = 0; i < 60; i++) {
    const t = mq.time.date.getTime()
    if (t > toMs) break
    const q = mq.quarter
    const rise = Astronomy.SearchRiseSet(Astronomy.Body.Moon, obs, +1, at(t - 12 * HOUR), 1)
    const set = Astronomy.SearchRiseSet(Astronomy.Body.Moon, obs, -1, at(t - 12 * HOUR), 1)
    const p = altAz(Astronomy.Body.Moon, t, obs)
    let title = QUARTER_TITLES[q]
    let detail =
      q === 0
        ? 'The Moon is between the Earth and the Sun: the darkest nights of the month are the few around it, the best for faint things.'
        : q === 2
          ? 'The whole face is lit: the Moon rises around sunset and lights the sky all night, washing out faint stars and meteors.'
          : q === 1
            ? 'Half lit: it sets around midnight, so the second half of the night is dark.'
            : 'Half lit: it rises around midnight, so the evening sky is dark and the morning has moonlight.'
    let priority: 1 | 2 | 3 = 3
    const near = perigees.find((g) => Math.abs(g.ms - t) < DAY && g.km < 361_000)
    if (near && (q === 0 || q === 2)) {
      title = q === 2 ? 'Supermoon (Full Moon at perigee)' : 'New Moon at perigee'
      detail = `${detail} It is also at its closest to the Earth (${Math.round(near.km).toLocaleString()} km), so it looks a little bigger and pulls a little harder on the tides.`
      priority = 2
    }
    if (rise || set) detail += ` At your location the Moon ${rise ? `rises at ${timeText(rise.date.getTime())}` : ''}${rise && set ? ' and ' : ''}${set ? `sets at ${timeText(set.date.getTime())}` : ''} around then.`
    out.push({
      id: `moon:${q}:${Math.round(t / 60_000)}`,
      kind: 'moon',
      title,
      detail,
      startMs: t,
      peakMs: t,
      priority,
      visible: 'yes',
      altDeg: p.alt,
      azDeg: p.az,
      deepSpace: { focus: 'moon', whenMs: t },
      remindable: priority === 2 && q === 2 // only supermoons
    })
    mq = Astronomy.NextMoonQuarter(mq)
  }
  return out
}

// ---------- planets ----------

const wrap180 = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180

/** Root-find the times when body1's ecliptic longitude passes body2's (a conjunction in longitude), scanning every `stepH` hours. body1 must move faster than body2 (so the difference rises). */
function conjunctionsInLongitude(b1: Astronomy.Body, b2: Astronomy.Body, fromMs: number, toMs: number, stepH: number): number[] {
  const out: number[] = []
  const f = (t: Astronomy.AstroTime): number => wrap180(Astronomy.PairLongitude(b1, b2, t))
  let prev = f(Astronomy.MakeTime(at(fromMs)))
  for (let t = fromMs + stepH * HOUR; t <= toMs; t += stepH * HOUR) {
    const cur = f(Astronomy.MakeTime(at(t)))
    if (prev < 0 && cur >= 0 && cur - prev < 90) {
      const root = Astronomy.Search(f, Astronomy.MakeTime(at(t - stepH * HOUR)), Astronomy.MakeTime(at(t)), { dt_tolerance_seconds: 30 })
      if (root) out.push(root.date.getTime())
    }
    prev = cur
  }
  return out
}

/** Topocentric angular separation between two bodies, degrees. */
export function separationDeg(b1: Astronomy.Body, b2: Astronomy.Body, ms: number, obs: Astronomy.Observer): number {
  const a = Astronomy.Equator(b1, at(ms), obs, false, true)
  const b = Astronomy.Equator(b2, at(ms), obs, false, true)
  const v1 = Astronomy.VectorFromSphere(new Astronomy.Spherical(a.dec, a.ra * 15, 1), at(ms))
  const v2 = Astronomy.VectorFromSphere(new Astronomy.Spherical(b.dec, b.ra * 15, 1), at(ms))
  return Astronomy.AngleBetween(v1, v2)
}

const CONJ_PLANETS = [Astronomy.Body.Mercury, Astronomy.Body.Venus, Astronomy.Body.Mars, Astronomy.Body.Jupiter, Astronomy.Body.Saturn]

export function magnitudeOf(body: Astronomy.Body, ms: number): number {
  return Astronomy.Illumination(body, at(ms)).mag
}

const constellationAt = (body: Astronomy.Body, ms: number): string => {
  const eq = Astronomy.Equator(body, at(ms), new Astronomy.Observer(0, 0, 0), false, true)
  return Astronomy.Constellation(eq.ra, eq.dec).name
}

/** The Moon passing close to a planet (within 6 degrees), as seen from the place. */
export function moonPlanetEvents(place: Place, fromMs: number, toMs: number): SkyEvent[] {
  const obs = obsOf(place)
  const out: SkyEvent[] = []
  for (const p of CONJ_PLANETS) {
    for (const t0 of conjunctionsInLongitude(Astronomy.Body.Moon, p, fromMs, toMs, 4)) {
      // the closest approach for this observer is within a couple of hours of the longitude conjunction
      let best = { ms: t0, sep: 99 }
      for (let t = t0 - 3 * HOUR; t <= t0 + 3 * HOUR; t += 10 * 60_000) {
        const s = separationDeg(Astronomy.Body.Moon, p, t, obs)
        if (s < best.sep) best = { ms: t, sep: s }
      }
      if (best.sep > 6) continue
      const look = bestLookTime(p, best.ms, obs, true)
      const moonUp = altAz(Astronomy.Body.Moon, best.ms, obs).alt
      const elong = Astronomy.AngleFromSun(p, at(best.ms))
      const name = planetName(p)
      const canSee = look.alt > 8 && elong > 12
      out.push({
        id: `moonplanet:${p}:${Math.round(t0 / 3_600_000)}`,
        kind: 'planet',
        title: `Moon near ${name}`,
        detail: `The Moon passes ${best.sep.toFixed(1)}° from ${name} (magnitude ${magnitudeOf(p, best.ms).toFixed(1)}, in ${constellationAt(p, best.ms)}). ${
          canSee ? `Look ${compass(look.az)} at about ${timeText(look.ms)}, when it is ${Math.round(look.alt)}° up.` : moonUp < 0 && look.alt < 8 ? 'From your location they are below the horizon in the dark hours.' : 'It is too close to the Sun or too low to see well from your location.'
        }`,
        startMs: best.ms - 2 * HOUR,
        peakMs: best.ms,
        endMs: best.ms + 2 * HOUR,
        priority: best.sep < 1 ? 2 : 3,
        visible: canSee ? 'yes' : 'no',
        altDeg: look.alt,
        azDeg: look.az,
        bestMs: look.ms,
        deepSpace: { focus: focusOf(p), whenMs: best.ms },
        remindable: best.sep < 3 && canSee
      })
    }
  }
  return out
}

/** Planet oppositions and greatest elongations, and each planet's conjunction with the Sun (when it is lost in the glare). */
export function planetEvents(place: Place, fromMs: number, toMs: number): SkyEvent[] {
  const obs = obsOf(place)
  const out: SkyEvent[] = []
  // oppositions: the planet is opposite the Sun, rises at sunset, up all night, closest and brightest
  for (const p of [Astronomy.Body.Mars, Astronomy.Body.Jupiter, Astronomy.Body.Saturn, Astronomy.Body.Uranus, Astronomy.Body.Neptune]) {
    let t = Astronomy.MakeTime(at(fromMs - 2 * DAY))
    for (let i = 0; i < 4; i++) {
      const opp = Astronomy.SearchRelativeLongitude(p, 0, t) // relative heliocentric longitude 0: Earth passes between the Sun and the planet
      const ms = opp.date.getTime()
      if (ms > toMs) break
      t = Astronomy.MakeTime(at(ms + 30 * DAY))
      if (ms < fromMs) continue
      const look = bestLookTime(p, ms, obs, true)
      const name = planetName(p)
      const mag = magnitudeOf(p, ms)
      const dist = Astronomy.GeoVector(p, at(ms), true).Length()
      const bright = p === Astronomy.Body.Mars || p === Astronomy.Body.Jupiter || p === Astronomy.Body.Saturn
      out.push({
        id: `opposition:${p}:${Math.round(ms / 3_600_000)}`,
        kind: 'planet',
        title: `${name} at opposition`,
        detail: `${name} is opposite the Sun: it rises at sunset, is up all night and is at its closest (${dist.toFixed(2)} AU) and brightest (magnitude ${mag.toFixed(1)}) of the year, in ${constellationAt(p, ms)}. ${look.alt > 5 ? `From your location it is highest (${Math.round(look.alt)}° ${compass(look.az)}) around ${timeText(look.ms)}.` : 'It stays low from your location.'}${bright ? '' : ' It needs binoculars or a telescope.'}`,
        startMs: ms - 12 * HOUR,
        peakMs: ms,
        endMs: ms + 12 * HOUR,
        priority: bright ? 2 : 3,
        visible: look.alt > 5 ? 'yes' : 'partly',
        altDeg: look.alt,
        azDeg: look.az,
        bestMs: look.ms,
        deepSpace: { focus: focusOf(p), whenMs: ms },
        remindable: bright
      })
    }
  }
  // greatest elongations of the inner planets: the best time to see them
  for (const p of [Astronomy.Body.Mercury, Astronomy.Body.Venus]) {
    let t = Astronomy.MakeTime(at(fromMs - DAY))
    for (let i = 0; i < 8; i++) {
      const el = Astronomy.SearchMaxElongation(p, t)
      const ms = el.time.date.getTime()
      if (ms > toMs) break
      t = Astronomy.MakeTime(at(ms + 20 * DAY))
      if (ms < fromMs) continue
      const evening = el.visibility === 'evening'
      const name = planetName(p)
      const look = bestLookTime(p, ms, obs, false)
      // the twilight sky an hour after sunset (or before sunrise) is when it is best; use the altitude at the horizon-lit moment
      const twi = bestLookTime(p, ms, obs, false)
      const sky = evening ? 'in the evening sky after sunset' : 'in the morning sky before sunrise'
      out.push({
        id: `elong:${p}:${Math.round(ms / 3_600_000)}`,
        kind: 'planet',
        title: `${name} at greatest ${evening ? 'eastern' : 'western'} elongation`,
        detail: `${name} is ${el.elongation.toFixed(0)}° from the Sun, as far as it gets: the best time to see it ${sky} (magnitude ${magnitudeOf(p, ms).toFixed(1)}). From your latitude the best view is ${twi.alt > 10 ? 'good' : 'low in the twilight'}.`,
        startMs: ms - 3 * DAY,
        peakMs: ms,
        endMs: ms + 3 * DAY,
        priority: p === Astronomy.Body.Venus ? 2 : 3,
        visible: look.alt > 5 ? 'yes' : 'partly',
        altDeg: look.alt,
        azDeg: look.az,
        bestMs: ms,
        deepSpace: { focus: focusOf(p), whenMs: ms },
        remindable: false
      })
    }
  }
  // the brightest Venus
  {
    const pk = Astronomy.SearchPeakMagnitude(Astronomy.Body.Venus, at(fromMs))
    const ms = pk.time.date.getTime()
    if (ms >= fromMs && ms <= toMs) {
      out.push({
        id: `venuspeak:${Math.round(ms / 3_600_000)}`,
        kind: 'planet',
        title: 'Venus at its brightest',
        detail: `Venus reaches magnitude ${pk.mag.toFixed(1)}, bright enough to see in daylight if you know where to look.`,
        startMs: ms - 5 * DAY,
        peakMs: ms,
        endMs: ms + 5 * DAY,
        priority: 2,
        visible: 'yes',
        deepSpace: { focus: 'venus', whenMs: ms },
        remindable: false
      })
    }
  }
  return out
}

/** Close pairings of planets (within 3 degrees), from the daily separations refined by the hour. */
export function planetPairEvents(place: Place, fromMs: number, toMs: number): SkyEvent[] {
  const obs = obsOf(place)
  const out: SkyEvent[] = []
  const days: number[] = []
  for (let t = fromMs - DAY; t <= toMs + DAY; t += DAY) days.push(t)
  const sepAt = (a: Astronomy.Body, b: Astronomy.Body, ms: number): number => Astronomy.AngleBetween(Astronomy.GeoVector(a, at(ms), true), Astronomy.GeoVector(b, at(ms), true))
  for (let i = 0; i < CONJ_PLANETS.length; i++) {
    for (let j = i + 1; j < CONJ_PLANETS.length; j++) {
      const a = CONJ_PLANETS[i]
      const b = CONJ_PLANETS[j]
      const s = days.map((d) => sepAt(a, b, d))
      for (let k = 1; k < s.length - 1; k++) {
        if (!(s[k] < s[k - 1] && s[k] <= s[k + 1] && s[k] < 3.5)) continue
        let best = { ms: days[k], sep: s[k] }
        for (let t = days[k] - DAY; t <= days[k] + DAY; t += HOUR) {
          const v = sepAt(a, b, t)
          if (v < best.sep) best = { ms: t, sep: v }
        }
        if (best.ms < fromMs || best.ms > toMs) continue
        const elong = Math.min(Astronomy.AngleFromSun(a, at(best.ms)), Astronomy.AngleFromSun(b, at(best.ms)))
        const look = bestLookTime(a, best.ms, obs, true)
        const canSee = elong > 14 && look.alt > 6
        const na = planetName(a)
        const nb = planetName(b)
        out.push({
          id: `pair:${a}:${b}:${Math.round(best.ms / 3_600_000)}`,
          kind: 'planet',
          title: `${na} and ${nb} close together`,
          detail: `${na} and ${nb} are ${best.sep.toFixed(1)}° apart in the sky (${constellationAt(a, best.ms)}), ${best.sep < 1 ? 'close enough to fit in one telescope field' : 'a fine pair for binoculars'}. ${canSee ? `Best ${compass(look.az)} around ${timeText(look.ms)}, ${Math.round(look.alt)}° up.` : 'They are too near the Sun, or too low, to see from your location.'}`,
          startMs: best.ms - 2 * DAY,
          peakMs: best.ms,
          endMs: best.ms + 2 * DAY,
          priority: best.sep < 1.5 ? 2 : 3,
          visible: canSee ? 'yes' : 'no',
          altDeg: look.alt,
          azDeg: look.az,
          bestMs: look.ms,
          deepSpace: { focus: focusOf(a), whenMs: best.ms },
          remindable: best.sep < 1.5 && canSee
        })
      }
    }
  }
  return out
}

// ---------- meteor showers ----------

export interface Shower {
  code: string
  name: string
  /** the Sun's ecliptic longitude at the peak, degrees (IMO) */
  lambda: number
  /** zenithal hourly rate at the peak, under perfect skies with the radiant overhead */
  zhr: number
  raH: number
  decDeg: number
  /** speed, km/s, and the usual first and last dates as "MM-DD" */
  speed: number
  active: [string, string]
  note: string
}

/** The main annual showers (International Meteor Organization working list). Peak times follow the Sun's longitude, so they shift a little each year. */
export const SHOWERS: Shower[] = [
  { code: 'QUA', name: 'Quadrantids', lambda: 283.15, zhr: 110, raH: 15.33, decDeg: 49.5, speed: 41, active: ['12-28', '01-12'], note: 'A sharp peak that lasts only a few hours; best from northern latitudes.' },
  { code: 'LYR', name: 'Lyrids', lambda: 32.32, zhr: 18, raH: 18.07, decDeg: 34, speed: 49, active: ['04-14', '04-30'], note: 'Bright, fast meteors, some with persistent trains.' },
  { code: 'ETA', name: 'Eta Aquariids', lambda: 45.5, zhr: 50, raH: 22.5, decDeg: -1, speed: 66, active: ['04-19', '05-28'], note: 'Debris from Halley\'s comet; fast meteors, best before dawn and from the southern hemisphere and tropics.' },
  { code: 'SDA', name: 'Southern Delta Aquariids', lambda: 125, zhr: 25, raH: 22.6, decDeg: -16, speed: 41, active: ['07-12', '08-23'], note: 'Faint, steady meteors; best from the southern hemisphere and tropics.' },
  { code: 'PER', name: 'Perseids', lambda: 140, zhr: 100, raH: 3.2, decDeg: 58, speed: 59, active: ['07-17', '08-24'], note: 'The most popular shower: many bright meteors on warm summer nights.' },
  { code: 'GIA', name: 'Draconids', lambda: 195.4, zhr: 10, raH: 17.47, decDeg: 54, speed: 20, active: ['10-06', '10-10'], note: 'Slow meteors, best in the evening; usually weak but with rare outbursts.' },
  { code: 'ORI', name: 'Orionids', lambda: 208, zhr: 20, raH: 6.33, decDeg: 16, speed: 66, active: ['10-02', '11-07'], note: 'Fast meteors from Halley\'s comet debris; best after midnight.' },
  { code: 'STA', name: 'Southern Taurids', lambda: 223, zhr: 5, raH: 3.53, decDeg: 9, speed: 27, active: ['09-20', '11-20'], note: 'Slow, bright fireballs; few but spectacular.' },
  { code: 'NTA', name: 'Northern Taurids', lambda: 230, zhr: 5, raH: 3.87, decDeg: 22, speed: 29, active: ['10-20', '12-10'], note: 'Slow, bright fireballs; few but spectacular.' },
  { code: 'LEO', name: 'Leonids', lambda: 236.1, zhr: 15, raH: 10.13, decDeg: 22, speed: 71, active: ['11-06', '11-30'], note: 'The fastest meteors; every 33 years it can storm.' },
  { code: 'GEM', name: 'Geminids', lambda: 262.2, zhr: 150, raH: 7.47, decDeg: 33, speed: 35, active: ['12-04', '12-20'], note: 'The richest shower of the year: bright, multicoloured meteors, active all night.' },
  { code: 'URS', name: 'Ursids', lambda: 270.7, zhr: 10, raH: 14.6, decDeg: 75, speed: 33, active: ['12-17', '12-26'], note: 'A quiet shower for northern observers.' }
]

/** Moonlight on the sky at a time: the illuminated fraction times how high the Moon is (0 = none, 1 = full Moon overhead). */
export function moonlight(ms: number, obs: Astronomy.Observer): { light: number; alt: number; illum: number } {
  const alt = altAz(Astronomy.Body.Moon, ms, obs).alt
  const illum = Astronomy.Illumination(Astronomy.Body.Moon, at(ms)).phase_fraction
  const height = alt <= 0 ? 0 : Math.min(1, 0.35 + Math.sin(alt * DEG) * 0.65)
  return { light: illum * height, alt, illum }
}

/** Radiant altitude (degrees) at a time, for a shower. */
export function radiantAlt(s: Shower, ms: number, obs: Astronomy.Observer): { alt: number; az: number } {
  const h = Astronomy.Horizon(at(ms), obs, s.raH, s.decDeg, 'normal')
  return { alt: h.altitude, az: h.azimuth }
}

/** Meteors an hour you might see: ZHR x sin(radiant altitude) x a Moon factor (the limiting magnitude falls in moonlight). A rough guide. */
export function expectedRate(zhr: number, radiantAltDeg: number, moonLight: number, sunAltDeg: number): number {
  if (radiantAltDeg <= 0 || sunAltDeg > -6) return 0
  const dark = sunAltDeg < -12 ? 1 : 0.4
  return Math.round(zhr * Math.sin(radiantAltDeg * DEG) * (1 - 0.75 * moonLight) * dark * 0.7)
}

export function inActiveRange(active: [string, string], month: number, day: number): boolean {
  const [sm, sd] = active[0].split('-').map(Number)
  const [em, ed] = active[1].split('-').map(Number)
  const startKey = sm * 100 + sd
  const endKey = em * 100 + ed
  const key = month * 100 + day
  return startKey <= endKey ? key >= startKey && key <= endKey : key >= startKey || key <= endKey
}

/** Showers whose active date range covers `nowMs` (UTC calendar date), each with a rough current meteors-per-hour estimate for `place`. */
export function activeShowers(nowMs: number, place: Place): { shower: Shower; rateNow: number }[] {
  const obs = obsOf(place)
  const d = new Date(nowMs)
  const month = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  const out: { shower: Shower; rateNow: number }[] = []
  for (const s of SHOWERS) {
    if (!inActiveRange(s.active, month, day)) continue
    const r = radiantAlt(s, nowMs, obs)
    const m = moonlight(nowMs, obs)
    const rateNow = expectedRate(s.zhr, r.alt, m.light, sunAlt(nowMs, obs))
    out.push({ shower: s, rateNow })
  }
  return out
}

export function showerEvents(place: Place, fromMs: number, toMs: number): SkyEvent[] {
  const obs = obsOf(place)
  const out: SkyEvent[] = []
  const y0 = new Date(fromMs).getUTCFullYear()
  const y1 = new Date(toMs).getUTCFullYear()
  for (let y = y0; y <= y1; y++) {
    for (const s of SHOWERS) {
      const start = Astronomy.MakeTime(new Date(Date.UTC(y, 0, 1)))
      const peak = Astronomy.SearchSunLongitude(s.lambda, start, 366)
      if (!peak) continue
      const pk = peak.date.getTime()
      if (pk < fromMs - DAY || pk > toMs) continue
      // the best hour of the two nights around the peak: highest expected rate
      let best = { ms: pk, rate: -1, alt: -90, az: 0, moon: 0, illum: 0 }
      for (let t = pk - 18 * HOUR; t <= pk + 30 * HOUR; t += 30 * 60_000) {
        const sun = sunAlt(t, obs)
        if (sun > -6) continue
        const r = radiantAlt(s, t, obs)
        const m = moonlight(t, obs)
        const rate = expectedRate(s.zhr, r.alt, m.light, sun)
        if (rate > best.rate) best = { ms: t, rate, alt: r.alt, az: r.az, moon: m.light, illum: m.illum }
      }
      const noNight = best.rate < 0
      const moonText = noNight ? '' : best.illum < 0.15 ? 'The Moon is a thin crescent, so the sky is dark' : best.moon < 0.1 ? 'The Moon is down at the best time' : `The Moon is ${Math.round(best.illum * 100)}% lit and ${best.moon > 0.4 ? 'high, which spoils the fainter meteors' : 'low, a small nuisance'}`
      out.push({
        id: `shower:${s.code}:${y}`,
        kind: 'meteor',
        title: `${s.name} peak`,
        detail: `${s.note} Peak ${clockText(pk)}, up to ${s.zhr} an hour under perfect skies. ${
          noNight || best.rate <= 0
            ? 'From your location the radiant stays below the horizon or the sky is not dark around the peak, so few meteors will be seen.'
            : `Best from ${clockText(best.ms)}: the radiant is ${Math.round(best.alt)}° up in the ${compass(best.az)}, so expect roughly ${best.rate} an hour. ${moonText}.`
        }`,
        startMs: pk - DAY,
        peakMs: pk,
        endMs: pk + DAY,
        priority: s.zhr >= 100 ? 1 : s.zhr >= 18 ? 2 : 3,
        visible: best.rate >= 3 ? 'yes' : best.rate > 0 ? 'partly' : 'no',
        altDeg: best.alt,
        azDeg: best.az,
        bestMs: best.rate > 0 ? best.ms : pk,
        deepSpace: { focus: 'earth', whenMs: best.ms },
        remindable: best.rate >= 8
      })
    }
  }
  return out
}

// ---------- eclipses ----------

export function eclipseEvents(place: Place, fromMs: number, toMs: number): SkyEvent[] {
  const obs = obsOf(place)
  const out: SkyEvent[] = []

  // solar: everything in the range, marked by whether it can be seen from here
  let g = Astronomy.SearchGlobalSolarEclipse(at(fromMs))
  for (let i = 0; i < 8; i++) {
    const t = g.peak.date.getTime()
    if (t > toMs) break
    const local = Astronomy.SearchLocalSolarEclipse(at(t - 2 * DAY), obs)
    const sameEvent = Math.abs(local.peak.time.date.getTime() - t) < DAY
    const kindName = String(g.kind).toLowerCase()
    const title = `${kindName === 'total' ? 'Total' : kindName === 'annular' ? 'Annular' : kindName === 'hybrid' ? 'Hybrid' : 'Partial'} solar eclipse`
    if (sameEvent && (local.partial_begin.altitude > 0 || local.partial_end.altitude > 0 || local.peak.altitude > 0)) {
      const seenAt = local.peak.altitude > 0 ? 'yes' : 'partly'
      const kindHere = String(local.kind).toLowerCase()
      out.push({
        id: `solar:${Math.round(t / 3_600_000)}`,
        kind: 'eclipse',
        title: `${title} (${kindHere === 'partial' ? 'partial from here' : kindHere + ' from here'})`,
        detail: `From your location ${Math.round(local.obscuration * 100)}% of the Sun is covered at the peak, ${timeText(local.peak.time.date.getTime())}, with the Sun ${Math.round(local.peak.altitude)}° up (it starts ${timeText(local.partial_begin.time.date.getTime())}, ends ${timeText(local.partial_end.time.date.getTime())}). ${
          kindHere === 'total' ? 'Totality is a few minutes of darkness with the corona visible: the only time it is safe to look without a filter.' : 'Never look at the Sun without proper eclipse glasses or a solar filter.'
        }`,
        startMs: local.partial_begin.time.date.getTime(),
        peakMs: local.peak.time.date.getTime(),
        endMs: local.partial_end.time.date.getTime(),
        priority: kindHere === 'total' ? 1 : local.obscuration > 0.5 ? 2 : 3,
        visible: seenAt,
        altDeg: local.peak.altitude,
        bestMs: local.peak.time.date.getTime(),
        deepSpace: { focus: 'earth', whenMs: local.peak.time.date.getTime() },
        remindable: local.obscuration > 0.2 && local.peak.altitude > 0
      })
    } else {
      out.push({
        id: `solar:${Math.round(t / 3_600_000)}`,
        kind: 'eclipse',
        title: `${title} (not visible from here)`,
        detail: `${/^[aeiou]/.test(kindName) ? 'An' : 'A'} ${kindName} solar eclipse peaks at ${clockText(t)}, seen from ${Math.abs(g.latitude ?? 0).toFixed(0)}°${(g.latitude ?? 0) >= 0 ? 'N' : 'S'}, ${Math.abs(g.longitude ?? 0).toFixed(0)}°${(g.longitude ?? 0) >= 0 ? 'E' : 'W'}. The Sun is not eclipsed above your horizon.`,
        startMs: t - 2 * HOUR,
        peakMs: t,
        endMs: t + 2 * HOUR,
        priority: 3,
        visible: 'no',
        deepSpace: { focus: 'earth', whenMs: t },
        remindable: false
      })
    }
    g = Astronomy.NextGlobalSolarEclipse(g.peak)
  }

  // lunar: visible from anywhere the Moon is up
  let le = Astronomy.SearchLunarEclipse(at(fromMs))
  for (let i = 0; i < 8; i++) {
    const t = le.peak.date.getTime()
    if (t > toMs) break
    const kind = String(le.kind).toLowerCase()
    const partial = le.sd_partial * 60_000
    const total = le.sd_total * 60_000
    const penum = le.sd_penum * 60_000
    const startMs = t - (kind === 'penumbral' ? penum : partial)
    const endMs = t + (kind === 'penumbral' ? penum : partial)
    const altPeak = altAz(Astronomy.Body.Moon, t, obs)
    const altStart = altAz(Astronomy.Body.Moon, startMs, obs).alt
    const altEnd = altAz(Astronomy.Body.Moon, endMs, obs).alt
    const up = [altStart, altPeak.alt, altEnd].filter((a) => a > 0).length
    const title = `${kind === 'total' ? 'Total' : kind === 'partial' ? 'Partial' : 'Penumbral'} lunar eclipse`
    out.push({
      id: `lunar:${Math.round(t / 3_600_000)}`,
      kind: 'eclipse',
      title,
      detail: `${
        kind === 'total'
          ? `The Moon passes through the Earth's shadow and turns coppery red for about ${Math.round(total / 60_000 * 2)} minutes (${Math.round(le.obscuration * 100)}% of the shadow's core), with the partial phases for ${Math.round(partial / 60_000 * 2)} minutes.`
          : kind === 'partial'
            ? `Part of the Moon (about ${Math.round(le.obscuration * 100)}%) dips into the Earth's dark shadow for ${Math.round(partial / 60_000 * 2)} minutes.`
            : 'The Moon passes through the faint outer shadow: the dimming is very subtle and hard to notice.'
      } Peak ${timeText(t)}. ${up === 3 ? `The Moon is up for all of it from your location (${Math.round(altPeak.alt)}° ${compass(altPeak.az)} at the peak).` : up > 0 ? `The Moon is above your horizon for only part of it (${Math.round(altPeak.alt)}° at the peak).` : 'The Moon is below your horizon: not visible from here.'} Safe to watch with the naked eye.`,
      startMs,
      peakMs: t,
      endMs,
      priority: kind === 'total' ? 1 : kind === 'partial' ? 2 : 3,
      visible: up === 3 || altPeak.alt > 10 ? 'yes' : up > 0 ? 'partly' : 'no',
      altDeg: altPeak.alt,
      azDeg: altPeak.az,
      bestMs: t,
      deepSpace: { focus: 'moon', whenMs: t },
      remindable: kind !== 'penumbral' && altPeak.alt > 5
    })
    le = Astronomy.NextLunarEclipse(le.peak)
  }
  return out
}

/** The eclipse (solar or lunar) covering `nowMs` from `place`, if any, with its geometry for a 3D shadow overlay. Lighter-weight than `eclipseEvents()`: no calendar text, just the window and obscuration. */
export function currentEclipseWindow(place: Place, nowMs: number): { kind: 'solar' | 'lunar'; startMs: number; peakMs: number; endMs: number; magnitude: number } | null {
  const g = Astronomy.SearchGlobalSolarEclipse(at(nowMs - 2 * DAY))
  const gt = g.peak.date.getTime()
  if (gt < nowMs + 2 * DAY) {
    // the shadow is a global Earth phenomenon: use an observer AT the eclipse's own point of greatest eclipse, not the
    // user's saved place, or almost every eclipse would be missed just because it doesn't pass near their home.
    const peakObs = g.latitude != null && g.longitude != null ? new Astronomy.Observer(g.latitude, g.longitude, 0) : obsOf(place)
    const local = Astronomy.SearchLocalSolarEclipse(at(gt - 2 * DAY), peakObs)
    if (Math.abs(local.peak.time.date.getTime() - gt) < DAY) {
      const startMs = local.partial_begin.time.date.getTime()
      const endMs = local.partial_end.time.date.getTime()
      if (nowMs >= startMs && nowMs <= endMs) return { kind: 'solar', startMs, peakMs: local.peak.time.date.getTime(), endMs, magnitude: local.obscuration }
    }
  }
  const le = Astronomy.SearchLunarEclipse(at(nowMs - 2 * DAY))
  const lt = le.peak.date.getTime()
  const half = (String(le.kind).toLowerCase() === 'penumbral' ? le.sd_penum : le.sd_partial) * 60_000
  const startMs = lt - half
  const endMs = lt + half
  if (nowMs >= startMs && nowMs <= endMs) return { kind: 'lunar', startMs, peakMs: lt, endMs, magnitude: le.obscuration }
  return null
}

// ---------- seasons and milestones ----------

/** The Sun's lowest altitude on a given day at a latitude (at its lower culmination), degrees: darker than -18 means a proper astronomical night. */
export function lowestSunAltitude(latDeg: number, sunDecDeg: number): number {
  return Math.abs(latDeg) - 90 + (latDeg >= 0 ? sunDecDeg : -sunDecDeg)
}

export function seasonEvents(place: Place, fromMs: number, toMs: number): SkyEvent[] {
  const out: SkyEvent[] = []
  const north = place.latDeg >= 0
  const y0 = new Date(fromMs).getUTCFullYear() - 1
  const y1 = new Date(toMs).getUTCFullYear() + 1
  for (let y = y0; y <= y1; y++) {
    const s = Astronomy.Seasons(y)
    const rows: [Astronomy.AstroTime, string, string][] = [
      [s.mar_equinox, north ? 'Spring equinox' : 'Autumn equinox', 'Day and night are about equal everywhere; the Sun rises due east and sets due west.'],
      [s.jun_solstice, north ? 'Summer solstice' : 'Winter solstice', north ? 'The longest day in the north, when the Sun is highest at noon.' : 'The shortest day in the south, when the Sun is lowest at noon.'],
      [s.sep_equinox, north ? 'Autumn equinox' : 'Spring equinox', 'Day and night are about equal everywhere; the Sun rises due east and sets due west.'],
      [s.dec_solstice, north ? 'Winter solstice' : 'Summer solstice', north ? 'The shortest day in the north, when the Sun is lowest at noon.' : 'The longest day in the south, when the Sun is highest at noon.']
    ]
    for (const [t, title, detail] of rows) {
      const ms = t.date.getTime()
      if (ms < fromMs || ms > toMs) continue
      out.push({ id: `season:${title}:${y}`, kind: 'season', title, detail: `${detail} Exactly at ${clockText(ms)}.`, startMs: ms, peakMs: ms, priority: 2, visible: 'yes', remindable: false })
    }
  }
  // the Earth's closest and furthest points from the Sun
  for (let y = y0; y <= y1; y++) {
    for (const [kind, label, text] of [[0, 'Perihelion', 'The Earth is closest to the Sun (about 147 million km) - it is winter in the north.'], [1, 'Aphelion', 'The Earth is furthest from the Sun (about 152 million km) - it is summer in the north.']] as const) {
      const guess = Date.UTC(y, kind === 0 ? 0 : 6, 3)
      let best = { ms: guess, d: kind === 0 ? 9 : 0 }
      for (let t = guess - 20 * DAY; t <= guess + 20 * DAY; t += DAY) {
        const d = Astronomy.HelioDistance(Astronomy.Body.Earth, at(t))
        if (kind === 0 ? d < best.d : d > best.d) best = { ms: t, d }
      }
      if (best.ms < fromMs || best.ms > toMs) continue
      out.push({ id: `apsis:${label}:${y}`, kind: 'season', title: label, detail: `${text} (${best.d.toFixed(4)} AU on ${new Date(best.ms).toLocaleDateString([], { day: 'numeric', month: 'long' })}).`, startMs: best.ms, peakMs: best.ms, priority: 3, visible: 'yes', remindable: false })
    }
  }
  // sunset and sunrise extremes at this place, and the days astronomical darkness disappears and returns
  const obs = obsOf(place)
  const noonUtc = (dayMs: number): number => dayMs + 12 * HOUR - (place.lonDeg / 15) * HOUR
  const sunsets: { ms: number; min: number }[] = []
  const dark: { ms: number; ok: boolean; low: number }[] = []
  for (let d = Math.floor(fromMs / DAY) * DAY; d <= toMs; d += DAY) {
    const noon = noonUtc(d)
    const set = Astronomy.SearchRiseSet(Astronomy.Body.Sun, obs, -1, at(noon), 1)
    if (set) {
      const local = new Date(set.date.getTime() - (place.lonDeg / 15) * HOUR)
      sunsets.push({ ms: set.date.getTime(), min: local.getUTCHours() * 60 + local.getUTCMinutes() })
    }
    const dec = Astronomy.Equator(Astronomy.Body.Sun, at(noon), obs, true, false).dec
    const low = lowestSunAltitude(place.latDeg, dec)
    dark.push({ ms: noon, ok: low < -18, low })
  }
  const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
  if (Math.abs(place.latDeg) < 66 && sunsets.length > 30) {
    // find the extremes within each stretch of a year
    let mn = sunsets[0]
    let mx = sunsets[0]
    for (const s of sunsets) {
      if (s.min < mn.min) mn = s
      if (s.min > mx.min) mx = s
    }
    for (const [x, label] of [[mn, 'Earliest sunset'], [mx, 'Latest sunset']] as const) {
      if (x.ms > fromMs + 3 * DAY && x.ms < toMs - 3 * DAY) out.push({ id: `sunsetx:${label}:${new Date(x.ms).getUTCFullYear()}`, kind: 'season', title: `${label} of the year`, detail: `The Sun sets at ${hhmm(x.min)} (local solar clock) on ${new Date(x.ms).toLocaleDateString([], { day: 'numeric', month: 'long' })}. The earliest and latest sunsets are not on the solstice: they fall a couple of weeks either side.`, startMs: x.ms, peakMs: x.ms, priority: 3, visible: 'yes', remindable: false })
    }
  }
  for (let i = 1; i < dark.length; i++) {
    if (dark[i].ok === dark[i - 1].ok) continue
    const lost = !dark[i].ok
    out.push({
      id: `darkness:${lost ? 'lost' : 'back'}:${new Date(dark[i].ms).getUTCFullYear()}:${Math.round(dark[i].ms / DAY)}`,
      kind: 'season',
      title: lost ? 'Astronomical darkness ends for the summer' : 'Astronomical darkness returns',
      detail: lost
        ? 'From about now the Sun stays less than 18° below the horizon all night: the sky never gets fully dark, so faint objects and the Milky Way are harder to see until it returns.'
        : 'From about now the sky gets fully dark again for at least part of the night: the deep-sky and Milky Way season is back.',
      startMs: dark[i].ms,
      peakMs: dark[i].ms,
      priority: 3,
      visible: 'yes',
      remindable: false
    })
  }
  return out
}
