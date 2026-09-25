// Registering a north-up survey cut-out onto the photo. Pure functions (no DOM), so they run under
// `node` for scripts/skySurvey.check.ts.

import * as S from './skyMath'

const DEG = Math.PI / 180

/** A north-up (east left) tangent-plane image of the sky. */
export interface SurveyPatch {
  /** centre of the image, J2000 degrees */
  ra: number
  dec: number
  /** field width in degrees */
  fovDeg: number
  /** image size in pixels */
  width: number
  height: number
}

export type Affine = [number, number, number, number, number, number]

/**
 * Canvas transform [a b c d e f] taking survey pixels (u right, v down) to photo pixels through
 * the camera, or null if the cut-out's centre is outside what the lens images. `toDate` rotates
 * J2000 into the frame the camera lives in. The map is the local affine one at the cut-out
 * centre: the cut-out is a few degrees at most, and any lens distortion across it is far below
 * what the survey resolves.
 */
export function surveyMatrix(cam: S.Camera, toDate: number[][], s: SurveyPatch): Affine | null {
  // The survey is north-up in J2000, so build its axes there and only then rotate them into the
  // camera's frame; near the poles precession turns "north" by a lot.
  const c0J = S.radecToVec(s.ra, s.dec)
  const eastJ = S.normalize(S.cross([0, 0, 1], c0J))
  const c0 = S.applyMatrix(toDate, c0J)
  const p0 = S.project(cam, c0)
  if (!p0) return null
  const east = S.applyMatrix(toDate, eastJ)
  const north = S.applyMatrix(toDate, S.cross(c0J, eastJ))
  const radPerPx = (s.fovDeg * DEG) / s.width
  const eps = radPerPx * 16
  const pe = S.project(cam, S.normalize(S.add3(c0, S.scale3(east, eps))))
  const pn = S.project(cam, S.normalize(S.add3(c0, S.scale3(north, eps))))
  if (!pe || !pn) return null
  // Survey u grows towards decreasing RA (east is left) and v towards the south.
  const a = (-(pe.x - p0.x) / eps) * radPerPx
  const b = (-(pe.y - p0.y) / eps) * radPerPx
  const c = (-(pn.x - p0.x) / eps) * radPerPx
  const d = (-(pn.y - p0.y) / eps) * radPerPx
  return [a, b, c, d, p0.x - a * (s.width / 2) - c * (s.height / 2), p0.y - b * (s.width / 2) - d * (s.height / 2)]
}
