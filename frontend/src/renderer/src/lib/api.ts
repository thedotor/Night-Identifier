const BASE_URL = 'http://127.0.0.1:8765'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new ApiError(res.status, text)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export interface HealthStatus {
  status: 'ok'
  gpu_available: boolean
  gpu_name: string | null
  version: string
}

export const api = {
  health: (): Promise<HealthStatus> => request('/health'),
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' })
}

export function wsUrl(path: string): string {
  return `ws://127.0.0.1:8765${path}`
}

export function previewUrl(imageId: number): string {
  return `${BASE_URL}/images/${imageId}/preview`
}

export function skyArtUrl(abbr: string): string {
  return `${BASE_URL}/sky/art/${abbr}`
}

export function referenceImageUrl(objectTypeId: number): string {
  return `${BASE_URL}/objects/${objectTypeId}/reference-image`
}

/** Backend-relative path (as returned in DeepSpaceImage.src) -> absolute URL. */
export function deepspaceSrc(src: string): string {
  return `${BASE_URL}${src}`
}

/** North-up survey image centred on (ra, dec), J2000 degrees; `fov` is the field width in degrees. */
export function deepspaceCutoutUrl(ra: number, dec: number, fov: number, size: number, survey = 'dss2'): string {
  const q = new URLSearchParams({
    ra: ra.toFixed(4),
    dec: dec.toFixed(4),
    fov: fov.toFixed(4),
    w: String(size),
    h: String(size),
    survey
  })
  return `${BASE_URL}/deepspace/cutout?${q}`
}

export type DeepSpaceKind = 'dso' | 'star' | 'body'

export interface DeepSpaceImage {
  src: string
  credit: string
  license: string
  source_url: string | null
  caption: string
  kind: 'photo' | 'survey'
}

export interface DeepSpaceObject {
  kind: DeepSpaceKind
  key: string
  title: string
  subtitle: string
  facts: { label: string; value: string }[]
  description: string | null
  description_url: string | null
  images: DeepSpaceImage[]
  /** true when the archives could not be reached, so description/photos may be missing */
  offline: boolean
}

export interface DeepSpacePackStatus {
  running: boolean
  total: number
  done: number
  failed: number
  current: string | null
  cache_bytes: number
}

export interface ObjectType {
  id: number
  name: string
  description: string
  reference_image_path: string | null
}

export type ImageStatus = 'imported' | 'annotated' | 'processed'
export type ImageCategory = 'library' | 'training'

export interface ImageRecord {
  id: number
  filename: string
  width: number
  height: number
  file_size_bytes: number
  status: ImageStatus
  category: ImageCategory
  latitude?: number | null
  longitude?: number | null
}

export interface ImageProperties {
  filename: string
  width: number
  height: number
  file_size_bytes: number
  stored_path: string
  status: ImageStatus
  created_at: string
}

export interface ImageStats {
  total: number
  pending: number
}

export interface DashboardStats {
  library_images: number
  training_images: number
  processed_images: number
  geotagged_images: number
  storage_bytes: number
  object_types: number
  manual_annotations: number
  detections: number
  training_runs: number
  completed_training_runs: number
}

export interface WatchFolderStatus {
  watch_dir: string
  watching: boolean
}

export type ScanEvent =
  | { type: 'watch_status'; watching: boolean; watch_dir: string | null }
  | { type: 'scanning'; filename: string }
  | { type: 'imported'; image: ImageRecord }
  | { type: 'skipped'; filename: string; reason: string }
  | { type: 'import_start'; total: number }
  | {
      type: 'import_progress'
      processed: number
      total: number
      filename: string
      status: 'imported' | 'skipped'
    }

export type TrainingStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped'

export interface TrainingRun {
  id: number
  status: TrainingStatus
  device: string
  epochs: number
  batch_size: number
  workers: number
  current_epoch: number
  image_count: number
  class_count: number
  metrics: Record<string, number>
  error_message: string | null
  model_path: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface TrainingReadiness {
  ready: boolean
  object_type_count: number
  annotated_image_count: number
  message: string | null
}

export interface GpuDevice {
  index: number
  name: string
}

export interface DeviceList {
  available: boolean
  devices: GpuDevice[]
}

export interface TrainingStatusOut {
  is_running: boolean
  current_run_id: number | null
  latest_run: TrainingRun | null
  has_model: boolean
}

export type TrainingEvent =
  | {
      type: 'status'
      run_id: number
      status: TrainingStatus
      error?: string
      image_count?: number
      class_count?: number
      model_path?: string
    }
  | {
      type: 'epoch'
      run_id: number
      epoch: number
      total_epochs: number
      metrics: Record<string, number>
    }

export interface StarCandidate {
  x: number
  y: number
  brightness: number
}

export type StarLabelType = 'star' | 'not_star'

export interface StarLabelRecord {
  id: number
  x: number
  y: number
  label: StarLabelType
}

export interface StarClassifierSummary {
  star_count: number
  not_star_count: number
  min_per_class: number
  ready_to_train: boolean
  has_model: boolean
}

export type StarClassifierRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped'

export interface StarClassifierRun {
  id: number
  status: StarClassifierRunStatus
  device: string
  epochs: number
  current_epoch: number
  label_count: number
  metrics: Record<string, number>
  error_message: string | null
  model_path: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface StarClassifierStatusOut {
  is_running: boolean
  current_run_id: number | null
  latest_run: StarClassifierRun | null
  has_model: boolean
}

export type StarClassifierEvent =
  | {
      type: 'status'
      run_id: number
      status: StarClassifierRunStatus
      error?: string
      label_count?: number
      device?: string
      model_path?: string
    }
  | {
      type: 'epoch'
      run_id: number
      epoch: number
      total_epochs: number
      metrics: Record<string, number>
    }

export type ShapeType = 'rect' | 'ellipse' | 'polygon'

export interface RectGeometry {
  x: number
  y: number
  width: number
  height: number
}

export interface EllipseGeometry {
  cx: number
  cy: number
  rx: number
  ry: number
}

export interface PolygonGeometry {
  points: number[]
}

export type Geometry = RectGeometry | EllipseGeometry | PolygonGeometry

export interface Annotation {
  id: number
  image_id: number
  object_type_id: number
  shape_type: ShapeType
  geometry: Geometry
}

export interface Detection {
  id: number
  object_type_id: number
  shape_type: ShapeType
  geometry: Geometry
  confidence: number | null
}

export interface ResultImage {
  image: ImageRecord
  detections: Detection[]
}

export interface ResultsStatus {
  is_running: boolean
  has_model: boolean
  total_images: number
  processed_images: number
}

export type ResultsEvent =
  | { type: 'start'; total: number }
  | { type: 'progress'; processed: number; total: number; filename: string; detection_count: number }
  | { type: 'image_error'; filename: string; error: string }
  | { type: 'stopped'; processed: number; total: number }
  | { type: 'completed'; processed: number; total: number }
  | { type: 'error'; error: string }

export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'

export interface LogEntry {
  id: number
  timestamp: string
  level: LogLevel
  source: string
  message: string
}

export interface DataDirInfo {
  path: string
  default_path: string
}

export interface DataDirMoveResult {
  path: string
  restart_required: boolean
}

export interface MapImage {
  id: number
  filename: string
  latitude: number
  longitude: number
  captured_at: string | null
}

export interface SkySummary {
  lens_model: string | null
  camera_model: string | null
  focal_mm: number | null
  focal_35mm: number | null
  diagonal_fov_deg: number | null
  captured_utc: string | null
  captured_local: string | null
  time_source: string | null
  latitude: number | null
  longitude: number | null
  hemisphere: string | null
  applied: string[]
  candidates_considered: number | null
}

