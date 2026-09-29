// The decisions behind the sky, camera and system alerts, as pure functions (no timers, no network, no DOM) so
// scripts/alerts.check.ts can test them. notifications/AlertWatchers.tsx does the polling and calls these.

import { bearingDeg, compassOf, distanceKm, type Strike } from '../lib/lightning'
import type { SatPass } from '../lib/satellites'
import { flareFlux, type Cme, type Flare } from '../lib/sun'
import type { SkyEvent } from '../lib/eventTypes'
import type { Place } from '../lib/skyTonight'
import type { Quake } from '../lib/hazards'

// ---------- quiet hours ----------

export interface QuietHours {
  enabled: boolean
  /** "HH:MM", local time */
  start: string
  end: string
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}

/** Is `date` inside the quiet period? The period may run past midnight (23:00 to 07:00); equal start and end means none. */
export function inQuietHours(q: QuietHours, date: Date): boolean {
  if (!q.enabled) return false
  const s = minutesOf(q.start)
  const e = minutesOf(q.end)
  if (s === e) return false
  const now = date.getHours() * 60 + date.getMinutes()
  return s < e ? now >= s && now < e : now >= s || now < e
}

// ---------- ISS pass ----------

export interface IssAlertConfig {
  leadMin: number
  minElevationDeg: number
  visibleOnly: boolean
}

/** The pass to warn about now: it starts within `leadMin` minutes, is high enough (and visible, if asked), and has not been warned about. */
export function issPassToAlert(passes: readonly SatPass[], nowMs: number, cfg: IssAlertConfig, lastAlertedRiseMs: number | null): SatPass | null {
  for (const p of passes) {
    const until = p.riseMs - nowMs
    if (until <= 0 || until > cfg.leadMin * 60_000) continue
    if (p.peakAltDeg < cfg.minElevationDeg) continue
    if (cfg.visibleOnly && !p.visible) continue
    if (lastAlertedRiseMs !== null && Math.abs(p.riseMs - lastAlertedRiseMs) < 60_000) continue
    return p
  }
  return null
}

// ---------- lightning ----------

export interface StormApproach {
  distanceKm: number
  speedKmH: number
  etaMin: number
  bearing: number
}

interface Centroid {
  lat: number
  lon: number
  tMs: number
  n: number
}

function centroid(strikes: readonly Strike[]): Centroid | null {
  if (!strikes.length) return null
  let x = 0
  let y = 0
  let z = 0
  let t = 0
  for (const s of strikes) {
    const la = (s.lat * Math.PI) / 180
    const lo = (s.lon * Math.PI) / 180
    x += Math.cos(la) * Math.cos(lo)
    y += Math.cos(la) * Math.sin(lo)
    z += Math.sin(la)
    t += s.tMs
  }
  const n = strikes.length
  const len = Math.hypot(x, y, z) || 1
  return { lat: (Math.asin(z / len) * 180) / Math.PI, lon: (Math.atan2(y, x) * 180) / Math.PI, tMs: t / n, n }
}

/**
 * Is a storm moving toward the place? Compares where the lightning within 300 km was in the last 6 minutes with where it was
 * 6 to 16 minutes ago. Needs at least `minStrikes` in each period; returns null when it is not clearly closing in, is
 * already overhead (that is the "lightning near you" alert's job), or is farther than `km`.
 */
export function stormApproaching(strikes: readonly Strike[], place: Place, nowMs: number, km: number, minSpeedKmH: number, minStrikes = 6): StormApproach | null {
  const near = strikes.filter((s) => distanceKm(place.latDeg, place.lonDeg, s.lat, s.lon) <= 300)
  const recent = centroid(near.filter((s) => s.tMs >= nowMs - 6 * 60_000))
  const earlier = centroid(near.filter((s) => s.tMs < nowMs - 6 * 60_000 && s.tMs >= nowMs - 16 * 60_000))
  if (!recent || !earlier || recent.n < minStrikes || earlier.n < minStrikes) return null
  const dNow = distanceKm(place.latDeg, place.lonDeg, recent.lat, recent.lon)
  const dPrev = distanceKm(place.latDeg, place.lonDeg, earlier.lat, earlier.lon)
  const dtH = (recent.tMs - earlier.tMs) / 3_600_000
  if (dtH <= 0) return null
  const speed = (dPrev - dNow) / dtH // positive: getting closer
  // storms move at tens of km/h; a faster "speed" is the cluster's middle jumping about as strikes come and go, not a storm
  if (dNow > km || dNow < 25 || speed < minSpeedKmH || speed > 200) return null
  return { distanceKm: dNow, speedKmH: speed, etaMin: (dNow / speed) * 60, bearing: bearingDeg(place.latDeg, place.lonDeg, recent.lat, recent.lon) }
}

export const describeStorm = (s: StormApproach): string =>
  `${Math.round(s.distanceKm)} km ${compassOf(s.bearing)}, closing at about ${Math.round(s.speedKmH)} km/h: overhead in roughly ${s.etaMin < 90 ? `${Math.round(s.etaMin)} min` : `${(s.etaMin / 60).toFixed(1)} h`}`

// ---------- clear night ----------

export interface HourlyCloud {
  /** ISO times, UTC, hour by hour */
  time: string[]
  cloud_cover: number[]
}

export interface ClearNight {
  clear: boolean
  meanCloud: number
  bestCloud: number
  hours: number
}

/** Cloud cover over the dark hours (between `darkStart` and `darkEnd`): clear when the average is at or under `maxMeanCloud` percent. */
export function clearNightVerdict(h: HourlyCloud, darkStart: Date, darkEnd: Date, maxMeanCloud: number): ClearNight | null {
  const vals: number[] = []
  for (let i = 0; i < h.time.length; i++) {
    const t = Date.parse(`${h.time[i]}:00Z`)
    if (t >= darkStart.getTime() - 30 * 60_000 && t <= darkEnd.getTime() && Number.isFinite(h.cloud_cover[i])) vals.push(h.cloud_cover[i])
  }
  if (vals.length < 2) return null
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  return { clear: mean <= maxMeanCloud, meanCloud: mean, bestCloud: Math.min(...vals), hours: vals.length }
}

/** Time to send the "clear night" message: from `leadMin` before sunset until 30 minutes after that, once per local day. */
export function clearNightDue(nowMs: number, sunset: Date | null, leadMin: number, lastSentDay: string | null): boolean {
  if (!sunset) return false
  const start = sunset.getTime() - leadMin * 60_000
  if (nowMs < start || nowMs > start + 30 * 60_000) return false
  const day = new Date(nowMs).toDateString()
  return lastSentDay !== day
}

// ---------- aurora and geomagnetic storms ----------

/** What an alert remembers between checks: whether it may fire again, and when it last did. */
export interface RepeatState {
  /** false from the moment it fires until the condition has clearly ended */
  armed: boolean
  lastSentMs: number | null
}

export const REPEAT_GAP_MS = 3 * 3_600_000

/**
 * Fire once when the condition starts, and again only after it has ended and returned, at least 3 hours after the last one.
 * `hot`: the condition is true now; `cleared`: it is clearly over (a lower bar than `hot`, so it does not flicker).
 */
export function repeatAlert(hot: boolean, cleared: boolean, state: RepeatState, nowMs: number): { send: boolean; state: RepeatState } {
  if (hot && state.armed && (state.lastSentMs === null || nowMs - state.lastSentMs >= REPEAT_GAP_MS)) return { send: true, state: { armed: false, lastSentMs: nowMs } }
  if (cleared) return { send: false, state: { ...state, armed: true } }
  return { send: false, state }
}

/** Aurora over your location: the chance is at least `minPct` and the sky is dark (Sun more than 12 degrees down). It re-arms when the chance falls under 60% of the limit, or it gets light. */
export function auroraChanceAlert(chance: number, sunAltDeg: number, minPct: number, state: RepeatState, nowMs: number): { send: boolean; state: RepeatState } {
  const dark = sunAltDeg < -12
  return repeatAlert(chance >= minPct && dark, chance < minPct * 0.6 || sunAltDeg > -6, state, nowMs)
}

/** A geomagnetic storm: Kp at or over `minKp`. It re-arms when Kp falls a full point below it. */
export function stormKpAlert(kp: number, minKp: number, state: RepeatState, nowMs: number): { send: boolean; state: RepeatState } {
  return repeatAlert(kp >= minKp, kp < minKp - 1, state, nowMs)
}

// ---------- the Sun: strong flares and CMEs heading for Earth ----------

const SEEN_CAP = 60

/**
 * Flares at or above `minFlux` (W/m2, M5 = 5e-5) that have not been announced. Only flares that peaked within `freshMs` are
 * announced (starting the app must not replay yesterday's), but every qualifying one is remembered, keyed by its start time.
 */
export function newStrongFlares(flares: Flare[], minFlux: number, seen: number[], nowMs: number, freshMs = 60 * 60_000): { fresh: Flare[]; seen: number[] } {
  const qualifying = flares.filter((f) => flareFlux(f.class) >= minFlux - 1e-15)
  const fresh = qualifying.filter((f) => !seen.includes(f.begin) && nowMs - f.peak <= freshMs)
  const next = [...new Set([...seen, ...qualifying.map((f) => f.begin)])].sort((a, b) => a - b).slice(-SEEN_CAP)
  return { fresh, seen: next }
}

/** CMEs that will reach Earth in the future and have not been announced (by NASA's id). */
export function newEarthCmes(cmes: Cme[], seen: string[], nowMs: number): { fresh: Cme[]; seen: string[] } {
  const qualifying = cmes.filter((c) => c.earth_directed && c.arrival != null && c.arrival > nowMs)
  const fresh = qualifying.filter((c) => !seen.includes(c.id))
  return { fresh, seen: [...new Set([...seen, ...qualifying.map((c) => c.id)])].slice(-SEEN_CAP) }
}

// ---------- the solar wind and the magnetic field ----------

/** Has Bz stayed at or below `limitNT` (a negative number) for the last `minutes`? `points` are wind readings, oldest first, with ISO times. */
export function bzSustainedSouth(points: { t: string; bz?: number | null }[], limitNT: number, minutes: number, nowMs: number): boolean {
  const recent = points.filter((p) => p.bz != null && nowMs - Date.parse(p.t.endsWith('Z') ? p.t : `${p.t}Z`) <= minutes * 60_000)
  if (recent.length < Math.max(3, Math.floor(minutes / 4))) return false // too few readings to say "for the whole time"
  const oldest = Date.parse(recent[0].t.endsWith('Z') ? recent[0].t : `${recent[0].t}Z`)
  if (nowMs - oldest < minutes * 60_000 * 0.8) return false // the readings do not go back far enough
  return recent.every((p) => (p.bz as number) <= limitNT)
}

/** Strong southward Bz for a while: fire once, again only after it has eased (above half the limit) and 3 hours have passed. */
export function bzSouthAlert(points: { t: string; bz?: number | null }[], limitNT: number, minutes: number, state: RepeatState, nowMs: number): { send: boolean; state: RepeatState } {
  const latest = [...points].reverse().find((p) => p.bz != null)?.bz ?? 0
  return repeatAlert(bzSustainedSouth(points, limitNT, minutes, nowMs), latest > limitNT / 2, state, nowMs)
}

/** A magnetic storm by Dst (nT, negative): at or below `-limitNT`; it ends when Dst is 20 nT above that. */
export function dstStormAlert(dst: number, limitNT: number, state: RepeatState, nowMs: number): { send: boolean; state: RepeatState } {
  return repeatAlert(dst <= -limitNT, dst > -limitNT + 20, state, nowMs)
}

/** Shocks (from lib/magnetosphere findShocks) not announced yet whose arrival at Earth is still ahead, keyed by the time L1 saw them. */
export function newShocks(shocks: { t: number; speedBefore: number; speedAfter: number }[], leadMin: (v: number) => number, seen: number[], nowMs: number): { fresh: { t: number; speedBefore: number; speedAfter: number; arrival: number }[]; seen: number[] } {
  const ahead = shocks.map((s) => ({ ...s, arrival: s.t + leadMin(s.speedAfter) * 60_000 })).filter((s) => s.arrival > nowMs)
  return { fresh: ahead.filter((s) => !seen.includes(s.t)), seen: [...new Set([...seen, ...ahead.map((s) => s.t)])].slice(-30) }
}

// ---------- sky-event reminders ----------

/** The kinds that remind you on their own (ISS passes have their own alert, Moon phases and seasons are not worth a notification). */
export const AUTO_REMIND_KINDS: string[] = ['eclipse', 'meteor', 'occultation', 'planet', 'comet', 'space']

/**
 * Events whose reminder is due: the best moment is less than `leadH` hours away and still ahead, it has not been announced, and
 * either you asked for it (`manual`) or it is a remindable event of a kind that reminds by itself, visible from here and good enough
 * (score at least `minScore`; an event with no cloud forecast yet still counts).
 */
export function eventsDue(events: SkyEvent[], nowMs: number, leadH: number, minScore: number, seen: string[], manual: string[]): { due: SkyEvent[]; seen: string[] } {
  const ahead = events.filter((e) => {
    const t = e.bestMs ?? e.peakMs
    return t > nowMs && t - leadH * 3_600_000 <= nowMs
  })
  const due = ahead.filter((e) => {
    if (seen.includes(e.id)) return false
    if (manual.includes(e.id)) return e.visible !== 'no'
    if (!e.remindable || e.visible === 'no' || !AUTO_REMIND_KINDS.includes(e.kind)) return false
    const s = e.score
    return !s || s.score == null || s.noForecast || s.score >= minScore
  })
  // remember everything that was considered due-window, so a low score that improves later does not surprise (and the list stays short)
  const next = [...new Set([...seen, ...due.map((e) => e.id)])].slice(-150)
  return { due, seen: next }
}

// ---------- camera ----------

export interface CameraSnapshot {
  id: string
  name: string
  kind: string
  running: boolean
  /** a capture sequence is running */
  sequence: boolean
  batteryPct: number | null
  shotsLeft: number | null
  modeDial: string | null
}

export interface CameraAlertState {
  lowBattery: boolean
  lowCard: boolean
  dialWarned: boolean
}

export interface CameraAlert {
  key: 'battery' | 'card' | 'dial'
  level: 'info' | 'error'
  title: string
  body: string
}

/** What to say about a camera now. `state` remembers what was already said, so each problem is announced once and again only after it clears. */
export function cameraAlerts(c: CameraSnapshot, cfg: { batteryPct: number; shotsLeft: number }, state: CameraAlertState): { alerts: CameraAlert[]; state: CameraAlertState } {
  const alerts: CameraAlert[] = []
  const next = { ...state }
  if (!c.running) return { alerts, state: { lowBattery: false, lowCard: false, dialWarned: false } }
  const lowBattery = c.batteryPct !== null && c.batteryPct <= cfg.batteryPct
  if (lowBattery && !state.lowBattery) alerts.push({ key: 'battery', level: 'error', title: `${c.name}: battery low`, body: `The camera battery is at ${c.batteryPct}%. Long exposures and Live View drain it quickly.` })
  next.lowBattery = c.batteryPct === null ? state.lowBattery : lowBattery || (state.lowBattery && c.batteryPct <= cfg.batteryPct + 8)
  const lowCard = c.shotsLeft !== null && c.shotsLeft <= cfg.shotsLeft
  if (lowCard && !state.lowCard) alerts.push({ key: 'card', level: 'error', title: `${c.name}: memory card nearly full`, body: `About ${c.shotsLeft} shots fit on the card at the current quality.` })
  next.lowCard = c.shotsLeft === null ? state.lowCard : lowCard
  const dialOk = c.modeDial === null || /\((M|B)\)/.test(c.modeDial)
  if (c.sequence && !dialOk && !state.dialWarned) alerts.push({ key: 'dial', level: 'info', title: `${c.name}: mode dial is not on M`, body: `It is on ${c.modeDial}, so a capture sequence cannot set ISO, shutter or aperture. Turn the dial to M (or B).` })
  next.dialWarned = c.sequence && !dialOk // stays true while the problem stays: said once
  return { alerts, state: next }
}

// ---------- data out of date ----------

export interface StaleFinding {
  key: string
  title: string
  body: string
}

export function staleData(
  sat: { datasets: Record<string, { age_s: number } | null> } | null,
  clouds: { available: boolean; stale: boolean; age_s: number | null } | null,
  staleDays: number
): StaleFinding[] {
  const out: StaleFinding[] = []
  if (sat) {
    const ages = Object.values(sat.datasets)
      .filter((d): d is { age_s: number } => d !== null)
      .map((d) => d.age_s / 86_400)
    const oldest = ages.length ? Math.max(...ages) : 0
    if (oldest > staleDays) out.push({ key: 'satellites', title: 'Satellite orbit data is out of date', body: `The newest download is ${Math.round(oldest)} days old, so satellite positions are getting less accurate. Check your connection, or refresh it in Settings.` })
  }
  if (clouds && clouds.available && clouds.stale) out.push({ key: 'clouds', title: 'The live cloud map has not refreshed', body: `The cloud picture is ${clouds.age_s ? `${Math.round(clouds.age_s / 3600)} hours` : 'several hours'} old. The weather-satellite service may be unreachable.` })
  return out
}

// ---------- disk ----------

export interface DriveInfo {
  label: string
  drive: string
  free_bytes: number
  total_bytes: number
}

export function lowDisks(drives: readonly DriveInfo[], minFreeGB: number): DriveInfo[] {
  return drives.filter((d) => d.free_bytes < minFreeGB * 1e9)
}

export const fmtGB = (bytes: number): string => `${(bytes / 1e9).toFixed(bytes < 1e10 ? 1 : 0)} GB`

// ---------- earthquakes and volcanoes ----------

const QUAKE_SEEN_CAP = 200

/** Earthquakes of at least `minMag` within `km` of `place` that have not been announced (by their id) and happened in the last `freshMs`. Everything qualifying is remembered, so starting the app does not replay old ones. */
export function quakesNearMe(quakes: Quake[], place: Place, minMag: number, km: number, seen: string[], nowMs: number, freshMs = 3 * 3_600_000): { fresh: (Quake & { km: number; bearing: number })[]; seen: string[] } {
  const qualifying = quakes
    .filter((q) => q.mag >= minMag - 1e-9)
    .map((q) => ({ ...q, km: distanceKm(place.latDeg, place.lonDeg, q.latDeg, q.lonDeg), bearing: bearingDeg(place.latDeg, place.lonDeg, q.latDeg, q.lonDeg) }))
    .filter((q) => q.km <= km)
  const fresh = qualifying.filter((q) => !seen.includes(q.id) && nowMs - q.tMs <= freshMs).sort((a, b) => b.mag - a.mag)
  return { fresh, seen: [...new Set([...seen, ...qualifying.map((q) => q.id)])].slice(-QUAKE_SEEN_CAP) }
}

/** Earthquakes of at least `minMag`, anywhere, and any with a tsunami warning, that have not been announced. */
export function bigQuakes(quakes: Quake[], minMag: number, seen: string[], nowMs: number, freshMs = 3 * 3_600_000): { fresh: Quake[]; seen: string[] } {
  const qualifying = quakes.filter((q) => q.mag >= minMag - 1e-9 || q.tsunami)
  const fresh = qualifying.filter((q) => !seen.includes(q.id) && nowMs - q.tMs <= freshMs).sort((a, b) => b.mag - a.mag)
  return { fresh, seen: [...new Set([...seen, ...qualifying.map((q) => q.id)])].slice(-QUAKE_SEEN_CAP) }
}

export interface ActiveVolcano {
  vnum: number
  name: string
  country: string
  lat: number
  lon: number
  /** 0 nothing unusual, 1 unrest or advisory, 2 watch, 3 erupting or warning */
  level: number
}

export const VOLCANO_LEVEL_NAME = ['quiet', 'unrest or advisory', 'watch', 'erupting or on warning']

/**
 * Volcanoes whose level went up since last time (or that are newly listed as active). `previous` is null the first time: the alert
 * only remembers what is already going on. A volcano that eases and later rises again is announced again. `within` limits it to volcanoes near you.
 */
export function volcanoChanges(active: ActiveVolcano[], previous: Record<string, number> | null, within: (v: ActiveVolcano) => boolean = () => true): { fresh: (ActiveVolcano & { from: number })[]; state: Record<string, number> } {
  const state: Record<string, number> = {}
  const fresh: (ActiveVolcano & { from: number })[] = []
  for (const v of active) {
    state[String(v.vnum)] = v.level
    if (previous === null || !within(v)) continue
    const from = previous[String(v.vnum)] ?? 0
    if (v.level > from) fresh.push({ ...v, from })
  }
  return { fresh: fresh.sort((a, b) => b.level - a.level), state }
}

export interface QuakeSwarm {
  key: string
  latDeg: number
  lonDeg: number
  count: number
  maxMag: number
  km: number | null
}

/**
 * A swarm: at least `count` earthquakes of `minMag`+ inside a circle of `radiusKm` within the last `windowMin` minutes. The biggest cluster
 * is reported; if a place is given only swarms within `withinKm` of it count (0: anywhere). Each cluster area is announced once per 6 hours.
 */
export function quakeSwarm(quakes: Quake[], nowMs: number, opt: { count: number; radiusKm: number; windowMin: number; minMag: number; withinKm: number }, place: Place | null, seen: string[]): { swarm: QuakeSwarm | null; seen: string[] } {
  const recent = quakes.filter((q) => q.mag >= opt.minMag - 1e-9 && nowMs - q.tMs <= opt.windowMin * 60_000)
  let best: { centre: Quake; members: Quake[] } | null = null
  for (const c of recent) {
    const members = recent.filter((q) => distanceKm(c.latDeg, c.lonDeg, q.latDeg, q.lonDeg) <= opt.radiusKm)
    if (members.length >= opt.count && (!best || members.length > best.members.length)) best = { centre: c, members }
  }
  if (!best) return { swarm: null, seen }
  const lat = best.members.reduce((s, q) => s + q.latDeg, 0) / best.members.length
  const lon = best.members.reduce((s, q) => s + q.lonDeg, 0) / best.members.length
  const km = place ? distanceKm(place.latDeg, place.lonDeg, lat, lon) : null
  if (opt.withinKm > 0 && (km === null || km > opt.withinKm)) return { swarm: null, seen }
  const key = `${Math.round(lat / 2) * 2}:${Math.round(lon / 2) * 2}:${Math.floor(nowMs / (6 * 3_600_000))}`
  if (seen.includes(key)) return { swarm: null, seen }
  return { swarm: { key, latDeg: lat, lonDeg: lon, count: best.members.length, maxMag: Math.max(...best.members.map((q) => q.mag)), km }, seen: [...seen, key].slice(-30) }
}
