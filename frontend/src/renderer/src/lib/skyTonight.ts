// What the sky is doing tonight at a place, for the dashboard: sun and moon times, how dark it gets,
// and where the planets are. Pure functions over astronomy-engine, so they can be run under node.

import * as Astronomy from 'astronomy-engine'

export interface Place {
  latDeg: number
  lonDeg: number
}

const observer = (p: Place): Astronomy.Observer => new Astronomy.Observer(p.latDeg, p.lonDeg, 0)
const toDate = (t: Astronomy.AstroTime | null): Date | null => (t ? t.date : null)

function altitudeOf(body: Astronomy.Body, date: Date, obs: Astronomy.Observer): { alt: number; az: number } {
  const eq = Astronomy.Equator(body, date, obs, true, true)
  const hor = Astronomy.Horizon(date, obs, eq.ra, eq.dec, 'normal')
  return { alt: hor.altitude, az: hor.azimuth }
}

export type DayState = 'day' | 'civil' | 'nautical' | 'astronomical' | 'night'

export interface NightInfo {
  state: DayState
  sunAltDeg: number
  sunset: Date | null
  sunrise: Date | null
  /** when the sky is fully dark (Sun 18 degrees down): from `darkStart` (null: already) to `darkEnd`; both null: no full darkness within 2 days */
  darkStart: Date | null
  darkEnd: Date | null
  alreadyDark: boolean
  /** hours of that darkness with the Moon below the horizon */
  moonlessHours: number | null
  darkHours: number | null
  moon: { illuminatedPct: number; phaseName: string; altDeg: number; rise: Date | null; set: Date | null }
}

const PHASES = ['New Moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full Moon', 'Waning gibbous', 'Last quarter', 'Waning crescent']
export const phaseName = (phaseDeg: number): string => PHASES[Math.floor((((phaseDeg % 360) + 360) % 360 + 22.5) / 45) % 8]

export function nightInfo(place: Place, now: Date): NightInfo {
  const obs = observer(place)
  const sun = altitudeOf(Astronomy.Body.Sun, now, obs).alt
  const state: DayState = sun > -0.833 ? 'day' : sun > -6 ? 'civil' : sun > -12 ? 'nautical' : sun > -18 ? 'astronomical' : 'night'
  const sunset = toDate(Astronomy.SearchRiseSet(Astronomy.Body.Sun, obs, -1, now, 2))
  const sunrise = toDate(Astronomy.SearchRiseSet(Astronomy.Body.Sun, obs, +1, now, 2))

  const alreadyDark = sun < -18
  const start = alreadyDark ? now : toDate(Astronomy.SearchAltitude(Astronomy.Body.Sun, obs, -1, now, 2, -18))
  const end = start ? toDate(Astronomy.SearchAltitude(Astronomy.Body.Sun, obs, +1, start, 2, -18)) : null

  let moonless: number | null = null
  let dark: number | null = null
  if (start && end) {
    dark = (end.getTime() - start.getTime()) / 3_600_000
    let below = 0
    const step = 10 * 60_000
    let n = 0
    for (let t = start.getTime(); t < end.getTime(); t += step) {
      n++
      if (altitudeOf(Astronomy.Body.Moon, new Date(t), obs).alt < 0) below++
    }
    moonless = n ? (below / n) * dark : 0
  }

  const phase = Astronomy.MoonPhase(now)
  return {
    state,
    sunAltDeg: sun,
    sunset,
    sunrise,
    darkStart: alreadyDark ? null : start,
    darkEnd: end,
    alreadyDark,
    moonlessHours: moonless,
    darkHours: dark,
    moon: {
      illuminatedPct: Astronomy.Illumination(Astronomy.Body.Moon, now).phase_fraction * 100,
      phaseName: phaseName(phase),
      altDeg: altitudeOf(Astronomy.Body.Moon, now, obs).alt,
      rise: toDate(Astronomy.SearchRiseSet(Astronomy.Body.Moon, obs, +1, now, 2)),
      set: toDate(Astronomy.SearchRiseSet(Astronomy.Body.Moon, obs, -1, now, 2))
    }
  }
}

export interface PlanetNow {
  name: string
  magnitude: number
  altDeg: number
  azDeg: number
  /** next time it sets (if up now) or rises (if not) */
  next: { kind: 'rises' | 'sets'; at: Date } | null
}

const PLANETS: [string, Astronomy.Body][] = [
  ['Mercury', Astronomy.Body.Mercury],
  ['Venus', Astronomy.Body.Venus],
  ['Mars', Astronomy.Body.Mars],
  ['Jupiter', Astronomy.Body.Jupiter],
  ['Saturn', Astronomy.Body.Saturn],
  ['Uranus', Astronomy.Body.Uranus],
  ['Neptune', Astronomy.Body.Neptune]
]

export function planetsNow(place: Place, now: Date): PlanetNow[] {
  const obs = observer(place)
  return PLANETS.map(([name, body]) => {
    const { alt, az } = altitudeOf(body, now, obs)
    const up = alt > 0
    const t = toDate(Astronomy.SearchRiseSet(body, obs, up ? -1 : +1, now, 2))
    return {
      name,
      magnitude: Astronomy.Illumination(body, now).mag,
      altDeg: alt,
      azDeg: az,
      next: t ? { kind: up ? ('sets' as const) : ('rises' as const), at: t } : null
    }
  }).sort((a, b) => b.altDeg - a.altDeg)
}

/** Where the Sun is straight overhead right now (degrees), for shading the night side of a world map. */
export function subsolarPoint(now: Date): { latDeg: number; lonDeg: number } {
  const eq = Astronomy.Equator(Astronomy.Body.Sun, now, new Astronomy.Observer(0, 0, 0), true, true)
  const gst = Astronomy.SiderealTime(now) * 15 // Greenwich sidereal time, degrees
  const lon = (((eq.ra * 15 - gst + 540) % 360) - 180)
  return { latDeg: eq.dec, lonDeg: lon }
}


/** How high the Sun is above (+) or below (-) the horizon at a place, degrees. Under -12 the sky is dark enough for aurora. */
export function sunAltitudeDeg(place: Place, now: Date): number {
  return altitudeOf(Astronomy.Body.Sun, now, observer(place)).alt
}
