// Earthquakes, volcanoes, heat spots and rocket launch pads on the Earth: point layers that are children of the Earth mesh, so they turn with it.
import * as THREE from 'three'
import type { HeatSpot, Quake, Volcano } from '@renderer/lib/hazards'
import { isUpcoming, type Launch } from '@renderer/lib/launches'
import type { AqiStation } from '@renderer/lib/aqi'

const DEG = Math.PI / 180

function unit(latDeg: number, lonDeg: number, r: number, out: Float32Array, i: number): void {
  const la = latDeg * DEG
  const lo = lonDeg * DEG
  out[3 * i] = r * Math.cos(la) * Math.cos(lo)
  out[3 * i + 1] = r * Math.cos(la) * Math.sin(lo)
  out[3 * i + 2] = r * Math.sin(la)
}

/** The point under a pixel (its index), ignoring points behind the globe and ones `keep` refuses. `reach` is how many pixels off still counts. */
function pickPoint(
  pos: Float32Array,
  count: number,
  keep: (i: number) => boolean,
  reach: (i: number) => number,
  px: number,
  py: number,
  w: number,
  h: number,
  camera: THREE.PerspectiveCamera,
  centre: THREE.Vector3,
  radiusAU: number,
  matrixWorld: THREE.Matrix4
): number | null {
  const cam = camera.position
  const v = new THREE.Vector3()
  const p = new THREE.Vector3()
  let best: { i: number; d: number } | null = null
  for (let i = 0; i < count; i++) {
    if (!keep(i)) continue
    p.set(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]).applyMatrix4(matrixWorld)
    v.copy(p).project(camera)
    if (v.z > 1 || v.z < -1) continue
    const d = Math.hypot(((v.x + 1) / 2) * w - px, ((1 - v.y) / 2) * h - py)
    if (d > reach(i) || (best && d >= best.d)) continue
    const dx = p.x - cam.x
    const dy = p.y - cam.y
    const dz = p.z - cam.z
    const len2 = dx * dx + dy * dy + dz * dz
    const t = Math.max(0, Math.min(1, ((centre.x - cam.x) * dx + (centre.y - cam.y) * dy + (centre.z - cam.z) * dz) / len2))
    if (Math.hypot(cam.x + dx * t - centre.x, cam.y + dy * t - centre.y, cam.z + dz * t - centre.z) < radiusAU * 0.999) continue // behind the globe
    best = { i, d }
  }
  return best ? best.i : null
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
/** Fade with the camera's distance from the Earth (AU) and with how far the scene's date is from now (hours). */
const fade = (distAU: number, hours: number): number => (1 - smooth(1.2e-3, 7e-3, distAU)) * (1 - smooth(3, 48, hours))

const COMMON_VERT = `
  #include <common>
  #include <logdepthbuf_pars_vertex>`
const COMMON_FRAG = `
  #include <common>
  #include <logdepthbuf_pars_fragment>`

// ---------------------------------------------------------------- earthquakes

/** A small jagged "crack" burst (with a dark outline baked in), sampled as an alpha/tint mask for each quake. */
function quakeIconTexture(): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2
  const cy = size / 2
  const spikes = 6
  const outerR = [26, 23, 27, 22, 25, 24]
  const innerR = [10, 8, 11, 8, 10, 9]
  const path = new Path2D()
  for (let i = 0; i < spikes; i++) {
    const aOuter = (Math.PI * 2 * i) / spikes - Math.PI / 2
    const aInner = aOuter + Math.PI / spikes
    const ox = cx + Math.cos(aOuter) * outerR[i]
    const oy = cy + Math.sin(aOuter) * outerR[i]
    const ix = cx + Math.cos(aInner) * innerR[i]
    const iy = cy + Math.sin(aInner) * innerR[i]
    if (i === 0) path.moveTo(ox, oy)
    else path.lineTo(ox, oy)
    path.lineTo(ix, iy)
  }
  path.closePath()
  ctx.strokeStyle = '#000'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 4
  ctx.stroke(path)
  ctx.fillStyle = '#fff'
  ctx.fill(path)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

const QUAKE_VERT = `${COMMON_VERT}
  attribute float aMag;
  attribute float aTime;
  uniform float uNow;
  uniform float uMinMag;
  uniform float uWindow;
  uniform float uScale;
  varying float vAge;
  void main() {
    float age = uNow - aTime;
    vAge = age;
    bool keep = aMag >= uMinMag && age <= uWindow && age >= -60.0;
    float base = clamp(6.0 + (aMag - 1.0) * 2.0, 6.0, 32.0);
    // big the moment it happens, easing smoothly down to its settled size over half an hour (not a hard cutoff)
    float freshT = smoothstep(0.0, 1800.0, age);
    float fresh = mix(4.2, 1.0, freshT);
    gl_PointSize = keep ? base * fresh * uScale : 0.0;
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
    #include <logdepthbuf_vertex>
  }`
const QUAKE_FRAG = `${COMMON_FRAG}
  uniform float uWindow;
  uniform float uOpacity;
  uniform sampler2D uQuakeIcon;
  varying float vAge;
  vec3 ageColour(float f) {
    vec3 a = vec3(1.0, 1.0, 1.0);
    vec3 b = vec3(1.0, 0.9, 0.3);
    vec3 c = vec3(1.0, 0.5, 0.15);
    vec3 d = vec3(0.85, 0.15, 0.1);
    if (f < 0.12) return mix(a, b, f / 0.12);
    if (f < 0.45) return mix(b, c, (f - 0.12) / 0.33);
    return mix(c, d, min(1.0, (f - 0.45) / 0.55));
  }
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p) * 2.0;
    if (r > 1.0) discard;
    float f = clamp(vAge / uWindow, 0.0, 1.0);
    vec3 col = ageColour(f);
    // eases from "just happened" (small crack sitting inside the animated ring) to "settled" (fills most of the sprite) over half an hour
    float freshT = smoothstep(0.0, 1800.0, vAge);
    float freshAmt = 1.0 - freshT;
    float core = mix(0.42, 0.92, freshT);
    vec2 uv = (gl_PointCoord - 0.5) / core + 0.5;
    vec4 icon = (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) ? vec4(0.0) : texture2D(uQuakeIcon, uv);
    float disc = icon.a;
    float ph = fract(vAge / 4.0);
    float ring = freshAmt * (1.0 - smoothstep(0.0, 0.07, abs(r - (0.4 + ph * 0.55)))) * (1.0 - ph);
    vec3 outCol = mix(vec3(0.06, 0.03, 0.03), col, icon.r);
    vec3 finalCol = mix(col, outCol, step(ring, disc));
    float a = max(disc, ring * 0.9) * mix(1.0, 0.65, f) * uOpacity;
    gl_FragColor = vec4(finalCol, a);
  }`

export class QuakeLayer {
  readonly points: THREE.Points
  rows: Quake[] = []
  private pos = new Float32Array(0)
  private readonly quakeIconTex = quakeIconTexture()
  private readonly uniforms = { uNow: { value: 0 }, uMinMag: { value: 2.5 }, uWindow: { value: 86_400 }, uScale: { value: 1 }, uOpacity: { value: 0 }, uQuakeIcon: { value: this.quakeIconTex } }
  private readonly epoch = Date.now()
  opacity = 0
  /** true while a quake newer than 15 minutes is showing (its ring is animating, so the picture must keep redrawing) */
  animating = false
  minMag = 2.5
  hours = 24

  constructor(private readonly parent: THREE.Object3D) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('aMag', new THREE.BufferAttribute(new Float32Array(0), 1))
    geo.setAttribute('aTime', new THREE.BufferAttribute(new Float32Array(0), 1))
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: this.uniforms, vertexShader: QUAKE_VERT, fragmentShader: QUAKE_FRAG })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 6
    parent.add(this.points)
  }

  setRows(rows: Quake[]): void {
    // a very busy month keeps its biggest quakes: the globe has to stay readable and fast
    const MAX = 14_000
    const kept = rows.length > MAX ? [...rows].sort((a, b) => b.mag - a.mag).slice(0, MAX) : rows
    this.rows = kept
    const n = kept.length
    this.pos = new Float32Array(n * 3)
    const mag = new Float32Array(n)
    const time = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      unit(kept[i].latDeg, kept[i].lonDeg, 1.0012, this.pos, i)
      mag[i] = kept[i].mag
      time[i] = (kept[i].tMs - this.epoch) / 1000
    }
    const g = this.points.geometry
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1))
    g.setAttribute('aTime', new THREE.BufferAttribute(time, 1))
    g.setDrawRange(0, n)
  }

  layout(distAU: number, hours: number, pixelRatio: number): void {
    const u = this.uniforms
    u.uNow.value = (Date.now() - this.epoch) / 1000
    u.uMinMag.value = this.minMag
    u.uWindow.value = this.hours * 3600
    u.uScale.value = pixelRatio * 1.15
    this.opacity = fade(distAU, hours)
    u.uOpacity.value = 0.95 * this.opacity
    this.points.visible = this.opacity > 0.02 && this.rows.length > 0
    const freshFrom = Date.now() - 1_800_000
    this.animating = this.points.visible && this.rows.some((q) => q.tMs > freshFrom && q.mag >= this.minMag)
  }

  private shown(i: number): boolean {
    const q = this.rows[i]
    return q.mag >= this.minMag && Date.now() - q.tMs <= this.hours * 3_600_000
  }

  local(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2])
  }

  pick(px: number, py: number, w: number, h: number, cam: THREE.PerspectiveCamera, centre: THREE.Vector3, radiusAU: number, m: THREE.Matrix4): number | null {
    if (this.opacity < 0.3 || !this.points.visible) return null
    return pickPoint(this.pos, this.rows.length, (i) => this.shown(i), (i) => Math.max(8, 3 + (this.rows[i].mag - 1) * 1.7 * 0.6 + 4), px, py, w, h, cam, centre, radiusAU, m)
  }

  dispose(): void {
    this.parent.remove(this.points)
    this.points.geometry.dispose()
    ;(this.points.material as THREE.Material).dispose()
    this.quakeIconTex.dispose()
  }
}

// ---------------------------------------------------------------- volcanoes

/** A mountain silhouette with a crater notch at the peak (dark outline baked in), sampled as an alpha/tint mask. */
function volcanoTexture(): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const path = new Path2D()
  path.moveTo(6, 58)
  path.lineTo(25, 14)
  path.lineTo(29, 24)
  path.lineTo(35, 24)
  path.lineTo(39, 14)
  path.lineTo(58, 58)
  path.closePath()
  ctx.strokeStyle = '#000'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 5
  ctx.stroke(path)
  ctx.fillStyle = '#fff'
  ctx.fill(path)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

const VOLCANO_VERT = `${COMMON_VERT}
  attribute float aLevel;
  uniform float uAll;
  uniform float uScale;
  varying float vLevel;
  void main() {
    vLevel = aLevel;
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
    float size = aLevel > 0.5 ? 15.0 + 4.0 * aLevel : (uAll > 0.5 ? 9.0 : 0.0);
    gl_PointSize = size * uScale;
    #include <logdepthbuf_vertex>
  }`
const VOLCANO_FRAG = `${COMMON_FRAG}
  uniform float uOpacity;
  uniform sampler2D uVolcanoIcon;
  varying float vLevel;
  void main() {
    #include <logdepthbuf_fragment>
    vec4 icon = texture2D(uVolcanoIcon, gl_PointCoord);
    if (icon.a < 0.05) discard;
    vec3 col = vLevel > 2.5 ? vec3(1.0, 0.3, 0.3) : vLevel > 1.5 ? vec3(1.0, 0.6, 0.24) : vLevel > 0.5 ? vec3(1.0, 0.85, 0.3) : vec3(0.56, 0.64, 0.76);
    vec3 outCol = mix(vec3(0.05, 0.03, 0.03), col, icon.r);
    float a = (vLevel > 0.5 ? 1.0 : 0.5) * icon.a * uOpacity;
    gl_FragColor = vec4(outCol, a);
  }`

export class VolcanoLayer {
  readonly points: THREE.Points
  rows: Volcano[] = []
  private pos = new Float32Array(0)
  private readonly volcanoIconTex = volcanoTexture()
  private readonly uniforms = { uAll: { value: 1 }, uScale: { value: 1 }, uOpacity: { value: 0 }, uVolcanoIcon: { value: this.volcanoIconTex } }
  opacity = 0
  showAll = true

  constructor(private readonly parent: THREE.Object3D) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('aLevel', new THREE.BufferAttribute(new Float32Array(0), 1))
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: this.uniforms, vertexShader: VOLCANO_VERT, fragmentShader: VOLCANO_FRAG })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 6
    parent.add(this.points)
  }

  setRows(rows: Volcano[]): void {
    this.rows = rows
    const n = rows.length
    this.pos = new Float32Array(n * 3)
    const level = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      unit(rows[i].latDeg, rows[i].lonDeg, 1.0012, this.pos, i)
      level[i] = rows[i].level
    }
    const g = this.points.geometry
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    g.setAttribute('aLevel', new THREE.BufferAttribute(level, 1))
    g.setDrawRange(0, n)
  }

  layout(distAU: number, hours: number, pixelRatio: number): void {
    const u = this.uniforms
    u.uAll.value = this.showAll ? 1 : 0
    u.uScale.value = pixelRatio * 1.1
    this.opacity = fade(distAU, 0) // the volcanoes themselves do not depend on the scene's date
    u.uOpacity.value = this.opacity
    this.points.visible = this.opacity > 0.02 && this.rows.length > 0
  }

  local(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2])
  }

  pick(px: number, py: number, w: number, h: number, cam: THREE.PerspectiveCamera, centre: THREE.Vector3, radiusAU: number, m: THREE.Matrix4): number | null {
    if (this.opacity < 0.3 || !this.points.visible) return null
    return pickPoint(this.pos, this.rows.length, (i) => this.showAll || this.rows[i].level > 0, (i) => (this.rows[i].level > 0 ? 14 : 9), px, py, w, h, cam, centre, radiusAU, m)
  }

  dispose(): void {
    this.parent.remove(this.points)
    this.points.geometry.dispose()
    ;(this.points.material as THREE.Material).dispose()
    this.volcanoIconTex.dispose()
  }
}

// ---------------------------------------------------------------- heat spots

const HEAT_VERT = `${COMMON_VERT}
  attribute float aFrp;
  uniform float uScale;
  varying float vFrp;
  void main() {
    vFrp = aFrp;
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
    gl_PointSize = clamp(2.5 + log(1.0 + aFrp) * 1.1, 2.5, 12.0) * uScale;
    #include <logdepthbuf_vertex>
  }`
const HEAT_FRAG = `${COMMON_FRAG}
  uniform float uOpacity;
  varying float vFrp;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p) * 2.0;
    if (r > 1.0) discard;
    vec3 col = mix(vec3(1.0, 0.45, 0.1), vec3(1.0, 0.95, 0.55), clamp(vFrp / 120.0, 0.0, 1.0));
    gl_FragColor = vec4(col, (1.0 - r * r) * 0.85 * uOpacity);
  }`

export class HeatLayer {
  readonly points: THREE.Points
  rows: HeatSpot[] = []
  private pos = new Float32Array(0)
  private readonly uniforms = { uScale: { value: 1 }, uOpacity: { value: 0 } }
  opacity = 0

  constructor(private readonly parent: THREE.Object3D) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('aFrp', new THREE.BufferAttribute(new Float32Array(0), 1))
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: this.uniforms, vertexShader: HEAT_VERT, fragmentShader: HEAT_FRAG })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 5
    parent.add(this.points)
  }

  setRows(rows: HeatSpot[]): void {
    this.rows = rows
    const n = rows.length
    this.pos = new Float32Array(n * 3)
    const frp = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      unit(rows[i].latDeg, rows[i].lonDeg, 1.0009, this.pos, i)
      frp[i] = rows[i].frp
    }
    const g = this.points.geometry
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    g.setAttribute('aFrp', new THREE.BufferAttribute(frp, 1))
    g.setDrawRange(0, n)
  }

  layout(distAU: number, hours: number, pixelRatio: number): void {
    this.uniforms.uScale.value = pixelRatio
    this.opacity = fade(distAU, hours)
    this.uniforms.uOpacity.value = this.opacity
    this.points.visible = this.opacity > 0.02 && this.rows.length > 0
  }

  dispose(): void {
    this.parent.remove(this.points)
    this.points.geometry.dispose()
    ;(this.points.material as THREE.Material).dispose()
  }
}

// ---------------------------------------------------------------- air quality

const AQI_VERT = `${COMMON_VERT}
  attribute float aAqi;
  uniform float uScale;
  varying float vAqi;
  void main() {
    vAqi = aAqi;
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
    gl_PointSize = 6.0 * uScale;
    #include <logdepthbuf_vertex>
  }`
const AQI_FRAG = `${COMMON_FRAG}
  uniform float uOpacity;
  varying float vAqi;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p) * 2.0;
    if (r > 1.0) discard;
    vec3 col = vAqi <= 50.0 ? vec3(0.0, 0.89, 0.0)
      : vAqi <= 100.0 ? vec3(1.0, 1.0, 0.0)
      : vAqi <= 150.0 ? vec3(1.0, 0.49, 0.0)
      : vAqi <= 200.0 ? vec3(1.0, 0.0, 0.0)
      : vAqi <= 300.0 ? vec3(0.56, 0.25, 0.59)
      : vec3(0.49, 0.0, 0.14);
    gl_FragColor = vec4(col, (1.0 - r * r * 0.3) * uOpacity);
  }`

export class AqiLayer {
  readonly points: THREE.Points
  rows: AqiStation[] = []
  private pos = new Float32Array(0)
  private readonly uniforms = { uScale: { value: 1 }, uOpacity: { value: 0 } }
  opacity = 0

  constructor(private readonly parent: THREE.Object3D) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('aAqi', new THREE.BufferAttribute(new Float32Array(0), 1))
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: this.uniforms, vertexShader: AQI_VERT, fragmentShader: AQI_FRAG })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 6
    parent.add(this.points)
  }

  setRows(rows: AqiStation[]): void {
    this.rows = rows
    const n = rows.length
    this.pos = new Float32Array(n * 3)
    const aqi = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      unit(rows[i].latDeg, rows[i].lonDeg, 1.0012, this.pos, i)
      aqi[i] = rows[i].aqi
    }
    const g = this.points.geometry
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    g.setAttribute('aAqi', new THREE.BufferAttribute(aqi, 1))
    g.setDrawRange(0, n)
  }

  layout(distAU: number, pixelRatio: number): void {
    this.uniforms.uScale.value = pixelRatio
    this.opacity = fade(distAU, 0)
    this.uniforms.uOpacity.value = this.opacity
    this.points.visible = this.opacity > 0.02 && this.rows.length > 0
  }

  pick(px: number, py: number, w: number, h: number, cam: THREE.PerspectiveCamera, centre: THREE.Vector3, radiusAU: number, m: THREE.Matrix4): number | null {
    if (this.opacity < 0.3 || !this.points.visible) return null
    return pickPoint(this.pos, this.rows.length, () => true, () => 10, px, py, w, h, cam, centre, radiusAU, m)
  }

  dispose(): void {
    this.parent.remove(this.points)
    this.points.geometry.dispose()
    ;(this.points.material as THREE.Material).dispose()
  }
}

// ---------------------------------------------------------------- rocket launches

/** A white rocket silhouette (with a dark outline baked in, so it reads on bright daytime ground) on a transparent
 * square, sampled as an alpha/tint mask for each launch pad marker. */
function rocketTexture(): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const path = new Path2D()
  path.moveTo(32, 4)
  path.lineTo(44, 24)
  path.lineTo(44, 44)
  path.lineTo(56, 60)
  path.lineTo(40, 46)
  path.lineTo(24, 46)
  path.lineTo(8, 60)
  path.lineTo(20, 44)
  path.lineTo(20, 24)
  path.closePath()
  ctx.strokeStyle = '#000'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 5
  ctx.stroke(path)
  ctx.fillStyle = '#fff'
  ctx.fill(path)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

const LAUNCH_VERT = `${COMMON_VERT}
  attribute float aClass;
  attribute float aCountdownHrs;
  uniform float uScale;
  uniform float uTime;
  varying float vClass;
  void main() {
    vClass = aClass;
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
    float base = aClass < 1.5 ? 16.0 : 11.0;
    float soon = aClass < 1.5 && aCountdownHrs >= 0.0 && aCountdownHrs < 6.0 ? (1.0 - aCountdownHrs / 6.0) : 0.0;
    float pulse = 1.0 + 0.4 * soon * sin(uTime * 4.0);
    gl_PointSize = base * pulse * uScale;
    #include <logdepthbuf_vertex>
  }`
const LAUNCH_FRAG = `${COMMON_FRAG}
  uniform float uOpacity;
  uniform sampler2D uRocket;
  varying float vClass;
  void main() {
    #include <logdepthbuf_fragment>
    vec4 rocket = texture2D(uRocket, gl_PointCoord);
    if (rocket.a < 0.05) discard;
    vec3 col = vClass < 0.5 ? vec3(0.35, 0.9, 0.45) : vClass < 1.5 ? vec3(0.7, 0.7, 0.78) : vClass < 2.5 ? vec3(0.45, 0.7, 1.0) : vec3(1.0, 0.35, 0.35);
    // the texture's own dark outline (rocket.r near 0) shows the marker on bright daytime ground too
    vec3 outCol = mix(vec3(0.02, 0.02, 0.02), col, rocket.r);
    gl_FragColor = vec4(outCol, rocket.a * uOpacity);
  }`

/** 0 upcoming (Go), 1 upcoming (other status), 2 flown successfully, 3 failed - the classes LAUNCH_FRAG colours by. */
function launchClass(l: Launch): number {
  if (l.status === 'Success') return 2
  if (l.status === 'Failure' || l.status === 'Partial Failure') return 3
  return l.status === 'Go' ? 0 : 1
}

export class LaunchLayer {
  readonly points: THREE.Points
  rows: Launch[] = []
  private pos = new Float32Array(0)
  private readonly rocketTex = rocketTexture()
  private readonly uniforms = { uScale: { value: 1 }, uOpacity: { value: 0 }, uTime: { value: 0 }, uRocket: { value: this.rocketTex } }
  opacity = 0

  constructor(private readonly parent: THREE.Object3D) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('aClass', new THREE.BufferAttribute(new Float32Array(0), 1))
    geo.setAttribute('aCountdownHrs', new THREE.BufferAttribute(new Float32Array(0), 1))
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: this.uniforms, vertexShader: LAUNCH_VERT, fragmentShader: LAUNCH_FRAG })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 6
    parent.add(this.points)
  }

  /** Rows with a real pad location, upcoming or completed within the last 48h (older completions are dropped rather than faded). */
  setRows(rows: Launch[], nowMs: number): void {
    this.rows = rows.filter((l) => l.lat != null && l.lon != null && (isUpcoming(l) || (l.netMs != null && nowMs - l.netMs < 48 * 3_600_000)))
    const n = this.rows.length
    this.pos = new Float32Array(n * 3)
    const cls = new Float32Array(n)
    const countdown = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const l = this.rows[i]
      unit(l.lat!, l.lon!, 1.0012, this.pos, i)
      cls[i] = launchClass(l)
      countdown[i] = l.netMs != null ? (l.netMs - nowMs) / 3_600_000 : 1e9
    }
    const g = this.points.geometry
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    g.setAttribute('aClass', new THREE.BufferAttribute(cls, 1))
    g.setAttribute('aCountdownHrs', new THREE.BufferAttribute(countdown, 1))
    g.setDrawRange(0, n)
  }

  layout(distAU: number, pixelRatio: number, timeS: number): void {
    this.uniforms.uScale.value = pixelRatio
    this.uniforms.uTime.value = timeS
    this.opacity = fade(distAU, 0)
    this.uniforms.uOpacity.value = this.opacity
    this.points.visible = this.opacity > 0.02 && this.rows.length > 0
  }

  pick(px: number, py: number, w: number, h: number, cam: THREE.PerspectiveCamera, centre: THREE.Vector3, radiusAU: number, m: THREE.Matrix4): number | null {
    if (this.opacity < 0.3 || !this.points.visible) return null
    return pickPoint(this.pos, this.rows.length, () => true, () => 12, px, py, w, h, cam, centre, radiusAU, m)
  }

  dispose(): void {
    this.parent.remove(this.points)
    this.points.geometry.dispose()
    ;(this.points.material as THREE.Material).dispose()
    this.rocketTex.dispose()
  }
}
