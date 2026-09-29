// Wind and sea-current fields for the 3D Earth: fetched from the backend as small "velocity pictures" (see backend/app/services/flow.py),
// sampled for the moving particles and for the click readout.
import { deepspaceSrc } from './api'
import { compassOf } from './lightning'

export type FlowKind = 'wind' | 'currents'
export type WindLevel = '10m' | '850' | '500' | '250'

export const WIND_LEVELS: { id: WindLevel; label: string; hint: string }[] = [
  { id: '10m', label: 'Surface (10 m)', hint: 'The wind at head height, what you feel on the ground' },
  { id: '850', label: '850 hPa (about 1.5 km)', hint: 'The wind at about 1.5 km up, above most of the ground friction' },
  { id: '500', label: '500 hPa (about 5.5 km)', hint: 'Mid-level winds, the ones that steer weather systems' },
  { id: '250', label: 'Jet stream (250 hPa, about 10 km)', hint: 'The jet streams, at the height airliners cruise' }
]

/** How many model seconds pass per real second, so the flow is watchable (the real wind would look still). Relative to each layer's own base rate. */
export const WIND_TIME_SCALE: Record<WindLevel, number> = { '10m': 1, '850': 0.8, '500': 0.5, '250': 0.35 }

/** The speed (m/s) at the hot end of the colour scale. */
export const speedMax = (kind: FlowKind, level: WindLevel = '10m'): number => (kind === 'currents' ? 1.2 : { '10m': 25, '850': 40, '500': 60, '250': 90 }[level])

/** Blue (calm) to red (fast). Also written into the particle shader, so the legend matches the picture. */
export const FLOW_STOPS: { at: number; rgb: [number, number, number] }[] = [
  { at: 0, rgb: [0.35, 0.55, 1.0] },
  { at: 0.25, rgb: [0.3, 0.9, 0.9] },
  { at: 0.5, rgb: [0.6, 1.0, 0.4] },
  { at: 0.75, rgb: [1.0, 0.9, 0.3] },
  { at: 1, rgb: [1.0, 0.35, 0.25] }
]
export const flowCss = (): string => `linear-gradient(90deg, ${FLOW_STOPS.map((s) => `rgb(${s.rgb.map((c) => Math.round(c * 255)).join(',')}) ${s.at * 100}%`).join(', ')})`

export interface FlowGrid {
  w: number
  h: number
  /** eastward and northward speed, m/s; row 0 is the north pole */
  u: Float32Array
  v: Float32Array
  /** 1 where there is data (currents have none on land) */
  ok: Uint8Array
  /** the longitude of the left edge */
  lon0: number
  validMs: number
  firstMs: number
  lastMs: number
  credit: string
}

/** The date asked for is outside what the source covers. */
export class FlowNoData extends Error {}

export async function fetchFlow(kind: FlowKind, level: WindLevel, tMs: number, signal?: AbortSignal): Promise<FlowGrid> {
  const url = kind === 'wind' ? `/flow/wind?level=${level}&t=${Math.round(tMs)}` : `/flow/currents?t=${Math.round(tMs)}`
  const res = await fetch(deepspaceSrc(url), { signal })
  if (res.status === 404) throw new FlowNoData()
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? detail
    } catch {
      /* keep the status */
    }
    throw new Error(detail)
  }
  const range = Number(res.headers.get('X-Range')) || 1
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
  const n = bitmap.width * bitmap.height
  const u = new Float32Array(n)
  const v = new Float32Array(n)
  const ok = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    u[i] = ((px[4 * i] / 255) * 2 - 1) * range
    v[i] = ((px[4 * i + 1] / 255) * 2 - 1) * range
    ok[i] = px[4 * i + 2] > 127 ? 1 : 0
  }
  const h = res.headers
  bitmap.close()
  return {
    w: canvas.width,
    h: canvas.height,
    u,
    v,
    ok,
    lon0: Number(h.get('X-Lon0')) || 0,
    validMs: Number(h.get('X-Valid-Time')),
    firstMs: Number(h.get('X-First-Time')),
    lastMs: Number(h.get('X-Last-Time')),
    credit: h.get('X-Credit') ?? ''
  }
}

/** The flow at a place (m/s), interpolated between the picture's pixels; null where there is no data (or too near it). */
export function sampleFlow(g: FlowGrid, latDeg: number, lonDeg: number, out: { u: number; v: number } = { u: 0, v: 0 }): { u: number; v: number } | null {
  const fx = ((((lonDeg - g.lon0) / 360) % 1) + 1) % 1
  const x = fx * g.w - 0.5
  const y = Math.min(g.h - 1, Math.max(0, ((90 - latDeg) / 180) * g.h - 0.5))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = x - x0
  const ty = y - y0
  const y1 = Math.min(g.h - 1, y0 + 1)
  const xa = ((x0 % g.w) + g.w) % g.w
  const xb = (xa + 1) % g.w
  let su = 0
  let sv = 0
  let sw = 0
  const add = (xi: number, yi: number, wgt: number): void => {
    const i = yi * g.w + xi
    if (g.ok[i]) {
      su += g.u[i] * wgt
      sv += g.v[i] * wgt
      sw += wgt
    }
  }
  add(xa, y0, (1 - tx) * (1 - ty))
  add(xb, y0, tx * (1 - ty))
  add(xa, y1, (1 - tx) * ty)
  add(xb, y1, tx * ty)
  if (sw < 0.5) return null
  out.u = su / sw
  out.v = sv / sw
  return out
}

const KNOTS = 1.943844
export const toKnots = (ms: number): number => ms * KNOTS

/** "12 m/s (23 kt) from the WSW": winds are named for where they come from. */
export function windWords(u: number, v: number): string {
  const sp = Math.hypot(u, v)
  const from = (Math.atan2(u, v) * 180) / Math.PI + 180
  return `${sp.toFixed(1)} m/s (${Math.round(toKnots(sp))} kt) from the ${compassOf(((from % 360) + 360) % 360)}`
}

/** "0.8 m/s (1.6 kt) toward the NE": currents are named for where they go. */
export function currentWords(u: number, v: number): string {
  const sp = Math.hypot(u, v)
  const to = (Math.atan2(u, v) * 180) / Math.PI
  return `${sp.toFixed(2)} m/s (${toKnots(sp).toFixed(1)} kt) toward the ${compassOf(((to % 360) + 360) % 360)}`
}
