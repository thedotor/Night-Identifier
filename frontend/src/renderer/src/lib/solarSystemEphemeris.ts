// Positions of the Sun, planets, Pluto and moons for the solar-system view, from astronomy-engine
// (VSOP87 planets, ELP/MPP02 Moon, JPL-fit Galilean moons). Everything is returned in the ecliptic
// J2000 frame, in AU. Pure functions (no DOM), so they run under `node` for
// scripts/solarSystem.check.ts.

import * as Astronomy from 'astronomy-engine'
import { KM_PER_AU, type MoonDef } from './solarSystemData'
import { positionAtMeanAnomaly, type Vec3 } from './kepler'

const J2000_MS = Date.UTC(2000, 0, 1, 12)
const DEG = Math.PI / 180
const DAY_MS = 86_400_000
const OBLIQUITY = 23.4392911 * (Math.PI / 180) // mean obliquity of the ecliptic at J2000
const COS_E = Math.cos(OBLIQUITY)
const SIN_E = Math.sin(OBLIQUITY)

/** Equatorial J2000 -> ecliptic J2000. */
const toEcl = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y * COS_E + v.z * SIN_E, -v.y * SIN_E + v.z * COS_E]

const body = (name: string): Astronomy.Body => name as Astronomy.Body

export const julianDate = (ms: number): number => 2451545.0 + (ms - J2000_MS) / DAY_MS

/** Heliocentric position of the Sun, a planet or Pluto. */
export function helioPosition(astro: string, date: Date): Vec3 {
  if (astro === 'Sun') return [0, 0, 0]
  return toEcl(Astronomy.HelioVector(body(astro), date))
}

/** A body's rotation state in the ecliptic frame: unit vectors along its north pole, along its
 * prime meridian at the equator, and (completing a right-handed set) along 90 degrees east. */
export interface BodyFrame {
  north: Vec3
  prime: Vec3
  east: Vec3
  /** prime-meridian angle W, degrees */
  spin: number
}

/** IAU rotation model (via astronomy-engine): W is measured along the body's equator from the
 * node where that equator crosses the ICRF equator, which lies at right ascension alpha + 90 deg. */
export function bodyFrame(astro: string, date: Date): BodyFrame {
  const ax = Astronomy.RotationAxis(body(astro), date)
  const north = toEcl(ax.north)
  const alpha = ax.ra * 15 * (Math.PI / 180)
  const node = toEcl({ x: -Math.sin(alpha), y: Math.cos(alpha), z: 0 })
  const w = ax.spin * (Math.PI / 180)
  const nn = cross(north, node)
  const prime: Vec3 = [node[0] * Math.cos(w) + nn[0] * Math.sin(w), node[1] * Math.cos(w) + nn[1] * Math.sin(w), node[2] * Math.cos(w) + nn[2] * Math.sin(w)]
  return { north, prime, east: cross(north, prime), spin: ax.spin }
}

/** Rotation axis (unit vector towards the north pole) and prime-meridian angle (degrees). */
export function rotation(astro: string, date: Date): { north: Vec3; spin: number } {
  const ax = Astronomy.RotationAxis(body(astro), date)
  return { north: toEcl(ax.north), spin: ax.spin }
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / n, a[1] / n, a[2] / n]
}

/** JPL Horizons element table for one moon: rows of [ec, i, om, w, n (deg/day), ma, a (AU)], one every `step`
 * days from `jd0`, osculating, relative to the planet, ecliptic J2000. */
export interface MoonTable {
  jd0: number
  step: number
  rows: number[][]
}

const TABLES = new Map<string, MoonTable>()
/** TDB - UTC, about 69 s in this era: an Io-speed moon moves 1,200 km in that time. */
const TDB_MINUS_UTC_DAYS = 69.2 / 86400

export function registerMoonTables(tables: Record<string, MoonTable>): void {
  TABLES.clear()
  for (const [id, t] of Object.entries(tables)) TABLES.set(id, t)
}

export const hasMoonTable = (id: string): boolean => TABLES.has(id)

/** Offset from the planet at a Julian date from the nearest table row (advanced by that row's mean
 * motion), or null outside the table's span. */
export function moonFromTable(table: MoonTable, jdUtc: number): Vec3 | null {
  const jd = jdUtc + TDB_MINUS_UTC_DAYS // Horizons tables are in TDB
  const idx = Math.round((jd - table.jd0) / table.step)
  if (idx < 0 || idx >= table.rows.length) return null
  const [ec, inc, om, w, n, ma, a] = table.rows[idx]
  const dt = jd - (table.jd0 + idx * table.step)
  return positionAtMeanAnomaly({ a, e: ec, i: inc, om, w }, (ma + n * dt) * DEG)
}

/** True if this moon is placed from real ephemeris data at this date, rather than an illustrative circle. */
export function moonIsReal(moon: MoonDef, date: Date): boolean {
  if (moon.engine) return true
  const t = TABLES.get(moon.id)
  if (!t) return false
  const idx = Math.round((julianDate(date.getTime()) + TDB_MINUS_UTC_DAYS - t.jd0) / t.step)
  return idx >= 0 && idx < t.rows.length
}

/** Position of a moon relative to its parent planet. */
export function moonOffset(moon: MoonDef, parentAstro: string, date: Date): Vec3 {
  const table = TABLES.get(moon.id)
  if (table) {
    const p = moonFromTable(table, julianDate(date.getTime()))
    if (p) return p
  }
  if (moon.engine === 'moon') return toEcl(Astronomy.GeoMoon(date))
  if (moon.engine) {
    const m = Astronomy.JupiterMoons(date)[moon.engine]
    return toEcl(m)
  }
  // Circular orbit in the parent's equatorial plane (a good model for the big regular moons).
  const { north } = rotation(parentAstro, date)
  const u = unit(cross(north, [0, 0, 1]))
  const v = cross(north, u)
  const days = (date.getTime() - J2000_MS) / DAY_MS
  const theta = ((moon.phase0 ?? 0) + (360 * days) / (moon.periodDays ?? 1)) * (Math.PI / 180)
  const r = (moon.aKm ?? 0) / KM_PER_AU
  return [r * (Math.cos(theta) * u[0] + Math.sin(theta) * v[0]), r * (Math.cos(theta) * u[1] + Math.sin(theta) * v[1]), r * (Math.cos(theta) * u[2] + Math.sin(theta) * v[2])]
}

/** One full orbit of a moon around its parent, sampled `n` times from `date`. */
export function moonOrbit(moon: MoonDef, parentAstro: string, date: Date, n = 96): Vec3[] {
  const period = Math.abs(moon.periodDays ?? 1) * DAY_MS
  const out: Vec3[] = []
  for (let k = 0; k <= n; k++) out.push(moonOffset(moon, parentAstro, new Date(date.getTime() + (k / n) * period)))
  return out
}

/** One full orbit of a planet or Pluto around the Sun, centred on `date` so it passes through the
 * planet's current position. */
export function planetOrbit(astro: string, periodDays: number, date: Date, n = 256): Vec3[] {
  const out: Vec3[] = []
  for (let k = 0; k <= n; k++) out.push(helioPosition(astro, new Date(date.getTime() + (k / n) * periodDays * DAY_MS)))
  return out
}
