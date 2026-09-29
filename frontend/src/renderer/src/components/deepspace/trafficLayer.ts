// Web traffic on the 3D Earth: a glowing dot at every place this PC is talking to, and a curved arc from your saved
// location to each one. Arcs climb higher the farther they go, so a link across an ocean is a tall bow and one to the next
// town a low hop. Brightness and size follow how many connections are open there; a place that has gone quiet fades out
// over a few seconds and a new one fades in. (Windows does not say how much data moves, so nothing here is a bandwidth.)
//
// Everything is drawn in the Earth's own frame (radius 1). Arcs are ribbons a few pixels wide whatever the zoom (GL lines
// are one pixel thin); the dots are point sprites sized on the GPU. The ribbon is coloured dull green at your end and
// bright green at theirs (the direction the data is travelling), with a scrolling texture of matrix-style code streaming
// along it from home to destination.

import * as THREE from 'three'
import type { TrafficPlace } from '@renderer/lib/traffic'

const DEG = Math.PI / 180
const CAPACITY = 400
const SEGMENTS = 40
/** each arc is SEGMENTS + 1 points, and every point makes two ribbon vertices (one either side of the line) */
const ARC_VERTS = (SEGMENTS + 1) * 2
const ARC_WIDTH_PX = 15
const FADE_IN_MS = 900
const LINGER_S = 25
/** how many times the text line repeats along one arc, and how fast it scrolls from home towards the destination */
const CODE_REPEATS = 3
const CODE_FLOW = 0.35

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

const unitOf = (lat: number, lon: number, out = new THREE.Vector3()): THREE.Vector3 => {
  const la = lat * DEG
  const lo = lon * DEG
  return out.set(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la))
}

const MATRIX_CHARS = '01アイウエオカキクケコサシスセソタチツテト0101'

/** One horizontal line of black text (transparent everywhere else), sampled by the arc shader and
 * scrolled along the ribbon's length -- a single row of characters, not stacked lines, so it reads as
 * one line of text running along the line rather than a block of scrolling code. Mipmapping is off so
 * it stays crisp instead of blurring into a faint tint at a distance. */
function buildMatrixTexture(): THREE.CanvasTexture {
  const cell = 64
  const count = 16
  const canvas = document.createElement('canvas')
  canvas.width = cell * count
  canvas.height = cell
  const ctx = canvas.getContext('2d')!
  ctx.font = `bold ${cell - 8}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let x = 0; x < count; x++) {
    const ch = MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)]
    ctx.fillStyle = 'rgba(0, 0, 0, 1)'
    ctx.fillText(ch, x * cell + cell / 2, cell / 2)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

interface Row {
  place: TrafficPlace
  unit: THREE.Vector3
  bornMs: number
  /** when the backend's age_s was measured, so the fade keeps running between polls */
  seenAtMs: number
}

const COMMON_VERTEX = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
`

export class TrafficLayer {
  private readonly parent: THREE.Object3D
  private rows = new Map<string, Row>()
  private order: Row[] = []
  private home: THREE.Vector3 | null = null
  private selectedId: string | null = null

  private readonly dotPos = new Float32Array(CAPACITY * 3)
  private readonly dotSize = new Float32Array(CAPACITY)
  private readonly dotAlpha = new Float32Array(CAPACITY)
  private readonly arcPos = new Float32Array(CAPACITY * ARC_VERTS * 3)
  private readonly arcPrev = new Float32Array(CAPACITY * ARC_VERTS * 3)
  private readonly arcNext = new Float32Array(CAPACITY * ARC_VERTS * 3)
  private readonly arcSide = new Float32Array(CAPACITY * ARC_VERTS)
  private readonly arcT = new Float32Array(CAPACITY * ARC_VERTS)
  private readonly arcAlpha = new Float32Array(CAPACITY * ARC_VERTS)
  private readonly arcIndex = new Uint16Array(CAPACITY * SEGMENTS * 6)
  private arcOf: number[] = [] // for each drawn arc, the index of its place in `order`
  private readonly arcAlphaOf = new Float32Array(CAPACITY)
  private readonly dots: THREE.Points
  private readonly arcs: THREE.Mesh
  private readonly ring: THREE.Points
  private readonly uniforms = {
    uPx: { value: 1 },
    uOpacity: { value: 1 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uWidth: { value: ARC_WIDTH_PX },
    uTime: { value: 0 },
    uTex: { value: buildMatrixTexture() }
  }
  private shownAt = 0
  /** wall-clock ms when this layer was built: uTime is kept relative to this, not to the Unix epoch,
   * since a raw epoch second count (~1.8e9) blows past float32's precision inside the shader's fract(). */
  private readonly t0Ms: number
  visible = false

  constructor(parent: THREE.Object3D) {
    this.parent = parent
    this.t0Ms = Date.now()

    const dg = new THREE.BufferGeometry()
    dg.setAttribute('position', new THREE.BufferAttribute(this.dotPos, 3))
    dg.setAttribute('aSize', new THREE.BufferAttribute(this.dotSize, 1))
    dg.setAttribute('aAlpha', new THREE.BufferAttribute(this.dotAlpha, 1))
    dg.setDrawRange(0, 0)
    this.dots = new THREE.Points(
      dg,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: this.uniforms,
        vertexShader: `${COMMON_VERTEX}
          uniform float uPx;
          attribute float aSize;
          attribute float aAlpha;
          varying float vAlpha;
          void main() {
            vAlpha = aAlpha;
            gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
            gl_PointSize = aSize * uPx;
            #include <logdepthbuf_vertex>
          }`,
        fragmentShader: `
          #include <common>
          #include <logdepthbuf_pars_fragment>
          uniform float uOpacity;
          varying float vAlpha;
          void main() {
            #include <logdepthbuf_fragment>
            float r = length(gl_PointCoord - 0.5) * 2.0;
            if (r > 1.0) discard;
            // a solid violet disc with a white-hot centre and a soft glow, and a dark outline so it shows on bright ground too
            float disc = 1.0 - smoothstep(0.46, 0.56, r);
            float hot = 1.0 - smoothstep(0.0, 0.3, r);
            float glow = pow(1.0 - r, 2.0) * 0.6;
            float outline = smoothstep(0.46, 0.56, r) * (1.0 - smoothstep(0.62, 0.74, r)) * 0.75;
            vec3 col = mix(vec3(0.92, 0.36, 0.98), vec3(1.0, 0.96, 1.0), hot);
            col = mix(col, vec3(0.16, 0.03, 0.22), outline / max(outline + glow, 0.001));
            gl_FragColor = vec4(col, max(max(disc, glow), outline) * vAlpha * uOpacity);
          }`
      })
    )
    this.dots.frustumCulled = false
    this.dots.renderOrder = 7
    parent.add(this.dots)

    const ag = new THREE.BufferGeometry()
    ag.setAttribute('position', new THREE.BufferAttribute(this.arcPos, 3))
    ag.setAttribute('aPrev', new THREE.BufferAttribute(this.arcPrev, 3))
    ag.setAttribute('aNext', new THREE.BufferAttribute(this.arcNext, 3))
    ag.setAttribute('aSide', new THREE.BufferAttribute(this.arcSide, 1))
    ag.setAttribute('aT', new THREE.BufferAttribute(this.arcT, 1))
    ag.setAttribute('aAlpha', new THREE.BufferAttribute(this.arcAlpha, 1))
    ag.setIndex(new THREE.BufferAttribute(this.arcIndex, 1))
    ag.setDrawRange(0, 0)
    this.arcs = new THREE.Mesh(
      ag,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: this.uniforms,
        vertexShader: `${COMMON_VERTEX}
          uniform vec2 uRes;
          uniform float uWidth;
          uniform float uPx;
          attribute vec3 aPrev;
          attribute vec3 aNext;
          attribute float aSide;
          attribute float aT;
          attribute float aAlpha;
          varying float vT;
          varying float vAlpha;
          varying float vSide;
          void main() {
            vT = aT;
            vAlpha = aAlpha;
            vSide = aSide;
            mat4 mvp = projectionMatrix * modelViewMatrix;
            vec4 cp = mvp * vec4(position, 1.0);
            vec4 c0 = mvp * vec4(aPrev, 1.0);
            vec4 c1 = mvp * vec4(aNext, 1.0);
            if (cp.w <= 0.0 || c0.w <= 0.0 || c1.w <= 0.0) {
              // a piece behind the camera: no ribbon
              gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
              return;
            }
            vec2 s0 = c0.xy / c0.w * uRes * 0.5;
            vec2 s1 = c1.xy / c1.w * uRes * 0.5;
            vec2 d = s1 - s0;
            d = length(d) > 1e-4 ? normalize(d) : vec2(1.0, 0.0);
            vec2 off = vec2(-d.y, d.x) * aSide * uWidth * 0.5;
            gl_Position = cp;
            gl_Position.xy += off / (uRes * 0.5) * cp.w;
            #include <logdepthbuf_vertex>
          }`,
        fragmentShader: `
          #include <common>
          #include <logdepthbuf_pars_fragment>
          uniform float uOpacity;
          uniform sampler2D uTex;
          uniform float uTime;
          varying float vT;
          varying float vAlpha;
          varying float vSide;
          void main() {
            #include <logdepthbuf_fragment>
            // dull green at your end, bright green at theirs -- the direction the data is travelling
            vec3 col = mix(vec3(0.03, 0.22, 0.07), vec3(0.4, 1.0, 0.5), vT);
            // one line of black text scrolling from home towards the destination, darkening the green
            vec2 uv = vec2(fract(vT * ${CODE_REPEATS.toFixed(1)} - uTime * ${CODE_FLOW.toFixed(2)}), vSide * 0.5 + 0.5);
            vec4 code = texture2D(uTex, uv);
            col = mix(col, vec3(0.0), code.a);
            float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
            gl_FragColor = vec4(col, vAlpha * uOpacity * edge * (0.5 + 0.5 * vT));
          }`
      })
    )
    this.arcs.frustumCulled = false
    this.arcs.renderOrder = 6
    parent.add(this.arcs)

    // the ring round the selected place
    const rg = new THREE.BufferGeometry()
    rg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
    this.ring = new THREE.Points(
      rg,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: this.uniforms,
        vertexShader: `${COMMON_VERTEX}
          uniform float uPx;
          void main() {
            gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
            gl_PointSize = 34.0 * uPx;
            #include <logdepthbuf_vertex>
          }`,
        fragmentShader: `
          #include <common>
          #include <logdepthbuf_pars_fragment>
          uniform float uOpacity;
          void main() {
            #include <logdepthbuf_fragment>
            float r = length(gl_PointCoord - 0.5) * 2.0;
            float a = smoothstep(0.72, 0.8, r) * (1.0 - smoothstep(0.9, 1.0, r));
            if (a < 0.01) discard;
            gl_FragColor = vec4(1.0, 1.0, 1.0, a * uOpacity);
          }`
      })
    )
    this.ring.frustumCulled = false
    this.ring.renderOrder = 12
    this.ring.visible = false
    parent.add(this.ring)
  }

  // ---------- data ----------

  /** The destinations from the backend, and the place the arcs start from (null: dots only). */
  setData(places: readonly TrafficPlace[], home: { latDeg: number; lonDeg: number } | null, nowMs = Date.now()): void {
    const next = new Map<string, Row>()
    for (const p of places.slice(0, CAPACITY)) {
      const old = this.rows.get(p.id)
      next.set(p.id, { place: p, unit: old?.unit ?? unitOf(p.lat, p.lon), bornMs: old?.bornMs ?? nowMs, seenAtMs: nowMs })
    }
    this.rows = next
    this.order = [...next.values()]
    this.home = home ? unitOf(home.latDeg, home.lonDeg) : null
    if (this.selectedId && !next.has(this.selectedId)) this.selectedId = null
    this.buildGeometry()
    this.updateRing()
    this.refreshAlpha(nowMs)
  }

  get placeCount(): number {
    return this.order.length
  }

  private buildGeometry(): void {
    const v = new THREE.Vector3()
    const w = this.home
    this.arcOf = []
    this.order.forEach((row, i) => {
      v.copy(row.unit).multiplyScalar(1.003)
      this.dotPos.set([v.x, v.y, v.z], 3 * i)
      this.dotSize[i] = 14 + Math.min(12, 3.6 * Math.log2(1 + row.place.n))
      if (!w) return
      const omega = Math.acos(Math.min(1, Math.max(-1, w.dot(row.unit))))
      const sin = Math.sin(omega)
      if (omega < 0.004 || sin < 1e-3) return // the same place as you, or exactly opposite: no arc
      const lift = 0.03 + 0.22 * (omega / Math.PI)
      const base = this.arcOf.length * ARC_VERTS
      this.arcOf.push(i)
      const pts: THREE.Vector3[] = []
      for (let k = 0; k <= SEGMENTS; k++) {
        const t = k / SEGMENTS
        const a = Math.sin((1 - t) * omega) / sin
        const b = Math.sin(t * omega) / sin
        const r = 1.003 + lift * Math.sin(Math.PI * t)
        pts.push(new THREE.Vector3(w.x * a + row.unit.x * b, w.y * a + row.unit.y * b, w.z * a + row.unit.z * b).multiplyScalar(r))
      }
      for (let k = 0; k <= SEGMENTS; k++) {
        const p = pts[k]
        const prev = pts[Math.max(0, k - 1)]
        const next = pts[Math.min(SEGMENTS, k + 1)]
        for (let side = 0; side < 2; side++) {
          const vi = base + k * 2 + side
          this.arcPos.set([p.x, p.y, p.z], vi * 3)
          this.arcPrev.set([prev.x, prev.y, prev.z], vi * 3)
          this.arcNext.set([next.x, next.y, next.z], vi * 3)
          this.arcSide[vi] = side === 0 ? -1 : 1
          this.arcT[vi] = k / SEGMENTS
        }
      }
      const io = (this.arcOf.length - 1) * SEGMENTS * 6
      for (let k = 0; k < SEGMENTS; k++) {
        const v0 = base + k * 2
        this.arcIndex.set([v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2], io + k * 6)
      }
    })
    const dg = this.dots.geometry
    dg.setDrawRange(0, this.order.length)
    dg.attributes.position.needsUpdate = true
    dg.attributes.aSize.needsUpdate = true
    const ag = this.arcs.geometry
    ag.setDrawRange(0, this.arcOf.length * SEGMENTS * 6)
    for (const name of ['position', 'aPrev', 'aNext', 'aSide', 'aT']) ag.attributes[name].needsUpdate = true
    ag.index!.needsUpdate = true
  }

  /** How solid a destination is now: 0..1 (fade in when new, fade out over LINGER_S after its last connection). */
  private life(row: Row, nowMs: number): number {
    const sinceSeen = row.place.age_s + (nowMs - row.seenAtMs) / 1000
    const linger = row.place.n > 0 ? 1 : clamp01(1 - sinceSeen / LINGER_S)
    return linger * clamp01((nowMs - row.bornMs) / FADE_IN_MS)
  }

  private refreshAlpha(nowMs: number): boolean {
    let moving = false
    const dim = this.selectedId ? 0.4 : 1
    this.order.forEach((row, i) => {
      const life = this.life(row, nowMs)
      if (life < 1) moving = true
      this.dotAlpha[i] = life
      // more connections make an arc stronger, and the selected one stands out
      const strength = 0.6 + 0.35 * clamp01(Math.log2(1 + row.place.n) / 4)
      this.arcAlphaOf[i] = life * strength * (row.place.id === this.selectedId ? 1.15 : dim)
    })
    // spread each arc's alpha over its vertices
    let o = 0
    for (const i of this.arcOf) {
      this.arcAlpha.fill(Math.min(1, this.arcAlphaOf[i]), o, o + ARC_VERTS)
      o += ARC_VERTS
    }
    this.dots.geometry.attributes.aAlpha.needsUpdate = true
    this.arcs.geometry.attributes.aAlpha.needsUpdate = true
    return moving
  }

  // ---------- per frame ----------

  /** `relevance` (0..1): how much real-time traffic still means for the scene's date. Returns true while a fade is going on (redraw soon). */
  update(relevance: number, pixelRatio: number, size: { x: number; y: number }, nowMs = Date.now()): boolean {
    this.uniforms.uPx.value = pixelRatio
    this.uniforms.uOpacity.value = relevance
    this.uniforms.uRes.value.set(size.x, size.y)
    this.uniforms.uTime.value = (nowMs - this.t0Ms) / 1000
    const on = this.visible && relevance > 0.02 && this.order.length > 0
    this.dots.visible = on
    this.arcs.visible = on && this.arcOf.length > 0
    this.ring.visible = on && this.selectedId !== null
    if (!on) return false
    // fades are worked out on the CPU, at most about eight times a second
    if (nowMs - this.shownAt < 120) return this.order.some((r) => this.life(r, nowMs) < 1)
    this.shownAt = nowMs
    return this.refreshAlpha(nowMs)
  }

  // ---------- picking ----------

  /** The destination under a screen position (ignoring ones behind the globe), or null. */
  pick(px: number, py: number, width: number, height: number, camera: THREE.PerspectiveCamera, earthCentre: THREE.Vector3, earthRadius: number): TrafficPlace | null {
    if (!this.dots.visible || (this.uniforms.uOpacity.value as number) < 0.3) return null
    const m = this.parent.matrixWorld
    const cam = camera.position
    const v = new THREE.Vector3()
    const w = new THREE.Vector3()
    let best: Row | null = null
    let bestD = 14
    this.order.forEach((row, i) => {
      if (this.dotAlpha[i] < 0.3) return
      w.set(this.dotPos[3 * i], this.dotPos[3 * i + 1], this.dotPos[3 * i + 2]).applyMatrix4(m)
      v.copy(w).project(camera)
      if (v.z > 1 || v.z < -1) return
      const d = Math.hypot(((v.x + 1) / 2) * width - px, ((1 - v.y) / 2) * height - py)
      if (d >= bestD) return
      const dx = w.x - cam.x
      const dy = w.y - cam.y
      const dz = w.z - cam.z
      const len2 = dx * dx + dy * dy + dz * dz
      const t = Math.max(0, Math.min(1, ((earthCentre.x - cam.x) * dx + (earthCentre.y - cam.y) * dy + (earthCentre.z - cam.z) * dz) / len2))
      const cx = cam.x + dx * t - earthCentre.x
      const cy = cam.y + dy * t - earthCentre.y
      const cz = cam.z + dz * t - earthCentre.z
      if (Math.hypot(cx, cy, cz) < earthRadius * 0.999) return // behind the globe
      best = row
      bestD = d
    })
    return best ? (best as Row).place : null
  }

  select(id: string | null): void {
    this.selectedId = id
    this.updateRing()
    this.refreshAlpha(Date.now())
  }

  private updateRing(): void {
    const row = this.selectedId ? this.rows.get(this.selectedId) : undefined
    if (!row) {
      this.selectedId = null
      this.ring.visible = false
      return
    }
    const p = row.unit
    this.ring.geometry.attributes.position.setXYZ(0, p.x * 1.003, p.y * 1.003, p.z * 1.003)
    this.ring.geometry.attributes.position.needsUpdate = true
  }

  dispose(): void {
    for (const o of [this.dots, this.arcs, this.ring]) {
      o.removeFromParent()
      o.geometry.dispose()
      ;(o.material as THREE.Material).dispose()
    }
  }
}
