import { useEffect, useRef, useState } from 'react'
import { api } from '@renderer/lib/api'
import { bearingDeg, compassOf, formatKm } from '@renderer/lib/lightning'
import { compass, findPasses } from '@renderer/lib/satellites'
import { nightInfo, sunAltitudeDeg, type Place } from '@renderer/lib/skyTonight'
import { computeEvents, NO_INPUTS, scoreEvents } from '@renderer/lib/skyCalendar'
import { readReminderIds } from '@renderer/components/events/EventBits'
import { RATING_LABEL } from '@renderer/lib/eventTypes'
import type { Outlook } from '@renderer/lib/eventScore'
import { findShocks, l1LeadMinutes, bzWords, dstLevel, type WindPoint } from '@renderer/lib/magnetosphere'
import { flareWords, radioBlackout, relativeTime, cmeDirection, type SunActivity } from '@renderer/lib/sun'
import { chanceAt, chanceVerdict, gScale, kpMeaning, parseGrid, type AuroraGridPayload, type SpaceWeather } from '@renderer/lib/aurora'
import { loadSatellites } from '@renderer/components/sky/useSatellites'
import { useLightningFeed } from '@renderer/components/lightning/useLightningFeed'
import { distanceKm as kmBetween, parseQuakes, type QuakeInfo, type QuakesPayload, type VolcanoesPayload } from '@renderer/lib/hazards'
import { readStoredPlace } from '@renderer/components/dashboard/usePlace'
import {
  auroraChanceAlert,
  eventsDue,
  bzSouthAlert,
  dstStormAlert,
  newShocks,
  newEarthCmes,
  newStrongFlares,
  bigQuakes,
  quakeSwarm,
  quakesNearMe,
  volcanoChanges,
  VOLCANO_LEVEL_NAME,
  stormKpAlert,
  type RepeatState,
  cameraAlerts,
  clearNightDue,
  clearNightVerdict,
  describeStorm,
  fmtGB,
  issPassToAlert,
  lowDisks,
  staleData,
  stormApproaching,
  type CameraAlertState,
  type CameraSnapshot,
  type DriveInfo,
  type HourlyCloud
} from './alertLogic'
import { useNotifications } from './NotificationContext'

const LAST_KEY = 'night-identifier:alert-last'
const DAY_MS = 86_400_000

/** What each alert last said and when, so an alert does not repeat after the app restarts. */
function lastMap(): Record<string, number | string> {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}') as Record<string, number | string>
  } catch {
    return {}
  }
}
const getLast = (key: string): number | string | null => lastMap()[key] ?? null
function setLast(key: string, value: number | string): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ ...lastMap(), [key]: value }))
  } catch {
    /* kept for this session only */
  }
}

const samePlace = (a: Place | null, b: Place | null): boolean => (a === null && b === null) || (a !== null && b !== null && a.latDeg === b.latDeg && a.lonDeg === b.lonDeg)

interface CameraRow {
  id: string
  name: string
  kind: string
  status: { state: string; sequence?: boolean; controls: { name: string; value: unknown }[] }
}

/**
 * The background checks behind the sky, camera and system alerts. Each one is a slow timer that reads the current settings
 * every time it runs (so switching a type on or off takes effect at once), asks the backend or the orbit maths a question, and
 * hands the answer to the decisions in alertLogic.ts. Renders nothing.
 */
export function AlertWatchers(): null {
  const { settings, notify } = useNotifications()
  const cfg = useRef(settings)
  cfg.current = settings
  const send = useRef(notify)
  send.current = notify

  const on = (category: keyof typeof settings.categories): boolean => cfg.current.enabled && cfg.current.categories[category]

  // ---------- ISS pass ----------
  useEffect(() => {
    let live = true
    const tick = async (): Promise<void> => {
      if (!on('issPass')) return
      const place = readStoredPlace()
      if (!place) return
      const p = cfg.current.params
      try {
        const cat = await loadSatellites(['iss'])
        const rec = cat.records.find((r) => r.norad === 25544)
        if (!rec || !live) return
        const now = Date.now()
        const passes = findPasses(rec, place, new Date(now), Math.max(1, p.issLeadMin / 60 + 0.25), 5)
        const last = getLast('issPass')
        const pass = issPassToAlert(passes, now, { leadMin: p.issLeadMin, minElevationDeg: p.issMinElevation, visibleOnly: p.issVisibleOnly }, typeof last === 'number' ? last : null)
        if (!pass) return
        setLast('issPass', pass.riseMs)
        const mins = Math.max(1, Math.round((pass.riseMs - now) / 60_000))
        send.current({
          category: 'issPass',
          level: 'info',
          title: `ISS passes over you in ${mins} min`,
          body: `Rises ${compass(pass.riseAzDeg)} at ${new Date(pass.riseMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, reaches ${pass.peakAltDeg.toFixed(0)}° in the ${compass(pass.peakAzDeg)}, sets ${compass(pass.setAzDeg)}. ${pass.visible ? 'It should be visible.' : 'Too bright a sky or in Earth’s shadow: not visible.'}`
        })
      } catch {
        /* no orbit data yet or offline: try again next minute */
      }
    }
    const first = window.setTimeout(() => void tick(), 15_000)
    const t = window.setInterval(() => void tick(), 60_000)
    return () => {
      live = false
      window.clearTimeout(first)
      window.clearInterval(t)
    }
  }, [])

  // ---------- earthquakes and volcanoes ----------
  useEffect(() => {
    let live = true
    const seenIds = (key: string): string[] => {
      try {
        const v = getLast(key)
        return typeof v === 'string' ? (JSON.parse(v) as string[]) : []
      } catch {
        return []
      }
    }
    const placeName = async (id: string): Promise<string> => {
      try {
        return (await api.get<QuakeInfo>(`/hazards/quake/${encodeURIComponent(id)}`)).place
      } catch {
        return ''
      }
    }
    const quakeRoute = (lat: number, lon: number): string => `/deep-space?view=solar&focus=earth&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&show=quakes`
    const tick = async (): Promise<void> => {
      const place = readStoredPlace()
      const wantNear = on('quakeNear') && place !== null
      const wantBig = on('quakeBig')
      const wantSwarm = on('quakeSwarm') && place !== null
      if (!wantNear && !wantBig && !wantSwarm) return
      let quakes
      try {
        quakes = parseQuakes(await api.get<QuakesPayload>('/hazards/quakes?min_mag=2&hours=3'))
      } catch {
        return // offline or the backend has not fetched yet: try again next minute
      }
      if (!live || quakes.length === 0) return
      const now = Date.now()
      const p = cfg.current.params
      if (wantNear && place) {
        const first = getLast('quakeNear:seen') === null
        const r = quakesNearMe(quakes, place, p.quakeNearMag, p.quakeNearKm, seenIds('quakeNear:seen'), now)
        setLast('quakeNear:seen', JSON.stringify(r.seen))
        // the very first look only remembers what is already there
        for (const q of first ? [] : r.fresh.slice(0, 3)) {
          const name = await placeName(q.id)
          send.current({
            category: 'quakeNear',
            level: q.mag >= 5 ? 'error' : 'info',
            title: `Magnitude ${q.mag.toFixed(1)} earthquake ${formatKm(q.km)} ${compassOf(q.bearing)} of you`,
            body: `${name || 'Location not named'}, ${q.depthKm.toFixed(0)} km deep, ${relativeTime(q.tMs, now)}.${q.tsunami ? ' A tsunami warning was issued: see tsunami.gov.' : ''}`,
            route: quakeRoute(q.latDeg, q.lonDeg)
          })
        }
      }
      if (wantBig) {
        const first = getLast('quakeBig:seen') === null
        const r = bigQuakes(quakes, p.quakeBigMag, seenIds('quakeBig:seen'), now)
        setLast('quakeBig:seen', JSON.stringify(r.seen))
        for (const q of first ? [] : r.fresh.slice(0, 2)) {
          const name = await placeName(q.id)
          const away = place ? `${formatKm(kmBetween(place.latDeg, place.lonDeg, q.latDeg, q.lonDeg))} from you. ` : ''
          send.current({
            category: 'quakeBig',
            level: 'error',
            title: `${q.tsunami && q.mag < p.quakeBigMag ? 'Tsunami warning: ' : ''}Magnitude ${q.mag.toFixed(1)} earthquake${name ? `: ${name}` : ''}`,
            body: `${away}${q.depthKm.toFixed(0)} km deep, ${relativeTime(q.tMs, now)}.${q.tsunami ? ' A tsunami warning was issued: see tsunami.gov.' : ''}`,
            route: quakeRoute(q.latDeg, q.lonDeg)
          })
        }
      }
      if (wantSwarm) {
        const r = quakeSwarm(quakes, now, { count: p.swarmCount, radiusKm: 60, windowMin: 60, minMag: 2.5, withinKm: p.swarmWithinKm }, place, seenIds('quakeSwarm:seen'))
        setLast('quakeSwarm:seen', JSON.stringify(r.seen))
        if (r.swarm) {
          send.current({
            category: 'quakeSwarm',
            level: 'info',
            title: `${r.swarm.count} earthquakes in one small area within an hour`,
            body: `The biggest was magnitude ${r.swarm.maxMag.toFixed(1)}${r.swarm.km !== null ? `, ${formatKm(r.swarm.km)} from you` : ''}. A swarm can be a sign of a bigger event or a volcano waking.`,
            route: quakeRoute(r.swarm.latDeg, r.swarm.lonDeg)
          })
        }
      }
    }
    const volcanoTick = async (): Promise<void> => {
      if (!on('volcanoAlert')) return
      let data: VolcanoesPayload
      try {
        data = await api.get<VolcanoesPayload>('/hazards/volcanoes')
      } catch {
        return
      }
      if (!live || !data.rows.length) return
      const place = readStoredPlace()
      const km = cfg.current.params.volcanoKm
      let previous: Record<string, number> | null = null
      try {
        const v = getLast('volcanoAlert:levels')
        previous = typeof v === 'string' ? (JSON.parse(v) as Record<string, number>) : null
      } catch {
        previous = null
      }
      const r = volcanoChanges(
        data.active.map((a) => ({ vnum: a.vnum, name: a.name, country: a.country, lat: a.lat, lon: a.lon, level: a.level })),
        previous,
        (v) => km === 0 || (place !== null && kmBetween(place.latDeg, place.lonDeg, v.lat, v.lon) <= km)
      )
      setLast('volcanoAlert:levels', JSON.stringify(r.state))
      for (const v of r.fresh.slice(0, 3)) {
        send.current({
          category: 'volcanoAlert',
          level: v.level >= 3 ? 'error' : 'info',
          title: v.level >= 3 && v.from < 3 ? `${v.name} (${v.country}) is erupting` : `${v.name} (${v.country}): ${VOLCANO_LEVEL_NAME[v.level]}`,
          body: `${v.from === 0 ? 'Newly reported' : `Raised from ${VOLCANO_LEVEL_NAME[v.from]}`} in the Smithsonian / USGS weekly report or the USGS alert levels.${place ? ` ${formatKm(kmBetween(place.latDeg, place.lonDeg, v.lat, v.lon))} from you.` : ''}`,
          route: `/deep-space?view=solar&focus=earth&lat=${v.lat.toFixed(3)}&lon=${v.lon.toFixed(3)}&show=volcanoes`
        })
      }
    }
    const first = window.setTimeout(() => void tick(), 40_000)
    const t = window.setInterval(() => void tick(), 60_000)
    const vFirst = window.setTimeout(() => void volcanoTick(), 45_000)
    const vt = window.setInterval(() => void volcanoTick(), 15 * 60_000)
    return () => {
      live = false
      window.clearTimeout(first)
      window.clearInterval(t)
      window.clearTimeout(vFirst)
      window.clearInterval(vt)
    }
  }, [])

  // ---------- lightning near you, storm approaching ----------
  const [place, setPlace] = useState<Place | null>(readStoredPlace)
  useEffect(() => {
    const t = window.setInterval(() => setPlace((cur) => (samePlace(cur, readStoredPlace()) ? cur : readStoredPlace())), 5000)
    return () => window.clearInterval(t)
  }, [])
  const watchLightning = settings.enabled && (settings.categories.lightningNear || settings.categories.stormApproaching) && place !== null
  const lastNear = useRef(0)
  const feed = useLightningFeed({
    enabled: watchLightning,
    windowMin: 20,
    place,
    nearKm: settings.params.lightningKm,
    onNear: (strike, km) => {
      if (!on('lightningNear')) return
      const now = Date.now()
      if (now - lastNear.current < cfg.current.params.lightningCooldownMin * 60_000) return
      lastNear.current = now
      const pl = readStoredPlace()
      const bearing = pl ? compassOf(bearingDeg(pl.latDeg, pl.lonDeg, strike.lat, strike.lon)) : ''
      send.current({
        category: 'lightningNear',
        level: 'error',
        title: `Lightning ${formatKm(km)} ${bearing} of you`,
        body: `A strike just landed within ${cfg.current.params.lightningKm} km of your saved location. Further strikes will not be announced for ${cfg.current.params.lightningCooldownMin} minutes.`
      })
    }
  })
  const getStrikes = useRef(feed.getStrikes)
  getStrikes.current = feed.getStrikes
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!on('stormApproaching')) return
      const pl = readStoredPlace()
      if (!pl) return
      const last = getLast('stormApproaching')
      if (typeof last === 'number' && Date.now() - last < 60 * 60_000) return
      const p = cfg.current.params
      const storm = stormApproaching(getStrikes.current(), pl, Date.now(), p.stormKm, p.stormMinSpeedKmH)
      if (!storm) return
      setLast('stormApproaching', Date.now())
      send.current({ category: 'stormApproaching', level: 'error', title: 'A thunderstorm is heading your way', body: `Lightning ${describeStorm(storm)}.` })
    }, 30_000)
    return () => window.clearInterval(t)
  }, [])

  // ---------- clear night ahead ----------
  useEffect(() => {
    const tick = async (): Promise<void> => {
      if (!on('clearNight')) return
      const pl = readStoredPlace()
      if (!pl) return
      const now = new Date()
      const info = nightInfo(pl, now)
      const day = now.toDateString()
      const last = getLast('clearNight')
      if (!clearNightDue(now.getTime(), info.sunset, cfg.current.params.clearNightLeadMin, typeof last === 'string' ? last : null)) return
      setLast('clearNight', day) // decided for today, whatever the answer
      if (!info.darkStart || !info.darkEnd) return
      try {
        const w = await api.get<{ hourly: HourlyCloud }>(`/weather?lat=${pl.latDeg}&lon=${pl.lonDeg}`)
        const verdict = clearNightVerdict(w.hourly, info.darkStart, info.darkEnd, cfg.current.params.clearNightMaxCloud)
        if (!verdict?.clear) return
        const clock = (d: Date): string => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        send.current({
          category: 'clearNight',
          level: 'success',
          title: 'Clear night ahead',
          body: `About ${Math.round(verdict.meanCloud)}% cloud while it is dark (${clock(info.darkStart)} to ${clock(info.darkEnd)}). Moon: ${info.moon.phaseName.toLowerCase()}, ${info.moon.illuminatedPct.toFixed(0)}% lit${info.moonlessHours !== null ? `, ${info.moonlessHours.toFixed(1)} h of moon-free dark` : ''}. A good night to set up.`
        })
      } catch {
        /* no forecast: say nothing */
      }
    }
    const first = window.setTimeout(() => void tick(), 20_000)
    const t = window.setInterval(() => void tick(), 60_000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(t)
    }
  }, [])

  // ---------- aurora at your location, geomagnetic storm ----------
  useEffect(() => {
    const state = (key: string): RepeatState => {
      const last = getLast(`${key}:last`)
      return { armed: getLast(`${key}:armed`) !== '0', lastSentMs: typeof last === 'number' ? last : null }
    }
    const save = (key: string, s: RepeatState): void => {
      setLast(`${key}:armed`, s.armed ? '1' : '0')
      if (s.lastSentMs !== null) setLast(`${key}:last`, s.lastSentMs)
    }
    const tick = async (): Promise<void> => {
      const now = Date.now()
      const pl = readStoredPlace()
      if (on('auroraChance') && pl) {
        try {
          const grid = parseGrid(await api.get<AuroraGridPayload>('/aurora/grid'))
          const chance = chanceAt(grid, pl.latDeg, pl.lonDeg)
          const sunAlt = sunAltitudeDeg(pl, new Date(now))
          const r = auroraChanceAlert(chance, sunAlt, cfg.current.params.auroraChancePct, state('auroraChance'), now)
          save('auroraChance', r.state)
          if (r.send) {
            const v = chanceVerdict(chance, sunAlt, pl.latDeg)
            send.current({ category: 'auroraChance', level: 'success', title: `Aurora possible: ${Math.round(chance)}% chance at your location`, body: `${v.text}. The forecast is NOAA's model, so check the sky for cloud too.` })
          }
        } catch {
          /* no forecast: try again in five minutes */
        }
      }
      if (on('geomagneticStorm')) {
        try {
          const w = await api.get<SpaceWeather>('/aurora/space-weather')
          if (w.kp_now != null) {
            const r = stormKpAlert(w.kp_now, cfg.current.params.stormKp, state('geomagneticStorm'), now)
            save('geomagneticStorm', r.state)
            if (r.send) {
              const g = gScale(w.kp_now)
              send.current({
                category: 'geomagneticStorm',
                level: 'success',
                title: `Geomagnetic storm${g ? ` ${g}` : ''}: Kp ${w.kp_now.toFixed(1)}`,
                body: `${kpMeaning(w.kp_now).text}. Aurora may be visible much farther from the poles than usual, so it is worth looking north (or south) after dark.`
              })
            }
          }
        } catch {
          /* no data: try again in five minutes */
        }
      }
    }
    const first = window.setTimeout(() => void tick(), 25_000)
    const t = window.setInterval(() => void tick(), 5 * 60_000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(t)
    }
  }, [])

  // ---------- sky events: a reminder a few hours before ----------
  useEffect(() => {
    const tick = async (): Promise<void> => {
      if (!on('skyEvent')) return
      const place = readStoredPlace()
      if (!place) return
      try {
        const now = Date.now()
        const lead = cfg.current.params.eventLeadH
        const to = now + (lead + 2) * 3_600_000
        // only the next few hours matter, so the year-long searches are skipped except the quick ones
        const events = await computeEvents(place, now - 3_600_000, to, NO_INPUTS, { heavy: true })
        if (events.length === 0) return
        let outlook: Outlook | null = null
        try {
          outlook = await api.get<Outlook>(`/events/outlook?lat=${place.latDeg}&lon=${place.lonDeg}`)
        } catch {
          /* no forecast: scored on the Moon and darkness only */
        }
        const scored = scoreEvents(events, place, outlook)
        const seenRaw = getLast('skyEvent:seen')
        const seen = (() => {
          try {
            return typeof seenRaw === 'string' ? (JSON.parse(seenRaw) as string[]) : []
          } catch {
            return []
          }
        })()
        const r = eventsDue(scored, now, lead, cfg.current.params.eventMinScore, seen, readReminderIds())
        setLast('skyEvent:seen', JSON.stringify(r.seen))
        for (const e of r.due.slice(0, 3)) {
          const t = e.bestMs ?? e.peakMs
          const mins = Math.max(1, Math.round((t - now) / 60_000))
          const when = mins >= 90 ? `in ${Math.round(mins / 60)} hours` : `in ${mins} minutes`
          const rating = e.score && e.score.rating !== 'unknown' ? ` Conditions for you: ${RATING_LABEL[e.score.rating].toLowerCase()}${e.score.reasons.length ? ' (' + e.score.reasons.slice(0, 3).join(', ') + ')' : ''}.` : ''
          send.current({ category: 'skyEvent', level: 'info', title: `${e.title}: ${when}`, body: `${e.detail.slice(0, 220)}${e.detail.length > 220 ? '…' : ''}${rating}` })
        }
      } catch {
        /* nothing to say this time */
      }
    }
    const first = window.setTimeout(() => void tick(), 40_000)
    const t = window.setInterval(() => void tick(), 10 * 60_000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(t)
    }
  }, [])

  // ---------- the wind and the field: southward Bz, shocks at L1, storms by Dst ----------
  useEffect(() => {
    const state = (key: string): RepeatState => {
      const last = getLast(`${key}:last`)
      return { armed: getLast(`${key}:armed`) !== '0', lastSentMs: typeof last === 'number' ? last : null }
    }
    const save = (key: string, s: RepeatState): void => {
      setLast(`${key}:armed`, s.armed ? '1' : '0')
      if (s.lastSentMs !== null) setLast(`${key}:last`, s.lastSentMs)
    }
    const tick = async (): Promise<void> => {
      const now = Date.now()
      if (on('bzSouth') || on('shockArrival')) {
        try {
          const w = await api.get<SpaceWeather>('/aurora/space-weather')
          const pts = (w.solar_wind ?? []) as WindPoint[]
          if (on('bzSouth')) {
            const limit = -cfg.current.params.bzSouthNt
            const r = bzSouthAlert(pts, limit, 15, state('bzSouth'), now)
            save('bzSouth', r.state)
            if (r.send) {
              const latest = [...pts].reverse().find((p) => p.bz != null)?.bz ?? limit
              send.current({
                category: 'bzSouth',
                level: 'success',
                title: `Southward Bz: ${latest.toFixed(1)} nT for 15 minutes`,
                body: `${bzWords(latest).text}. This is what lets the wind's energy into the Earth's field: aurora and geomagnetic activity often follow within an hour. Wind: ${w.solar_wind_now?.speed != null ? Math.round(w.solar_wind_now.speed) + ' km/s' : 'speed unknown'}.`
              })
            }
          }
          if (on('shockArrival')) {
            const seen = (() => {
              try {
                const v = getLast('shockArrival:seen')
                return typeof v === 'string' ? (JSON.parse(v) as number[]) : []
              } catch {
                return []
              }
            })()
            const r = newShocks(findShocks(pts), l1LeadMinutes, seen, now)
            setLast('shockArrival:seen', JSON.stringify(r.seen))
            for (const s of r.fresh.slice(0, 1)) {
              send.current({
                category: 'shockArrival',
                level: 'info',
                title: `Solar wind shock: reaches Earth ${relativeTime(s.arrival, now)}`,
                body: `The spacecraft at L1 saw the wind jump from ${Math.round(s.speedBefore)} to ${Math.round(s.speedAfter)} km/s with a denser wind. When it reaches Earth the magnetic field can be compressed and a storm can begin.`
              })
            }
          }
        } catch {
          /* no data: try again in five minutes */
        }
      }
      if (on('dstStorm')) {
        try {
          const d = await api.get<{ now: [number, number] }>('/space/dst')
          const r = dstStormAlert(d.now[1], cfg.current.params.dstStormNt, state('dstStorm'), now)
          save('dstStorm', r.state)
          if (r.send) {
            send.current({ category: 'dstStorm', level: 'success', title: `Magnetic storm under way: Dst ${Math.round(d.now[1])} nT`, body: `${dstLevel(d.now[1]).label}. The ring current around the Earth is weakening the field at the equator; aurora is likely to reach lower latitudes than usual.` })
          }
        } catch {
          /* no data: try again in five minutes */
        }
      }
    }
    const first = window.setTimeout(() => void tick(), 32_000)
    const t = window.setInterval(() => void tick(), 5 * 60_000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(t)
    }
  }, [])

  // ---------- the Sun: strong flares, CMEs heading for Earth ----------
  useEffect(() => {
    const seenList = <T,>(key: string): T[] => {
      try {
        const v = getLast(key)
        return typeof v === 'string' ? (JSON.parse(v) as T[]) : []
      } catch {
        return []
      }
    }
    const tick = async (): Promise<void> => {
      if (!on('solarFlare') && !on('cmeEarth')) return
      let act: SunActivity
      try {
        act = await api.get<SunActivity>('/sun/activity')
      } catch {
        return // no data: try again in five minutes
      }
      const now = Date.now()
      if (on('solarFlare')) {
        const first = getLast('solarFlare:seen') === null
        const r = newStrongFlares(act.flares, cfg.current.params.flareMinM * 1e-5, seenList<number>('solarFlare:seen'), now)
        setLast('solarFlare:seen', JSON.stringify(r.seen))
        // the very first look only remembers what is already there, unless it is happening right now (peaked in the last hour)
        for (const f of r.fresh.slice(0, first ? 1 : 3)) {
          const blackout = radioBlackout(f.class)
          send.current({
            category: 'solarFlare',
            level: 'info',
            title: `Solar flare ${f.class}`,
            body: `${flareWords(f.class)}${blackout ? ` Radio blackout scale ${blackout}.` : ''} It peaked ${relativeTime(f.peak, now)}. Whether it sent a CME towards Earth is worked out over the next day: an alert follows if so.`
          })
        }
      }
      if (on('cmeEarth')) {
        const r = newEarthCmes(act.cmes, seenList<string>('cmeEarth:seen'), now)
        setLast('cmeEarth:seen', JSON.stringify(r.seen))
        for (const c of r.fresh.slice(0, 2)) {
          send.current({
            category: 'cmeEarth',
            level: 'info',
            title: `CME heading for Earth: arrives ${relativeTime(c.arrival!, now)}`,
            body: `A ${Math.round(c.speed)} km/s coronal mass ejection, ${cmeDirection(c)}. Predicted arrival ${new Date(c.arrival!).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} (${c.arrival_source}; such estimates can be off by half a day). A strong hit can bring aurora far from the poles.`
          })
        }
      }
    }
    const first = window.setTimeout(() => void tick(), 35_000)
    const t = window.setInterval(() => void tick(), 5 * 60_000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(t)
    }
  }, [])

  // ---------- Canon camera health ----------
  const camState = useRef<Record<string, CameraAlertState>>({})
  useEffect(() => {
    let live = true
    const tick = async (): Promise<void> => {
      if (!on('cameraHealth')) return
      let cams: CameraRow[]
      try {
        cams = await api.get<CameraRow[]>('/live/cameras')
      } catch {
        return
      }
      if (!live) return
      for (const c of cams) {
        if (c.kind !== 'canon') continue
        const info = (n: string): string | null => {
          const v = c.status.controls.find((x) => x.name === n)?.value
          return typeof v === 'string' ? v : null
        }
        const pct = /^(\d+)%/.exec(info('status_8') ?? '')
        const shots = Number(info('status_40a'))
        const snap: CameraSnapshot = {
          id: c.id,
          name: c.name,
          kind: c.kind,
          running: c.status.state === 'running',
          sequence: !!c.status.sequence,
          batteryPct: pct ? Number(pct[1]) : null,
          shotsLeft: info('status_40a') !== null && Number.isFinite(shots) ? shots : null,
          modeDial: info('status_400')
        }
        const r = cameraAlerts(snap, { batteryPct: cfg.current.params.batteryPct, shotsLeft: cfg.current.params.shotsLeft }, camState.current[c.id] ?? { lowBattery: false, lowCard: false, dialWarned: false })
        camState.current[c.id] = r.state
        for (const a of r.alerts) send.current({ category: 'cameraHealth', level: a.level, title: a.title, body: a.body })
      }
    }
    const t = window.setInterval(() => void tick(), 30_000)
    const first = window.setTimeout(() => void tick(), 10_000)
    return () => {
      live = false
      window.clearTimeout(first)
      window.clearInterval(t)
    }
  }, [])

  // ---------- data out of date ----------
  useEffect(() => {
    const tick = async (): Promise<void> => {
      if (!on('dataStale')) return
      const [sat, clouds] = await Promise.all([
        api.get<{ datasets: Record<string, { age_s: number } | null> }>('/satellites/status').catch(() => null),
        api.get<{ available: boolean; stale: boolean; age_s: number | null }>('/weather/clouds/info').catch(() => null)
      ])
      for (const f of staleData(sat, clouds, cfg.current.params.staleDays)) {
        const last = getLast(`stale:${f.key}`)
        if (typeof last === 'number' && Date.now() - last < DAY_MS) continue
        setLast(`stale:${f.key}`, Date.now())
        send.current({ category: 'dataStale', level: 'info', title: f.title, body: f.body })
      }
    }
    const first = window.setTimeout(() => void tick(), 120_000)
    const t = window.setInterval(() => void tick(), 30 * 60_000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(t)
    }
  }, [])

  // ---------- disk space ----------
  useEffect(() => {
    const tick = async (): Promise<void> => {
      if (!on('diskSpace')) return
      const d = await api.get<{ drives: DriveInfo[] }>('/dashboard/disk').catch(() => null)
      if (!d) return
      for (const drive of lowDisks(d.drives, cfg.current.params.diskFreeGB)) {
        const key = `disk:${drive.drive}`
        const last = getLast(key)
        if (typeof last === 'number' && Date.now() - last < DAY_MS) continue
        setLast(key, Date.now())
        send.current({
          category: 'diskSpace',
          level: 'error',
          title: `Only ${fmtGB(drive.free_bytes)} free on ${drive.drive}`,
          body: `${drive.label} are saved on this drive and it is running low (under ${cfg.current.params.diskFreeGB} GB). Long Live View captures could fill it.`
        })
      }
    }
    const first = window.setTimeout(() => void tick(), 20_000)
    const t = window.setInterval(() => void tick(), 10 * 60_000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(t)
    }
  }, [])

  return null
}
