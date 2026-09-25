// Zoom-in fade: past a magnification threshold the photo cross-fades into real survey imagery
// (DSS2 via the backend's /deepspace/cutout) of the patch of sky under the view, laid onto the
// same camera so stars and the overlay line up with it. The image is registered per frame by
// surveyMatrix(); this hook only decides how far the fade has gone and which cut-out to load.

import { useEffect, useMemo, useState } from 'react'
import * as S from '@renderer/lib/skyMath'
import { deepspaceCutoutUrl } from '@renderer/lib/api'
import type { SkyView } from '@renderer/lib/skyCatalogue'
import type { SurveyPatch } from '@renderer/lib/skySurvey'

const DEG = Math.PI / 180
const QUANT = 1.25 // requested fields step by this factor so nearby views share one cut-out
const MARGIN = 1.25 // extra field around the view, so small pans need no new image
const MIN_FOV_DEG = 0.02
const MAX_FOV_DEG = 20 // wider than this, one survey image says nothing a photo doesn't
const CUTOUT_PX = 1024
const DEBOUNCE_MS = 300
/** The fade runs from START to START * FADE_SPAN screen px per photo px. */
const FADE_SPAN = 3

export const SURVEY_CREDIT = 'Sky survey: DSS2 (STScI / ESO / Caltech), via CDS Strasbourg'

export interface LoadedSurvey {
  img: HTMLImageElement
  /** centre of the cut-out, J2000 degrees */
  ra: number
  dec: number
  /** field width in degrees (north up, east left) */
  fovDeg: number
}

export type SurveyStatus = 'idle' | 'loading' | 'ok' | 'error'

export interface SurveyFade {
  /** 0 = photo only .. 1 = survey only */
  t: number
  survey: LoadedSurvey | null
  status: SurveyStatus
}

interface Args {
  enabled: boolean
  camera: S.Camera
  view: SkyView | null
  xf: { k: number; ox: number; oy: number }
  size: { w: number; h: number }
  /** screen px per photo px when the whole photo is fitted */
  fitK: number
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/** Inverse of a rotation matrix is its transpose. */
const transposed = (m: number[][]): number[][] => m[0].map((_, i) => m.map((row) => row[i]))

export function useSurveyFade({ enabled, camera, view, xf, size, fitK }: Args): SurveyFade {
  const start = Math.max(0.8, 3 * fitK)
  const t = enabled && view ? clamp01((xf.k - start) / (start * (FADE_SPAN - 1))) : 0

  const [survey, setSurvey] = useState<LoadedSurvey | null>(null)
  const [status, setStatus] = useState<SurveyStatus>('idle')

  // What to load: the patch under the view centre, quantised so a small pan or zoom keeps the same request.
  const target = useMemo(() => {
    if (t <= 0 || !view) return null
    const hw = size.w / 2 / xf.k
    const hh = size.h / 2 / xf.k
    const cx = (size.w / 2 - xf.ox) / xf.k
    const cy = (size.h / 2 - xf.oy) / xf.k
    const diag = S.angleBetween(S.unproject(camera, cx - hw, cy - hh), S.unproject(camera, cx + hw, cy + hh)) / DEG
    if (!Number.isFinite(diag) || diag * MARGIN > MAX_FOV_DEG) return null
    const fov = MIN_FOV_DEG * Math.pow(QUANT, Math.ceil(Math.log(Math.max(diag * MARGIN, MIN_FOV_DEG) / MIN_FOV_DEG) / Math.log(QUANT)))
    const c = S.vecToRadec(S.applyMatrix(transposed(view.matrix), S.unproject(camera, cx, cy)))
    const step = fov / 8
    const dec = Math.round(c.dec / step) * step
    const raStep = step / Math.max(Math.cos(dec * DEG), 0.05)
    const ra = (((Math.round(c.ra / raStep) * raStep) % 360) + 360) % 360
    return { ra, dec: Math.max(-90, Math.min(90, dec)), fov }
  }, [t > 0, view, camera, xf.k, xf.ox, xf.oy, size.w, size.h]) // eslint-disable-line react-hooks/exhaustive-deps

  const key = target ? `${target.ra.toFixed(4)}|${target.dec.toFixed(4)}|${target.fov.toFixed(4)}` : null

  useEffect(() => {
    if (!target) return
    let live = true
    const timer = setTimeout(() => {
      setStatus('loading')
      const img = new Image()
      img.onload = () => {
        if (!live) return
        setSurvey({ img, ra: target.ra, dec: target.dec, fovDeg: target.fov })
        setStatus('ok')
      }
      img.onerror = () => live && setStatus('error')
      img.src = deepspaceCutoutUrl(target.ra, target.dec, target.fov, CUTOUT_PX)
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { t, survey, status: target ? status : 'idle' }
}
