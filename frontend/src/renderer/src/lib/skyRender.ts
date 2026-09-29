// Overlay renderer. Everything is drawn as vectors by pushing catalogue directions
// through the current Camera (skyMath.project), so constellation lines bend correctly
// under fisheye projections and move/rotate/scale are only ever camera edits.
//
// The canvas context is expected to be in image-pixel coordinates; `k` is screen
// pixels per image pixel so strokes and text keep a constant on-screen size.

import * as S from './skyMath'
import { artImage, ART_GRID, dsoGroup, starVec, type Catalogue, type DsoGroup, type SkyView } from './skyCatalogue'
import type { Body } from './skyEphemeris'
import { colorOf, isBright, type SatFrame } from './satellites'
import type { PlaneFrame } from './aircraft'
import { drawShape, kindInfo } from './aircraftIcons'
import type { MeteorStreak } from './meteorStreaks'

export interface Layers {
  stars: boolean
  constellations: boolean
  asterisms: boolean
  art: boolean // classical constellation illustrations
  planets: boolean // Sun, Moon and planets
  satellites: boolean // ISS, Starlink...: what and when is chosen in the Satellites panel
  nebulae: boolean
  galaxies: boolean
  clusters: boolean
  labels: boolean
  horizon: boolean
  opacity: number // 0..1
  artOpacity: number // 0..1, on top of opacity
  magOffset: number // added to the automatic magnitude limit
}

export const DEFAULT_LAYERS: Layers = {
  stars: true,
  constellations: true,
  asterisms: true,
  art: false,
  planets: true,
  satellites: false,
  nebulae: true,
  galaxies: true,
  clusters: true,
  labels: true,
  horizon: true,
  opacity: 0.75,
  artOpacity: 0.6,
  magOffset: 0
}

export interface PairMark {
  n: number
  x: number
  y: number
  dir: Vec3 // catalogue direction in the camera frame
}
type Vec3 = S.Vec3

const COLORS = {
  star: '#7dd3fc',
  constellation: '#60a5fa',
  asterism: '#fbbf24',
  nebulae: '#f472b6',
  galaxies: '#4ade80',
  clusters: '#c4b5fd',
  darkNebula: '#9ca3af',
  horizon: '#f87171',
  pair: '#facc15'
}

const DEG = Math.PI / 180

/** Faintest star to draw: dense when zoomed in, sparse for wide frames. */
export function autoMagLimit(fovHDeg: number, offset = 0): number {
  const auto = 4.5 + 2.2 * Math.log10(90 / Math.max(fovHDeg, 1))
  return Math.max(3, Math.min(8.5, auto + offset))
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

class LabelPlacer {
  private placed: Rect[] = []
  tryPlace(r: Rect): boolean {
    for (const p of this.placed)
      if (r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y) return false
    this.placed.push(r)
    return true
  }
}

export interface DrawArgs {
  ctx: CanvasRenderingContext2D
  cam: S.Camera
  cat: Catalogue
  view: SkyView
  layers: Layers
  k: number
  observer: S.Observer | null
  pairs: PairMark[]
  bodies: Body[]
  /** satellites to draw (the caller only sets this when the layer is on) */
  sats?: SatFrame | null
  /** aircraft to draw (Live View) */
  planes?: PlaneFrame | null
  /** meteor-shower streaks to draw (Live View) */
  meteors?: MeteorStreak[] | null
}

export function drawOverlay(a: DrawArgs): void {
  const { ctx, cam, cat, view, layers, k } = a
  const px = 1 / k // one screen pixel in image units
  const margin = 40 * px
  const inFrame = (p: S.Pixel | null): p is S.Pixel =>
    p !== null &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.x > -margin &&
    p.y > -margin &&
    p.x < cam.width + margin &&
    p.y < cam.height + margin

  const fovDeg = cam.fovH / DEG
  const magLimit = autoMagLimit(fovDeg, layers.magOffset)
  const labels = new LabelPlacer()
  const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })

  ctx.save()
  ctx.globalAlpha = layers.opacity
  ctx.lineJoin = 'round'
  ctx.textBaseline = 'middle'

  const text = (
    s: string,
    x: number,
    y: number,
    color: string,
    sizePx = 11,
    italic = false
  ): void => {
    ctx.font = `${italic ? 'italic ' : ''}${sizePx * px}px sans-serif`
    const w = ctx.measureText(s).width
    const h = sizePx * 1.3 * px
    if (!labels.tryPlace(rect(x, y - h / 2, w, h))) return
    ctx.lineWidth = 3 * px
    ctx.strokeStyle = 'rgba(0,0,0,0.7)'
    ctx.strokeText(s, x, y)
    ctx.fillStyle = color
    ctx.fillText(s, x, y)
  }

  if (layers.horizon && a.observer) drawHorizon(a, inFrame, text)

  if (layers.art) drawArt(a)

  // Figure lines first so stars and labels sit on top.
  for (const kind of ['constellation', 'asterism'] as const) {
    if (!(kind === 'constellation' ? layers.constellations : layers.asterisms)) continue
    const color = COLORS[kind]
    ctx.strokeStyle = color
    ctx.lineWidth = (kind === 'constellation' ? 1.4 : 1.6) * px
    ctx.setLineDash(kind === 'asterism' ? [6 * px, 4 * px] : [])
    ctx.beginPath()
    cat.figures.forEach((fig, fi) => {
      if (fig.kind !== kind) return
      const vs = view.figures[fi]
      for (const [ia, ib] of fig.lines) addSkyLine(ctx, cam, vs[ia], vs[ib])
    })
    ctx.stroke()
    ctx.setLineDash([])
  }

  drawDsos(a, inFrame, magLimit, text)

  if (layers.stars) {
    ctx.strokeStyle = COLORS.star
    ctx.lineWidth = 1.2 * px
    const labelLimit = magLimit - 2.2
    const named: { i: number; p: S.Pixel; r: number }[] = []
    ctx.beginPath()
    for (let n = 0; n < cat.order.length; n++) {
      const i = cat.order[n]
      if (cat.mag[i] > magLimit) break
      const p = S.project(cam, starVec(view, i))
      if (!inFrame(p)) continue
      const r = (3.5 + Math.max(0, 6.5 - cat.mag[i]) * 1.6) * px
      ctx.moveTo(p.x + r, p.y)
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      if (layers.labels && cat.mag[i] <= labelLimit && cat.names.has(i)) named.push({ i, p, r })
    }
    ctx.stroke()
    if (layers.labels)
      for (const { i, p, r } of named) text(cat.names.get(i)!, p.x + r + 3 * px, p.y, '#e0f2fe', 11)
  }

  if (layers.labels) {
    cat.figures.forEach((fig, fi) => {
      if (fig.kind === 'constellation' ? !layers.constellations : !layers.asterisms) return
      const p = S.project(cam, view.figureCentres[fi])
      if (!inFrame(p)) return
      const label = fig.kind === 'constellation' ? fig.name.toUpperCase() : fig.name
      ctx.font = `${12 * px}px sans-serif`
      const w = ctx.measureText(label).width
      text(label, p.x - w / 2, p.y, COLORS[fig.kind], 12, fig.kind === 'asterism')
    })
  }

  if (layers.planets) drawBodies(a, inFrame, text)

  if (a.sats) drawSatellites(a, a.sats, inFrame, text)
  if (a.planes) drawPlanes(a, a.planes, inFrame, text)
  if (a.meteors?.length) drawMeteors(a, a.meteors)

  // Picked star pairs: where the user clicked vs where the catalogue star lands.
  ctx.globalAlpha = 1
  for (const m of a.pairs) {
    const p = S.project(cam, m.dir)
    ctx.strokeStyle = COLORS.pair
    ctx.lineWidth = 1.5 * px
    ctx.beginPath()
    const c = 9 * px
    ctx.moveTo(m.x - c, m.y)
    ctx.lineTo(m.x + c, m.y)
    ctx.moveTo(m.x, m.y - c)
    ctx.lineTo(m.x, m.y + c)
    ctx.stroke()
    if (inFrame(p)) {
      ctx.setLineDash([3 * px, 3 * px])
      ctx.beginPath()
      ctx.moveTo(m.x, m.y)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(p.x, p.y, 6 * px, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.font = `bold ${12 * px}px sans-serif`
    ctx.fillStyle = COLORS.pair
    ctx.fillText(String(m.n), m.x + 11 * px, m.y - 11 * px)
  }
  ctx.restore()
}

/** Add the great-circle arc a->b to the current path, bending it as the lens dictates. */
function addSkyLine(ctx: CanvasRenderingContext2D, cam: S.Camera, a: Vec3, b: Vec3): void {
  if (cam.projection === 'rectilinear') {
    // Great circles are straight in a rectilinear image.
    const pa = S.project(cam, a)
    const pb = S.project(cam, b)
    if (!pa || !pb) return
    ctx.moveTo(pa.x, pa.y)
    ctx.lineTo(pb.x, pb.y)
    return
  }
  let pen = false
  for (const v of S.greatCirclePoints(a, b, 2)) {
    const p = S.project(cam, v)
    if (!p) {
      pen = false
      continue
    }
    if (pen) ctx.lineTo(p.x, p.y)
    else ctx.moveTo(p.x, p.y)
    pen = true
  }
}

type TextFn = (s: string, x: number, y: number, color: string, sizePx?: number, italic?: boolean) => void

const DSO_GROUPS: DsoGroup[] = ['nebulae', 'galaxies', 'clusters']

function drawDsos(
  a: DrawArgs,
  inFrame: (p: S.Pixel | null) => p is S.Pixel,
  magLimit: number,
  text: TextFn
): void {
  const { ctx, cam, cat, view, layers, k } = a
  const px = 1 / k
  const dsoLimit = Math.min(14, magLimit + 1)
  const groups = DSO_GROUPS.filter((g) => layers[g])
  if (!groups.length) return
  const labelled: { i: number; p: S.Pixel; r: number; color: string }[] = []

  for (const group of groups) {
    ctx.strokeStyle = COLORS[group]
    ctx.lineWidth = 1.3 * px
    ctx.beginPath()
    const dark: { i: number; p: S.Pixel; r: number }[] = []
    cat.dsos.forEach((d, i) => {
      if (dsoGroup(d.type) !== group) return
      const c = view.dsos[i]
      const p = S.project(cam, c)
      if (!inFrame(p)) return
      const maj = (d.maj ?? 0) / 60 // degrees
      const min = (d.min ?? d.maj ?? 0) / 60
      // Sky-space ellipse, so it distorts with the lens instead of being a screen ellipse.
      const east: Vec3 = S.normalize([-c[1], c[0], 0])
      const north = S.cross(c, east)
      const pa = (d.pa ?? 0) * DEG
      const m = S.add3(S.scale3(north, Math.cos(pa)), S.scale3(east, Math.sin(pa)))
      const n = S.add3(S.scale3(north, -Math.sin(pa)), S.scale3(east, Math.cos(pa)))
      const pts: S.Pixel[] = []
      for (let t = 0; t < 32; t++) {
        const ang = (t / 32) * 2 * Math.PI
        const off = S.add3(S.scale3(m, (Math.cos(ang) * maj * DEG) / 2), S.scale3(n, (Math.sin(ang) * min * DEG) / 2))
        const q = S.project(cam, S.normalize(S.add3(c, off)))
        if (q) pts.push(q)
      }
      const xs = pts.map((q) => q.x)
      const ys = pts.map((q) => q.y)
      const sizeScreen = pts.length === 32 ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * k : 0
      // Faint objects only show once they are big enough on screen to matter; most emission
      // nebulae have no magnitude at all, so their size is what decides.
      if ((d.mag ?? 99) > dsoLimit && sizeScreen < 14) return
      let r = 6 * px
      if (sizeScreen >= 12) r = (sizeScreen / 2) * px
      if (d.type === 'DrkN') {
        dark.push({ i, p, r }) // dark nebulae get their own dashed grey outline
        return
      }
      if (sizeScreen >= 12) {
        pts.forEach((q, j) => (j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)))
        ctx.closePath()
      } else {
        ctx.moveTo(p.x + r, p.y)
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      }
      labelled.push({ i, p, r, color: COLORS[group] })
    })
    ctx.stroke()

    if (dark.length) {
      ctx.strokeStyle = COLORS.darkNebula
      ctx.setLineDash([4 * px, 3 * px])
      ctx.beginPath()
      for (const { i, p, r } of dark) {
        ctx.moveTo(p.x + r, p.y)
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        labelled.push({ i, p, r, color: COLORS.darkNebula })
      }
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  if (layers.labels)
    for (const { i, p, r, color } of labelled) {
      const d = cat.dsos[i]
      text(d.name ? `${d.id} ${d.name}` : d.id, p.x + r + 3 * px, p.y, color, 11)
    }
}

/** Classical constellation drawings, warped onto the sky through the camera. */
function drawArt(a: DrawArgs): void {
  const { ctx, cam, cat, view, layers, k } = a
  const px = 1 / k
  ctx.save()
  ctx.globalAlpha = layers.opacity * layers.artOpacity
  const n = ART_GRID + 1
  // A triangle spanning most of the frame is the lens wrapping around, not a real drawing.
  const maxSpan = Math.max(cam.width, cam.height) * 1.5
  const valid = (q: S.Pixel | null): q is S.Pixel => q !== null && Number.isFinite(q.x) && Number.isFinite(q.y)
  cat.art.forEach((art, ai) => {
    const nodes = view.art[ai].map((v) => S.project(cam, v))
    // Cheap reject: skip a drawing that is entirely off the frame or too small to see.
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const q of nodes) {
      if (!valid(q)) continue
      x0 = Math.min(x0, q.x)
      y0 = Math.min(y0, q.y)
      x1 = Math.max(x1, q.x)
      y1 = Math.max(y1, q.y)
    }
    if (x1 < 0 || y1 < 0 || x0 > cam.width || y0 > cam.height || Math.max(x1 - x0, y1 - y0) * k < 30) return
    const img = artImage(art.abbr)
    if (!img) return
    const sx = img.naturalWidth / art.width
    const sy = img.naturalHeight / art.height
    for (let j = 0; j < ART_GRID; j++)
      for (let i = 0; i < ART_GRID; i++) {
        const i0 = j * n + i
        const corners = [
          [i0, i0 + 1, i0 + n],
          [i0 + 1, i0 + n + 1, i0 + n]
        ]
        for (const tri of corners) {
          const q = tri.map((t) => nodes[t])
          if (!q.every(valid)) continue
          const d = q as S.Pixel[]
          const minX = Math.min(d[0].x, d[1].x, d[2].x)
          const maxX = Math.max(d[0].x, d[1].x, d[2].x)
          const minY = Math.min(d[0].y, d[1].y, d[2].y)
          const maxY = Math.max(d[0].y, d[1].y, d[2].y)
          if (maxX < 0 || maxY < 0 || minX > cam.width || minY > cam.height) continue
          if (maxX - minX > maxSpan || maxY - minY > maxSpan) continue
          const src = tri.map((t) => [art.uv[t][0] * sx, art.uv[t][1] * sy] as [number, number])
          drawTexturedTriangle(ctx, img, src, d, px)
        }
      }
  })
  ctx.restore()
}

/** Draw the image triangle s (image pixels) onto the triangle d (canvas coordinates). */
function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  s: [number, number][],
  d: S.Pixel[],
  px: number
): void {
  const [u0, v0] = s[0]
  const [u1, v1] = s[1]
  const [u2, v2] = s[2]
  const det = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1)
  if (Math.abs(det) < 1e-9) return
  const solve = (a0: number, a1: number, a2: number): [number, number, number] => [
    (a0 * (v1 - v2) + a1 * (v2 - v0) + a2 * (v0 - v1)) / det,
    (a0 * (u2 - u1) + a1 * (u0 - u2) + a2 * (u1 - u0)) / det,
    (a0 * (u1 * v2 - u2 * v1) + a1 * (u2 * v0 - u0 * v2) + a2 * (u0 * v1 - u1 * v0)) / det
  ]
  const [a, c, e] = solve(d[0].x, d[1].x, d[2].x)
  const [b, dd, f] = solve(d[0].y, d[1].y, d[2].y)
  // Grow the clip a little so neighbouring triangles overlap instead of leaving hairline seams.
  const cx = (d[0].x + d[1].x + d[2].x) / 3
  const cy = (d[0].y + d[1].y + d[2].y) / 3
  ctx.save()
  ctx.beginPath()
  d.forEach((q, i) => {
    const len = Math.hypot(q.x - cx, q.y - cy) || 1
    const gx = q.x + ((q.x - cx) / len) * 0.6 * px
    const gy = q.y + ((q.y - cy) / len) * 0.6 * px
    if (i) ctx.lineTo(gx, gy)
    else ctx.moveTo(gx, gy)
  })
  ctx.closePath()
  ctx.clip()
  ctx.transform(a, b, c, dd, e, f)
  ctx.drawImage(img, 0, 0)
  ctx.restore()
}

/** Sun, Moon and planets. */
function drawBodies(a: DrawArgs, inFrame: (p: S.Pixel | null) => p is S.Pixel, text: TextFn): void {
  const { ctx, cam, k, layers } = a
  const px = 1 / k
  for (const b of a.bodies) {
    const p = S.project(cam, b.vec)
    if (!inFrame(p)) continue
    // Apparent disc radius in image pixels: project a point one angular radius away.
    let disc = 0
    if (b.radiusDeg > 0) {
      const side = S.normalize(S.cross(b.vec, [0, 0, 1]))
      const q = S.project(cam, S.normalize(S.add3(b.vec, S.scale3(side, Math.tan(b.radiusDeg * DEG)))))
      if (q) disc = Math.hypot(q.x - p.x, q.y - p.y)
    }
    const r = Math.max(disc, (b.kind === 'planet' ? 4 + Math.max(0, Math.min(4, -b.mag)) * 0.6 : 7) * px)
    ctx.fillStyle = b.color
    ctx.strokeStyle = b.color
    ctx.lineWidth = 1.6 * px
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.globalAlpha = layers.opacity * (b.kind === 'planet' ? 0.9 : 0.35)
    ctx.fill()
    ctx.globalAlpha = layers.opacity
    ctx.stroke()
    if (b.kind === 'planet') {
      // Tick marks either side, so a planet stays findable even when it is a single pixel in the photo.
      const t = r + 6 * px
      ctx.beginPath()
      ctx.moveTo(p.x - t, p.y)
      ctx.lineTo(p.x - r - 1 * px, p.y)
      ctx.moveTo(p.x + r + 1 * px, p.y)
      ctx.lineTo(p.x + t, p.y)
      ctx.stroke()
    }
    if (layers.labels) {
      const label = b.kind === 'moon' && b.lit !== undefined ? `Moon ${Math.round(b.lit * 100)}% lit` : b.name
      text(label, p.x + r + 8 * px, p.y, b.color, 12)
    }
  }
}

/** Satellites: a trail through each (dim where it has been, brighter where it is going), a dot, and a name for the bright ones. */
function drawSatellites(a: DrawArgs, sats: SatFrame, inFrame: (p: S.Pixel | null) => p is S.Pixel, text: TextFn): void {
  const { ctx, cam, k, layers } = a
  const px = 1 / k
  const maxJump = Math.max(cam.width, cam.height) * 0.6 // a longer hop is the lens wrapping round, not a real path
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineWidth = 1.3 * px
  for (const t of sats.trails) {
    const selected = t.norad === sats.selected
    ctx.strokeStyle = t.color
    let prev: S.Pixel | null = null
    for (let pass = 0; pass < 2; pass++) {
      // pass 0: where it has been, faint; pass 1: where it is going
      const from = pass === 0 ? 0 : t.now
      const to = pass === 0 ? t.now : t.path.length - 1
      ctx.globalAlpha = layers.opacity * (pass === 0 ? 0.3 : selected ? 0.95 : 0.6)
      ctx.lineWidth = (selected ? 2 : 1.3) * px
      ctx.beginPath()
      prev = null
      for (let i = from; i <= to; i++) {
        const v = t.path[i]
        const p = v ? S.project(cam, v) : null
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > maxJump)) {
          prev = null
          continue
        }
        if (prev) ctx.lineTo(p.x, p.y)
        else ctx.moveTo(p.x, p.y)
        prev = p
      }
      ctx.stroke()
    }
  }
  ctx.globalAlpha = layers.opacity
  const labelled: { s: SatFrame['dots'][number]; p: S.Pixel; r: number }[] = []
  for (const d of sats.dots) {
    const p = S.project(cam, d.dir)
    if (!inFrame(p)) continue
    const color = colorOf(d.s.rec.flags)
    const r = (isBright(d.s.rec.flags) ? 4.5 : 3) * px
    ctx.lineWidth = 1.5 * px
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    if (d.s.sunlit) {
      ctx.globalAlpha = layers.opacity
      ctx.fill()
    } else {
      // in Earth's shadow a camera cannot see it: hollow and faint
      ctx.globalAlpha = layers.opacity * 0.4
      ctx.stroke()
      ctx.globalAlpha = layers.opacity
    }
    if (d.s.rec.norad === sats.selected) {
      ctx.globalAlpha = 1
      ctx.strokeStyle = '#fde047'
      ctx.lineWidth = 2 * px
      for (const rr of [r + 6 * px, r + 12 * px]) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.globalAlpha = layers.opacity
    }
    if (layers.labels && (d.s.rec.norad === sats.selected || sats.labelAll || isBright(d.s.rec.flags))) labelled.push({ s: d, p, r })
  }
  // The picked one first, so it wins a crowded spot.
  labelled.sort((x, y) => Number(y.s.s.rec.norad === sats.selected) - Number(x.s.s.rec.norad === sats.selected))
  for (const { s, p, r } of labelled) text(s.s.rec.name, p.x + r + 5 * px, p.y, colorOf(s.s.rec.flags), 11)
  if (sats.pinned) drawPinned(a, sats.pinned, sats.dots.some((d) => d.s.rec.norad === sats.pinned!.s.rec.norad), inFrame)
  ctx.restore()
}

/** A brief streak per active meteor, bright head fading to a transparent tail, itself fading in then out
 * over its short lifetime (already worked out as `alpha` by MeteorStreakSpawner). */
function drawMeteors(a: DrawArgs, meteors: MeteorStreak[]): void {
  const { ctx, cam, k, layers } = a
  const px = 1 / k
  ctx.save()
  ctx.lineCap = 'round'
  for (const m of meteors) {
    if (m.alpha <= 0) continue
    const tail = S.project(cam, m.tail)
    const head = S.project(cam, m.head)
    if (!tail || !head) continue
    const a1 = layers.opacity * m.alpha
    const grad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y)
    grad.addColorStop(0, 'rgba(255,255,255,0)')
    grad.addColorStop(1, `rgba(255,255,255,${a1})`)
    ctx.strokeStyle = grad
    ctx.lineWidth = 1.6 * px
    ctx.beginPath()
    ctx.moveTo(tail.x, tail.y)
    ctx.lineTo(head.x, head.y)
    ctx.stroke()
    ctx.fillStyle = `rgba(255,255,255,${a1})`
    ctx.beginPath()
    ctx.arc(head.x, head.y, 1.4 * px, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

const PIN_COLOR = '#ff5c5c'

/**
 * The always-shown satellite. In the picture: a marker (hollow and dashed under the horizon) with its track and a name.
 * Out of the picture: an arrow on the nearest edge pointing the way, and how far away it is.
 */
function drawPinned(a: DrawArgs, pin: NonNullable<SatFrame['pinned']>, alreadyDrawn: boolean, inFrame: (p: S.Pixel | null) => p is S.Pixel): void {
  const { ctx, cam, k, layers } = a
  const px = 1 / k
  const maxJump = Math.max(cam.width, cam.height) * 0.6
  const below = pin.s.altDeg < 0
  ctx.save()
  ctx.lineCap = 'round'
  ctx.strokeStyle = PIN_COLOR

  // its track: solid while above the horizon, dashed under it
  ctx.lineWidth = 1.6 * px
  for (const wantBelow of [false, true]) {
    ctx.globalAlpha = layers.opacity * (wantBelow ? 0.5 : 0.75)
    ctx.setLineDash(wantBelow ? [4 * px, 5 * px] : [])
    ctx.beginPath()
    let prev: S.Pixel | null = null
    let prevBelow: boolean | null = null
    for (const pt of pin.path) {
      const p = S.project(cam, pt.dir)
      const ok: boolean = !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && !(prev !== null && Math.hypot(p.x - prev.x, p.y - prev.y) > maxJump)
      if (!ok || pt.below !== wantBelow) {
        prev = ok ? p : null
        prevBelow = null
        continue
      }
      if (prev && prevBelow === wantBelow) ctx.lineTo(p!.x, p!.y)
      else ctx.moveTo(p!.x, p!.y)
      prev = p
      prevBelow = wantBelow
    }
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1

  const label = below ? `ISS  ${Math.abs(pin.s.altDeg).toFixed(0)}° below the horizon` : `ISS  ${pin.s.altDeg.toFixed(0)}° up`
  const drawText = (s: string, x: number, y: number, align: CanvasTextAlign): void => {
    ctx.font = `bold ${12 * px}px sans-serif`
    ctx.textAlign = align
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 3.5 * px
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'
    ctx.strokeText(s, x, y)
    ctx.fillStyle = PIN_COLOR
    ctx.fillText(s, x, y)
  }

  const p = S.project(cam, pin.dir)
  if (inFrame(p) && p.x >= 0 && p.y >= 0 && p.x <= cam.width && p.y <= cam.height) {
    if (!alreadyDrawn) {
      ctx.strokeStyle = PIN_COLOR
      ctx.fillStyle = PIN_COLOR
      ctx.lineWidth = 2 * px
      ctx.beginPath()
      ctx.arc(p.x, p.y, 6 * px, 0, Math.PI * 2)
      if (below) {
        ctx.setLineDash([3 * px, 3 * px])
        ctx.stroke()
        ctx.setLineDash([])
      } else ctx.fill()
      ctx.beginPath()
      ctx.arc(p.x, p.y, 12 * px, 0, Math.PI * 2)
      ctx.globalAlpha = 0.6
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    drawText(label, p.x + 16 * px, p.y, p.x > cam.width * 0.7 ? 'right' : 'left')
  } else {
    // off the picture: an arrow on the edge nearest to it
    const dx = S.dot(pin.dir, cam.right)
    const dy = -S.dot(pin.dir, cam.up)
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const inset = 30 * px
    const t = Math.min((cam.width / 2 - inset) / Math.max(Math.abs(ux), 1e-6), (cam.height / 2 - inset) / Math.max(Math.abs(uy), 1e-6))
    const ax = cam.width / 2 + ux * t
    const ay = cam.height / 2 + uy * t
    const ang = Math.atan2(uy, ux)
    ctx.fillStyle = PIN_COLOR
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'
    ctx.lineWidth = 2 * px
    ctx.beginPath()
    ctx.moveTo(ax + Math.cos(ang) * 14 * px, ay + Math.sin(ang) * 14 * px)
    ctx.lineTo(ax + Math.cos(ang + 2.5) * 11 * px, ay + Math.sin(ang + 2.5) * 11 * px)
    ctx.lineTo(ax + Math.cos(ang - 2.5) * 11 * px, ay + Math.sin(ang - 2.5) * 11 * px)
    ctx.closePath()
    ctx.stroke()
    ctx.fill()
    const away = (Math.acos(Math.max(-1, Math.min(1, S.dot(pin.dir, cam.forward)))) * 180) / Math.PI
    const right = ax > cam.width / 2
    drawText(label, ax + (right ? -20 : 20) * px, ay - 8 * px, right ? 'right' : 'left')
    drawText(`${away.toFixed(0)}° from the middle of the picture`, ax + (right ? -20 : 20) * px, ay + 8 * px, right ? 'right' : 'left')
  }
  ctx.restore()
}

/** Only this many of the nearest aircraft get a name, or the sky is all text. */
const MAX_PLANE_LABELS = 30
/** How big an aircraft icon is, in screen pixels. */
const PLANE_ICON_PX = 22

/** Aircraft: an icon for what each is (airliner, small plane, helicopter…), turned the way it is heading in the picture; the nearest ones are named. */
function drawPlanes(a: DrawArgs, planes: PlaneFrame, inFrame: (p: S.Pixel | null) => p is S.Pixel, text: TextFn): void {
  const { ctx, cam, k, layers } = a
  const px = 1 / k
  ctx.save()
  ctx.globalAlpha = layers.opacity
  let named = 0
  for (const d of planes.dots) {
    const p = S.project(cam, d.dir)
    if (!inFrame(p)) continue
    const q = S.project(cam, d.ahead)
    const ang = q && Math.hypot(q.x - p.x, q.y - p.y) > 1e-6 ? Math.atan2(q.y - p.y, q.x - p.x) : -Math.PI / 2
    const colour = kindInfo(d.kind).colour
    drawShape(ctx, d.shape, p.x, p.y, PLANE_ICON_PX * px, ang + Math.PI / 2, colour)
    if (layers.labels && named < MAX_PLANE_LABELS) {
      text(d.label, p.x + 14 * px, p.y, colour, 10)
      named++
    }
  }
  ctx.restore()
}

function drawHorizon(
  a: DrawArgs,
  inFrame: (p: S.Pixel | null) => p is S.Pixel,
  text: TextFn
): void {
  const { ctx, cam, observer, k } = a
  if (!observer) return
  const px = 1 / k
  ctx.strokeStyle = COLORS.horizon
  ctx.lineWidth = 2 * px
  ctx.beginPath()
  let pen = false
  for (let az = 0; az <= 360; az += 3) {
    const p = S.project(cam, S.altAzToVec(0, az, observer))
    if (!p) {
      pen = false
      continue
    }
    if (pen) ctx.lineTo(p.x, p.y)
    else ctx.moveTo(p.x, p.y)
    pen = true
  }
  ctx.stroke()
  for (const [label, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
    const p = S.project(cam, S.altAzToVec(0, az, observer))
    if (inFrame(p)) text(label, p.x, p.y - 12 * px, COLORS.horizon, 14)
  }
}

export interface Candidate {
  index: number
  x: number
  y: number
  dist: number // image px
  mag: number
}

/** Catalogue stars near an image point, best guess first: close and bright wins. */
export function nearbyStars(
  cam: S.Camera,
  cat: Catalogue,
  view: SkyView,
  x: number,
  y: number,
  radius: number,
  magLimit: number,
  max = 6
): Candidate[] {
  const out: Candidate[] = []
  for (let n = 0; n < cat.order.length; n++) {
    const i = cat.order[n]
    if (cat.mag[i] > magLimit) break
    const p = S.project(cam, starVec(view, i))
    if (!p) continue
    const dist = Math.hypot(p.x - x, p.y - y)
    if (dist <= radius) out.push({ index: i, x: p.x, y: p.y, dist, mag: cat.mag[i] })
  }
  const score = (c: Candidate): number => c.dist / radius + c.mag * 0.12
  return out.sort((p, q) => score(p) - score(q)).slice(0, max)
}
