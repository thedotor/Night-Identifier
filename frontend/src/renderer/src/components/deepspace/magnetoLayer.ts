// The Earth's magnetic field in the 3D scene.
//
//  * Field lines: traced through the real IGRF-14 field for the scene's date (lib/geomag.ts), from the ground out to the
//    magnetosphere and back. Near the Earth they are the model's lines; farther out they are bent the way the solar wind bends
//    them (squashed on the Sun side, stretched into a tail on the night side): a schematic distortion, not a model of the tail.
//    In a storm (Dst, Kp, southward Bz) they shake and turn from blue to orange.
//  * A colour map on the surface of the real field strength or magnetic declination (IGRF), with contour lines.
//  * The magnetopause and the bow shock, sized from the live solar wind (Shue 1998, Farris and Russell 1994).
//  * The real ground magnetometers (USGS), coloured by how much they moved in the last hour.
//
// Everything in `group` is in Earth radii (the group is scaled to the Earth's radius and sits at the Earth's centre).

import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { coefficientsAt, decimalYear, declinationGrid, fieldSpherical, strengthGrid, traceFieldLine, EARTH_RADIUS_KM, type Vec3 } from '@renderer/lib/geomag'
import { bowShockAt, magnetopauseAt, stationLevel, warpPoint, type Magnetosphere } from '@renderer/lib/magnetosphere'

const DEG = Math.PI / 180
const LINE_LONS = 12
const LINE_LATS = [24, 40, 54, 64, 72, 80]
const MAX_R = 16

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export interface StationRow {
  id: string
  name: string
  lat: number
  lon: number
  range_1h: number
  max_step: number
  f: number
  time: number
}

export interface MagnetoFlags {
  lines: boolean
  map: boolean
  mapKind: 'strength' | 'declination'
  surfaces: boolean
  stations: boolean
}

export interface MagnetoState {
  /** unit vector from the Earth toward the Sun, scene axes */
  sunDir: THREE.Vector3
  /** the Earth mesh's orientation */
  earthQuat: THREE.Quaternion
  magnetosphere: Magnetosphere
  /** 0 calm .. 1 storm */
  disturbance: number
  stretch: number
  /** 1 while the live data mean something for the scene's date, 0 far from now */
  live: number
  /** distance of the camera from the Earth's centre, Earth radii */
  camRe: number
  timeS: number
}

interface LineSet {
  /** Earth-fixed points of every line, Earth radii */
  pts: Float32Array
  /** start of each line in `pts` (in points, not floats), and a final end marker */
  starts: number[]
  segCount: number
}

/** Field strength (nT) to a colour: blue (weak, 22 uT) through green and yellow to red (strong, 67 uT). */
export function strengthColour(nT: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (nT - 22_000) / 45_000))
  const stops: [number, [number, number, number]][] = [
    [0, [0.13, 0.2, 0.85]],
    [0.25, [0.1, 0.7, 0.9]],
    [0.5, [0.35, 0.85, 0.35]],
    [0.75, [0.98, 0.85, 0.2]],
    [1, [0.95, 0.25, 0.15]]
  ]
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const k = (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0])
      const a = stops[i - 1][1]
      const b = stops[i][1]
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
    }
  }
  return stops[stops.length - 1][1]
}

/** Declination (degrees east of north) to a colour: blue for west, red for east, white near zero; strong colour beyond 30 degrees. */
export function declinationColour(deg: number): [number, number, number] {
  const t = Math.min(1, Math.abs(deg) / 30)
  const w: [number, number, number] = [0.95, 0.95, 0.95]
  const c: [number, number, number] = deg >= 0 ? [0.95, 0.25, 0.2] : [0.2, 0.35, 0.95]
  return [w[0] + (c[0] - w[0]) * t, w[1] + (c[1] - w[1]) * t, w[2] + (c[2] - w[2]) * t]
}

const LINE_VERT = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aT;
  attribute float aL;
  attribute float aLine;
  uniform float uTime;
  uniform float uDist;
  varying float vT;
  varying float vL;
  varying float vLine;
  void main() {
    vT = aT;
    vL = aL;
    vLine = aLine;
    vec3 p = position;
    // in a storm the outer lines shake sideways
    float mid = sin(aT * 3.14159);
    vec3 dir = vec3(sin(aLine * 50.0), cos(aLine * 70.0), sin(aLine * 90.0));
    p += dir * uDist * 0.35 * mid * aL * sin(aT * 18.0 + uTime * 3.0 + aLine * 6.28);
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(p, 1.0));
    #include <logdepthbuf_vertex>
  }`
const LINE_FRAG = `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uTime;
  uniform float uDist;
  uniform float uAlpha;
  varying float vT;
  varying float vL;
  varying float vLine;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 col = mix(vec3(0.35, 0.72, 1.0), vec3(0.78, 0.45, 1.0), vL);
    col = mix(col, vec3(1.0, 0.38, 0.14), uDist);
    float pulse = 0.6 + 0.4 * sin(vT * 30.0 - uTime * (1.5 + 3.0 * uDist) + vLine * 10.0);
    gl_FragColor = vec4(col, uAlpha * (0.2 + 0.3 * pulse) * (0.55 + 0.45 * uDist + 0.3 * (1.0 - vL)));
  }`

const SURF_VERT = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec2 aUv;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    vUv = aUv;
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`
const SURF_FRAG = `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    #include <logdepthbuf_fragment>
    float edge = 1.0 - abs(dot(normalize(vN), normalize(vView)));
    vec2 g = abs(fract(vUv * vec2(24.0, 36.0)) - 0.5);
    float grid = 1.0 - smoothstep(0.0, 0.08, min(g.x, g.y));
    gl_FragColor = vec4(uColor, uOpacity * (0.04 + 0.3 * edge * edge + 0.1 * grid));
  }`

const MAP_VERT = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
    #include <logdepthbuf_vertex>
  }`
const MAP_FRAG = `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uMap;
  uniform sampler2D uVal;
  uniform float uOpacity;
  uniform float uContours;
  varying vec3 vDir;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 d = normalize(vDir);
    float lon = atan(d.y, d.x);
    float lat = asin(clamp(d.z, -1.0, 1.0));
    vec2 uv = vec2(lon / 6.28318530718 + 0.5, lat / 3.14159265359 + 0.5);
    vec4 t = texture2D(uMap, uv);
    // the contour value is kept as a high and a low half float (summed here), so it is precise enough to follow a nearly flat contour
    // contour lines: a line every 1/uContours of the value (0..1), kept about a pixel wide on screen
    // (fwidth is how far the value moves per pixel), and faded out where the lines would be packed closer than the pixels
    vec2 hl = texture2D(uVal, uv).rg;
    float v = (hl.r + hl.g) * uContours;
    float w = max(fwidth(v), 1e-4);
    float c = (1.0 - smoothstep(0.6 * w, 1.6 * w, min(fract(v), 1.0 - fract(v)))) * (1.0 - smoothstep(0.25, 0.6, w));
    gl_FragColor = vec4(mix(t.rgb, vec3(0.05), c * 0.55), uOpacity);
  }`

/** A paraboloid-like surface r(theta) revolved about the Sun line (local +x), cut off at `maxR` Earth radii. */
function revolvedSurface(rOf: (theta: number) => number, thetaMaxDeg: number, maxR: number): THREE.BufferGeometry {
  const rings = 60
  const segs = 48
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  let used = 0
  for (let i = 0; i <= rings; i++) {
    const th = (i / rings) * thetaMaxDeg * DEG
    const r = Math.min(rOf(th), maxR)
    used = i
    for (let j = 0; j <= segs; j++) {
      const ph = (j / segs) * Math.PI * 2
      pos.push(r * Math.cos(th), r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph))
      uv.push(i / rings, j / segs)
    }
    if (rOf(th) >= maxR) break
  }
  for (let i = 0; i < used; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j
      const b = a + segs + 1
      idx.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

const labelStyle = (color: string): string => `padding-left:8px;font:11px/1.25 system-ui,sans-serif;color:${color};text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:none;user-select:none`

export class MagnetoLayer {
  readonly group = new THREE.Group()
  private readonly earthMesh: THREE.Mesh
  private flags: MagnetoFlags = { lines: true, map: false, mapKind: 'strength', surfaces: true, stations: true }
  private year = NaN
  private builtAt = 0

  // field lines
  private lineSet: LineSet | null = null
  private lines: THREE.LineSegments | null = null
  private lineU = { uTime: { value: 0 }, uDist: { value: 0 }, uAlpha: { value: 1 } }
  private lastWarpKey = ''

  // surface map
  private map: THREE.Mesh | null = null
  private mapTex = new Map<string, { col: THREE.DataTexture; val: THREE.DataTexture }>()
  private mapU = { uMap: { value: null as THREE.Texture | null }, uVal: { value: null as THREE.Texture | null }, uOpacity: { value: 0.55 }, uContours: { value: 9 } }

  // magnetopause and bow shock, in a frame whose +x is the Sun direction
  private readonly sunFrame = new THREE.Group()
  private mp: THREE.Mesh | null = null
  private bs: THREE.Mesh | null = null
  private mpLabel: CSS2DObject
  private bsLabel: CSS2DObject
  private mpDiv: HTMLDivElement
  private bsDiv: HTMLDivElement
  private surfKey = ''

  // stations
  private stations: StationRow[] = []
  private stPoints: THREE.Points | null = null
  private stHalo: THREE.Points | null = null
  private stLabels: { obj: CSS2DObject; div: HTMLDivElement; unit: THREE.Vector3 }[] = []
  private readonly dotTexture: THREE.Texture
  private readonly glowTexture: THREE.Texture
  private readonly tmp = new THREE.Vector3()
  private readonly tmp2 = new THREE.Vector3()
  private readonly radiusAU: number

  constructor(earthGroup: THREE.Group, earthMesh: THREE.Mesh, radiusAU: number, dot: THREE.Texture, glow: THREE.Texture) {
    this.earthMesh = earthMesh
    this.radiusAU = radiusAU
    this.dotTexture = dot
    this.glowTexture = glow
    this.group.scale.setScalar(radiusAU)
    earthGroup.add(this.group)
    this.group.add(this.sunFrame)
    this.mpDiv = document.createElement('div')
    this.mpDiv.style.cssText = labelStyle('#7ff0dc')
    this.bsDiv = document.createElement('div')
    this.bsDiv.style.cssText = labelStyle('#ffc58a')
    this.mpLabel = new CSS2DObject(this.mpDiv)
    this.bsLabel = new CSS2DObject(this.bsDiv)
    this.sunFrame.add(this.mpLabel, this.bsLabel)
  }

  setFlags(f: MagnetoFlags): void {
    this.flags = f
    if (this.lines) this.lines.visible = f.lines
    if (this.map) this.map.visible = f.map
    this.applyMap()
    for (const s of [this.mp, this.bs]) if (s) s.visible = f.surfaces
    this.mpLabel.visible = this.bsLabel.visible = f.surfaces
    if (this.stPoints) this.stPoints.visible = this.stHalo!.visible = f.stations
    for (const l of this.stLabels) l.obj.visible = f.stations
  }

  // ---------- the field lines ----------

  private buildLines(year: number): void {
    const c = coefficientsAt(year)
    const all: Vec3[][] = []
    for (const sgn of [1, -1]) {
      for (let li = 0; li < LINE_LATS.length; li++) {
        for (let k = 0; k < LINE_LONS; k++) {
          // the southern footpoints are shifted half a step so they do not sit on the northern lines' other ends
          const lon = (k + (sgn < 0 ? 0.5 : 0)) * (360 / LINE_LONS)
          const lat = sgn * LINE_LATS[li]
          const la = lat * DEG
          const lo = lon * DEG
          const start: Vec3 = [Math.cos(la) * Math.cos(lo) * 1.0005, Math.cos(la) * Math.sin(lo) * 1.0005, Math.sin(la) * 1.0005]
          // go outward: with the field where it points up (south) and against it where it points down (north)
          const f = fieldSpherical(c, EARTH_RADIUS_KM, (90 - lat) * DEG, lo)
          const line = traceFieldLine(c, start, f.br > 0 ? 1 : -1, 0.03, 900, MAX_R)
          if (line.length > 4) all.push(line)
        }
      }
    }
    let total = 0
    for (const l of all) total += l.length
    const pts = new Float32Array(total * 3)
    const starts: number[] = []
    let o = 0
    const aT: number[] = []
    const aL: number[] = []
    const aLine: number[] = []
    all.forEach((l, li) => {
      starts.push(o)
      const rmax = Math.max(...l.map((p) => Math.hypot(p[0], p[1], p[2])))
      l.forEach((p, i) => {
        pts[3 * o] = p[0]
        pts[3 * o + 1] = p[1]
        pts[3 * o + 2] = p[2]
        o++
        aT.push(i / (l.length - 1))
        aL.push(Math.min(1, (rmax - 1) / (MAX_R - 1)))
        aLine.push((li * 0.61803) % 1)
      })
    })
    starts.push(o)
    // segments: two vertices per segment
    const segCount = total - all.length
    const geo = new THREE.BufferGeometry()
    const position = new Float32Array(segCount * 2 * 3)
    const t2 = new Float32Array(segCount * 2)
    const l2 = new Float32Array(segCount * 2)
    const n2 = new Float32Array(segCount * 2)
    let s = 0
    for (let li = 0; li < all.length; li++) {
      for (let i = starts[li]; i < starts[li + 1] - 1; i++) {
        for (const q of [i, i + 1]) {
          t2[s] = aT[q]
          l2[s] = aL[q]
          n2[s] = aLine[q]
          s++
        }
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aT', new THREE.BufferAttribute(t2, 1))
    geo.setAttribute('aL', new THREE.BufferAttribute(l2, 1))
    geo.setAttribute('aLine', new THREE.BufferAttribute(n2, 1))
    if (this.lines) {
      this.lines.removeFromParent()
      this.lines.geometry.dispose()
    }
    const mat = this.lines
      ? (this.lines.material as THREE.ShaderMaterial)
      : new THREE.ShaderMaterial({ uniforms: this.lineU, vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    this.lines = new THREE.LineSegments(geo, mat)
    this.lines.frustumCulled = false
    this.lines.renderOrder = 6
    this.lines.visible = this.flags.lines
    this.group.add(this.lines)
    this.lineSet = { pts, starts, segCount }
    this.lastWarpKey = ''
  }

  /** Turn the Earth-fixed lines into the Sun-fixed frame, bend them for the wind, and write them out. */
  private writeLines(st: MagnetoState): void {
    const ls = this.lineSet
    const lines = this.lines
    if (!ls || !lines) return
    const key = [st.earthQuat.x, st.earthQuat.y, st.earthQuat.z, st.earthQuat.w, st.sunDir.x, st.sunDir.y, st.sunDir.z, st.magnetosphere.r0.toFixed(2), st.stretch.toFixed(2)].map((v) => (typeof v === 'number' ? v.toFixed(4) : v)).join(',')
    if (key === this.lastWarpKey) return
    this.lastWarpKey = key
    // the Sun frame: x = toward the Sun, y = ecliptic north x x (normalised), z = x x y
    const x = st.sunDir
    const y = new THREE.Vector3(0, 0, 1).cross(x).normalize()
    const z = new THREE.Vector3().crossVectors(x, y)
    const squash = Math.min(1.1, st.magnetosphere.r0 / 10.2)
    const q = st.earthQuat
    const pos = (lines.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    const P = new THREE.Vector3()
    let w = 0
    const put = (i: number): void => {
      P.set(ls.pts[3 * i], ls.pts[3 * i + 1], ls.pts[3 * i + 2]).applyQuaternion(q)
      const wp = warpPoint([P.dot(x), P.dot(y), P.dot(z)], squash, st.stretch)
      pos[w++] = x.x * wp[0] + y.x * wp[1] + z.x * wp[2]
      pos[w++] = x.y * wp[0] + y.y * wp[1] + z.y * wp[2]
      pos[w++] = x.z * wp[0] + y.z * wp[1] + z.z * wp[2]
    }
    for (let li = 0; li < ls.starts.length - 1; li++) {
      for (let i = ls.starts[li]; i < ls.starts[li + 1] - 1; i++) {
        put(i)
        put(i + 1)
      }
    }
    lines.geometry.getAttribute('position').needsUpdate = true
  }

  // ---------- the surface map ----------

  private mapTexture(kind: MagnetoFlags['mapKind'], year: number): { col: THREE.DataTexture; val: THREE.DataTexture } {
    const key = `${kind}:${Math.round(year * 4)}`
    const have = this.mapTex.get(key)
    if (have) return have
    const c = coefficientsAt(year)
    const w = 360
    const h = 180
    const data = new Uint8Array(w * h * 4)
    // The contour value goes in its own texture as two half floats (high part, and what the high part left out): a byte, or one
    // half float, is coarser than the field changes across a texel near a high or low, which broke the lines into flickering dots.
    const val = new Uint16Array(w * h * 2)
    const half = THREE.DataUtils.toHalfFloat
    const grid = kind === 'strength' ? strengthGrid(c, w, h) : declinationGrid(c, w, h)
    for (let j = 0; j < h; j++) {
      // the texture's row 0 is the south (v = 0), the grid's row 0 is the north
      const src = h - 1 - j
      for (let i = 0; i < w; i++) {
        // the grid's column 0 is -180; the shader's u = 0 is -180 too (lon / 2pi + 0.5)
        const v = grid[src * w + i]
        const col = kind === 'strength' ? strengthColour(v) : declinationColour(v)
        const o = (j * w + i) * 4
        data[o] = Math.round(col[0] * 255)
        data[o + 1] = Math.round(col[1] * 255)
        data[o + 2] = Math.round(col[2] * 255)
        data[o + 3] = 255
        // the value for the contour lines, 0..1 (strength 20..70 uT, declination -60..60 degrees)
        const t = kind === 'strength' ? (v - 20_000) / 50_000 : (v + 60) / 120
        const tv = Math.min(1, Math.max(0, t))
        const hi = THREE.DataUtils.fromHalfFloat(half(tv))
        val[(j * w + i) * 2] = half(hi)
        val[(j * w + i) * 2 + 1] = half(tv - hi)
      }
    }
    const make = (tex: THREE.DataTexture): THREE.DataTexture => {
      tex.magFilter = THREE.LinearFilter
      tex.minFilter = THREE.LinearFilter
      tex.wrapS = THREE.RepeatWrapping
      tex.generateMipmaps = false
      tex.needsUpdate = true
      return tex
    }
    const tex = { col: make(new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType)), val: make(new THREE.DataTexture(val, w, h, THREE.RGFormat, THREE.HalfFloatType)) }
    this.mapTex.set(key, tex)
    if (this.mapTex.size > 6) {
      const first = this.mapTex.keys().next().value as string
      const old = this.mapTex.get(first)
      old?.col.dispose()
      old?.val.dispose()
      this.mapTex.delete(first)
    }
    return tex
  }

  private applyMap(): void {
    if (!this.map || !Number.isFinite(this.year)) return
    const tex = this.mapTexture(this.flags.mapKind, this.year)
    this.mapU.uMap.value = tex.col
    this.mapU.uVal.value = tex.val
    // contour every 2.5 uT (20 lines over 50 uT) or every 10 degrees of declination (12 over 120)
    this.mapU.uContours.value = this.flags.mapKind === 'strength' ? 20 : 12
  }

  private ensureMap(): void {
    if (this.map) return
    const geo = new THREE.SphereGeometry(1.003, 128, 64)
    geo.rotateX(Math.PI / 2)
    this.map = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({ uniforms: this.mapU, vertexShader: MAP_VERT, fragmentShader: MAP_FRAG, transparent: true, depthWrite: false })
    )
    this.map.frustumCulled = false
    this.map.renderOrder = 4
    this.map.visible = this.flags.map
    this.earthMesh.add(this.map)
    this.applyMap()
  }

  // ---------- magnetopause and bow shock ----------

  private ensureSurfaces(m: Magnetosphere): void {
    const key = `${m.r0.toFixed(1)}:${m.alpha.toFixed(2)}:${m.bowNose.toFixed(1)}`
    if (key === this.surfKey && this.mp) return
    this.surfKey = key
    for (const s of [this.mp, this.bs]) {
      if (s) {
        s.removeFromParent()
        s.geometry.dispose()
      }
    }
    const mk = (geo: THREE.BufferGeometry, color: number, opacity: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } }, vertexShader: SURF_VERT, fragmentShader: SURF_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }))
      mesh.frustumCulled = false
      mesh.renderOrder = 5
      mesh.visible = this.flags.surfaces
      this.sunFrame.add(mesh)
      return mesh
    }
    this.mp = mk(revolvedSurface((t) => magnetopauseAt(m, t), 172, 42), 0x3fe8d0, 0.9)
    this.bs = mk(revolvedSurface((t) => bowShockAt(m.bowNose, t), 150, 60), 0xffa55a, 0.8)
    this.mpLabel.position.set(m.r0, 0, 0)
    this.bsLabel.position.set(m.bowNose, 0, 0)
    this.mpDiv.textContent = `Magnetopause ${m.r0.toFixed(1)} Earth radii (${Math.round(m.r0 * EARTH_RADIUS_KM / 1000).toLocaleString()} thousand km)`
    this.bsDiv.textContent = `Bow shock ${m.bowNose.toFixed(1)} Earth radii`
  }

  // ---------- stations ----------

  setStations(rows: StationRow[]): void {
    this.stations = rows
    for (const s of [this.stPoints, this.stHalo]) {
      if (s) {
        s.removeFromParent()
        s.geometry.dispose()
        ;(s.material as THREE.Material).dispose()
      }
    }
    for (const l of this.stLabels) {
      l.obj.removeFromParent()
      l.div.remove()
    }
    this.stLabels = []
    this.stPoints = this.stHalo = null
    if (!rows.length) return
    const pos: number[] = []
    const col: number[] = []
    const cols: Record<string, [number, number, number]> = { quiet: [0.35, 0.95, 0.5], good: [0.95, 0.9, 0.3], great: [1, 0.6, 0.2], warn: [1, 0.25, 0.2] }
    for (const r of rows) {
      const la = r.lat * DEG
      const lo = r.lon * DEG
      const u = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la))
      pos.push(u.x * 1.003, u.y * 1.003, u.z * 1.003)
      const c = cols[stationLevel(r.range_1h).tone]
      col.push(c[0], c[1], c[2])
      const div = document.createElement('div')
      div.style.cssText = labelStyle('#d8ffe6')
      div.textContent = `${r.id} ${Math.round(r.range_1h)} nT/h`
      const obj = new CSS2DObject(div)
      obj.center.set(0, 0.5)
      obj.position.copy(u).multiplyScalar(1.003)
      this.earthMesh.add(obj)
      this.stLabels.push({ obj, div, unit: u })
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    this.stHalo = new THREE.Points(geo, new THREE.PointsMaterial({ size: 20, sizeAttenuation: false, vertexColors: true, map: this.glowTexture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6, alphaTest: 0.01 }))
    this.stPoints = new THREE.Points(geo, new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, vertexColors: true, map: this.dotTexture, transparent: true, depthWrite: false, alphaTest: 0.01 }))
    for (const p of [this.stHalo, this.stPoints]) {
      p.frustumCulled = false
      p.renderOrder = 8
      p.visible = this.flags.stations
      this.earthMesh.add(p)
    }
  }

  // ---------- each frame ----------

  /** True while something animates (so the engine keeps drawing). */
  get animating(): boolean {
    return !!this.lines?.visible
  }

  update(st: MagnetoState, sceneMs: number): void {
    const year = decimalYear(sceneMs)
    // IGRF is a model of 2020-2025 with a forecast to 2030: far outside that the lines would mean nothing
    const valid = 1 - smooth(10, 30, Math.abs(year - 2025))
    const now = performance.now()
    if ((!Number.isFinite(this.year) || Math.abs(year - this.year) > 0.25) && now - this.builtAt > 1500) {
      this.year = year
      this.builtAt = now
      this.buildLines(year)
      if (this.map) this.applyMap()
    }
    if (this.flags.map) this.ensureMap()
    const far = 1 - smooth(60, 160, st.camRe) // the field is a near-Earth picture
    if (this.lines) {
      this.lines.visible = this.flags.lines && valid > 0.02 && far > 0.02
      this.lineU.uTime.value = st.timeS
      this.lineU.uDist.value = st.disturbance * st.live
      this.lineU.uAlpha.value = valid * far
      if (this.lines.visible) this.writeLines(st)
    }
    if (this.map) {
      this.map.visible = this.flags.map && valid > 0.02
      this.mapU.uOpacity.value = 0.55 * valid * far
    }
    if (this.flags.surfaces) {
      this.ensureSurfaces(st.magnetosphere)
      // the Sun frame
      const x = st.sunDir
      const y = this.tmp.set(0, 0, 1).cross(x).normalize()
      const z = this.tmp2.crossVectors(x, y)
      const m = new THREE.Matrix4().makeBasis(x, y, z)
      this.sunFrame.quaternion.setFromRotationMatrix(m)
      const a = far * (0.4 + 0.6 * st.live)
      for (const s of [this.mp, this.bs]) if (s) (s.material as THREE.ShaderMaterial).uniforms.uOpacity.value = (s === this.mp ? 0.9 : 0.8) * a
      const near = st.camRe < 120
      this.mpLabel.visible = this.bsLabel.visible = near
      this.mpDiv.style.opacity = this.bsDiv.style.opacity = String(Math.max(0, a))
    }
    // stations
    if (this.stPoints && this.flags.stations) {
      const fade = st.live * (1 - smooth(40, 90, st.camRe))
      ;(this.stPoints.material as THREE.PointsMaterial).opacity = fade
      ;(this.stHalo!.material as THREE.PointsMaterial).opacity = 0.6 * fade
      this.stPoints.visible = this.stHalo!.visible = fade > 0.02
      const pulse = 0.5 + 0.5 * Math.sin(st.timeS * 3)
      ;(this.stHalo!.material as THREE.PointsMaterial).size = 16 + 8 * pulse
    }
  }

  /** Station names: show them when the camera is within a few Earth radii, and only the ones on the near side. */
  updateStationLabels(camLocalUnit: THREE.Vector3, camRe: number, live: number): void {
    const horizon = 1 / Math.max(camRe, 1.0001) + 0.02
    for (const l of this.stLabels) {
      const facing = l.unit.dot(camLocalUnit) > horizon
      l.obj.visible = this.flags.stations && live > 0.3 && camRe < 3.2 && facing
    }
  }

  dispose(): void {
    for (const t of this.mapTex.values()) {
      t.col.dispose()
      t.val.dispose()
    }
    this.lines?.geometry.dispose()
    ;(this.lines?.material as THREE.Material | undefined)?.dispose()
    for (const s of [this.mp, this.bs, this.map, this.stPoints, this.stHalo]) {
      s?.removeFromParent()
      s?.geometry.dispose()
      ;((s?.material as THREE.Material | undefined))?.dispose()
    }
    for (const l of this.stLabels) {
      l.obj.removeFromParent()
      l.div.remove()
    }
    this.mpLabel.removeFromParent()
    this.bsLabel.removeFromParent()
    this.mpDiv.remove()
    this.bsDiv.remove()
    this.group.removeFromParent()
  }
}
