// How good will an event be to watch from a place? A 0-100 score from the darkness, the Moon, the cloud forecast and how high the
// thing is. And a summary of each night. Pure (astronomy-engine): scripts/events.check.ts.

import * as Astronomy from 'astronomy-engine'
import type { Place } from './skyTonight'
import { nightInfo, phaseName } from './skyTonight'
import { KIND_BY_ID, type EventScore, type Rating, type SkyEvent } from './eventTypes'
import { altAz, moonlight, DAY } from './eventsSky'

const HOUR = 3_600_000

/** Hourly cloud cover (%), UTC hours, from the backend. */
export interface Outlook {
  t: number[]
  cloud: (number | null)[]
}

/** The cloud cover at a time (nearest hour), or null when the forecast does not reach it. */
export function cloudAt(o: Outlook | null, ms: number): number | null {
  if (!o || o.t.length === 0) return null
  if (ms < o.t[0] - HOUR || ms > o.t[o.t.length - 1] + HOUR) return null
  let lo = 0
  let hi = o.t.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (o.t[mid] <= ms) lo = mid
    else hi = mid
  }
  const i = Math.abs(o.t[lo] - ms) <= Math.abs(o.t[hi] - ms) ? lo : hi
  return o.cloud[i]
}

/** The average cloud over [from, to], or null with no data there. */
export function cloudBetween(o: Outlook | null, from: number, to: number): number | null {
  if (!o) return null
  const vals: number[] = []
  for (let t = from; t <= to; t += HOUR) {
    const c = cloudAt(o, t)
    if (c != null) vals.push(c)
  }
  return vals.length >= Math.max(1, Math.floor((to - from) / HOUR / 3)) ? vals.reduce((s, x) => s + x, 0) / vals.length : null
}

export const ratingOf = (score: number): Rating => (score >= 65 ? 'good' : score >= 35 ? 'fair' : 'poor')

/** How dark the sky needs to be for a kind of event. */
type Need = 'dark' | 'twilight' | 'day' | 'none'

function needOf(e: SkyEvent): Need {
  switch (e.kind) {
    case 'meteor':
    case 'comet':
    case 'space':
      return 'dark'
    case 'planet':
    case 'occultation':
    case 'iss':
      return 'twilight'
    case 'eclipse':
      return /solar/i.test(e.title) ? 'day' : 'twilight'
    default:
      return 'none'
  }
}

function darkness(need: Need, sunAlt: number): { f: number; note: string } {
  if (need === 'day') return sunAlt > 0 ? { f: 1, note: 'Sun up' } : { f: 0.05, note: 'Sun below the horizon' }
  if (need === 'dark') {
    if (sunAlt < -18) return { f: 1, note: 'sky fully dark' }
    if (sunAlt < -12) return { f: 0.8, note: 'sky nearly dark (nautical twilight)' }
    if (sunAlt < -6) return { f: 0.4, note: 'still twilight' }
    if (sunAlt < 0) return { f: 0.1, note: 'twilight, too bright' }
    return { f: 0, note: 'daylight' }
  }
  // twilight: a bright object shows from civil twilight on
  if (sunAlt < -6) return { f: 1, note: 'dark enough' }
  if (sunAlt < -3) return { f: 0.85, note: 'in twilight' }
  if (sunAlt < 0) return { f: 0.6, note: 'in bright twilight' }
  return { f: 0.35, note: 'in daylight' }
}

/** Score one event for a place, at its best moment, using the cloud forecast if it reaches that far. */
export function scoreEvent(e: SkyEvent, place: Place, outlook: Outlook | null): EventScore {
  if (e.kind === 'moon' || e.kind === 'season' || e.kind === 'asteroid') return { score: null, rating: 'unknown', reasons: [], noForecast: false }
  const t = e.bestMs ?? e.peakMs
  const obs = new Astronomy.Observer(place.latDeg, place.lonDeg, 0)
  if (e.visible === 'no') return { score: 0, rating: 'poor', reasons: ['not visible from your location'], noForecast: false }
  const need = needOf(e)
  const sun = altAz(Astronomy.Body.Sun, t, obs).alt
  const dk = need === 'none' ? { f: 1, note: '' } : darkness(need, sun)
  const faint = KIND_BY_ID.get(e.kind)?.faint ?? false
  const ml = moonlight(t, obs)
  const moonF = faint ? 1 - 0.85 * ml.light : 1 - 0.15 * ml.light
  const cloud = cloudAt(outlook, t)
  const cloudF = cloud == null ? 0.75 : Math.pow(1 - cloud / 100, 1.5)
  const alt = e.altDeg
  const altF = alt == null ? 1 : alt < 5 ? 0.15 : alt < 15 ? 0.5 : alt < 30 ? 0.8 : 1
  const partlyF = e.visible === 'partly' ? 0.7 : 1
  const score = Math.round(100 * dk.f * moonF * cloudF * altF * partlyF)
  const reasons: string[] = []
  if (dk.note) reasons.push(dk.note)
  if (ml.alt > 0 && (faint || ml.light > 0.3)) reasons.push(`Moon ${Math.round(ml.illum * 100)}% lit and ${Math.round(ml.alt)}° up`)
  else if (faint && ml.alt <= 0) reasons.push('Moon below the horizon')
  if (alt != null) reasons.push(`${Math.round(alt)}° above the horizon`)
  reasons.push(cloud == null ? 'no cloud forecast this far ahead' : `cloud ${Math.round(cloud)}%`)
  if (e.visible === 'partly') reasons.push('only partly visible from here')
  return { score, rating: ratingOf(score), reasons, noForecast: cloud == null }
}

export function scoreAll(events: SkyEvent[], place: Place, outlook: Outlook | null): SkyEvent[] {
  return events.map((e) => ({ ...e, score: scoreEvent(e, place, outlook) }))
}

// ---------- nights ----------

export interface NightSummary {
  /** the evening's date (local solar day) as a ms timestamp of that day's noon at the place */
  noonMs: number
  sunsetMs: number | null
  sunriseMs: number | null
  darkStartMs: number | null
  darkEndMs: number | null
  darkHours: number | null
  moonlessHours: number | null
  moonIllumPct: number
  moonPhase: string
  moonRiseMs: number | null
  moonSetMs: number | null
  cloudAvg: number | null
  score: number
  rating: Rating
  reasons: string[]
  events: SkyEvent[]
}

/** Local solar noon (UTC ms) of the `n`-th day counted from the day containing `fromMs`. */
export function solarNoon(place: Place, fromMs: number, n: number): number {
  const shift = (place.lonDeg / 15) * HOUR
  const day = Math.floor((fromMs + shift) / DAY) + n
  return day * DAY + 12 * HOUR - shift
}

export function nightSummary(place: Place, noonMs: number, outlook: Outlook | null, events: SkyEvent[]): NightSummary {
  const info = nightInfo(place, new Date(noonMs))
  const sunset = info.sunset?.getTime() ?? null
  const sunrise = info.sunrise?.getTime() ?? null
  const darkStart = info.darkStart?.getTime() ?? null
  const darkEnd = info.darkEnd?.getTime() ?? null
  const from = darkStart ?? (sunset != null ? sunset + HOUR : noonMs + 9 * HOUR)
  const to = darkEnd ?? (sunrise != null ? sunrise - HOUR : noonMs + 17 * HOUR)
  const cloud = cloudBetween(outlook, from, Math.max(from + HOUR, to))
  const night0 = sunset ?? noonMs + 6 * HOUR
  const night1 = sunrise ?? night0 + 12 * HOUR
  const inNight = events.filter((e) => (e.visible !== 'no' && e.kind !== 'moon' && e.kind !== 'season' && e.kind !== 'asteroid') && (e.bestMs ?? e.peakMs) >= night0 - 2 * HOUR && (e.bestMs ?? e.peakMs) <= night1)
  const dark = info.darkHours
  const moonless = info.moonlessHours
  // quality: darkness available, how much of it is moonless, and the cloud
  const darkF = dark == null ? 0.35 : dark <= 0 ? 0.2 : Math.min(1, 0.4 + dark / 8)
  const moonlessFrac = dark && dark > 0 && moonless != null ? Math.min(1, moonless / dark) : 0
  const illum = info.moon.illuminatedPct / 100
  const moonF = moonlessFrac + (1 - moonlessFrac) * (1 - 0.85 * illum)
  const cloudF = cloud == null ? 0.75 : Math.pow(1 - cloud / 100, 1.5)
  const score = Math.round(100 * darkF * moonF * cloudF)
  const reasons: string[] = []
  if (dark == null || dark <= 0) reasons.push('no fully dark sky at this time of year')
  else reasons.push(`${dark.toFixed(1)} hours of full darkness`)
  if (moonless != null && dark) reasons.push(moonless >= dark - 0.2 ? 'the Moon is down for all of it' : moonless < 0.5 ? `the Moon is up (${Math.round(info.moon.illuminatedPct)}% lit)` : `${moonless.toFixed(1)} of them Moon-free`)
  reasons.push(cloud == null ? 'no cloud forecast yet' : `cloud ${Math.round(cloud)}%`)
  return {
    noonMs,
    sunsetMs: sunset,
    sunriseMs: sunrise,
    darkStartMs: darkStart,
    darkEndMs: darkEnd,
    darkHours: dark,
    moonlessHours: moonless,
    moonIllumPct: info.moon.illuminatedPct,
    moonPhase: phaseName(Astronomy.MoonPhase(new Date(night0 + 3 * HOUR))),
    moonRiseMs: info.moon.rise?.getTime() ?? null,
    moonSetMs: info.moon.set?.getTime() ?? null,
    cloudAvg: cloud,
    score,
    rating: ratingOf(score),
    reasons,
    events: inNight.sort((a, b) => (a.bestMs ?? a.peakMs) - (b.bestMs ?? b.peakMs))
  }
}

export function nightSummaries(place: Place, fromMs: number, nights: number, outlook: Outlook | null, events: SkyEvent[]): NightSummary[] {
  return Array.from({ length: nights }, (_, i) => nightSummary(place, solarNoon(place, fromMs, i), outlook, events))
}
