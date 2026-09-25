// Hit-testing for clicks on the Sky Overlay: which deep-sky objects, planets and named stars
// are under (or near) an image point. Pure functions, like skyRender's nearbyStars.

import * as S from './skyMath'
import { dsoGroup, starVec, type Catalogue, type SkyView } from './skyCatalogue'
import type { Body } from './skyEphemeris'
import type { DeepSpaceKind } from './api'
import type { Layers } from './skyRender'

const DEG = Math.PI / 180
/** Unnamed stars are only offered when they are at least this bright. */
const UNNAMED_STAR_MAG = 3.5

export interface SkyObjectRef {
  kind: DeepSpaceKind
  /** key understood by /deepspace/object: DSO id, star index or body id */
  key: string
  label: string
  sub: string
  vec: S.Vec3
  /** image px from the click to the object's centre */
  dist: number
}

/** Image-pixel length of an angular distance (degrees) at a sky direction. */
function angularPx(cam: S.Camera, c: S.Vec3, p: S.Pixel, deg: number): number {
  const north = S.normalize(S.cross(S.normalize(S.cross([0, 0, 1], c)), c))
  const q = S.project(cam, S.normalize(S.add3(c, S.scale3(north, Math.tan(deg * DEG)))))
  return q ? Math.hypot(q.x - p.x, q.y - p.y) : 0
}

export function pickObjects(
  cam: S.Camera,
  cat: Catalogue,
  view: SkyView,
  bodies: Body[],
  layers: Layers,
  x: number,
  y: number,
  radius: number,
  max = 5
): SkyObjectRef[] {
  const out: (SkyObjectRef & { score: number })[] = []
  const add = (o: SkyObjectRef, reach: number, bias: number): void => {
    if (o.dist <= Math.max(radius, reach)) out.push({ ...o, score: o.dist / Math.max(radius, reach) + bias })
  }

  if (layers.planets)
    for (const b of bodies) {
      const p = S.project(cam, b.vec)
      if (!p) continue
      add(
        { kind: 'body', key: b.id, label: b.name, sub: b.kind === 'planet' ? 'Planet' : b.kind === 'sun' ? 'Star (the Sun)' : 'Moon', vec: b.vec, dist: Math.hypot(p.x - x, p.y - y) },
        b.radiusDeg > 0 ? angularPx(cam, b.vec, p, b.radiusDeg) : 0,
        -0.3
      )
    }

  cat.dsos.forEach((d, i) => {
    if (!layers[dsoGroup(d.type)]) return
    const c = view.dsos[i]
    const p = S.project(cam, c)
    if (!p) return
    const semiMajor = d.maj ? angularPx(cam, c, p, d.maj / 120) : 0
    add(
      { kind: 'dso', key: d.id, label: d.name ? `${d.id} ${d.name}` : d.id, sub: d.type, vec: c, dist: Math.hypot(p.x - x, p.y - y) },
      semiMajor,
      -0.15
    )
  })

  if (layers.stars)
    for (let n = 0; n < cat.order.length; n++) {
      const i = cat.order[n]
      const name = cat.names.get(i)
      if (!name && cat.mag[i] > UNNAMED_STAR_MAG) {
        if (cat.mag[i] > 6) break
        continue
      }
      const v = starVec(view, i)
      const p = S.project(cam, v)
      if (!p) continue
      add(
        { kind: 'star', key: String(i), label: name ?? `Star, mag ${cat.mag[i].toFixed(1)}`, sub: `Star · mag ${cat.mag[i].toFixed(1)}`, vec: v, dist: Math.hypot(p.x - x, p.y - y) },
        0,
        cat.mag[i] * 0.05
      )
    }

  return out
    .sort((a, b) => a.score - b.score)
    .slice(0, max)
    .map(({ score: _score, ...o }) => o)
}
