// Space-weather events for the calendar (forecast aurora storms, CME arrivals, fast wind), and visible satellite passes.
// Pure. Inputs are the plain data the backend already serves.

import type { Place } from './skyTonight'
import type { SkyEvent } from './eventTypes'
import { geomagneticPole, coefficientsAt, decimalYear } from './geomag'
import { findStreams } from './magnetosphere'
import { relativeTime, type Cme } from './sun'
import type { SatPass } from './satellites'
import { clockText, compass, timeText } from './eventsSky'

const DEG = Math.PI / 180
const HOUR = 3_600_000

/** A place's geomagnetic latitude, degrees, from the dipole part of the IGRF model. */
export function geomagneticLatitude(place: Place, ms = Date.now()): number {
  const pole = geomagneticPole(coefficientsAt(decimalYear(ms)))
  const s = Math.sin(place.latDeg * DEG) * Math.sin(pole.latDeg * DEG) + Math.cos(place.latDeg * DEG) * Math.cos(pole.latDeg * DEG) * Math.cos((place.lonDeg - pole.lonDeg) * DEG)
  return Math.asin(Math.max(-1, Math.min(1, s))) / DEG
}

/** How far toward the equator the aurora oval reaches in geomagnetic latitude for a Kp: about 67 degrees at Kp 0, 53 at Kp 5 (G1), 42 at Kp 9. A rough guide. */
export const auroraEdge = (kp: number): number => 67 - 2.8 * kp

/** Could the aurora be seen from this geomagnetic latitude at this Kp (low on the horizon at the edge, overhead well inside it)? */
export function auroraReach(place: Place, kp: number, ms = Date.now()): 'overhead' | 'horizon' | 'no' {
  const g = Math.abs(geomagneticLatitude(place, ms))
  const edge = auroraEdge(kp)
  if (g >= edge + 4) return 'overhead'
  if (g >= edge - 3) return 'horizon'
  return 'no'
}

export interface KpForecastRow {
  time: string
  kp: number
  kind: string
}

const parse = (t: string): number => Date.parse(t.endsWith('Z') ? t : `${t}Z`)

/** Events from the space-weather forecast: storms (Kp 5 or more, grouped), CMEs arriving, fast wind streams. */
export function spaceEvents(place: Place, input: { kp: KpForecastRow[] | null; cmes: Cme[] | null; enlilRows: number[][] | null }, nowMs: number): SkyEvent[] {
  const out: SkyEvent[] = []
  // Kp forecast: consecutive 3-hour blocks at or above Kp 5
  const rows = (input.kp ?? []).filter((r) => r.kind === 'predicted' && parse(r.time) + 3 * HOUR > nowMs).sort((a, b) => parse(a.time) - parse(b.time))
  let i = 0
  while (i < rows.length) {
    if (rows[i].kp >= 5) {
      let j = i
      let peak = i
      while (j + 1 < rows.length && rows[j + 1].kp >= 4.67 && parse(rows[j + 1].time) - parse(rows[j].time) <= 3 * HOUR + 1) {
        j++
        if (rows[j].kp > rows[peak].kp) peak = j
      }
      const start = parse(rows[i].time)
      const end = parse(rows[j].time) + 3 * HOUR
      const kp = rows[peak].kp
      const g = Math.min(5, Math.floor(kp + 1e-6) - 4)
      const reach = auroraReach(place, kp, start)
      out.push({
        id: `kp:${Math.round(start / HOUR)}`,
        kind: 'space',
        title: `Geomagnetic storm forecast (G${g}, Kp ${kp.toFixed(0)})`,
        detail: `NOAA forecasts Kp up to ${kp.toFixed(1)} between ${clockText(start)} and ${clockText(end)}. ${
          reach === 'overhead' ? 'From your latitude the aurora could be well up in the sky if it is dark and clear.' : reach === 'horizon' ? 'From your latitude the aurora could show low on the northern (or southern) horizon if it is dark and clear.' : 'From your latitude the aurora is unlikely to be visible, but it can still disturb radio and GPS.'
        } Forecasts this far ahead are uncertain: check again on the day.`,
        startMs: start,
        peakMs: parse(rows[peak].time) + 1.5 * HOUR,
        endMs: end,
        priority: g >= 3 ? 1 : 2,
        visible: reach === 'no' ? 'no' : reach === 'horizon' ? 'partly' : 'yes',
        deepSpace: { focus: 'earth', whenMs: parse(rows[peak].time) + 1.5 * HOUR },
        remindable: reach !== 'no'
      })
      i = j + 1
    } else i++
  }
  // CMEs heading for Earth
  for (const c of input.cmes ?? []) {
    if (!c.earth_directed || c.arrival == null || c.arrival <= nowMs) continue
    const reach = auroraReach(place, 6, c.arrival)
    out.push({
      id: `cme:${c.id}`,
      kind: 'space',
      title: `CME reaches Earth (${Math.round(c.speed)} km/s)`,
      detail: `A coronal mass ejection is expected ${relativeTime(c.arrival, nowMs)} (${clockText(c.arrival)}, ${c.arrival_source}; the estimate can be off by half a day). If its magnetic field points south it can cause a storm: ${reach === 'no' ? 'the aurora would still be too far north for your latitude unless it is strong' : 'watch for aurora that night after dark'}.`,
      startMs: c.arrival - 6 * HOUR,
      peakMs: c.arrival,
      endMs: c.arrival + 12 * HOUR,
      priority: c.speed > 900 ? 1 : 2,
      visible: reach === 'no' ? 'partly' : 'yes',
      deepSpace: { focus: 'sun', whenMs: c.t215 },
      remindable: true
    })
  }
  // fast wind streams in NOAA's Enlil forecast
  for (const s of input.enlilRows ? findStreams(input.enlilRows) : []) {
    if (s.startMs <= nowMs || s.startMs > nowMs + 7 * 24 * HOUR) continue
    out.push({
      id: `stream:${Math.round(s.startMs / HOUR)}`,
      kind: 'space',
      title: `High-speed solar wind (to ${Math.round(s.peakSpeed)} km/s)`,
      detail: `NOAA's WSA-Enlil model shows a fast stream reaching Earth around ${clockText(s.startMs)}, peaking at ${Math.round(s.peakSpeed)} km/s about ${relativeTime(s.peakMs, nowMs)}. Fast streams often bring a few nights of aurora at high latitudes. This is a model forecast.`,
      startMs: s.startMs,
      peakMs: s.peakMs,
      endMs: s.endMs,
      priority: 3,
      visible: 'partly',
      deepSpace: { focus: 'sun', whenMs: s.startMs },
      remindable: false
    })
  }
  return out
}

/** Visible satellite passes (sunlit against a dark sky) as events. `name` is what the object is called. */
export function passEvents(name: string, passes: SatPass[], fromMs: number, toMs: number, norad: number): SkyEvent[] {
  return passes
    .filter((p) => p.visible && p.peakMs >= fromMs && p.peakMs <= toMs)
    .map((p) => ({
      id: `pass:${norad}:${Math.round(p.peakMs / 60_000)}`,
      kind: 'iss' as const,
      title: `${name} pass, ${Math.round(p.peakAltDeg)}° high`,
      detail: `${name} rises in the ${compass(p.riseAzDeg)} at ${timeText(p.riseMs)}, is highest (${Math.round(p.peakAltDeg)}°, ${compass(p.peakAzDeg)}) at ${timeText(p.peakMs)} and sets in the ${compass(p.setAzDeg)} at ${timeText(p.setMs)}. It is sunlit while you are in the dark, so it shows as a bright, steady, fast-moving star. Passes shift by a few seconds a week: check the day before.`,
      startMs: p.riseMs,
      peakMs: p.peakMs,
      endMs: p.setMs,
      priority: (p.peakAltDeg >= 50 ? 2 : 3) as 2 | 3,
      visible: 'yes' as const,
      altDeg: p.peakAltDeg,
      azDeg: p.peakAzDeg,
      bestMs: p.peakMs,
      deepSpace: { focus: 'earth', whenMs: p.peakMs },
      remindable: p.peakAltDeg >= 40
    }))
}
