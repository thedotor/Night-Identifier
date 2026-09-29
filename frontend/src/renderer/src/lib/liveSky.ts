// Star overlay for Live View: keeps a sky alignment true while the sky turns.
//
// A camera that is fixed to the ground sees the sky rotate about the celestial pole at the
// sidereal rate. So an alignment is stored as a Camera plus the instant it was true for; the
// camera to draw at any later time is that Camera turned about the pole by however far the
// Earth has rotated since. Nothing else is needed (the site's latitude and longitude only
// matter for the horizon and for aiming by altitude/azimuth), so this also works for an
// alignment made without a location.
//
// Pure functions (no DOM) so scripts/liveSky.check.ts can run them under node.

import * as S from './skyMath'

const DEG = Math.PI / 180
const POLE: S.Vec3 = [0, 0, 1]

/** An alignment: the camera in the of-date frame of `frameJd`, true at `jd0`. */
export interface SkyAlignment {
  camera: Record<string, unknown>
  jd0: number
  frameJd: number
  /** 'guess' is the starting point offered before the user has aligned anything */
  how: 'auto' | 'manual' | 'guess'
  /** fit quality shown to the user */
  rmsPx?: number
  matched?: number
}

/** Degrees the Earth turns between two instants, wrapped to (-180, 180]. */
export function earthTurnDeg(jdFrom: number, jdTo: number): number {
  const d = (((S.gmstDeg(jdTo) - S.gmstDeg(jdFrom)) % 360) + 540) % 360 - 180
  return d === -180 ? 180 : d
}

/** Turn a direction about the celestial pole (positive = towards increasing right ascension). */
export const turnAboutPole = (v: S.Vec3, deg: number): S.Vec3 => S.rotateAbout(v, POLE, deg * DEG)

/**
 * The camera at a later instant. Fixed to the ground, it swings eastward in right ascension as
 * the Earth turns, so its axes turn about the pole by the same angle.
 */
export function cameraAfter(cam: S.Camera, turn: number): S.Camera {
  if (turn === 0) return cam
  return { ...cam, right: turnAboutPole(cam.right, turn), up: turnAboutPole(cam.up, turn), forward: turnAboutPole(cam.forward, turn) }
}

/**
 * A star direction seen at jdFrom, expressed for the camera as it is at jdTo. Used to combine
 * clicks made at different moments into one fit: a star clicked a minute ago has since moved.
 */
export function carryDirection(v: S.Vec3, jdFrom: number, jdTo: number): S.Vec3 {
  return turnAboutPole(v, earthTurnDeg(jdFrom, jdTo))
}

/** The camera to draw at `jd`, for a source frame of the given size. A tracking mount cancels the turn. */
export function cameraAt(align: SkyAlignment, jd: number, width: number, height: number, tracking: boolean): S.Camera | null {
  const cam = S.cameraFromJson(align.camera, width, height)
  if (!cam) return null
  return tracking ? cam : cameraAfter(cam, earthTurnDeg(align.jd0, jd))
}

/** Re-express a camera in another epoch's equator and equinox (precession only; a small change). */
export function rebaseFrame(cam: S.Camera, fromJd: number, toJd: number): S.Camera {
  if (Math.abs(fromJd - toJd) < 1e-6) return cam
  const from = S.precessionMatrix(fromJd)
  const to = S.precessionMatrix(toJd)
  // to * from^T: back to J2000, then forward to the new date.
  const back = (v: S.Vec3): S.Vec3 => S.applyMatrix(transpose(from), v)
  const move = (v: S.Vec3): S.Vec3 => S.applyMatrix(to, back(v))
  return { ...cam, right: move(cam.right), up: move(cam.up), forward: move(cam.forward) }
}

function transpose(m: number[][]): number[][] {
  return [0, 1, 2].map((i) => [m[0][i], m[1][i], m[2][i]])
}

/** Rotate a stored alignment into the session's frame (its stars are precessed to `frameJd`). */
export function alignmentInFrame(align: SkyAlignment, frameJd: number): SkyAlignment | null {
  const cam = S.cameraFromJson(align.camera, 1, 1)
  if (!cam) return null
  return { ...align, camera: S.cameraToJson(rebaseFrame(cam, align.frameJd, frameJd)), frameJd }
}

/** How well a stored alignment still lines up with the stars in a fresh picture. */
export interface AlignmentCheck {
  /** ok: it lines up. off: it does not (the camera was moved, or the lens or focus changed). unsure: too few stars to say (cloud, twilight, a covered lens). */
  verdict: 'ok' | 'off' | 'unsure'
  /** detected stars that have a catalogue star where the alignment says one should be */
  matched: number
  /** detected stars looked at */
  tested: number
  /** how many would match by luck, with this many catalogue stars in the frame */
  chance: number
}

const CHECK_STARS = 40
const CHECK_MIN_STARS = 6

/**
 * Compare the stars found in a picture (`detected`, in the camera's own pixels) with where the catalogue stars are predicted to be
 * (`predicted`, same pixels, only those inside the frame). A camera that has not moved matches nearly every star; one that has been
 * bumped matches about as many as chance would.
 */
export function checkAlignment(detected: readonly (readonly number[])[], predicted: readonly { x: number; y: number }[], width: number, height: number): AlignmentCheck {
  const list = detected.slice(0, CHECK_STARS)
  const tol = Math.max(6, 0.006 * width)
  // grid of the predicted stars, so each detected star only looks at its neighbours
  const cell = tol * 2
  const cols = Math.ceil(width / cell) + 1
  const grid = new Map<number, { x: number; y: number }[]>()
  for (const p of predicted) {
    const k = Math.floor(p.y / cell) * cols + Math.floor(p.x / cell)
    const g = grid.get(k)
    if (g) g.push(p)
    else grid.set(k, [p])
  }
  let matched = 0
  for (const d of list) {
    const cx = Math.floor(d[0] / cell)
    const cy = Math.floor(d[1] / cell)
    let hit = false
    for (let dy = -1; dy <= 1 && !hit; dy++)
      for (let dx = -1; dx <= 1 && !hit; dx++) {
        const g = grid.get((cy + dy) * cols + cx + dx)
        if (g) hit = g.some((p) => Math.hypot(p.x - d[0], p.y - d[1]) <= tol)
      }
    if (hit) matched++
  }
  const density = predicted.length / Math.max(1, width * height)
  const pChance = Math.min(1, Math.PI * tol * tol * density)
  const chance = pChance * list.length
  const sigma = Math.sqrt(list.length * pChance * (1 - pChance))
  const base = { matched, tested: list.length, chance }
  // too few stars, or so many catalogue stars that matching means nothing
  if (list.length < CHECK_MIN_STARS || pChance > 0.5) return { verdict: 'unsure', ...base }
  if (matched >= Math.max(4, chance + 4 * sigma) && matched >= 0.4 * list.length) return { verdict: 'ok', ...base }
  if (matched <= chance + 2 * sigma) return { verdict: 'off', ...base }
  return { verdict: 'unsure', ...base }
}

export interface SkySettings {
  on: boolean
  locked: boolean
  /** the camera sits on a star tracker, so the stars hold still in its picture */
  tracking: boolean
  lat: string
  lon: string
  /** lat and lon were typed for this camera; otherwise they follow the location saved for the whole app */
  ownPlace: boolean
  lens: S.Projection
  fovDeg: string
  /** the field of view above is trustworthy, so auto-align only searches near it (faster) */
  fovKnown: boolean
  alignment: SkyAlignment | null
  layers: Partial<SkyLayerFlags>
  /** seconds the camera's picture lags real time; satellites are drawn where they were that long ago */
  satLag: number
  /** show aircraft (live ADS-B) around the camera */
  planes: boolean
  /** show shooting-star streaks while a real meteor shower is active */
  meteors: boolean
}

/** The subset of overlay layers Live View offers. */
export interface SkyLayerFlags {
  stars: boolean
  constellations: boolean
  asterisms: boolean
  planets: boolean
  satellites: boolean
  nebulae: boolean
  galaxies: boolean
  clusters: boolean
  labels: boolean
  horizon: boolean
  opacity: number
  magOffset: number
}

export const DEFAULT_SKY_SETTINGS: SkySettings = {
  on: false,
  locked: false,
  tracking: false,
  lat: '',
  lon: '',
  ownPlace: false,
  lens: 'rectilinear',
  fovDeg: '60',
  fovKnown: false,
  alignment: null,
  layers: {},
  satLag: 0,
  planes: false,
  meteors: true
}

export const parseNumber = (s: string): number | null => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : null)

export function siteFrom(lat: string, lon: string, date: Date): S.Observer | null {
  const la = parseNumber(lat)
  const lo = parseNumber(lon)
  if (la === null || lo === null || Math.abs(la) > 90 || Math.abs(lo) > 360) return null
  return { latDeg: la, lonDeg: lo, date }
}
