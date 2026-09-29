// Types and REST helpers for the Live View backend (/live). Frames themselves travel over the
// WebSocket in liveSocket.ts.

import { api } from '@renderer/lib/api'

export type CameraState = 'stopped' | 'connecting' | 'running' | 'lost' | 'error' | 'unavailable'

export interface LiveControl {
  name: string
  label: string
  kind: 'range' | 'toggle' | 'choice' | 'action' | 'buttons' | 'info' | 'jog'
  value: number | boolean | string | null
  min: number | null
  max: number | null
  step: number | null
  unit: string
  choices: string[] | null
  log: boolean
  group: string
}

export interface CameraStatus {
  id: string
  state: CameraState
  error: string | null
  fps: number
  width: number | null
  height: number | null
  bit_depth: number | null
  viewers: number
  astro: boolean
  info: { model?: string; sensor?: string; bit_depth?: number; stills?: boolean }
  recording: boolean
  sequence: boolean
  detecting: boolean
  controls: LiveControl[]
}

export interface MotionSettings {
  enabled: boolean
  mode: 'motion' | 'meteor'
  sensitivity: number
  min_area_pct: number
  cooldown_s: number
  save_frame: boolean
  save_clip: boolean
}

export interface LiveCamera {
  id: string
  name: string
  kind: string
  params: Record<string, string | number | boolean | null>
  background: boolean
  auto_reconnect: boolean
  motion: MotionSettings
  status: CameraStatus | null
}

export interface OnvifStream {
  name: string
  uri: string
  width: number
  height: number
  encoding: string
}

export type Tested = 'hardware' | 'simulated' | 'untested'

export interface Candidate {
  kind: string
  name: string
  params: Record<string, string | number | boolean | null>
  note?: string
  tested?: Tested
}

export interface KindInfo {
  kind: string
  label: string
  tested: Tested
}

export interface DriverDiagnostic extends KindInfo {
  available: boolean
  note: string
  /** Where this driver's vendor SDK files go (Documents/Night Identifier/...), for kinds that need one. */
  sdk_path?: string | null
}

export interface StretchSpec {
  mode: 'auto' | 'off' | 'manual'
  black: number
  white: number
  mid: number
}

export interface HistogramData {
  bins: number[]
  median: number
  max: number
  clipped: number
  black: number
}

export interface FocusData {
  fwhm: number | null
  stars: number
  sharp: number
}

export interface FrameHeader {
  cam: string
  seq: number
  ts: number
  w: number
  h: number
  sw: number
  sh: number
  bits: number
  fps: number
  exp: number | null
  temp?: number
  hist?: HistogramData
  focus?: FocusData | null
}

export type LiveEvent =
  | ({ type: 'status' } & CameraStatus)
  | { type: 'hello'; cameras: Record<string, CameraStatus> }
  | { type: 'error'; camera: string; error: string }
  | { type: 'lost'; camera: string; name: string; error: string }
  | { type: 'reconnected'; camera: string; name: string }
  | { type: 'photo'; camera: string; name: string; file: string; image_id: number | null }
  | { type: 'motion'; camera: string; name: string; kind: string; file?: string | null; changed_pct?: number }
  | { type: 'sequence_done'; camera: string; name: string; frames: number; imported: number; folder: string; stopped_early: boolean }
  | { type: 'progress'; camera: string; kind: string; done: number; total: number }

export const live = {
  cameras: (): Promise<LiveCamera[]> => api.get('/live/cameras'),
  kinds: (): Promise<KindInfo[]> => api.get('/live/kinds'),
  discover: (): Promise<Candidate[]> => api.post('/live/discover'),
  probe: (kind: string, host: string, port?: number): Promise<Candidate[]> => api.post('/live/probe', { kind, host, port }),
  onvif: (host: string, port: number | undefined, username: string, password: string): Promise<OnvifStream[]> =>
    api.post('/live/onvif', { host, port, username: username || undefined, password: password || undefined }),
  diagnostics: (): Promise<DriverDiagnostic[]> => api.get('/live/diagnostics'),
  folder: (): Promise<{ path: string }> => api.get('/live/folder'),
  add: (body: { name: string; kind: string; params: Candidate['params']; background?: boolean }): Promise<LiveCamera> =>
    api.post('/live/cameras', body),
  patch: (id: string, body: Partial<Pick<LiveCamera, 'name' | 'params' | 'background' | 'auto_reconnect'>> & { motion?: Partial<MotionSettings> }): Promise<LiveCamera> =>
    request('PATCH', `/live/cameras/${id}`, body),
  remove: (id: string): Promise<void> => api.delete(`/live/cameras/${id}`),
  start: (id: string): Promise<LiveCamera> => api.post(`/live/cameras/${id}/start`),
  stop: (id: string): Promise<LiveCamera> => api.post(`/live/cameras/${id}/stop`),
  setControl: (id: string, name: string, value: unknown): Promise<{ applied: boolean; queued?: boolean }> =>
    api.put(`/live/cameras/${id}/controls/${name}`, { value }),
  snapshot: (id: string, stretch: StretchSpec | null): Promise<{ image_id: number; filename: string; saved_to: string }> =>
    api.post(`/live/cameras/${id}/snapshot`, { stretch }),
  capture: (id: string, body: { format: FrameFormat; to_library: boolean; stretch: StretchSpec | null }): Promise<{ saved_to: string; filename: string; image_id?: number }> =>
    api.post(`/live/cameras/${id}/capture`, body),
  record: (id: string, body: { format: 'mp4' | 'ser'; stretch: StretchSpec | null }): Promise<{ file: string }> => api.post(`/live/cameras/${id}/record`, body),
  stopRecord: (id: string): Promise<{ file: string; frames: number; dropped: number; seconds: number; error: string | null }> =>
    api.post(`/live/cameras/${id}/record/stop`),
  sequence: (
    id: string,
    body: { count: number; interval_s: number; format: FrameFormat; to_library: boolean; stretch: StretchSpec | null }
  ): Promise<{ folder: string; count: number }> => api.post(`/live/cameras/${id}/sequence`, body),
  stopSequence: (id: string): Promise<{ done: number }> => api.post(`/live/cameras/${id}/sequence/stop`),
  /** point sources in the newest frame (camera pixels, brightest first) and when it was taken (unix seconds) */
  stars: (id: string): Promise<{ stars: [number, number, number][]; width: number; height: number; timestamp: number }> =>
    api.get(`/live/cameras/${id}/stars`)
}

export type FrameFormat = 'fits' | 'png' | 'jpg'

const BASE = 'http://127.0.0.1:8765'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (!res.ok) throw new Error((await res.text().catch(() => res.statusText)) || res.statusText)
  return res.json() as Promise<T>
}

/** FastAPI error bodies are {"detail": "..."}; show just the message. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown }
    if (typeof parsed.detail === 'string') return parsed.detail
  } catch {
    /* not JSON */
  }
  return raw
}
