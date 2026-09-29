// Wind or sea currents on the Earth as thousands of small streaks that drift along the real field (a moving picture of a real velocity
// grid, sped up so it can be watched). One instance per layer; both are children of the Earth mesh, so they turn with it.
import * as THREE from 'three'
import { FLOW_STOPS, sampleFlow, type FlowGrid } from '@renderer/lib/flow'

const DEG = Math.PI / 180
const EARTH_R_M = 6_371_000
const SAMPLE_DT = 0.09 // seconds between the points that make up a trail

export interface FlowStyle {
  count: number
  /** distance from the Earth's centre, in Earth radii */
  radius: number
  /** model seconds per real second when the whole globe is in view */
  timeScale: number
  /** the speed (m/s) at the hot end of the colour scale */
  speedMax: number
  /** points in a trail */
  trail: number
  /** how long a particle lives, seconds (min, max) */
  life: [number, number]
  opacity: number
}

const glslStops = (): string =>
  `const vec3 C[5] = vec3[5](${FLOW_STOPS.map((s) => `vec3(${s.rgb.map((c) => c.toFixed(3)).join(',')})`).join(',')});
   vec3 ramp(float t) { float f = clamp(t, 0.0, 1.0) * 4.0; int i = int(min(floor(f), 3.0)); return mix(C[i], C[i + 1], f - float(i)); }`

export class FlowParticles {
  readonly lines: THREE.LineSegments
  private grid: FlowGrid | null = null
  private readonly n: number
  private readonly L: number
  private readonly lat: Float32Array
  private readonly lon: Float32Array
  private readonly age: Float32Array
  private readonly life: Float32Array
  private readonly spd: Float32Array
  private readonly hist: Float32Array
  private readonly pos: Float32Array
  private readonly info: Float32Array
  private head = 0
  private sampleAcc = 0
  private readonly tmp = { u: 0, v: 0 }
  private readonly uniforms: { uOpacity: { value: number }; uMax: { value: number } }
  /** true while it is on screen and moving: the engine keeps redrawing */
  active = false
  visible = false

  constructor(
    parent: THREE.Object3D,
    private readonly style: FlowStyle
  ) {
    const n = (this.n = style.count)
    const L = (this.L = style.trail)
    this.lat = new Float32Array(n)
    this.lon = new Float32Array(n)
    this.age = new Float32Array(n).fill(1e9) // all dead: they are placed on the first update
    this.life = new Float32Array(n)
    this.spd = new Float32Array(n)
    this.hist = new Float32Array(n * L * 3)
    this.pos = new Float32Array(n * L * 2 * 3)
    this.info = new Float32Array(n * L * 2 * 2)
    const t = new Float32Array(n * L * 2)
    for (let i = 0; i < n; i++)
      for (let k = 0; k < L; k++) {
        t[(i * L + k) * 2] = 1 - k / L
        t[(i * L + k) * 2 + 1] = 1 - (k + 1) / L
      }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aInfo', new THREE.BufferAttribute(this.info, 2).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aT', new THREE.BufferAttribute(t, 1))
    this.uniforms = { uOpacity: { value: style.opacity }, uMax: { value: style.speedMax } }
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: this.uniforms,
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec2 aInfo;
        attribute float aT;
        varying vec2 vInfo;
        varying float vT;
        void main() {
          vInfo = aInfo;
          vT = aT;
          gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float uOpacity;
        uniform float uMax;
        varying vec2 vInfo;
        varying float vT;
        ${glslStops()}
        void main() {
          #include <logdepthbuf_fragment>
          gl_FragColor = vec4(ramp(vInfo.x / uMax), vInfo.y * vT * uOpacity);
        }`
    })
    this.lines = new THREE.LineSegments(geo, mat)
    this.lines.frustumCulled = false
    this.lines.renderOrder = 7
    this.lines.visible = false
    parent.add(this.lines)
  }

  setGrid(g: FlowGrid | null): void {
    const fresh = !this.grid && !!g
    this.grid = g
    if (fresh) this.age.fill(1e9) // start over from a clean spread
    if (!g) this.lines.geometry.setDrawRange(0, 0)
  }

  /** The speed at the hot end of the colour scale (it depends on the wind level). */
  setSpeedMax(v: number): void {
    this.uniforms.uMax.value = v
  }

  /** Relative rate (wind levels move at different paces). */
  timeFactor = 1

  /**
   * `camDir`: unit vector from the Earth's centre towards the camera, in the Earth's own axes. `camRe`: the camera's distance from the
   * centre in Earth radii. `fade` (0..1): how much of the layer to show at all (dates the data does not cover, being far away).
   * Returns true while streaks are moving on screen.
   */
  update(dt: number, camDir: THREE.Vector3, camRe: number, fade: number): boolean {
    const g = this.grid
    const show = this.visible && !!g && fade > 0.02 && camRe > 1.0005
    this.lines.visible = show
    this.active = show
    if (!show || !g) return false
    const { n, L, style } = this
    this.uniforms.uOpacity.value = style.opacity * fade
    const cosCap = 1 / camRe // the visible cap: points on the sphere with dot(p, camDir) above this
    const cap = Math.acos(Math.min(1, cosCap))
    const cosSpawn = Math.cos(cap * 0.97)
    const cosKeep = Math.cos(cap * 1.02)
    // the streaks slow down as you come close, so what you see moves at the same pace on screen
    const pace = Math.min(1.6, Math.max(0.06, cap / (Math.PI / 3)))
    const dtModel = Math.min(dt, 0.1) * style.timeScale * this.timeFactor * pace
    // a basis perpendicular to the camera direction, to place new streaks inside the visible cap
    const cx = camDir.x
    const cy = camDir.y
    const cz = camDir.z
    let ex = -cy
    let ey = cx
    let ez = 0
    const el = Math.hypot(ex, ey) || 1
    ex /= el
    ey /= el
    const fx = cy * ez - cz * ey
    const fy = cz * ex - cx * ez
    const fz = cx * ey - cy * ex
    const sampleNow = (this.sampleAcc += dt) >= SAMPLE_DT
    if (sampleNow) {
      this.sampleAcc = 0
      this.head = (this.head + 1) % L
    }
    const r = style.radius
    const tmp = this.tmp
    const dtReal = Math.min(dt, 0.1)
    for (let i = 0; i < n; i++) {
      let la = this.lat[i]
      let lo = this.lon[i]
      let alive = this.age[i] < this.life[i]
      if (alive) {
        const px = Math.cos(la) * Math.cos(lo)
        const py = Math.cos(la) * Math.sin(lo)
        const pz = Math.sin(la)
        if (px * cx + py * cy + pz * cz < cosKeep) alive = false
      }
      let placed = false
      if (!alive) {
        // a new streak somewhere in view, on a spot with data
        for (let tries = 0; tries < 4 && !placed; tries++) {
          const ct = 1 - Math.random() * (1 - cosSpawn)
          const st = Math.sqrt(1 - ct * ct)
          const ph = Math.random() * Math.PI * 2
          const a = Math.cos(ph) * st
          const b = Math.sin(ph) * st
          const px = cx * ct + ex * a + fx * b
          const py = cy * ct + ey * a + fy * b
          const pz = cz * ct + ez * a + fz * b
          la = Math.asin(Math.max(-1, Math.min(1, pz)))
          lo = Math.atan2(py, px)
          if (sampleFlow(g, la / DEG, lo / DEG, tmp)) placed = true
        }
        if (placed) {
          this.lat[i] = la
          this.lon[i] = lo
          this.age[i] = Math.random() * 0.4
          this.life[i] = style.life[0] + Math.random() * (style.life[1] - style.life[0])
        } else {
          this.age[i] = 1e9 // nowhere with data in view this time: try again next frame
          this.life[i] = 0
        }
      }
      if (this.age[i] < this.life[i] && sampleFlow(g, la / DEG, lo / DEG, tmp)) {
        if (!placed) {
          const cl = Math.max(0.05, Math.cos(la))
          la += (tmp.v * dtModel) / EARTH_R_M
          lo += (tmp.u * dtModel) / (EARTH_R_M * cl)
          la = Math.max(-1.55, Math.min(1.55, la))
          if (lo > Math.PI) lo -= 2 * Math.PI
          else if (lo < -Math.PI) lo += 2 * Math.PI
          this.lat[i] = la
          this.lon[i] = lo
          this.age[i] += dtReal
        }
        this.spd[i] = Math.hypot(tmp.u, tmp.v)
      } else if (this.age[i] < this.life[i]) {
        this.age[i] = 1e9 // ran onto land or off the data: replace it next frame
        this.life[i] = 0
      }
      const clat = Math.cos(la)
      const X = r * clat * Math.cos(lo)
      const Y = r * clat * Math.sin(lo)
      const Z = r * Math.sin(la)
      const hb = i * L * 3
      if (placed) {
        for (let k = 0; k < L; k++) {
          const o = hb + k * 3
          this.hist[o] = X
          this.hist[o + 1] = Y
          this.hist[o + 2] = Z
        }
      } else if (sampleNow) {
        const o = hb + this.head * 3
        this.hist[o] = X
        this.hist[o + 1] = Y
        this.hist[o + 2] = Z
      }
      // the streak: the current point, then the trail from the newest sample back, as L segments
      const age = this.age[i]
      const lf = this.life[i]
      const alpha = Math.min(1, age / 0.35) * Math.min(1, Math.max(0, (lf - age) / 0.6))
      const spd = this.spd[i]
      let ax = X
      let ay = Y
      let az = Z
      const vb = i * L * 6
      const ib = i * L * 4
      for (let k = 0; k < L; k++) {
        const slot = (this.head - k + L * 2) % L
        const o = hb + slot * 3
        const bx = this.hist[o]
        const by = this.hist[o + 1]
        const bz = this.hist[o + 2]
        const p = vb + k * 6
        this.pos[p] = ax
        this.pos[p + 1] = ay
        this.pos[p + 2] = az
        this.pos[p + 3] = bx
        this.pos[p + 4] = by
        this.pos[p + 5] = bz
        const q = ib + k * 4
        this.info[q] = spd
        this.info[q + 1] = alpha
        this.info[q + 2] = spd
        this.info[q + 3] = alpha
        ax = bx
        ay = by
        az = bz
      }
    }
    const geo = this.lines.geometry
    geo.attributes.position.needsUpdate = true
    geo.attributes.aInfo.needsUpdate = true
    geo.setDrawRange(0, n * L * 2)
    return true
  }

  dispose(): void {
    this.lines.removeFromParent()
    this.lines.geometry.dispose()
    ;(this.lines.material as THREE.Material).dispose()
  }
}
