import * as THREE from 'three'
import { getQualitySetting, planFor, probeGpuName } from '@renderer/lib/graphicsQuality'

/**
 * The sharp Earth pictures (NASA Blue Marble and Black Marble, 5K or 10K wide), fetched once when the app starts and kept as the compressed
 * files, so a 3D Earth that opens later (the Earth page, Solar System, a dashboard globe) already has them and only has to unpack them.
 * The backend stitches and caches them on its first request, which can take a while; asking early hides that.
 */

const BASE = 'http://127.0.0.1:8765/deepspace/earth-map'
const blobs = new Map<string, Promise<Blob | null>>()

export type MapKind = 'day' | 'night'

/** The level this computer will use (0: just the small map that is always there), or 0 when the graphics card cannot hold it. */
export function wantedEarthLevel(maxTextureSize: number): 0 | 3 | 4 {
  const level = planFor(getQualitySetting(), probeGpuName()).plan.earthMapLevel
  if (level === 4 && maxTextureSize < 10240) return maxTextureSize >= 5120 ? 3 : 0
  if (level === 3 && maxTextureSize < 5120) return 0
  return level
}

function fetchBlob(kind: MapKind, level: number): Promise<Blob | null> {
  const key = `${kind}${level}`
  let p = blobs.get(key)
  if (!p) {
    p = fetch(`${BASE}/${kind}/${level}`)
      .then((r) => (r.ok ? r.blob() : null))
      .catch(() => null)
      .then((b) => {
        if (!b) blobs.delete(key) // try again next time it is asked for
        return b
      })
    blobs.set(key, p)
  }
  return p
}

/** Start fetching the maps this computer will want. Safe to call more than once. */
export function preloadEarthMaps(): void {
  let max = 8192
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2') ?? c.getContext('webgl')
    if (gl) {
      max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  } catch {
    /* keep the guess */
  }
  const level = wantedEarthLevel(max)
  if (!level) return
  void fetchBlob('day', level).then(() => fetchBlob('night', level))
}

/** A texture of the sharp map, unpacked from the kept file (fetched now if it was not preloaded). Null when it cannot be had. */
export async function earthMapTexture(kind: MapKind, level: number, anisotropy: number): Promise<THREE.Texture | null> {
  const blob = await fetchBlob(kind, level)
  if (!blob) return null
  try {
    // unpacked off the main thread; already flipped, as three.js expects of a bitmap
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const t = new THREE.Texture(bitmap as unknown as HTMLImageElement)
    t.flipY = false
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = anisotropy
    t.needsUpdate = true
    return t
  } catch {
    return null
  }
}
