// The solar wind in the 3D scene.
//
//  * A stream of particles from the Sun to the Earth. Its speed, density and colour are the real wind measured at the L1 point
//    (about 1.5 million km sunward of Earth) right now. Time is sped up, since the real wind takes days to cross: at 400 km/s
//    a particle crosses in 60 seconds here (about 4.3 days in reality), faster wind faster.
//  * The L1 marker, where the wind is measured.
//  * Markers for what is on its way: coronal mass ejections and high-speed streams with their arrival times, and shocks that
//    L1 has just seen, each placed where it would be now if it kept its speed.
//  * NOAA's WSA-Enlil model picture (density or speed) laid flat in the plane of the planets, out to 1.7 AU: a forecast model,
//    a 2D slice, hourly for about a week.
//
// The group is a child of the Sun's group, so positions are heliocentric AU in ecliptic axes.

import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { AU_KM, L1_DISTANCE_KM, distanceToEarthAU } from '@renderer/lib/magnetosphere'
import type { Vec3 } from '@renderer/lib/sun'

const L1_AU = L1_DISTANCE_KM / AU_KM
const MAX_PARTICLES = 9000
const BASE_PARTICLES = 2000

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export interface WindNow {
  speed: number | null
  density: number | null
  bz: number | null
  bt: number | null
}

export interface WindMarker {
  id: string
  kind: 'cme' | 'stream' | 'shock'
  arrivalMs: number
  speed: number
  label: string
}

export interface WindFlags {
  stream: boolean
  markers: boolean
  sheet: boolean
}

const STREAM_VERT = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aSeed;
  attribute float aRad;
  attribute float aAng;
  attribute float aSpd;
  uniform float uTime;
  uniform float uRate;
  uniform vec3 uE;
  uniform vec3 uP1;
  uniform vec3 uP2;
  uniform float uLen;
  uniform float uStart;
  uniform float uSpread;
  uniform float uSize;
  varying float vFade;
  varying float vS;
  void main() {
    float s = fract(aSeed + uTime * uRate * aSpd);
    float along = mix(uStart, uLen, s);
    float rad = sqrt(aRad) * along * uSpread;
    vec3 p = uE * along + (uP1 * cos(aAng) + uP2 * sin(aAng)) * rad;
    vS = s;
    vFade = smoothstep(0.0, 0.05, s) * (1.0 - smoothstep(0.92, 1.0, s));
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(p, 1.0));
    gl_PointSize = uSize;
    #include <logdepthbuf_vertex>
  }`
const STREAM_FRAG = `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uV;
  uniform float uAlpha;
  varying float vFade;
  varying float vS;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    vec3 col = mix(vec3(0.3, 0.55, 1.0), vec3(0.4, 1.0, 0.9), smoothstep(300.0, 450.0, uV));
    col = mix(col, vec3(1.0, 0.9, 0.35), smoothstep(450.0, 600.0, uV));
    col = mix(col, vec3(1.0, 0.35, 0.2), smoothstep(650.0, 900.0, uV));
    gl_FragColor = vec4(col, uAlpha * vFade * (1.0 - d * 2.0) * (0.35 + 0.65 * (1.0 - vS)));
  }`

const SHEET_VERT = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vP;
  varying vec3 vV;
  varying vec3 vN;
  void main() {
    vP = position.xy;
    vV = (modelViewMatrix * vec4(position, 1.0)).xyz;
    vN = mat3(modelViewMatrix) * vec3(0.0, 0.0, 1.0);
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
    #include <logdepthbuf_vertex>
  }`
const SHEET_FRAG = `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uMap;
  uniform float uAlpha;
  uniform vec3 uEarthV;
  uniform float uEarthR;
  varying vec2 vP;
  varying vec3 vV;
  varying vec3 vN;
  void main() {
    #include <logdepthbuf_fragment>
    float r = length(vP);
    if (r > 0.995) discard;
    vec3 col = texture2D(uMap, vP * 0.5 + 0.5).rgb;
    // The Earth sits in this flat sheet, so the half of it behind the sheet would be tinted by it. Leave a hole in the sheet
    // wherever the view ray, carried on past the sheet, still runs into the Earth (the near half hides the sheet by itself).
    float len = length(vV);
    vec3 d = vV / len;
    float b = dot(uEarthV, d);
    float h = length(uEarthV - d * b);
    float hole = 0.0;
    if (b > 0.0 && h < uEarthR) {
      float exit = b + sqrt(max(uEarthR * uEarthR - h * h, 0.0));
      hole = (1.0 - smoothstep(0.9 * uEarthR, uEarthR, h)) * step(len, exit);
    }
    // Seen almost edge-on (looking across the sheet, or from inside it) it is only a sliver that shimmers and swims, so fade it out
    float facing = smoothstep(0.02, 0.16, abs(dot(normalize(vN), d)));
    gl_FragColor = vec4(col, uAlpha * (1.0 - smoothstep(0.9, 0.995, r)) * (1.0 - hole) * facing);
  }`

const labelStyle = (color: string): string => `padding-left:9px;font:11px/1.3 system-ui,sans-serif;color:${color};text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:none;user-select:none`

interface MarkerItem {
  m: WindMarker
  dot: THREE.Sprite
  ring: THREE.Mesh
  label: CSS2DObject
  div: HTMLDivElement
}

const KIND_COLOUR: Record<WindMarker['kind'], number> = { cme: 0xff6a3d, stream: 0x59d6ff, shock: 0xfff08a }

export class WindLayer {
  readonly group = new THREE.Group()
  private flags: WindFlags = { stream: true, markers: true, sheet: false }
  private readonly stream: THREE.Points
  private readonly streamU: Record<string, { value: unknown }>
  private readonly sheet: THREE.Mesh
  private readonly sheetU: { uMap: { value: THREE.Texture | null }; uAlpha: { value: number }; uEarthV: { value: THREE.Vector3 }; uEarthR: { value: number } }
  private sheetTex: THREE.CanvasTexture | null = null
  private sheetHalfAU = 1.7
  private readonly l1Dot: THREE.Sprite
  private readonly l1Label: CSS2DObject
  private readonly l1Div: HTMLDivElement
  private items = new Map<string, MarkerItem>()
  private wind: WindNow = { speed: null, density: null, bz: null, bt: null }
  private readonly dotTexture: THREE.Texture
  private t0 = performance.now()
  private readonly e = new THREE.Vector3()
  private readonly p1 = new THREE.Vector3()
  private readonly p2 = new THREE.Vector3()

  constructor(sunGroup: THREE.Group, dot: THREE.Texture) {
    this.dotTexture = dot
    sunGroup.add(this.group)

    const seed = new Float32Array(MAX_PARTICLES)
    const rad = new Float32Array(MAX_PARTICLES)
    const ang = new Float32Array(MAX_PARTICLES)
    const spd = new Float32Array(MAX_PARTICLES)
    for (let i = 0; i < MAX_PARTICLES; i++) {
      seed[i] = Math.random()
      rad[i] = Math.random()
      ang[i] = Math.random() * Math.PI * 2
      spd[i] = 0.85 + Math.random() * 0.3
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3))
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    geo.setAttribute('aRad', new THREE.BufferAttribute(rad, 1))
    geo.setAttribute('aAng', new THREE.BufferAttribute(ang, 1))
    geo.setAttribute('aSpd', new THREE.BufferAttribute(spd, 1))
    geo.setDrawRange(0, BASE_PARTICLES)
    this.streamU = {
      uTime: { value: 0 },
      uRate: { value: 1 / 60 },
      uE: { value: new THREE.Vector3(1, 0, 0) },
      uP1: { value: new THREE.Vector3(0, 1, 0) },
      uP2: { value: new THREE.Vector3(0, 0, 1) },
      uLen: { value: 1 },
      uStart: { value: 0.02 },
      uSpread: { value: Math.tan((5 * Math.PI) / 180) },
      uSize: { value: 2.6 },
      uV: { value: 400 },
      uAlpha: { value: 0.5 }
    }
    this.stream = new THREE.Points(geo, new THREE.ShaderMaterial({ uniforms: this.streamU, vertexShader: STREAM_VERT, fragmentShader: STREAM_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
    this.stream.frustumCulled = false
    this.stream.renderOrder = 6
    this.group.add(this.stream)

    this.sheetU = { uMap: { value: null }, uAlpha: { value: 0.55 }, uEarthV: { value: new THREE.Vector3(0, 0, -1e3) }, uEarthR: { value: 0 } }
    this.sheet = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 96, 96), new THREE.ShaderMaterial({ uniforms: this.sheetU, vertexShader: SHEET_VERT, fragmentShader: SHEET_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide }))
    this.sheet.frustumCulled = false
    this.sheet.renderOrder = 2
    this.sheet.visible = false
    this.group.add(this.sheet)

    this.l1Dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: 0xffffff, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }))
    this.l1Dot.scale.setScalar(0.011)
    this.l1Dot.renderOrder = 9
    this.l1Div = document.createElement('div')
    this.l1Div.style.cssText = labelStyle('#dff3ff')
    this.l1Label = new CSS2DObject(this.l1Div)
    this.l1Label.center.set(0, 0.5)
    this.group.add(this.l1Dot, this.l1Label)
  }

  setFlags(f: WindFlags): void {
    this.flags = f
    this.stream.visible = f.stream
    this.l1Dot.visible = this.l1Label.visible = f.stream || f.markers
    for (const it of this.items.values()) it.dot.visible = it.ring.visible = it.label.visible = f.markers
    this.sheet.visible = f.sheet && !!this.sheetTex
  }

  setWind(w: WindNow): void {
    this.wind = w
    const v = w.speed ?? 400
    this.streamU.uV.value = v
    // a full crossing takes 60 s at 400 km/s
    this.streamU.uRate.value = v / 400 / 60
    const n = w.density ?? 5
    const count = Math.round(Math.min(MAX_PARTICLES, Math.max(BASE_PARTICLES * 0.3, (BASE_PARTICLES * n) / 5)))
    this.stream.geometry.setDrawRange(0, count)
  }

  /** The Enlil picture for the sheet: the bitmap is the circle cropped from NOAA's picture, `auFraction` how far the circle's radius is per AU. */
  setSheet(bitmap: ImageBitmap, auFraction: number): void {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    bitmap.close()
    this.sheetTex?.dispose()
    const t = new THREE.CanvasTexture(canvas)
    t.anisotropy = 16
    this.sheetTex = t
    this.sheetU.uMap.value = t
    this.sheetHalfAU = 1 / Math.max(0.1, auFraction)
    this.sheet.scale.set(this.sheetHalfAU, this.sheetHalfAU, 1)
    this.sheet.visible = this.flags.sheet
  }

  clearSheet(): void {
    this.sheetTex?.dispose()
    this.sheetTex = null
    this.sheetU.uMap.value = null
    this.sheet.visible = false
  }

  setMarkers(list: WindMarker[]): void {
    const keep = new Set(list.map((m) => m.id))
    for (const [id, it] of this.items) {
      if (!keep.has(id)) {
        this.removeItem(it)
        this.items.delete(id)
      }
    }
    for (const m of list) {
      const have = this.items.get(m.id)
      if (have) {
        have.m = m
        continue
      }
      const colour = KIND_COLOUR[m.kind]
      const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dotTexture, color: colour, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }))
      dot.scale.setScalar(0.014)
      dot.renderOrder = 9
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64), new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }))
      ring.renderOrder = 7
      ring.frustumCulled = false
      const div = document.createElement('div')
      div.style.cssText = labelStyle(m.kind === 'cme' ? '#ffb199' : m.kind === 'stream' ? '#b7ecff' : '#fff3b0')
      div.textContent = m.label
      const label = new CSS2DObject(div)
      label.center.set(0, 0.5)
      this.group.add(dot, ring, label)
      this.items.set(m.id, { m, dot, ring, label, div })
    }
    for (const it of this.items.values()) if (it.div.textContent !== it.m.label) it.div.textContent = it.m.label
  }

  private removeItem(it: MarkerItem): void {
    for (const o of [it.dot, it.ring]) {
      o.removeFromParent()
      ;(o.material as THREE.Material).dispose()
    }
    it.ring.geometry.dispose()
    it.label.removeFromParent()
    it.div.remove()
  }

  get animating(): boolean {
    return this.flags.stream && this.stream.visible
  }

  /**
   * `earthPos`: the Earth's heliocentric position (AU). `camToEarth`, `camToSun`: the camera's distances (AU). `live`: how much the
   * measured wind means for the scene's date (1 near now, 0 far from it).
   */
  update(earthPos: Vec3, sceneMs: number, camToEarth: number, camToSun: number, live: number, earthView: THREE.Vector3, earthRadius: number, bodyRatio = Infinity, nowMs = Date.now()): void {
    const len = Math.hypot(...earthPos)
    this.e.set(earthPos[0] / len, earthPos[1] / len, earthPos[2] / len)
    this.p1.set(0, 0, 1).cross(this.e).normalize()
    this.p2.crossVectors(this.e, this.p1)

    // the stream
    const u = this.streamU
    ;(u.uE.value as THREE.Vector3).copy(this.e)
    ;(u.uP1.value as THREE.Vector3).copy(this.p1)
    ;(u.uP2.value as THREE.Vector3).copy(this.p2)
    u.uLen.value = len
    u.uTime.value = (performance.now() - this.t0) / 1000
    // not near the Earth (where the particles' own precision runs out), and not far from the Sun
    u.uAlpha.value = 0.55 * live * smooth(3e-5, 4e-4, camToEarth) * (1 - smooth(30, 200, camToSun))
    this.stream.visible = this.flags.stream && (u.uAlpha.value as number) > 0.01

    // L1
    const l1 = this.e.clone().multiplyScalar(len - L1_AU)
    this.l1Dot.position.copy(l1)
    this.l1Label.position.copy(l1)
    const w = this.wind
    this.l1Div.textContent = `L1, where the wind is measured${w.speed != null ? ` · ${Math.round(w.speed)} km/s` : ''}${w.density != null ? ` · ${w.density.toFixed(1)}/cm³` : ''}${w.bz != null ? ` · Bz ${w.bz.toFixed(1)} nT` : ''}`
    const showL1 = (this.flags.stream || this.flags.markers) && live > 0.05
    this.l1Dot.visible = showL1 && camToSun < 60
    this.l1Label.visible = showL1 && camToEarth < 0.2 && camToEarth > 6e-4
    this.l1Div.style.opacity = String(live)
    ;(this.l1Dot.material as THREE.SpriteMaterial).opacity = live * smooth(3e-4, 2e-3, camToEarth)

    // markers
    for (const it of this.items.values()) {
      const d = distanceToEarthAU(it.m.arrivalMs, it.m.speed, nowMs)
      const along = Math.max(0.02, len - d)
      const pos = this.e.clone().multiplyScalar(along)
      it.dot.position.copy(pos)
      it.label.position.copy(pos)
      // a ring square to the Sun-Earth line, about as wide as the wind stream there
      it.ring.position.copy(pos)
      it.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.e)
      it.ring.scale.setScalar(Math.max(0.01, along * 0.09))
      const arrived = it.m.arrivalMs < nowMs
      const show = this.flags.markers && !arrived && live > 0.05
      it.dot.visible = it.ring.visible = show && camToSun < 80
      it.label.visible = show && camToEarth < 3 && camToSun < 40
      it.div.style.opacity = String(live)
    }

    // the flow sheet: turned so that the picture's x axis (toward the Earth) lies along the Earth's direction
    if (this.sheet.visible || (this.flags.sheet && this.sheetTex)) {
      this.sheet.rotation.z = Math.atan2(this.e.y, this.e.x)
      // The Earth is cut out of the sheet in the shader (uEarthV: its centre in view space, uEarthR: a little over its radius).
      // Any other focused body is in the plane too, and is not cut out: the sheet fades out as the camera comes within a few
      // hundred of its radii (`bodyRatio`).
      this.sheetU.uEarthV.value.copy(earthView)
      this.sheetU.uEarthR.value = earthRadius * 1.03
      this.sheetU.uAlpha.value = 0.6 * smooth(0.12, 0.7, camToSun) * (1 - smooth(80, 400, camToSun)) * smooth(100, 500, bodyRatio)
      this.sheet.visible = this.flags.sheet && !!this.sheetTex && (this.sheetU.uAlpha.value as number) > 0.01
    }
    void sceneMs
  }

  dispose(): void {
    this.stream.geometry.dispose()
    ;(this.stream.material as THREE.Material).dispose()
    this.sheet.geometry.dispose()
    ;(this.sheet.material as THREE.Material).dispose()
    this.sheetTex?.dispose()
    for (const it of this.items.values()) this.removeItem(it)
    this.items.clear()
    this.l1Dot.removeFromParent()
    ;(this.l1Dot.material as THREE.Material).dispose()
    this.l1Label.removeFromParent()
    this.l1Div.remove()
    this.group.removeFromParent()
  }
}
