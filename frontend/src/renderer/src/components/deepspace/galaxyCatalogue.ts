// The real galaxies beyond the Local Group (the 2MASS Redshift Survey, about 43,000 of them) as a cloud of points at their measured places:
// clusters, filaments and the gap where the Milky Way's dust hides the sky all show. Colour follows the morphological type; the size follows
// how luminous the galaxy really is, so the big ones stand out at any distance.
import * as THREE from 'three'
import { positionAU } from '@renderer/lib/galaxyMath'
import { distanceMpc, mpcToAU, type Vec3 } from '@renderer/lib/galaxyMorph'

export interface GalaxyRow {
  ra: number
  dec: number
  cz: number
  kt: number
  /** log10 of the isophotal radius in arcsec, or -1 */
  logr: number
  /** apparent axis ratio, or -1 */
  ba: number
  t: number
  bar: number
}

const VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uScale;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
    gl_PointSize = aSize * uScale;
    #include <logdepthbuf_vertex>
  }`
const FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uAlpha;
  varying vec3 vColor;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p) * 2.0;
    if (r > 1.0) discard;
    gl_FragColor = vec4(vColor, (1.0 - r * r) * uAlpha);
  }`

const colourOf = (t: number): Vec3 =>
  t <= -4 ? [1.0, 0.8, 0.55] : t <= -1 ? [1.0, 0.9, 0.72] : t <= 9 ? [0.72, 0.84, 1.0] : t < 98 ? [0.62, 0.8, 1.0] : [0.95, 0.92, 0.88]

export class GalaxyCatalogue {
  readonly points: THREE.Points
  readonly rows: GalaxyRow[]
  /** absolute scene position (AU, ecliptic) of each galaxy in `rows`' order, and how far away it is */
  readonly pos: Float64Array
  readonly distAU: Float64Array
  /** the index in `rows` of each point; some rows are left out (too near to have a redshift distance, or already a galaxy of their own) */
  readonly rowOf: Int32Array
  private readonly size: Float32Array
  private readonly base: Float32Array
  private readonly uniforms: { uScale: { value: number }; uAlpha: { value: number } }

  /** `skip(ra, dec, distAU)`: true for galaxies that are already drawn some other way. */
  constructor(rows: GalaxyRow[], skip: (ra: number, dec: number, distAU: number) => boolean) {
    this.rows = rows
    const keep: number[] = []
    const dist: number[] = []
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const mpc = distanceMpc(r.cz, r.ra, r.dec)
      if (mpc === null) continue
      const au = mpcToAU(mpc)
      if (skip(r.ra, r.dec, au)) continue
      keep.push(i)
      dist.push(au)
    }
    const n = keep.length
    this.rowOf = Int32Array.from(keep)
    this.distAU = Float64Array.from(dist)
    this.pos = new Float64Array(n * 3)
    const p32 = new Float32Array(n * 3)
    const col = new Float32Array(n * 3)
    this.size = new Float32Array(n)
    this.base = new Float32Array(n)
    for (let k = 0; k < n; k++) {
      const r = rows[keep[k]]
      const p = positionAU(r.ra, r.dec, dist[k])
      this.pos.set(p, 3 * k)
      p32.set(p, 3 * k)
      const c = colourOf(r.t)
      col.set(c, 3 * k)
      // absolute K magnitude: about -25 for the biggest ellipticals, -21 for an ordinary spiral
      const mK = r.kt - 5 * Math.log10(Math.max(dist[k] / 206_264.806, 1) / 10)
      const s = Math.min(2.6, Math.max(0.9, 1.05 + (-21 - mK) * 0.3))
      this.base[k] = s
      this.size[k] = s
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(p32, 3))
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    this.uniforms = { uScale: { value: 1 }, uAlpha: { value: 0 } }
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: this.uniforms }))
    this.points.frustumCulled = false
    this.points.renderOrder = -6
  }

  get count(): number {
    return this.rowOf.length
  }

  /** Draw it this visible (0..1); `pixelRatio` keeps the points the same size on a sharper screen. */
  setAlpha(a: number, pixelRatio: number): void {
    this.uniforms.uAlpha.value = 0.4 * a
    this.uniforms.uScale.value = pixelRatio
    this.points.visible = a > 0.01
  }

  /** Stop drawing one galaxy (it has become a flyable one with its own model). */
  hide(k: number, hidden: boolean): void {
    this.size[k] = hidden ? 0 : this.base[k]
    this.points.geometry.attributes.aSize.needsUpdate = true
  }

  /** The galaxy under a click (its index among the points), preferring the brighter ones; -1 if none is close. */
  pick(px: number, py: number, w: number, h: number, cam: THREE.PerspectiveCamera, origin: Vec3, reachPx = 11): number {
    const v = new THREE.Vector3()
    let best = -1
    let bestScore = Infinity
    for (let k = 0; k < this.count; k++) {
      if (this.size[k] === 0) continue
      v.set(this.pos[3 * k] - origin[0], this.pos[3 * k + 1] - origin[1], this.pos[3 * k + 2] - origin[2]).project(cam)
      if (v.z > 1 || v.z < -1) continue
      const dx = ((v.x + 1) / 2) * w - px
      const dy = ((1 - v.y) / 2) * h - py
      const d = Math.hypot(dx, dy)
      if (d > reachPx) continue
      const score = d / this.base[k]
      if (score < bestScore) {
        bestScore = score
        best = k
      }
    }
    return best
  }

  dispose(): void {
    this.points.removeFromParent()
    this.points.geometry.dispose()
    ;(this.points.material as THREE.Material).dispose()
  }
}
