// Matching the 3D scene to the photo, for the merged zoom: as you zoom out of the photo the 3D sky
// (seen from where the photo was taken) is aimed and scaled to line up with it, so the two can be
// cross-faded seamlessly. Pure functions (no DOM), so they run under `node` for scripts/skyLift.check.ts.

import * as S from './skyMath'
import { equatorialToEcliptic } from './galaxyMath'
import type { Vec3 } from './kepler'

const DEG = Math.PI / 180

/** Where the 3D camera should look, in the scene's ecliptic J2000 frame. */
export interface LiftView {
  forward: Vec3
  up: Vec3
  /** vertical field of view of the viewport, degrees */
  fovDeg: number
  /** where the optical axis lands on screen (px): the photo's centre, which moves as you pan */
  principal: { x: number; y: number }
}

export interface ScreenXform {
  /** screen px per photo px */
  k: number
  ox: number
  oy: number
}

/** Widest view the ground-level camera will show before you start rising off the Earth. */
export const MAX_GROUND_FOV_DEG = 120

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / n, a[1] / n, a[2] / n]
}

/** Of-date equatorial direction -> J2000 ecliptic (the inverse precession is the transpose). */
export function dateToEcliptic(toDate: number[][], v: Vec3): Vec3 {
  const j2000: Vec3 = [
    toDate[0][0] * v[0] + toDate[1][0] * v[1] + toDate[2][0] * v[2],
    toDate[0][1] * v[0] + toDate[1][1] * v[1] + toDate[2][1] * v[2],
    toDate[0][2] * v[0] + toDate[1][2] * v[1] + toDate[2][2] * v[2]
  ]
  return equatorialToEcliptic(j2000)
}

/** The observer's zenith in the scene's frame. */
export const zenithEcliptic = (toDate: number[][], obs: S.Observer): Vec3 => dateToEcliptic(toDate, S.altAzToVec(90, 0, obs))

/** Angular size (radians) of one image pixel at the photo point that sits at the screen centre. */
function radPerImagePx(cam: S.Camera, cx: number, cy: number): number {
  return S.angleBetween(S.unproject(cam, cx, cy), S.unproject(cam, cx, cy - 1))
}

/**
 * The view, in the photo's own (of-date equatorial) frame, that reproduces the photo on screen: it
 * looks along the photo's optical axis with the photo's roll and angular scale, and its principal
 * point sits where the photo's centre does, so panning the photo shifts the 3D view the same way.
 * For a rectilinear photo that is exact; a fisheye photo matches only near its centre, where the
 * scale is well defined.
 */
export function matchViewOfDate(cam: S.Camera, xf: ScreenXform, size: { w: number; h: number }): LiftView {
  const cx = cam.width / 2
  const cy = cam.height / 2
  const forward = S.unproject(cam, cx, cy)
  const above = S.unproject(cam, cx, cy - 4 / xf.k) // 4 screen px up the image
  const up = unit([above[0] - forward[0] * dot(forward, above), above[1] - forward[1] * dot(forward, above), above[2] - forward[2] * dot(forward, above)])
  const perScreenPx = radPerImagePx(cam, cx, cy) / xf.k
  const fov = 2 * Math.atan((size.h / 2) * perScreenPx) / DEG
  return { forward, up, fovDeg: Math.max(1, Math.min(170, fov)), principal: { x: xf.ox + cx * xf.k, y: xf.oy + cy * xf.k } }
}

/** The same view, in the scene's ecliptic J2000 frame. */
export function matchView(cam: S.Camera, toDate: number[][], xf: ScreenXform, size: { w: number; h: number }): LiftView {
  const v = matchViewOfDate(cam, xf, size)
  return { forward: dateToEcliptic(toDate, v.forward), up: dateToEcliptic(toDate, v.up), fovDeg: v.fovDeg, principal: v.principal }
}

/** The photo zoom (screen px per photo px) at which the matched view is `fovDeg` tall, at the photo centre. */
export function zoomForFov(cam: S.Camera, viewportH: number, fovDeg: number): number {
  const perImagePx = radPerImagePx(cam, cam.width / 2, cam.height / 2)
  return (viewportH / 2) * perImagePx / Math.tan((fovDeg * DEG) / 2)
}

/** 0 = photo only .. 1 = 3D only, from how far the photo has been zoomed out relative to filling the window. */
export function liftFade(k: number, fitK: number): number {
  const start = 0.9 * fitK
  const end = 0.5 * fitK
  const t = (start - k) / (start - end)
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)
}

// ---------- altitude ----------

export const MIN_ALTITUDE_M = 2
/** Above this the camera hands over to the free orbit view around the Earth. */
export const ORBIT_ALTITUDE_M = 400_000
const EARTH_RADIUS_M = 6_371_000

/** Altitude after a wheel step: `deltaY` > 0 rises, < 0 sinks. Multiplicative, so it takes as many
 * wheel clicks to go from 2 m to 200 m as from 200 km to 20,000 km. 0 means on the ground. */
export function stepAltitude(altM: number, deltaY: number): number {
  const factor = Math.exp(deltaY * 0.0034)
  if (altM <= 0) return deltaY > 0 ? MIN_ALTITUDE_M * factor : 0
  const next = altM * factor
  return next < MIN_ALTITUDE_M ? 0 : next
}

/** How far the view has tilted from the sky towards the ground: 0 up to ~20 km, 1 by the handover. */
export function nadirBlend(altM: number): number {
  const t = (Math.log(Math.max(altM, 1)) - Math.log(20_000)) / (Math.log(ORBIT_ALTITUDE_M) - Math.log(20_000))
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)
}

/** Distance from the Earth's centre, in Earth radii, for an altitude. */
export const earthRadii = (altM: number): number => (EARTH_RADIUS_M + altM) / EARTH_RADIUS_M
