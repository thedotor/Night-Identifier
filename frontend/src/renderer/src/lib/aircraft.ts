// Aircraft (ADS-B) for the sky overlay and the 3D Earth: rows from the backend in, "where is it now"
// and "where is it in the sky from here" out. Pure functions, no DOM.
//
// A row is a position at a moment in the past (the receiver's last report). Between reports an aircraft
// is moved along its heading at its ground speed, which is good to a few hundred metres for the
// minutes between refreshes.

import * as sat from './satelliteJs'
import * as S from './skyMath'
import type { Site } from './satellites'
import { asKind, asShape, kindInfo, type AircraftKind, type AircraftShape } from './aircraftIcons'

const DEG = Math.PI / 180
const EARTH_RADIUS_M = 6_371_008.8
/** Reports older than this are not carried forward: the aircraft has probably turned or landed. */
const MAX_EXTRAPOLATE_S = 900

export interface Aircraft {
  hex: string
  callsign: string
  latDeg: number
  lonDeg: number
  /** height above sea level, metres */
  altM: number
  speedMs: number
  /** degrees clockwise from north */
  trackDeg: number
  /** climb (+) or descent (-), metres per second */
  vrateMs: number
  type: string
  reg: string
  /** what the filter groups it under, and which icon draws it */
  kind: AircraftKind
  shape: AircraftShape
  /** when the position was reported (ms since 1970) */
  tMs: number
}

export interface AircraftPayload {
  fields: string[]
  rows: (string | number)[][]
  fetched_at: number
  stale?: boolean
  error?: string | null
  credit: string
  /** the world feed: false until the aircraft database has downloaded (until then business jets, small planes, military and cargo are guesses) */
  types_ready?: boolean
}

export function parseAircraft(p: AircraftPayload): Aircraft[] {
  const i = (n: string): number => p.fields.indexOf(n)
  const c = { hex: i('hex'), cs: i('callsign'), lat: i('lat'), lon: i('lon'), alt: i('alt_m'), spd: i('speed_ms'), trk: i('track'), vr: i('vrate_ms'), type: i('type'), reg: i('reg'), t: i('t'), kind: i('kind'), shape: i('shape') }
  const out: Aircraft[] = []
  for (const r of p.rows) {
    const lat = Number(r[c.lat])
    const lon = Number(r[c.lon])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    out.push({
      hex: String(r[c.hex]),
      callsign: String(r[c.cs] ?? ''),
      latDeg: lat,
      lonDeg: lon,
      altM: Number(r[c.alt]) || 0,
      speedMs: Number(r[c.spd]) || 0,
      trackDeg: Number(r[c.trk]) || 0,
      vrateMs: Number(r[c.vr]) || 0,
      type: String(r[c.type] ?? ''),
      reg: String(r[c.reg] ?? ''),
      kind: asKind(r[c.kind]),
      shape: asShape(r[c.shape]),
      tMs: Number(r[c.t]) * 1000
    })
  }
  return out
}

export interface AircraftPosition {
  latDeg: number
  lonDeg: number
  altM: number
}

/** Where the aircraft is at `ms`, carried along its track from its last report. */
export function advance(a: Aircraft, ms: number): AircraftPosition {
  const dt = Math.max(-30, Math.min(MAX_EXTRAPOLATE_S, (ms - a.tMs) / 1000))
  if (a.speedMs < 1) return { latDeg: a.latDeg, lonDeg: a.lonDeg, altM: a.altM }
  const d = (a.speedMs * dt) / EARTH_RADIUS_M // angular distance, radians
  const brg = a.trackDeg * DEG
  const lat1 = a.latDeg * DEG
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg))
  const lon2 = a.lonDeg * DEG + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2))
  return { latDeg: lat2 / DEG, lonDeg: ((((lon2 / DEG) + 540) % 360) - 180), altM: Math.max(0, a.altM + a.vrateMs * dt) }
}

export interface AircraftLook {
  altDeg: number
  azDeg: number
  rangeKm: number
}

/** Altitude and azimuth of an aircraft as seen from a site on the ground. */
export function lookFrom(site: Site, p: AircraftPosition): AircraftLook {
  const obs = { latitude: site.latDeg * DEG, longitude: site.lonDeg * DEG, height: site.heightKm ?? 0 }
  const ecf = sat.geodeticToEcf({ latitude: p.latDeg * DEG, longitude: p.lonDeg * DEG, height: p.altM / 1000 })
  const l = sat.ecfToLookAngles(obs, ecf)
  return { altDeg: l.elevation / DEG, azDeg: (((l.azimuth / DEG) % 360) + 360) % 360, rangeKm: l.rangeSat }
}

export const flightLevel = (altM: number): string => `FL${String(Math.round(altM / 0.3048 / 100)).padStart(3, '0')}`

/** One aircraft as the sky renderer draws it. */
export interface PlaneDot {
  hex: string
  label: string
  kind: AircraftKind
  shape: AircraftShape
  /** sky direction now, and a few seconds ahead (gives the way it is heading in the picture) */
  dir: S.Vec3
  ahead: S.Vec3
  altDeg: number
  rangeKm: number
}

export interface PlaneFrame {
  /** what is drawn: the aircraft above the horizon whose kind is not filtered out */
  dots: PlaneDot[]
  /** every aircraft above the horizon by kind, filtered out or not (for the numbers in the filter) */
  counts: Partial<Record<AircraftKind, number>>
}

/** Aircraft above the horizon, as sky directions for the camera frame defined by `frame`. */
export function buildPlaneFrame(rows: Aircraft[], ms: number, site: Site, frame: S.Observer, hidden?: ReadonlySet<AircraftKind>): PlaneFrame {
  const dots: PlaneDot[] = []
  const counts: PlaneFrame['counts'] = {}
  for (const a of rows) {
    const p = advance(a, ms)
    const look = lookFrom(site, p)
    if (look.altDeg < 0.3) continue
    counts[a.kind] = (counts[a.kind] ?? 0) + 1
    if (hidden?.has(a.kind)) continue
    const q = lookFrom(site, advance(a, ms + 4000))
    dots.push({
      hex: a.hex,
      label: `${a.callsign || a.hex.toUpperCase()} ${flightLevel(p.altM)}${a.type ? ` ${a.type}` : ''}`,
      kind: a.kind,
      shape: a.shape,
      dir: S.altAzToVec(look.altDeg, look.azDeg, frame),
      ahead: S.altAzToVec(q.altDeg, q.azDeg, frame),
      altDeg: look.altDeg,
      rangeKm: look.rangeKm
    })
  }
  dots.sort((x, y) => x.rangeKm - y.rangeKm)
  return { dots, counts }
}

/** Aircraft of each kind in `rows` (the whole list, not only what is above the horizon). */
export function countKinds(rows: readonly Aircraft[]): Partial<Record<AircraftKind, number>> {
  const out: Partial<Record<AircraftKind, number>> = {}
  for (const a of rows) out[a.kind] = (out[a.kind] ?? 0) + 1
  return out
}

export const kindLabel = (k: AircraftKind): string => kindInfo(k).label
