// Lightning on the 3D Earth: every strike as a flash that pops and then fades through white, yellow, orange
// and red as it ages, plus a heat map of where lightning has been most frequent over the same period.
//
// Strikes live in fixed-size arrays used as a ring, so a busy storm day never grows memory. The flashes are one
// point sprite each; their colour, size and fade are worked out on the GPU from the strike's age, so nothing is
// rewritten as time passes. The heat map is a 1024x512 picture wrapped on a shell just above the ground.

import * as THREE from 'three'
import { AGE_STOPS, type Strike } from '@renderer/lib/lightning'

const DEG = Math.PI / 180
/** most strikes kept on the globe at once (older ones are overwritten first) */
const CAPACITY = 120_000
const HEAT_W = 1024
const HEAT_H = 512
const HEAT_EVERY_MS = 2000

export type LightningMode = 'auto' | 'flashes' | 'heat' | 'both'

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

const glslStops = (): string => {
  // the same colour ramp as lib/lightning.ts ageColour, written into the shader
  const lines = AGE_STOPS.map(([f, c]) => `vec4(${c[0].toFixed(3)}, ${c[1].toFixed(3)}, ${c[2].toFixed(3)}, ${f.toFixed(2)})`)
  return `const vec4 STOPS[5] = vec4[5](${lines.join(', ')});`
}

/** A white lightning-bolt silhouette (with a dark outline baked in, so it reads on bright daytime ground) on a
 * transparent square, sampled as an alpha mask for each flash. */
function boltTexture(): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const path = new Path2D()
  path.moveTo(38, 2)
  path.lineTo(16, 33)
  path.lineTo(28, 33)
  path.lineTo(12, 62)
  path.lineTo(42, 28)
  path.lineTo(29, 28)
  path.closePath()
  ctx.strokeStyle = '#000'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 6
  ctx.stroke(path)
  ctx.fillStyle = '#fff'
  ctx.fill(path)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

export interface PickedStrike extends Strike {
  /** ms the strike happened before now */
  ageMs: number
}

export class LightningLayer {
  private readonly parent: THREE.Object3D
  private readonly epochMs = Math.floor(Date.now() / 1000) * 1000
  private readonly pos = new Float32Array(CAPACITY * 3)
  private readonly time = new Float32Array(CAPACITY) // seconds since epochMs
  private readonly meta = { seq: new Float64Array(CAPACITY), tMs: new Float64Array(CAPACITY), lat: new Float32Array(CAPACITY), lon: new Float32Array(CAPACITY), stations: new Uint16Array(CAPACITY), acc: new Uint32Array(CAPACITY), pol: new Int8Array(CAPACITY) }
  private next = 0
  private count = 0
  private newest = 0 // ms of the newest strike
  readonly points: THREE.Points
  private readonly boltTex = boltTexture()
  private readonly uniforms = { uNow: { value: 0 }, uWindow: { value: 600 }, uSize: { value: 12 }, uOpacity: { value: 1 }, uBolt: { value: this.boltTex } }
  private readonly heat: THREE.Mesh
  private readonly heatCanvas: HTMLCanvasElement
  private readonly heatTexture: THREE.CanvasTexture
  private heatAt = 0
  private heatDirty = true
  private readonly marker: THREE.Sprite
  private selected = -1
  windowMin = 10
  mode: LightningMode = 'auto'
  visible = true

  constructor(parent: THREE.Object3D, dotTexture: THREE.Texture) {
    this.parent = parent
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('aTime', new THREE.BufferAttribute(this.time, 1))
    geo.setDrawRange(0, 0)
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: this.uniforms,
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        uniform float uNow;
        uniform float uWindow;
        uniform float uSize;
        attribute float aTime;
        varying float vAge;
        varying float vFrac;
        void main() {
          float age = uNow - aTime;
          vAge = age;
          vFrac = clamp(age / uWindow, 0.0, 1.0);
          gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
          // a new strike pops big and settles: the flash
          float pop = age < 5.0 ? 1.0 + 2.6 * exp(-age * 1.3) : 1.0;
          gl_PointSize = (age < 0.0 || age > uWindow) ? 0.0 : uSize * pop;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float uOpacity;
        uniform sampler2D uBolt;
        varying float vAge;
        varying float vFrac;
        ${glslStops()}
        vec3 ageColour(float f) {
          for (int i = 1; i < 5; i++) {
            if (f <= STOPS[i].w) {
              float t = (f - STOPS[i - 1].w) / (STOPS[i].w - STOPS[i - 1].w);
              return mix(STOPS[i - 1].rgb, STOPS[i].rgb, t);
            }
          }
          return STOPS[4].rgb;
        }
        void main() {
          #include <logdepthbuf_fragment>
          vec4 boltSample = texture2D(uBolt, gl_PointCoord);
          if (boltSample.a < 0.05) discard;
          vec3 col = ageColour(vFrac);
          col = mix(vec3(1.0), col, smoothstep(0.0, 1.4, vAge)); // white-hot at the moment of the strike
          float life = 1.0 - vFrac * 0.85;
          // the texture's own dark outline (boltSample.r near 0) shows the flash on bright daytime ground too
          vec3 outCol = mix(vec3(0.02, 0.01, 0.0), col * (1.0 + 0.8 * exp(-vAge * 1.5)), boltSample.r);
          gl_FragColor = vec4(outCol, boltSample.a * life * uOpacity);
        }`
    })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 6
    parent.add(this.points)

    this.heatCanvas = document.createElement('canvas')
    this.heatCanvas.width = HEAT_W
    this.heatCanvas.height = HEAT_H
    this.heatTexture = new THREE.CanvasTexture(this.heatCanvas)
    this.heatTexture.colorSpace = THREE.SRGBColorSpace
    this.heatTexture.wrapS = THREE.RepeatWrapping
    const hgeo = new THREE.SphereGeometry(1.0035, 96, 48)
    hgeo.rotateX(Math.PI / 2)
    this.heat = new THREE.Mesh(hgeo, new THREE.MeshBasicMaterial({ map: this.heatTexture, transparent: true, depthWrite: false, opacity: 0 }))
    this.heat.renderOrder = 5
    this.heat.frustumCulled = false
    parent.add(this.heat)

    this.marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture, color: 0xffffff, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, opacity: 0.6 }))
    this.marker.scale.setScalar(0.05)
    this.marker.renderOrder = 12
    this.marker.visible = false
    parent.add(this.marker)
  }

  // ---------- data ----------

  /** Empty the globe (the window was widened, so the older strikes are about to be sent again). */
  clear(): void {
    this.next = 0
    this.count = 0
    this.newest = 0
    this.selected = -1
    this.marker.visible = false
    this.points.geometry.setDrawRange(0, 0)
    this.heatDirty = true
  }

  add(rows: readonly Strike[]): void {
    for (const s of rows) {
      const i = this.next
      const la = s.lat * DEG
      const lo = s.lon * DEG
      const r = 1.0009
      this.pos[3 * i] = r * Math.cos(la) * Math.cos(lo)
      this.pos[3 * i + 1] = r * Math.cos(la) * Math.sin(lo)
      this.pos[3 * i + 2] = r * Math.sin(la)
      this.time[i] = (s.tMs - this.epochMs) / 1000
      this.meta.seq[i] = s.seq
      this.meta.tMs[i] = s.tMs
      this.meta.lat[i] = s.lat
      this.meta.lon[i] = s.lon
      this.meta.stations[i] = s.stations
      this.meta.acc[i] = s.accuracyM
      this.meta.pol[i] = s.polarity
      this.next = (i + 1) % CAPACITY
      this.count = Math.min(CAPACITY, this.count + 1)
      if (s.tMs > this.newest) this.newest = s.tMs
    }
    this.points.geometry.attributes.position.needsUpdate = true
    this.points.geometry.attributes.aTime.needsUpdate = true
    this.points.geometry.setDrawRange(0, this.count)
    this.heatDirty = true
  }

  get strikeCount(): number {
    let n = 0
    const cutoff = Date.now() - this.windowMin * 60_000
    for (let i = 0; i < this.count; i++) if (this.meta.tMs[i] >= cutoff) n++
    return n
  }

  // ---------- per frame ----------

  /**
   * `alt`: the camera's height above the surface in Earth radii. `relevance` (0..1): how much these real-time strikes still mean
   * for the scene's date. Returns true when the picture needs redrawing soon (a flash is in progress).
   */
  update(alt: number, relevance: number, pixelRatio: number, nowMs = Date.now()): boolean {
    const u = this.uniforms
    u.uNow.value = (nowMs - this.epochMs) / 1000
    u.uWindow.value = this.windowMin * 60
    u.uSize.value = (12 + 10 * (1 - smooth(0.05, 3, alt))) * pixelRatio
    // far away: the heat map; close: the flashes; in between, both fading across each other
    const flashes = this.mode === 'flashes' || this.mode === 'both' ? 1 : this.mode === 'heat' ? 0 : 1 - smooth(0.7, 1.7, alt)
    const heat = this.mode === 'heat' || this.mode === 'both' ? 1 : this.mode === 'flashes' ? 0 : smooth(0.25, 1.2, alt)
    const on = this.visible && relevance > 0.02
    u.uOpacity.value = flashes * relevance
    this.points.visible = on && flashes > 0.02
    const heatMat = this.heat.material as THREE.MeshBasicMaterial
    heatMat.opacity = heat * relevance * 0.9
    this.heat.visible = on && heat > 0.02
    if (this.heat.visible && (this.heatDirty || nowMs - this.heatAt > HEAT_EVERY_MS)) this.drawHeat(nowMs)
    this.marker.visible = on && flashes > 0.3 && this.selected >= 0
    return this.points.visible && nowMs - this.newest < 6000
  }

  /** The heat map: strikes counted into 0.35 degree cells (recent ones weigh more), blurred, and coloured from clear through blue and yellow to red. */
  private drawHeat(nowMs: number): void {
    this.heatAt = nowMs
    this.heatDirty = false
    const w = HEAT_W
    const h = HEAT_H
    const grid = new Float32Array(w * h)
    const window = this.windowMin * 60_000
    for (let i = 0; i < this.count; i++) {
      const age = nowMs - this.meta.tMs[i]
      if (age < 0 || age > window) continue
      const x = Math.min(w - 1, Math.floor(((this.meta.lon[i] + 180) / 360) * w))
      const y = Math.min(h - 1, Math.floor(((90 - this.meta.lat[i]) / 180) * h))
      grid[y * w + x] += 1 - 0.55 * (age / window)
    }
    // blur: a box blur three times over is close to a Gaussian; each pass runs along the rows and then down the columns
    const tmp = new Float32Array(w * h)
    const radius = 4
    const blur = (src: Float32Array, dst: Float32Array, horizontal: boolean): void => {
      const n = horizontal ? w : h
      const lines = horizontal ? h : w
      const stride = horizontal ? 1 : w
      const lineStride = horizontal ? w : 1
      for (let l = 0; l < lines; l++) {
        const base = l * lineStride
        let sum = 0
        for (let k = -radius; k <= radius; k++) sum += src[base + (((k % n) + n) % n) * stride]
        for (let k = 0; k < n; k++) {
          dst[base + k * stride] = sum / (2 * radius + 1)
          sum += src[base + ((k + radius + 1) % n) * stride] - src[base + (((k - radius) % n) + n) % n * stride]
        }
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      blur(grid, tmp, true)
      blur(tmp, grid, false)
    }
    let max = 0
    for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i]
    // one reference for the colours, so a quiet day shows dim patches and a stormy one shows hot cores
    const ref = Math.max(max * 0.7, 0.02)
    const ctx = this.heatCanvas.getContext('2d')!
    const img = ctx.createImageData(w, h)
    const d = img.data
    for (let i = 0; i < grid.length; i++) {
      const v = Math.min(1, grid[i] / ref)
      const a = smooth(0.02, 0.25, v)
      const j = i * 4
      // blue -> cyan -> yellow -> red -> white
      const t = v
      d[j] = Math.round(255 * Math.min(1, Math.max(0, t < 0.5 ? t * 1.2 : 0.6 + (t - 0.5) * 0.8)))
      d[j + 1] = Math.round(255 * Math.min(1, Math.max(0, t < 0.35 ? 0.35 + t * 1.5 : t < 0.7 ? 0.9 - (t - 0.35) * 1.6 : 0.34 + (t - 0.7) * 2)))
      d[j + 2] = Math.round(255 * Math.min(1, Math.max(0, t < 0.35 ? 0.9 : 0.9 - (t - 0.35) * 2.4 + (t > 0.85 ? (t - 0.85) * 5 : 0))))
      d[j + 3] = Math.round(255 * a)
    }
    ctx.putImageData(img, 0, 0)
    this.heatTexture.needsUpdate = true
  }

  // ---------- picking ----------

  /** The strike under a screen position (ignoring ones behind the globe), or null; remembers it as selected and rings it. */
  pick(px: number, py: number, width: number, height: number, camera: THREE.PerspectiveCamera, earthCentre: THREE.Vector3, earthRadius: number, nowMs = Date.now()): PickedStrike | null {
    if (!this.points.visible || (this.uniforms.uOpacity.value as number) < 0.3) return null
    const m = this.parent.matrixWorld
    const cam = camera.position
    const v = new THREE.Vector3()
    const w = new THREE.Vector3()
    const window = this.windowMin * 60_000
    let best = -1
    let bestD = 12
    for (let i = 0; i < this.count; i++) {
      const age = nowMs - this.meta.tMs[i]
      if (age < 0 || age > window) continue
      w.set(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]).applyMatrix4(m)
      v.copy(w).project(camera)
      if (v.z > 1 || v.z < -1) continue
      const d = Math.hypot(((v.x + 1) / 2) * width - px, ((1 - v.y) / 2) * height - py)
      if (d >= bestD) continue
      const dx = w.x - cam.x
      const dy = w.y - cam.y
      const dz = w.z - cam.z
      const len2 = dx * dx + dy * dy + dz * dz
      const t = Math.max(0, Math.min(1, ((earthCentre.x - cam.x) * dx + (earthCentre.y - cam.y) * dy + (earthCentre.z - cam.z) * dz) / len2))
      const cx = cam.x + dx * t - earthCentre.x
      const cy = cam.y + dy * t - earthCentre.y
      const cz = cam.z + dz * t - earthCentre.z
      if (Math.hypot(cx, cy, cz) < earthRadius * 0.999) continue // behind the globe
      best = i
      bestD = d
    }
    if (best < 0) return null
    this.selected = best
    this.marker.position.set(this.pos[3 * best], this.pos[3 * best + 1], this.pos[3 * best + 2])
    this.marker.visible = true
    return { seq: this.meta.seq[best], tMs: this.meta.tMs[best], lat: this.meta.lat[best], lon: this.meta.lon[best], polarity: this.meta.pol[best], stations: this.meta.stations[best], accuracyM: this.meta.acc[best], ageMs: nowMs - this.meta.tMs[best] }
  }

  deselect(): void {
    this.selected = -1
    this.marker.visible = false
  }

  dispose(): void {
    for (const o of [this.points, this.heat, this.marker]) o.removeFromParent()
    this.points.geometry.dispose()
    ;(this.points.material as THREE.Material).dispose()
    this.boltTex.dispose()
    this.heat.geometry.dispose()
    ;(this.heat.material as THREE.Material).dispose()
    this.heatTexture.dispose()
    ;(this.marker.material as THREE.Material).dispose()
  }
}
