// The ships on the Earth: one small hull icon per ship, turned to the way it is heading on the screen, coloured by type. A child of the
// Earth mesh, so it turns with the Earth. Like the aircraft layer, positions are carried along each ship's course between reports.
import * as THREE from 'three'
import { advanceShip, SHIP_CATS, type Ship } from '@renderer/lib/ships'

const DEG = Math.PI / 180
const RADIUS = 1.0012 // just above the surface, under the clouds

const catColour = (id: number): THREE.Color => new THREE.Color(SHIP_CATS.find((c) => c.id === id)?.colour ?? '#b8c4d6')

export function makeShipIcon(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.beginPath()
  g.moveTo(32, 4)
  g.lineTo(45, 22)
  g.lineTo(43, 56)
  g.lineTo(21, 56)
  g.lineTo(19, 22)
  g.closePath()
  g.lineWidth = 6
  g.strokeStyle = 'rgba(20,24,34,0.85)'
  g.stroke()
  g.fillStyle = '#ffffff'
  g.fill()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

export class ShipLayer {
  readonly points: THREE.Points
  rows: Ship[] = []
  private pos = new Float32Array(0)
  private dirs = new Float32Array(0)
  private cols = new Float32Array(0)
  /** rows by MMSI, to find a ship again after a new snapshot */
  index = new Map<number, number>()
  private lastAt = 0
  private readonly uniforms: { uTex: { value: THREE.Texture }; uSize: { value: number }; uAspect: { value: number }; uOpacity: { value: number } }
  opacity = 0
  /** categories not shown (ids) */
  hidden = new Set<number>()

  constructor(
    private readonly parent: THREE.Object3D,
    icon: THREE.Texture
  ) {
    this.uniforms = { uTex: { value: icon }, uSize: { value: 10 }, uAspect: { value: 1 }, uOpacity: { value: 0 } }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('dir', new THREE.BufferAttribute(this.dirs, 3))
    geo.setAttribute('aCol', new THREE.BufferAttribute(this.cols, 3))
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: this.uniforms,
      // a point sprite turned to the ship's heading *on the screen*: the vertex shader projects the point and a spot a little way ahead of it
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        uniform float uSize;
        uniform float uAspect;
        attribute vec3 dir;
        attribute vec3 aCol;
        varying vec2 vDir;
        varying vec3 vCol;
        void main() {
          vec4 c1 = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
          vec4 c2 = projectionMatrix * (modelViewMatrix * vec4(position + dir * 0.004, 1.0));
          vec2 d = c2.xy / c2.w - c1.xy / c1.w;
          d.x *= uAspect;
          vDir = length(d) > 1e-9 ? normalize(d) : vec2(0.0, 1.0);
          vCol = aCol;
          gl_PointSize = dot(aCol, aCol) < 0.0001 ? 0.0 : uSize;
          gl_Position = c1;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform sampler2D uTex;
        uniform float uOpacity;
        varying vec2 vDir;
        varying vec3 vCol;
        void main() {
          #include <logdepthbuf_fragment>
          vec2 p = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y);
          vec2 uv = vec2(dot(p, vec2(vDir.y, -vDir.x)), dot(p, vDir)) + 0.5;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          vec4 t = texture2D(uTex, uv);
          if (t.a < 0.05) discard;
          gl_FragColor = vec4(vCol * t.rgb, t.a * uOpacity);
        }`
    })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 4
    parent.add(this.points)
  }

  /** A new snapshot from the backend. */
  setRows(rows: Ship[]): void {
    this.rows = rows
    this.index = new Map(rows.map((r, i) => [r.mmsi, i]))
    const n = rows.length
    this.pos = new Float32Array(n * 3)
    this.dirs = new Float32Array(n * 3)
    this.cols = new Float32Array(n * 3)
    const g = this.points.geometry
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    g.setAttribute('dir', new THREE.BufferAttribute(this.dirs, 3))
    g.setAttribute('aCol', new THREE.BufferAttribute(this.cols, 3))
    g.setDrawRange(0, n)
    this.paint()
    this.advance(true)
  }

  /** Which categories to draw (ids that are switched off are hidden). */
  setHidden(hidden: Set<number>): void {
    this.hidden = hidden
    this.paint()
  }

  private paint(): void {
    const c = new THREE.Color()
    for (let i = 0; i < this.rows.length; i++) {
      if (this.hidden.has(this.rows[i].cat)) this.cols.fill(0, 3 * i, 3 * i + 3)
      else {
        c.copy(catColour(this.rows[i].cat))
        this.cols[3 * i] = c.r
        this.cols[3 * i + 1] = c.g
        this.cols[3 * i + 2] = c.b
      }
    }
    this.points.geometry.attributes.aCol.needsUpdate = true
  }

  /** Move every ship along its course to the present. About every 2 s. Returns true when something changed. */
  advance(force = false): boolean {
    const now = performance.now()
    if (!force && now - this.lastAt < 2000) return false
    this.lastAt = now
    const t = Date.now()
    const { rows, pos, dirs } = this
    for (let i = 0; i < rows.length; i++) {
      const q = advanceShip(rows[i], t)
      const la = q.latDeg * DEG
      const lo = q.lonDeg * DEG
      const cla = Math.cos(la)
      const sla = Math.sin(la)
      const clo = Math.cos(lo)
      const slo = Math.sin(lo)
      pos[3 * i] = RADIUS * cla * clo
      pos[3 * i + 1] = RADIUS * cla * slo
      pos[3 * i + 2] = RADIUS * sla
      const trk = rows[i].courseDeg * DEG
      const n = Math.cos(trk)
      const e = Math.sin(trk)
      dirs[3 * i] = -sla * clo * n - slo * e
      dirs[3 * i + 1] = -sla * slo * n + clo * e
      dirs[3 * i + 2] = cla * n
    }
    this.points.geometry.attributes.position.needsUpdate = true
    this.points.geometry.attributes.dir.needsUpdate = true
    return true
  }

  /** Fade with distance from the Earth (`distAU`) and with how far the scene's date is from now (`hours`); size grows as you come in. */
  layout(distAU: number, earthRadiusAU: number, hours: number, pixelRatio: number, aspect: number, ramp: (d: number, a: number, b: number) => number): void {
    this.opacity = (1 - ramp(distAU, 3e-4, 2e-3)) * (1 - ramp(hours, 3, 48))
    const alt = distAU / earthRadiusAU - 1
    this.uniforms.uOpacity.value = 0.95 * this.opacity
    this.uniforms.uSize.value = (7 + 8 * (1 - ramp(alt, 0.05, 3))) * pixelRatio
    this.uniforms.uAspect.value = aspect
    this.points.visible = this.opacity > 0.02 && this.rows.length > 0
  }

  /** Where ship `i` is now, in the Earth's own axes (unit radii). */
  local(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2])
  }

  /** The ship under a pixel (row index) or null; ships behind the globe are ignored. */
  pick(px: number, py: number, w: number, h: number, camera: THREE.PerspectiveCamera, centre: THREE.Vector3, radiusAU: number, matrixWorld: THREE.Matrix4): number | null {
    if (this.opacity < 0.3 || !this.points.visible) return null
    const cam = camera.position
    const v = new THREE.Vector3()
    const p = new THREE.Vector3()
    let best: { i: number; d: number } | null = null
    for (let i = 0; i < this.rows.length; i++) {
      if (this.hidden.has(this.rows[i].cat)) continue
      p.set(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]).applyMatrix4(matrixWorld)
      v.copy(p).project(camera)
      if (v.z > 1 || v.z < -1) continue
      const d = Math.hypot(((v.x + 1) / 2) * w - px, ((1 - v.y) / 2) * h - py)
      if (d > 10 || (best && d >= best.d)) continue
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

  dispose(): void {
    this.parent.remove(this.points)
    this.points.geometry.dispose()
    ;(this.points.material as THREE.Material).dispose()
  }
}
