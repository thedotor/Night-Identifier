// How hard the 3D views work. The Deep Space scene draws hundreds of thousands of points and a
// large logarithmic-depth scene, which a modern GPU shrugs off and a weak or software one may not.
// "Auto" looks at the GPU's name and picks; the rest are explicit.

export type QualitySetting = 'auto' | 'low' | 'medium' | 'high'
export type QualityLevel = 'low' | 'medium' | 'high'

export interface QualityPlan {
  antialias: boolean
  /** cap on the device pixel ratio the 3D canvas renders at */
  pixelRatioCap: number
  /** points in the schematic Milky Way */
  milkyWayPoints: number
  /** faintest Hipparcos star drawn in the 3D cloud (apparent magnitude at the Sun) */
  maxStarVmag: number
  /** longitude x latitude segments of the Earth's globe */
  earthSegments: [number, number]
}

export const PLANS: Record<QualityLevel, QualityPlan> = {
  low: { antialias: false, pixelRatioCap: 1, milkyWayPoints: 50_000, maxStarVmag: 7.5, earthSegments: [96, 48] },
  medium: { antialias: true, pixelRatioCap: 1.25, milkyWayPoints: 120_000, maxStarVmag: 9, earthSegments: [144, 72] },
  high: { antialias: true, pixelRatioCap: 1.5, milkyWayPoints: 220_000, maxStarVmag: 99, earthSegments: [192, 96] }
}

export const QUALITY_LABELS: Record<QualitySetting, { label: string; description: string }> = {
  auto: { label: 'Auto', description: 'Picks from your graphics card' },
  low: { label: 'Low', description: 'Fewer stars, no edge smoothing: for integrated or software graphics' },
  medium: { label: 'Medium', description: 'A balance for laptops' },
  high: { label: 'High', description: 'Everything: 38,000 stars and a dense galaxy' }
}

const STORAGE_KEY = 'night-identifier:graphics-quality'

export function getQualitySetting(): QualitySetting {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'low' || v === 'medium' || v === 'high' || v === 'auto') return v
  } catch {
    /* storage unavailable: fall through */
  }
  return 'auto'
}

export function setQualitySetting(q: QualitySetting): void {
  try {
    localStorage.setItem(STORAGE_KEY, q)
  } catch {
    /* the choice just won't persist */
  }
}

/** The graphics card's own name, or '' when the browser won't say. */
export function probeGpuName(): string {
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl') ?? c.getContext('experimental-webgl')) as WebGLRenderingContext | null
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    const name = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return name
  } catch {
    return ''
  }
}

/** What "auto" means for a given GPU name. */
export function autoLevel(gpuName: string): QualityLevel {
  if (/swiftshader|llvmpipe|softpipe|basic render|software|microsoft basic/i.test(gpuName)) return 'low'
  if (/intel.*(hd|uhd|iris)|intel\(r\)|radeon(\(tm\))? graphics|vega \d+ graphics/i.test(gpuName) && !/arc|rtx|geforce|radeon rx|radeon pro/i.test(gpuName)) return 'medium'
  return 'high'
}

export function planFor(setting: QualitySetting, gpuName: string): { level: QualityLevel; plan: QualityPlan } {
  const level = setting === 'auto' ? autoLevel(gpuName) : setting
  return { level, plan: PLANS[level] }
}
