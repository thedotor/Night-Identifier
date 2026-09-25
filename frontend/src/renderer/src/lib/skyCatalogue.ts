// Client-side view of GET /sky/catalogue: flat typed arrays for the 15k stars (so a
// per-frame scan stays cheap), plus constellation/asterism figures and deep-sky
// objects. Positions are J2000; precess() rotates everything into the camera's
// of-date frame once per observation time, not once per frame.

import { api, skyArtUrl } from './api'
import { add3, applyMatrix, cross, dot, normalize, precessionMatrix, radecToVec, scale3, type Vec3 } from './skyMath'

interface RawFigure {
  abbr: string
  name: string
  kind: 'constellation' | 'asterism'
  stars: { ra: number; dec: number; mag: number; name?: string | null }[]
  lines: [number, number][]
}

export interface Dso {
  id: string
  name: string
  type: string
  ra: number
  dec: number
  mag: number | null
  maj: number | null // arcmin
  min: number | null
  pa: number | null // degrees, north through east
}

interface RawArt {
  size: [number, number]
  anchors: { x: number; y: number; ra: number; dec: number }[]
}

interface RawCatalogue {
  stars: number[] // flat [ra, dec, mag, ...]
  star_names: Record<string, string>
  dsos: Dso[]
  figures: RawFigure[]
  art: Record<string, RawArt>
}

export type DsoGroup = 'nebulae' | 'galaxies' | 'clusters'

/** Which Layers switch controls a deep-sky object (OpenNGC type codes). */
export function dsoGroup(type: string): DsoGroup {
  if (type === 'G' || type === 'GPair' || type === 'GTrpl' || type === 'GGroup') return 'galaxies'
  if (type === 'OCl' || type === 'GCl' || type === '*Ass' || type === '**' || type === 'Other') return 'clusters'
  return 'nebulae' // Neb, HII, EmN, RfN, SNR, DrkN, PN, Cl+N
}

/** Classical illustration for one constellation, laid onto the sky as a grid of directions. */
export interface ArtDef {
  abbr: string
  width: number
  height: number
  /** art-pixel position of each grid node, (ART_GRID + 1)^2 of them, row by row */
  uv: [number, number][]
  /** the same nodes as J2000 sky directions */
  dirs: Vec3[]
}

export const ART_GRID = 8

export interface Catalogue {
  count: number
  ra: Float64Array
  dec: Float64Array
  mag: Float64Array
  /** star indices, brightest first, so scans can stop at a magnitude limit */
  order: Uint32Array
  names: Map<number, string>
  dsos: Dso[]
  figures: RawFigure[]
  art: ArtDef[]
}

/** The catalogue rotated into one observation's frame (see precess). */
export interface SkyView {
  jd: number
  matrix: number[][]
  stars: Float64Array // 3 * count
  dsos: Vec3[]
  figures: Vec3[][] // per figure, per star
  figureCentres: Vec3[]
  art: Vec3[][] // per Catalogue.art entry: its grid nodes in this frame
}

let cached: Promise<Catalogue> | null = null

export function loadCatalogue(): Promise<Catalogue> {
  cached ??= api.get<RawCatalogue>('/sky/catalogue').then(buildCatalogue)
  cached.catch(() => (cached = null))
  return cached
}

function buildCatalogue(raw: RawCatalogue): Catalogue {
  const count = Math.floor(raw.stars.length / 3)
  const ra = new Float64Array(count)
  const dec = new Float64Array(count)
  const mag = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    ra[i] = raw.stars[3 * i]
    dec[i] = raw.stars[3 * i + 1]
    mag[i] = raw.stars[3 * i + 2]
  }
  const order = Uint32Array.from({ length: count }, (_, i) => i).sort((a, b) => mag[a] - mag[b])
  const names = new Map<number, string>()
  for (const [k, v] of Object.entries(raw.star_names)) names.set(Number(k), v)
  return { count, ra, dec, mag, order, names, dsos: raw.dsos, figures: raw.figures, art: buildArt(raw.art ?? {}) }
}

/** Rotate the whole catalogue from J2000 to the equator/equinox of the given Julian date. */
export function precess(cat: Catalogue, jd: number): SkyView {
  const matrix = precessionMatrix(jd)
  const stars = new Float64Array(3 * cat.count)
  for (let i = 0; i < cat.count; i++) {
    const v = applyMatrix(matrix, radecToVec(cat.ra[i], cat.dec[i]))
    stars[3 * i] = v[0]
    stars[3 * i + 1] = v[1]
    stars[3 * i + 2] = v[2]
  }
  const figures = cat.figures.map((f) => f.stars.map((s) => applyMatrix(matrix, radecToVec(s.ra, s.dec))))
  const figureCentres = figures.map((vs) => {
    const sum: Vec3 = [0, 0, 0]
    for (const v of vs) {
      sum[0] += v[0]
      sum[1] += v[1]
      sum[2] += v[2]
    }
    const n = Math.hypot(sum[0], sum[1], sum[2]) || 1
    return [sum[0] / n, sum[1] / n, sum[2] / n] as Vec3
  })
  return {
    jd,
    matrix,
    stars,
    dsos: cat.dsos.map((d) => applyMatrix(matrix, radecToVec(d.ra, d.dec))),
    figures,
    figureCentres,
    art: cat.art.map((a) => a.dirs.map((v) => applyMatrix(matrix, v)))
  }
}

export const starVec = (view: SkyView, i: number): Vec3 => [
  view.stars[3 * i],
  view.stars[3 * i + 1],
  view.stars[3 * i + 2]
]

export function starLabel(cat: Catalogue, i: number): string {
  return cat.names.get(i) ?? `mag ${cat.mag[i].toFixed(1)} · RA ${cat.ra[i].toFixed(2)}° Dec ${cat.dec[i].toFixed(2)}°`
}

// ---------- constellation artwork ----------
// Each picture has 3+ anchor stars (art pixel <-> RA/Dec). The picture is treated as a flat
// drawing of the sky around its anchors (a gnomonic tangent plane): a least-squares affine
// fit takes art pixels to plane coordinates, and a grid of art points is turned into sky
// directions once. Every frame the grid is pushed through the camera, so the picture bends
// with the lens exactly like the constellation lines do.

/** Solve the 3x3 system m x = b (Cramer's rule); null if singular. */
function solve3(m: number[][], b: number[]): number[] | null {
  const det = (a: number[][]): number =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
  const d = det(m)
  if (Math.abs(d) < 1e-12) return null
  return [0, 1, 2].map((c) => det(m.map((row, r) => row.map((v, k) => (k === c ? b[r] : v)))) / d)
}

function buildArt(raw: Record<string, RawArt>): ArtDef[] {
  const out: ArtDef[] = []
  for (const [abbr, info] of Object.entries(raw)) {
    const anchors = info.anchors
    if (anchors.length < 3) continue
    const vecs = anchors.map((a) => radecToVec(a.ra, a.dec))
    const c = normalize(vecs.reduce((acc, v) => add3(acc, v), [0, 0, 0] as Vec3))
    const east = normalize(cross([0, 0, 1], c))
    const north = cross(c, east)
    const plane = vecs.map((v) => {
      const d = dot(v, c)
      return [dot(v, east) / d, dot(v, north) / d] as [number, number]
    })

    // Normal equations for [x y 1] * coeffs = plane, one column at a time.
    const ata = [0, 1, 2].map(() => [0, 0, 0])
    const atb = [[0, 0, 0], [0, 0, 0]]
    anchors.forEach((a, i) => {
      const row = [a.x, a.y, 1]
      for (let r = 0; r < 3; r++) {
        for (let k = 0; k < 3; k++) ata[r][k] += row[r] * row[k]
        atb[0][r] += row[r] * plane[i][0]
        atb[1][r] += row[r] * plane[i][1]
      }
    })
    const cx = solve3(ata, atb[0])
    const cy = solve3(ata, atb[1])
    if (!cx || !cy) continue

    const [w, h] = info.size
    const uv: [number, number][] = []
    const dirs: Vec3[] = []
    for (let j = 0; j <= ART_GRID; j++)
      for (let i = 0; i <= ART_GRID; i++) {
        const x = (i / ART_GRID) * w
        const y = (j / ART_GRID) * h
        const xi = cx[0] * x + cx[1] * y + cx[2]
        const eta = cy[0] * x + cy[1] * y + cy[2]
        uv.push([x, y])
        dirs.push(normalize(add3(c, add3(scale3(east, xi), scale3(north, eta)))))
      }
    out.push({ abbr, width: w, height: h, uv, dirs })
  }
  return out
}

// ---------- artwork images (loaded on demand) ----------

const artImages = new Map<string, HTMLImageElement>()
const artListeners = new Set<() => void>()

/** The drawing for a constellation once it has loaded (starts the download the first time). */
export function artImage(abbr: string): HTMLImageElement | null {
  let img = artImages.get(abbr)
  if (!img) {
    img = new Image()
    img.onload = () => artListeners.forEach((f) => f())
    img.src = skyArtUrl(abbr)
    artImages.set(abbr, img)
  }
  return img.complete && img.naturalWidth > 0 ? img : null
}

/** Called whenever a drawing finishes loading, so the canvas can repaint. */
export function onArtLoaded(fn: () => void): () => void {
  artListeners.add(fn)
  return () => artListeners.delete(fn)
}
