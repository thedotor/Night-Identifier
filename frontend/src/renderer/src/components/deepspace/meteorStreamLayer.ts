// Meteoroid debris streams: for each active shower with a known parent body, a scatter of synthetic
// particles riding the same ellipse (same a, e, w, period; a small seeded jitter in i/om gives the
// stream some width) but spread all the way around the orbit in mean anomaly. They ride their own
// Kepler orbits exactly like the asteroid-belt clouds (see setOrbits' cloud block and kepler.ts's
// makeCloud), so speeding up time makes the whole necklace of particles visibly flow. Brightness peaks
// near the point where Earth's own ~1 AU orbit actually crosses the stream (the shower's real node),
// and fades elsewhere -- that point is also marked with a small label.
//
// Lives in the AU-scale small-body frame (this.smallGroup), unlike meteorLayer.ts's MeteorRadiantLayer,
// which draws each shower's radiant on the far star-backdrop dome. The two are complementary, not
// duplicates: one shows where the meteors seem to come from as seen from Earth, this one shows the
// real debris trail out in the solar system.

import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { atEccentric, makeCloud, orbitBasis, type Elements, type ElementCloud } from '@renderer/lib/kepler'
import type { Shower } from '@renderer/lib/eventsSky'

const TWO_PI = Math.PI * 2
const PARTICLES_PER_STREAM = 450
const JITTER_DEG = 0.7

const rand = (seed: number): number => {
  const x = Math.sin(seed) * 43758.5453
  return x - Math.floor(x)
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

const wrap = (x: number): number => ((x % TWO_PI) + TWO_PI) % TWO_PI

/** The eccentric anomaly where this orbit crosses the ecliptic plane (z=0), whichever of the two
 * nodes lies closer to Earth's ~1 AU -- that is where Earth actually meets the stream each year. Null
 * for a near-zero-inclination orbit (no single crossing; none of the real shower parents are like this). */
function findNodeE(el: Elements): number | null {
  const { p, q } = orbitBasis(el)
  const A = p[2]
  const B = Math.sqrt(1 - el.e * el.e) * q[2]
  const R = Math.hypot(A, B)
  if (R < 1e-9) return null
  const phi = Math.atan2(B, A)
  const ratio = Math.min(1, Math.max(-1, (el.e * A) / R))
  const ac = Math.acos(ratio)
  const e1 = phi + ac
  const e2 = phi - ac
  const r = (E: number): number => el.a * (1 - el.e * Math.cos(E))
  return Math.abs(r(e1) - 1) <= Math.abs(r(e2) - 1) ? e1 : e2
}

const labelStyle = (color: string): string =>
  `padding-left:8px;font:11px/1.25 system-ui,sans-serif;color:${color};text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:none;user-select:none`

interface StreamItem {
  cloud: ElementCloud
  buffer: Float32Array
  alphaAttr: Float32Array
  tp: Float64Array
  per: number
  mNode: number | null
  points: THREE.Points
  label: CSS2DObject | null
  labelDiv: HTMLDivElement | null
}

function streamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uOpacity: { value: 1 }, uSize: { value: 2.4 }, uColor: { value: new THREE.Color(0xffe9a8) } },
    vertexShader: `
      attribute float aAlpha;
      uniform float uSize;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
        gl_PointSize = uSize;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlpha;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        if (r > 1.0) discard;
        float disc = 1.0 - smoothstep(0.55, 1.0, r);
        gl_FragColor = vec4(uColor, disc * vAlpha * uOpacity);
      }`
  })
}

export class MeteorStreamLayer {
  readonly group = new THREE.Group()
  private items = new Map<string, StreamItem>()
  private readonly material = streamMaterial()

  constructor(parent: THREE.Object3D) {
    parent.add(this.group)
  }

  /** Rebuild the set of streams to match the showers whose active date range covers the scene's current
   * date and that have a resolved parent orbit. Small and infrequent (about once a minute), so a full
   * rebuild is cheap. Independent of any observer location: unlike the radiant layer, a debris stream
   * exists in space whether or not it is currently visible from anywhere in particular on Earth. */
  setActive(showers: Shower[], parentOf: (code: string) => Elements | null): void {
    const keep = new Set<string>()
    for (const shower of showers) {
      const el = parentOf(shower.code)
      if (!el) continue
      keep.add(shower.code)
      if (!this.items.has(shower.code)) this.items.set(shower.code, this.build(shower, el))
    }
    for (const [code, item] of this.items) {
      if (keep.has(code)) continue
      item.points.geometry.dispose()
      this.group.remove(item.points)
      item.label?.removeFromParent()
      item.labelDiv?.remove()
      this.items.delete(code)
    }
  }

  private build(shower: Shower, el: Elements): StreamItem {
    const n = PARTICLES_PER_STREAM
    const rows: number[][] = []
    const tp = new Float64Array(n)
    const base = hashCode(shower.code)
    for (let k = 0; k < n; k++) {
      const di = (rand(base + k * 12.9898) - 0.5) * 2 * JITTER_DEG
      const dom = (rand(base + k * 78.233) - 0.5) * 2 * JITTER_DEG
      const tpk = el.tp - (k / n) * el.per
      tp[k] = tpk
      rows.push([el.a, el.e, el.i + di, el.om + dom, el.w, tpk, el.per])
    }
    const cloud = makeCloud(rows)
    const buffer = new Float32Array(3 * cloud.count)
    const alphaAttr = new Float32Array(cloud.count).fill(0.3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(buffer, 3))
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphaAttr, 1))
    const points = new THREE.Points(geo, this.material)
    points.frustumCulled = false
    this.group.add(points)

    const nodeE = findNodeE(el)
    let label: CSS2DObject | null = null
    let labelDiv: HTMLDivElement | null = null
    if (nodeE !== null) {
      const p = atEccentric(el, orbitBasis(el), nodeE)
      labelDiv = document.createElement('div')
      labelDiv.style.cssText = labelStyle('#ffcf8a')
      labelDiv.textContent = `☄ ${shower.name} · up to ${shower.zhr}/hr`
      label = new CSS2DObject(labelDiv)
      label.position.set(p[0], p[1], p[2])
      this.group.add(label)
    }

    return { cloud, buffer, alphaAttr, tp, per: el.per, mNode: nodeE === null ? null : nodeE - el.e * Math.sin(nodeE), points, label, labelDiv }
  }

  /** Move every stream's particles to a Julian date and refresh the node-proximity fade. Only worth
   * calling when the date has moved enough to see (about a day), same as the belt clouds. */
  update(jd: number): void {
    for (const it of this.items.values()) {
      it.cloud.positions(jd, it.buffer)
      it.points.geometry.attributes.position.needsUpdate = true
      if (it.mNode !== null) {
        const n = it.cloud.count
        for (let k = 0; k < n; k++) {
          const m = wrap((TWO_PI * (jd - it.tp[k])) / it.per)
          const dM = Math.atan2(Math.sin(m - it.mNode), Math.cos(m - it.mNode))
          const c = Math.max(0, Math.cos(dM * 0.5))
          it.alphaAttr[k] = 0.08 + 0.92 * Math.pow(c, 6)
        }
        it.points.geometry.attributes.aAlpha.needsUpdate = true
      }
    }
  }

  /** Per-frame: the overall fade (same factor the belts use for the "solar system" zoom tier). */
  layout(alpha: number): void {
    this.group.visible = alpha > 0.02 && this.items.size > 0
    this.material.uniforms.uOpacity.value = alpha
    for (const it of this.items.values()) if (it.label) it.label.visible = alpha > 0.3
  }

  dispose(): void {
    for (const it of this.items.values()) {
      it.points.geometry.dispose()
      it.label?.removeFromParent()
      it.labelDiv?.remove()
    }
    this.items.clear()
    this.material.dispose()
    this.group.removeFromParent()
  }
}
