// Occultations: the Moon passing in front of a planet or a bright star, as seen from a place. Pure (astronomy-engine).
//
// The Moon is close enough that its position shifts by up to about a degree depending on where you stand, so an occultation
// that happens for one town is a near miss for the next. The search scans the Moon's path with its centre-of-Earth position
// every 2 hours, and only for the few stretches that come within about 2.6 degrees of a target it goes on to compute the
// position as seen from the place, minute by minute.

import * as Astronomy from 'astronomy-engine'
import type { Place } from './skyTonight'
import type { SkyEvent } from './eventTypes'
import { DAY, altAz, compass, planetName, timeText } from './eventsSky'

const DEG = Math.PI / 180
const HOUR = 3_600_000
const MIN = 60_000
const MOON_RADIUS_KM = 1737.4
const KM_PER_AU = 149_597_870.7

type V = [number, number, number]

export interface OccTarget {
  id: string
  name: string
  /** a fixed star: J2000 right ascension (hours) and declination (degrees) */
  star?: { raH: number; decDeg: number; mag: number }
  planet?: Astronomy.Body
}

/** The stars the Moon can cover (they lie within about 5 degrees of the ecliptic), by J2000 coordinates. */
export const OCCULT_STARS: OccTarget[] = [
  { id: 'aldebaran', name: 'Aldebaran', star: { raH: 4.5987, decDeg: 16.5093, mag: 0.9 } },
  { id: 'alcyone', name: 'the Pleiades (Alcyone)', star: { raH: 3.7914, decDeg: 24.1051, mag: 2.9 } },
  { id: 'regulus', name: 'Regulus', star: { raH: 10.1395, decDeg: 11.9672, mag: 1.4 } },
  { id: 'spica', name: 'Spica', star: { raH: 13.4199, decDeg: -11.1613, mag: 1.0 } },
  { id: 'antares', name: 'Antares', star: { raH: 16.4901, decDeg: -26.432, mag: 1.1 } }
]

export const OCCULT_PLANETS: OccTarget[] = [Astronomy.Body.Mercury, Astronomy.Body.Venus, Astronomy.Body.Mars, Astronomy.Body.Jupiter, Astronomy.Body.Saturn].map((b) => ({ id: String(b).toLowerCase(), name: planetName(b), planet: b }))

const unitOf = (raH: number, decDeg: number): V => {
  const a = raH * 15 * DEG
  const d = decDeg * DEG
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]
}
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const angleDeg = (a: V, b: V): number => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) / DEG

/** Topocentric J2000 direction of a body as seen from the observer. */
function topo(body: Astronomy.Body, ms: number, obs: Astronomy.Observer): V {
  const eq = Astronomy.Equator(body, new Date(ms), obs, false, true)
  return unitOf(eq.ra, eq.dec)
}

function geoUnit(v: { x: number; y: number; z: number }): V {
  const l = Math.hypot(v.x, v.y, v.z)
  return [v.x / l, v.y / l, v.z / l]
}

export interface Occultation {
  target: OccTarget
  /** ms: the target disappears, is deepest, reappears */
  ingressMs: number
  midMs: number
  egressMs: number
  /** the closest the centres come, degrees, against the Moon's radius */
  minSepDeg: number
  moonRadiusDeg: number
  moonAltAtIngress: number
  moonAltAtEgress: number
  sunAltAtIngress: number
  sunAltAtEgress: number
  waxing: boolean
}

/** All occultations of the given targets that the place can see (at least part of them, Moon above the horizon). */
export function findOccultations(place: Place, targets: OccTarget[], fromMs: number, toMs: number): Occultation[] {
  const obs = new Astronomy.Observer(place.latDeg, place.lonDeg, 0)
  const out: Occultation[] = []
  const STEP = 2 * HOUR
  // planets: a position every day, interpolated (they move a fraction of a degree a day)
  const planetDays = new Map<string, V[]>()
  const dayCount = Math.ceil((toMs - fromMs) / DAY) + 3
  for (const t of targets) {
    if (!t.planet) continue
    const arr: V[] = []
    for (let d = 0; d < dayCount; d++) arr.push(geoUnit(Astronomy.GeoVector(t.planet, new Date(fromMs + d * DAY), false)))
    planetDays.set(t.id, arr)
  }
  const targetUnit = (t: OccTarget, ms: number): V => {
    if (t.star) return unitOf(t.star.raH, t.star.decDeg)
    const arr = planetDays.get(t.id)!
    const x = (ms - fromMs) / DAY
    const i = Math.max(0, Math.min(arr.length - 2, Math.floor(x)))
    const f = x - i
    const a = arr[i]
    const b = arr[i + 1]
    const v: V = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
    const l = Math.hypot(...v)
    return [v[0] / l, v[1] / l, v[2] / l]
  }
  const near = new Map<string, number>() // target id -> last coarse time it was within range (to make windows)
  const windows: { t: OccTarget; from: number; to: number }[] = []
  const open = new Map<string, { t: OccTarget; from: number; to: number }>()
  for (let ms = fromMs - STEP; ms <= toMs + STEP; ms += STEP) {
    const moon = geoUnit(Astronomy.GeoMoon(new Date(ms)))
    for (const t of targets) {
      const sep = angleDeg(moon, targetUnit(t, ms))
      const w = open.get(t.id)
      if (sep < 2.6) {
        if (w) w.to = ms
        else open.set(t.id, { t, from: ms, to: ms })
        near.set(t.id, ms)
      } else if (w) {
        windows.push(w)
        open.delete(t.id)
      }
    }
  }
  for (const w of open.values()) windows.push(w)

  for (const w of windows) {
    const t0 = w.from - STEP
    const t1 = w.to + STEP
    let best = { ms: 0, sep: 99 }
    const samples: { ms: number; sep: number }[] = []
    for (let ms = t0; ms <= t1; ms += MIN) {
      const moon = topo(Astronomy.Body.Moon, ms, obs)
      const tar = w.t.star ? unitOf(w.t.star.raH, w.t.star.decDeg) : topo(w.t.planet!, ms, obs)
      const sep = angleDeg(moon, tar)
      samples.push({ ms, sep })
      if (sep < best.sep) best = { ms, sep }
    }
    const dist = Astronomy.GeoMoon(new Date(best.ms))
    const radius = Math.asin(MOON_RADIUS_KM / (Math.hypot(dist.x, dist.y, dist.z) * KM_PER_AU)) / DEG
    if (best.sep >= radius) continue
    // the times the target crosses the limb, interpolated between minutes
    let ingress = best.ms
    let egress = best.ms
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]
      const b = samples[i]
      if (a.sep >= radius && b.sep < radius && a.ms < best.ms) ingress = a.ms + ((a.sep - radius) / (a.sep - b.sep)) * MIN
      if (a.sep < radius && b.sep >= radius && b.ms > best.ms) {
        egress = a.ms + ((radius - a.sep) / (b.sep - a.sep)) * MIN
        break
      }
    }
    if (ingress < fromMs || ingress > toMs) continue
    const mIn = altAz(Astronomy.Body.Moon, ingress, obs).alt
    const mOut = altAz(Astronomy.Body.Moon, egress, obs).alt
    if (mIn < 0 && mOut < 0) continue
    out.push({
      target: w.t,
      ingressMs: ingress,
      midMs: best.ms,
      egressMs: egress,
      minSepDeg: best.sep,
      moonRadiusDeg: radius,
      moonAltAtIngress: mIn,
      moonAltAtEgress: mOut,
      sunAltAtIngress: altAz(Astronomy.Body.Sun, ingress, obs).alt,
      sunAltAtEgress: altAz(Astronomy.Body.Sun, egress, obs).alt,
      waxing: Astronomy.MoonPhase(new Date(best.ms)) < 180
    })
  }
  return out.sort((a, b) => a.ingressMs - b.ingressMs)
}

/** Occultation events for the calendar. */
export function occultationEvents(place: Place, fromMs: number, toMs: number): SkyEvent[] {
  const obs = new Astronomy.Observer(place.latDeg, place.lonDeg, 0)
  return findOccultations(place, [...OCCULT_STARS, ...OCCULT_PLANETS], fromMs, toMs).map((o) => {
    const brightTarget = o.target.planet === Astronomy.Body.Venus || o.target.planet === Astronomy.Body.Jupiter || (o.target.star?.mag ?? 9) < 1.6
    // a star or faint planet needs a dark-ish sky; Venus and Jupiter can be seen against a twilight or even a daytime sky
    const skyOk = (sun: number): boolean => sun < (brightTarget ? -1 : -8) || (brightTarget && (o.target.planet === Astronomy.Body.Venus || o.target.planet === Astronomy.Body.Jupiter))
    const inSeen = o.moonAltAtIngress > 3 && skyOk(o.sunAltAtIngress)
    const outSeen = o.moonAltAtEgress > 3 && skyOk(o.sunAltAtEgress)
    const both = inSeen && outSeen
    const az = altAz(Astronomy.Body.Moon, o.midMs, obs)
    // the Moon moves eastward against the stars: it covers a star with its EAST limb and uncovers it at the WEST limb.
    // For a waxing Moon the lit side is the west one, so the disappearance is at the dark edge (easy to watch) and the reappearance at the bright one.
    const inLimb = o.waxing ? 'dark' : 'bright'
    const outLimb = o.waxing ? 'bright' : 'dark'
    const mins = Math.round((o.egressMs - o.ingressMs) / MIN)
    return {
      id: `occult:${o.target.id}:${Math.round(o.midMs / 3_600_000)}`,
      kind: 'occultation' as const,
      title: `Moon occults ${o.target.name}`,
      detail: `The Moon passes in front of ${o.target.name}: it disappears at ${timeText(o.ingressMs)} (${outSeen || inSeen ? `Moon ${Math.round(o.moonAltAtIngress)}° up` : 'Moon below the horizon'}, at the ${inLimb} edge) and reappears at ${timeText(o.egressMs)} (${Math.round(o.moonAltAtEgress)}°, at the ${outLimb} edge), ${mins} minutes later. ${
        both ? 'Both events are above your horizon.' : inSeen ? 'Only the disappearance is above your horizon.' : outSeen ? 'Only the reappearance is above your horizon.' : 'The sky is too bright or the Moon too low for either.'
      } A telescope or binoculars help; the exact times shift by a minute or two within a few tens of kilometres.`,
      startMs: o.ingressMs - 20 * MIN,
      peakMs: o.midMs,
      endMs: o.egressMs + 20 * MIN,
      priority: (o.target.planet ? 2 : 3) as 1 | 2 | 3,
      visible: both ? ('yes' as const) : inSeen || outSeen ? ('partly' as const) : ('no' as const),
      altDeg: az.alt,
      azDeg: az.az,
      bestMs: o.ingressMs,
      deepSpace: { focus: 'moon', whenMs: o.midMs },
      remindable: both || inSeen
    } satisfies SkyEvent
  })
}

export { compass }
