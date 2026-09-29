// A detailed 3D model of one galaxy, made of tens of thousands of stars placed by the rules of its type: a bulge, a bar, an exponential disc,
// and arms on logarithmic spirals for a spiral; a smooth ellipsoid for an elliptical; a few clumps for an irregular. Not a survey: the
// shape (type, tilt, position angle, size) is the real galaxy's, the individual stars are invented, the same ones every time.
import * as THREE from 'three'
import { classOf, thicknessOf, type GalaxyShape, type Vec3 } from '@renderer/lib/galaxyMorph'

/** A small seeded random source (the same seed, the same galaxy). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WARM: Vec3 = [1.0, 0.82, 0.55]
const PALE: Vec3 = [1.0, 0.92, 0.78]
const BLUE: Vec3 = [0.62, 0.74, 1.0]
const PINK: Vec3 = [1.0, 0.48, 0.66]

const VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uSize;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
    gl_PointSize = uSize * aSize;
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
    float a = (1.0 - r * r) * uAlpha;
    gl_FragColor = vec4(vColor, a);
  }`

interface Cloud {
  pos: number[]
  col: number[]
  size: number[]
}
const newCloud = (): Cloud => ({ pos: [], col: [], size: [] })

const gauss = (r: () => number): number => {
  let u = 0
  let v = 0
  while (u === 0) u = r()
  while (v === 0) v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function put(c: Cloud, x: number, y: number, z: number, colour: Vec3, bright: number, size: number): void {
  c.pos.push(x, y, z)
  c.col.push(colour[0] * bright, colour[1] * bright, colour[2] * bright)
  c.size.push(size)
}

const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** Radius (in units of the galaxy's radius) drawn from an exponential disc with scale `h`, cut off at 1. */
const expRadius = (r: () => number, h: number): number => -h * Math.log(1 - r() * (1 - Math.exp(-1 / h)))

function buildStars(shape: GalaxyShape, n: number, dust: Cloud): Cloud {
  const r = rng(shape.seed)
  const c = newCloud()
  const cls = classOf(shape.t)
  const q = thicknessOf(shape.t)
  if (cls === 'elliptical') {
    // bright core, long faint halo, squashed along z
    for (let i = 0; i < n; i++) {
      const rad = Math.min(1, -0.2 * Math.log(1 - r() * 0.999))
      const u = r() * 2 - 1
      const ph = r() * Math.PI * 2
      const s = Math.sqrt(1 - u * u)
      const col = mix(WARM, PALE, Math.min(1, rad * 1.6))
      put(c, rad * s * Math.cos(ph), rad * s * Math.sin(ph) * 0.92, rad * u * q, col, 0.5 + r() * 0.5, 0.7 + r() * 0.9)
    }
    return c
  }
  if (cls === 'irregular') {
    const clumps = 7 + Math.floor(r() * 5)
    const centres: { p: Vec3; s: number; w: number }[] = []
    for (let k = 0; k < clumps; k++) {
      const a = r() * Math.PI * 2
      const rad = Math.sqrt(r()) * 0.6
      centres.push({ p: [rad * Math.cos(a), rad * Math.sin(a), gauss(r) * 0.03], s: 0.08 + r() * 0.2, w: 0.5 + r() })
    }
    const total = centres.reduce((s, k) => s + k.w, 0)
    for (let i = 0; i < n; i++) {
      let pick = r() * total
      let k = centres[0]
      for (const cc of centres) {
        pick -= cc.w
        if (pick <= 0) {
          k = cc
          break
        }
      }
      const young = r() < 0.55
      const knot = young && r() < 0.06
      put(c, k.p[0] + gauss(r) * k.s, k.p[1] + gauss(r) * k.s, k.p[2] + gauss(r) * k.s * 0.35, knot ? PINK : young ? BLUE : PALE, 0.4 + r() * 0.6, 0.7 + r() * 1.0)
    }
    return c
  }

  // ---- discs: lenticular and spiral ----
  const spiral = cls === 'spiral'
  const T = Math.max(0, shape.t)
  const bulgeFrac = spiral ? Math.min(0.4, Math.max(0.06, 0.42 - 0.04 * T)) : 0.34
  const nBulge = Math.floor(n * bulgeFrac)
  const nBar = shape.bar ? Math.floor(n * 0.12) : 0
  const nDisc = n - nBulge - nBar
  const rb = Math.max(0.05, 0.13 - 0.007 * T)
  for (let i = 0; i < nBulge; i++) {
    const rad = Math.min(0.6, -rb * Math.log(1 - r() * 0.999))
    const u = r() * 2 - 1
    const ph = r() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    put(c, rad * s * Math.cos(ph), rad * s * Math.sin(ph), rad * u * 0.7, mix(WARM, PALE, Math.min(1, rad * 2)), 0.55 + r() * 0.45, 0.8 + r() * 0.9)
  }
  const barHalf = 0.28 + 0.03 * (9 - T) * 0.2
  for (let i = 0; i < nBar; i++) {
    const x = (r() * 2 - 1) * barHalf
    put(c, x, gauss(r) * 0.04, gauss(r) * 0.018, mix(WARM, PALE, Math.abs(x) / barHalf * 0.5), 0.55 + r() * 0.4, 0.8 + r() * 0.8)
  }
  const h = spiral ? 0.26 + 0.015 * T : 0.32
  const thick = spiral ? 0.02 : 0.045
  const armFrac = spiral ? Math.min(0.72, 0.42 + 0.04 * T) : 0
  const pitch = Math.tan((6 + 2.2 * T) * (Math.PI / 180))
  const nArms = shape.bar || T <= 5 ? 2 : 3
  const r0 = shape.bar ? barHalf * 0.95 : 0.06
  const phase = r() * Math.PI * 2
  const inner = (rad: number, theta: number, arm: number): number => phase + Math.log(Math.max(rad, r0) / r0) / pitch + (arm * Math.PI * 2) / nArms + theta
  for (let i = 0; i < nDisc; i++) {
    const inArm = spiral && r() < armFrac
    let rad = expRadius(r, h)
    let theta = r() * Math.PI * 2
    let colour = mix(PALE, WARM, Math.max(0, 0.5 - rad))
    let size = 0.7 + r() * 0.8
    if (inArm) {
      rad = Math.max(r0, rad)
      const arm = Math.floor(r() * nArms)
      theta = inner(rad, gauss(r) * (0.07 + 0.12 * rad), arm)
      colour = r() < 0.07 ? PINK : mix(BLUE, PALE, Math.min(1, 0.15 + rad * 0.5 * r()))
      size = 0.8 + r() * 1.1
    }
    put(c, rad * Math.cos(theta), rad * Math.sin(theta), gauss(r) * thick * (1 + rad * 0.5), colour, 0.35 + r() * 0.55, size)
  }
  // dust: dark lanes on the inner (trailing) edge of the arms, thin, so they show best edge-on
  if (spiral) {
    const nDust = Math.floor(n * 0.12)
    for (let i = 0; i < nDust; i++) {
      const rad = Math.max(r0, 0.12 + Math.pow(r(), 0.8) * 0.62)
      const arm = Math.floor(r() * nArms)
      const th = inner(rad, -0.12 - Math.abs(gauss(r)) * (0.09 + 0.1 * rad), arm)
      put(dust, rad * Math.cos(th), rad * Math.sin(th), gauss(r) * thick * 0.5, [0.12, 0.07, 0.04], 1, 1.6 + r() * 1.6)
    }
  }
  return c
}

function makePoints(cloud: Cloud, blending: THREE.Blending, alpha: number): THREE.Points {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(cloud.pos, 3))
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(cloud.col, 3))
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(cloud.size, 1))
  const m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending, uniforms: { uSize: { value: 2 }, uAlpha: { value: alpha } } })
  const p = new THREE.Points(g, m)
  p.frustumCulled = false
  return p
}

/** One galaxy's stars and dust, in a unit-radius frame (x long axis, z the axis of the disc). Put it in a group scaled to the galaxy's radius. */
export class GalaxyModel {
  readonly group = new THREE.Group()
  private readonly stars: THREE.Points
  private readonly dust: THREE.Points | null
  private readonly count: number
  private readonly baseAlpha = 0.55

  constructor(shape: GalaxyShape, count = 70000) {
    const dustCloud = newCloud()
    const cloud = buildStars(shape, count, dustCloud)
    this.count = cloud.size.length
    this.stars = makePoints(cloud, THREE.AdditiveBlending, this.baseAlpha)
    this.stars.renderOrder = 4
    this.group.add(this.stars)
    this.dust = dustCloud.size.length ? makePoints(dustCloud, THREE.NormalBlending, 0.05) : null
    if (this.dust) {
      this.dust.renderOrder = 5
      this.group.add(this.dust)
    }
  }

  /** `screenR`: the galaxy's radius on screen in pixels; `alpha`: 0..1 how much of the model to show. */
  update(screenR: number, alpha: number): void {
    // a point covers about the same share of the picture however close you are, so the disc neither dissolves nor blobs
    const s = Math.min(9, Math.max(1.6, Math.sqrt((Math.PI * screenR * screenR) / this.count) * 2.4))
    const sm = this.stars.material as THREE.ShaderMaterial
    sm.uniforms.uSize.value = s
    sm.uniforms.uAlpha.value = this.baseAlpha * alpha * Math.min(1, Math.max(0.35, 2.4 / s))
    if (this.dust) {
      const dm = this.dust.material as THREE.ShaderMaterial
      dm.uniforms.uSize.value = s * 1.15
      dm.uniforms.uAlpha.value = 0.05 * alpha
    }
    this.group.visible = alpha > 0.01
  }

  dispose(): void {
    this.group.removeFromParent()
    for (const p of [this.stars, this.dust]) {
      if (!p) continue
      p.geometry.dispose()
      ;(p.material as THREE.Material).dispose()
    }
  }
}
