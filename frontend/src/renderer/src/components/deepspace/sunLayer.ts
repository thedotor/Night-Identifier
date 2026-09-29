// The live Sun in the 3D solar system.
//
//  * Surface: a real picture of the Sun (NASA SDO: visible light, magnetic field or extreme ultraviolet) wrapped onto the
//    sphere. The picture is the Sun's Earth-facing side, so it is projected onto the near hemisphere exactly as the camera at
//    Earth saw it (orthographic, solar north up). The far side is not observed by SDO: it shows a dimmed mirror of the near side.
//  * Corona: SOHO LASCO C2 (about 2.3 to 6 solar radii) and C3 (about 4.4 to 30) coronagraph pictures on flat sheets that turn to
//    face the camera wherever it is, so the streamers and CMEs look right from any side (an approximation: they are only
//    truly right for a viewer at Earth). Luminance is turned into transparency and added to the sky as light.
//  * CMEs: NASA DONKI's catalogue, each as a translucent bubble travelling outward at its measured speed along its measured
//    direction, with a line to its front and, for those heading at Earth, the predicted arrival.
//  * Sunspot groups: NOAA's numbered regions, labelled where they are on the surface, drifting west as the Sun turns.
//
// Everything here is in solar radii, inside a group scaled to the Sun's real radius (so the group is a child of the Sun's own
// group and rides the floating origin with it).

import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { cmeFront, cmeVisible, discFraction, facesEarth, flareFlux, heeqToScene, regionLon, relativeTime, sunFrame, type Cme, type Flare, type Region, type SunFrame, type SurfaceKind, type Vec3 } from '@renderer/lib/sun'

const DEG = Math.PI / 180
const C2_HALF_RSUN = 6.4
const C3_HALF_RSUN = 32

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

const VERT_PLAIN = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vDir;
  varying vec2 vP;
  void main() {
    vDir = position;
    vP = position.xy;
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
    #include <logdepthbuf_vertex>
  }`

const DISC_FRAG = `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uMap;
  uniform vec3 uRight;
  uniform vec3 uUp;
  uniform vec3 uEarth;
  uniform float uFrac;
  uniform vec3 uTint;
  uniform float uFar;
  varying vec3 vDir;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 n = normalize(vDir);
    vec2 p = vec2(dot(n, uRight), dot(n, uUp));
    vec3 c = texture2D(uMap, 0.5 + 0.5 * p * uFrac).rgb * uTint;
    float side = dot(n, uEarth) >= 0.0 ? 1.0 : uFar;
    gl_FragColor = vec4(c * side, 1.0);
  }`

const CORONA_FRAG = `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uMap;
  uniform float uAngle;
  uniform float uInner;
  uniform float uInnerW;
  uniform float uOuter;
  uniform float uOuterW;
  uniform float uAlpha;
  uniform float uGain;
  uniform float uFloor;
  varying vec2 vP;
  void main() {
    #include <logdepthbuf_fragment>
    float c = cos(uAngle);
    float s = sin(uAngle);
    vec2 q = vec2(vP.x * c - vP.y * s, vP.x * s + vP.y * c);
    float r = length(q);
    vec3 col = texture2D(uMap, 0.5 + 0.5 * q).rgb;
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    float k = smoothstep(uFloor, uFloor + 0.3, lum);
    float m = smoothstep(uInner, uInner + uInnerW, r) * (1.0 - smoothstep(uOuter - uOuterW, uOuter, r));
    gl_FragColor = vec4(col * uGain, k * m * uAlpha);
  }`

const CME_VERT = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aRim;
  varying float vRim;
  void main() {
    vRim = aRim;
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
    #include <logdepthbuf_vertex>
  }`
const CME_FRAG = `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vRim;
  void main() {
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(uColor, uOpacity * (0.04 + 0.32 * pow(vRim, 4.0)));
  }`

/** A unit spherical cap around +Z, half-angle `alphaDeg`, with a 0..1 "how near the rim" attribute. */
function capGeometry(alphaDeg: number): THREE.BufferGeometry {
  const rings = 10
  const segs = 56
  const alpha = Math.min(88, Math.max(4, alphaDeg)) * DEG
  const pos: number[] = []
  const rim: number[] = []
  const idx: number[] = []
  pos.push(0, 0, 1)
  rim.push(0)
  for (let i = 1; i <= rings; i++) {
    const th = (i / rings) * alpha
    for (let j = 0; j < segs; j++) {
      const ph = (j / segs) * Math.PI * 2
      pos.push(Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th))
      rim.push(i / rings)
    }
  }
  for (let j = 0; j < segs; j++) idx.push(0, 1 + j, 1 + ((j + 1) % segs))
  for (let i = 1; i < rings; i++) {
    const a = 1 + (i - 1) * segs
    const b = 1 + i * segs
    for (let j = 0; j < segs; j++) {
      const j2 = (j + 1) % segs
      idx.push(a + j, b + j, b + j2, a + j, b + j2, a + j2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aRim', new THREE.Float32BufferAttribute(rim, 1))
  g.setIndex(idx)
  return g
}

function ringGeometry(alphaDeg: number): THREE.BufferGeometry {
  const alpha = Math.min(88, Math.max(4, alphaDeg)) * DEG
  const pos: number[] = []
  for (let j = 0; j < 72; j++) {
    const ph = (j / 72) * Math.PI * 2
    pos.push(Math.sin(alpha) * Math.cos(ph), Math.sin(alpha) * Math.sin(ph), Math.cos(alpha))
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  return g
}

const labelStyle = (color: string): string => `padding-left:8px;font:11px/1.25 system-ui,sans-serif;color:${color};text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:none;user-select:none`

const FLARE_FADE_MS = 3 * 3_600_000

/** Yellow/orange/red for a C/M/X-class flare (bucketed by flux, so edge cases like "M9.9" and "X1.0" fall where they should). */
export function flareColour(cls: string | null | undefined): THREE.Color {
  const f = flareFlux(cls)
  if (f >= 1e-4) return new THREE.Color('#ff5050')
  if (f >= 1e-5) return new THREE.Color('#ff9a3d')
  return new THREE.Color('#ffd84d')
}

let flareTexture: THREE.CanvasTexture | null = null
function flareGlowTexture(): THREE.CanvasTexture {
  if (flareTexture) return flareTexture
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.4, 'rgba(255,255,255,0.6)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  flareTexture = new THREE.CanvasTexture(canvas)
  return flareTexture
}

interface FlareItem {
  flare: Flare
  region: Region
  sprite: THREE.Sprite
}

interface CmeItem {
  cme: Cme
  cap: THREE.Mesh
  ring: THREE.LineLoop
  axis: THREE.Line
  label: CSS2DObject
  labelDiv: HTMLDivElement
  text: string
}

interface SpotItem {
  region: Region
  label: CSS2DObject
  div: HTMLDivElement
}

export interface SunLayerFlags {
  surface: boolean
  corona: boolean
  cmes: boolean
  spots: boolean
  flares: boolean
}

export class SunLayer {
  /** child of the Sun's group, scaled so 1 unit = 1 solar radius */
  readonly group = new THREE.Group()
  private readonly disc: THREE.Mesh
  private readonly discU: {
    uMap: { value: THREE.Texture | null }
    uRight: { value: THREE.Vector3 }
    uUp: { value: THREE.Vector3 }
    uEarth: { value: THREE.Vector3 }
    uFrac: { value: number }
    uTint: { value: THREE.Vector3 }
    uFar: { value: number }
  }
  private readonly c2: THREE.Mesh
  private readonly c3: THREE.Mesh
  private readonly coronaU: { c2: Record<string, { value: unknown }>; c3: Record<string, { value: unknown }> }
  private readonly cmeGroup = new THREE.Group()
  private readonly cmeItems = new Map<string, CmeItem>()
  private readonly flareGroup = new THREE.Group()
  private spotItems: SpotItem[] = []
  private flareItems: FlareItem[] = []
  private frame: SunFrame | null = null
  private textures: { surface: THREE.CanvasTexture | null; c2: THREE.CanvasTexture | null; c3: THREE.CanvasTexture | null } = { surface: null, c2: null, c3: null }
  private flags: SunLayerFlags = { surface: true, corona: true, cmes: true, spots: true, flares: true }
  private cmes: Cme[] = []
  private regions: Region[] = []
  private flares: Flare[] = []
  private readonly tmp = new THREE.Vector3()
  private readonly tmp2 = new THREE.Vector3()
  private readonly q = new THREE.Quaternion()
  private surfaceKind: SurfaceKind = 'visual'
  private readonly radiusAU: number

  constructor(sunGroup: THREE.Group, radiusAU: number) {
    this.radiusAU = radiusAU
    this.group.scale.setScalar(radiusAU)
    sunGroup.add(this.group)

    const geo = new THREE.SphereGeometry(1.003, 96, 48)
    this.discU = {
      uMap: { value: null },
      uRight: { value: new THREE.Vector3(1, 0, 0) },
      uUp: { value: new THREE.Vector3(0, 0, 1) },
      uEarth: { value: new THREE.Vector3(0, -1, 0) },
      uFrac: { value: 0.72 },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uFar: { value: 0.5 }
    }
    this.disc = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: this.discU, vertexShader: VERT_PLAIN, fragmentShader: DISC_FRAG }))
    this.disc.frustumCulled = false
    this.disc.visible = false
    this.group.add(this.disc)

    const sheet = (halfR: number, inner: number, innerW: number, outer: number, outerW: number, gain: number, floor: number): { mesh: THREE.Mesh; u: Record<string, { value: unknown }> } => {
      const u: Record<string, { value: unknown }> = {
        uMap: { value: null },
        uAngle: { value: 0 },
        uInner: { value: inner },
        uInnerW: { value: innerW },
        uOuter: { value: outer },
        uOuterW: { value: outerW },
        uAlpha: { value: 0 },
        uGain: { value: gain },
        uFloor: { value: floor }
      }
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT_PLAIN, fragmentShader: CORONA_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
      )
      mesh.scale.setScalar(halfR)
      mesh.renderOrder = 4
      mesh.frustumCulled = false
      mesh.visible = false
      return { mesh, u }
    }
    // C2: occulter edge at 2.3 R (0.36 of the half-width), the corners of its square are cut. C3: occulter edge at 4.4 R, its round edge at 30 R.
    const a = sheet(C2_HALF_RSUN, 2.3 / C2_HALF_RSUN, 0.5 / C2_HALF_RSUN * 1.6, 0.98, 0.2, 0.95, 0.09)
    const b = sheet(C3_HALF_RSUN, 6.6 / C3_HALF_RSUN, 2.6 / C3_HALF_RSUN, 0.93, 0.08, 1.15, 0.09)
    this.c2 = a.mesh
    this.c3 = b.mesh
    this.coronaU = { c2: a.u, c3: b.u }
    this.group.add(this.c2, this.c3, this.cmeGroup, this.flareGroup)
  }

  // ---------- inputs ----------

  setFlags(f: SunLayerFlags): void {
    this.flags = f
    this.applyVisibility()
  }

  private applyVisibility(): void {
    this.disc.visible = this.flags.surface && !!this.textures.surface
    this.c2.visible = this.flags.corona && !!this.textures.c2
    this.c3.visible = this.flags.corona && !!this.textures.c3
    this.cmeGroup.visible = this.flags.cmes
    this.flareGroup.visible = this.flags.flares
    for (const s of this.spotItems) s.label.visible = this.flags.spots
  }

  private textureOf(bitmap: ImageBitmap): THREE.CanvasTexture {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    bitmap.close()
    const t = new THREE.CanvasTexture(canvas)
    t.anisotropy = 4
    t.needsUpdate = true
    return t
  }

  /** The disc picture. `kind` chooses the colouring: the visible-light picture is grey, so it is tinted the Sun's yellow-orange. */
  setSurface(kind: SurfaceKind, bitmap: ImageBitmap): void {
    this.textures.surface?.dispose()
    const t = this.textureOf(bitmap)
    this.textures.surface = t
    this.surfaceKind = kind
    this.discU.uMap.value = t
    if (kind === 'visual') this.discU.uTint.value.set(1.45, 1.05, 0.55)
    else this.discU.uTint.value.set(1, 1, 1)
    this.applyVisibility()
  }

  setCorona(which: 'c2' | 'c3', bitmap: ImageBitmap): void {
    this.textures[which]?.dispose()
    const t = this.textureOf(bitmap)
    this.textures[which] = t
    this.coronaU[which].uMap.value = t
    this.applyVisibility()
  }

  setActivity(cmes: Cme[], regions: Region[], flares: Flare[] = []): void {
    this.cmes = cmes
    this.regions = regions
    this.flares = flares
    // CMEs: rebuild what changed
    const keep = new Set(cmes.map((c) => c.id))
    for (const [id, it] of this.cmeItems) {
      if (!keep.has(id)) {
        this.removeCme(it)
        this.cmeItems.delete(id)
      }
    }
    for (const c of cmes) {
      if (!this.cmeItems.has(c.id) && Math.abs(c.lon) <= 360) this.cmeItems.set(c.id, this.makeCme(c))
    }
    // spots
    for (const s of this.spotItems) {
      s.label.removeFromParent()
      s.div.remove()
    }
    this.spotItems = regions.map((r) => {
      const div = document.createElement('div')
      div.style.cssText = labelStyle('#ffe9a8')
      div.textContent = `AR${r.number}`
      const label = new CSS2DObject(div)
      this.group.add(label)
      return { region: r, label, div }
    })
    // flares: rebuilt wholesale, small list refreshed every few minutes
    for (const f of this.flareItems) {
      f.sprite.removeFromParent()
      ;(f.sprite.material as THREE.SpriteMaterial).dispose()
    }
    this.flareItems = []
    for (const fl of flares) {
      const region = regions.find((r) => r.number === fl.region)
      if (!region) continue
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: flareGlowTexture(), color: flareColour(fl.class), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }))
      sprite.renderOrder = 5
      this.flareGroup.add(sprite)
      this.flareItems.push({ flare: fl, region, sprite })
    }
    this.applyVisibility()
  }

  private makeCme(c: Cme): CmeItem {
    const earth = c.earth_directed
    const far = Math.abs(c.lon) > 90
    const colour = earth ? new THREE.Color('#ff6a3d') : far ? new THREE.Color('#9fa8ff') : new THREE.Color('#6ad0ff')
    const capGeo = capGeometry(c.half_angle)
    const cap = new THREE.Mesh(
      capGeo,
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: colour }, uOpacity: { value: 0 } },
        vertexShader: CME_VERT,
        fragmentShader: CME_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
      })
    )
    cap.renderOrder = 6
    cap.frustumCulled = false
    const ring = new THREE.LineLoop(ringGeometry(c.half_angle), new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }))
    ring.renderOrder = 6
    ring.frustumCulled = false
    const axisGeo = new THREE.BufferGeometry()
    axisGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 1], 3))
    const axis = new THREE.Line(axisGeo, new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }))
    axis.renderOrder = 6
    axis.frustumCulled = false
    const labelDiv = document.createElement('div')
    labelDiv.style.cssText = labelStyle(earth ? '#ffb199' : '#bfe4ff')
    const label = new CSS2DObject(labelDiv)
    this.cmeGroup.add(cap, ring, axis, label)
    return { cme: c, cap, ring, axis, label, labelDiv, text: '' }
  }

  private removeCme(it: CmeItem): void {
    for (const o of [it.cap, it.ring, it.axis]) {
      o.removeFromParent()
      o.geometry.dispose()
      ;(o.material as THREE.Material).dispose()
    }
    it.label.removeFromParent()
    it.labelDiv.remove()
  }

  // ---------- each frame ----------

  /**
   * `earthPos`: the Earth's heliocentric position (AU, ecliptic) at the scene's date, which decides which face of the Sun the
   * picture shows. `camLocal`: the camera in solar radii from the Sun's centre.
   */
  update(cam: THREE.PerspectiveCamera, earthPos: Vec3, sceneMs: number, relevance = 1): void {
    const f = (this.frame = sunFrame(earthPos))
    const camLocal = this.tmp.copy(cam.position).sub(this.group.getWorldPosition(this.tmp2)).divideScalar(this.radiusAU)
    const dist = camLocal.length()

    if (this.disc.visible) {
      this.discU.uRight.value.set(...f.right)
      this.discU.uUp.value.set(...f.up)
      this.discU.uEarth.value.set(...f.earth)
      this.discU.uFrac.value = discFraction(f.distAU, 2.6, 512)
      this.discU.uFar.value = this.surfaceKind === 'magnetogram' ? 0.35 : 0.45
    }

    if (this.c2.visible || this.c3.visible) {
      // turn the sheets to face the camera, and rotate the picture so solar north is where it would appear from here
      const right = this.tmp.set(1, 0, 0).applyQuaternion(cam.quaternion)
      const up = this.tmp2.set(0, 1, 0).applyQuaternion(cam.quaternion)
      const nx = f.north[0] * right.x + f.north[1] * right.y + f.north[2] * right.z
      const ny = f.north[0] * up.x + f.north[1] * up.y + f.north[2] * up.z
      const angle = Math.atan2(nx, ny)
      this.q.copy(cam.quaternion)
      this.c2.quaternion.copy(this.q)
      this.c3.quaternion.copy(this.q)
      this.coronaU.c2.uAngle.value = angle
      this.coronaU.c3.uAngle.value = angle
      // a sheet only makes sense from outside its own field: fade it out as the camera comes inside it
      this.coronaU.c2.uAlpha.value = relevance * smooth(3.5, 10, dist)
      this.coronaU.c3.uAlpha.value = relevance * smooth(9, 30, dist)
    }

    // CMEs
    if (this.flags.cmes) {
      for (const it of this.cmeItems.values()) {
        const c = it.cme
        const r = cmeFront(c, sceneMs)
        const show = cmeVisible(c, sceneMs) && sceneMs >= c.t215 - 86_400_000
        it.cap.visible = it.ring.visible = it.axis.visible = it.label.visible = show
        if (!show) continue
        const dir = heeqToScene(f, c.lat, c.lon)
        this.tmp.set(...dir)
        this.q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.tmp)
        for (const o of [it.cap, it.ring, it.axis]) {
          o.quaternion.copy(this.q)
          o.scale.setScalar(r)
        }
        // fade the bubble in as it leaves the Sun and out as it gets far; very close to it, thin it so it does not fill the screen
        const fade = smooth(3, 6, r) * (1 - smooth(150, 300, r)) * relevance
        ;(it.cap.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0.9 * fade
        ;(it.ring.material as THREE.LineBasicMaterial).opacity = 0.9 * fade
        ;(it.axis.material as THREE.LineBasicMaterial).opacity = 0.5 * fade
        it.label.position.set(dir[0] * r, dir[1] * r, dir[2] * r)
        const text = `CME ${Math.round(c.speed)} km/s${c.earth_directed && c.arrival ? ` · Earth ${relativeTime(c.arrival, sceneMs)}` : ''}`
        if (text !== it.text) {
          it.text = text
          it.labelDiv.textContent = text
        }
        // labels only when the front is somewhere you can read them
        const dCam = Math.hypot(camLocal.x - dir[0] * r, camLocal.y - dir[1] * r, camLocal.z - dir[2] * r)
        it.label.visible = fade > 0.15 && dCam < Math.max(60, r * 5)
      }
    }

    // sunspot groups
    if (this.flags.spots) {
      const near = dist < 90
      for (const s of this.spotItems) {
        const lon = regionLon(s.region, sceneMs)
        const dir = heeqToScene(f, s.region.lat, lon)
        s.label.position.set(dir[0] * 1.012, dir[1] * 1.012, dir[2] * 1.012)
        // only groups on the side facing the camera, and only when the Sun is big enough to read them
        const facing = dir[0] * camLocal.x + dir[1] * camLocal.y + dir[2] * camLocal.z > 1
        s.label.visible = near && facing && facesEarth(lon) && relevance > 0.2
      }
    }

    // flares: a glow on the region they came from, rising to the peak then fading over a few hours
    if (this.flags.flares) {
      for (const it of this.flareItems) {
        const fl = it.flare
        const peak = Math.max(fl.peak, fl.begin + 60_000)
        const lon = regionLon(it.region, sceneMs)
        const dir = heeqToScene(f, it.region.lat, lon)
        it.sprite.position.set(dir[0] * 1.02, dir[1] * 1.02, dir[2] * 1.02)
        const alpha = Math.max(0, Math.min(smooth(fl.begin, peak, sceneMs), 1 - smooth(peak, peak + FLARE_FADE_MS, sceneMs)))
        const pulse = 0.85 + 0.15 * Math.sin(sceneMs / 400)
        it.sprite.scale.setScalar(0.06 + 0.04 * Math.min(1, flareFlux(fl.class) / 1e-4))
        ;(it.sprite.material as THREE.SpriteMaterial).opacity = alpha * pulse
        it.sprite.visible = facesEarth(lon) && alpha > 0.02
      }
    }
  }

  /** What the panel says about a region: its current heliographic position, in words. */
  static regionWords(r: Region, sceneMs: number): string {
    const lon = regionLon(r, sceneMs)
    const ns = r.lat >= 0 ? 'N' : 'S'
    const ew = lon >= 0 ? 'W' : 'E'
    return `AR${r.number}: ${ns}${Math.abs(Math.round(r.lat))}${ew}${Math.abs(Math.round(lon))}${r.spot_class ? `, ${r.spot_class}` : ''}${r.mag_class ? ` / magnetic ${r.mag_class}` : ''}`
  }

  getFrame(): SunFrame | null {
    return this.frame
  }

  /** The CME whose front point is nearest the given screen point (within ~14px), or null. Ignores CMEs that aren't currently shown. */
  pick(px: number, py: number, width: number, height: number, camera: THREE.PerspectiveCamera): Cme | null {
    if (!this.cmeGroup.visible) return null
    let best: { cme: Cme; d: number } | null = null
    for (const it of this.cmeItems.values()) {
      if (!it.cap.visible) continue
      it.label.getWorldPosition(this.tmp).project(camera)
      if (this.tmp.z > 1 || this.tmp.z < -1) continue
      const sx = ((this.tmp.x + 1) / 2) * width
      const sy = ((1 - this.tmp.y) / 2) * height
      const d = Math.hypot(sx - px, sy - py)
      if (d > 14 || (best && d >= best.d)) continue
      best = { cme: it.cme, d }
    }
    return best?.cme ?? null
  }

  /** The flare whose marker is nearest the given screen point (within ~16px), or null. Ignores flares with no visible marker. */
  pickFlare(px: number, py: number, width: number, height: number, camera: THREE.PerspectiveCamera): Flare | null {
    if (!this.flareGroup.visible) return null
    let best: { flare: Flare; d: number } | null = null
    for (const it of this.flareItems) {
      if (!it.sprite.visible) continue
      it.sprite.getWorldPosition(this.tmp).project(camera)
      if (this.tmp.z > 1 || this.tmp.z < -1) continue
      const sx = ((this.tmp.x + 1) / 2) * width
      const sy = ((1 - this.tmp.y) / 2) * height
      const d = Math.hypot(sx - px, sy - py)
      if (d > 16 || (best && d >= best.d)) continue
      best = { flare: it.flare, d }
    }
    return best?.flare ?? null
  }

  dispose(): void {
    for (const it of this.cmeItems.values()) this.removeCme(it)
    this.cmeItems.clear()
    for (const f of this.flareItems) {
      f.sprite.removeFromParent()
      ;(f.sprite.material as THREE.SpriteMaterial).dispose()
    }
    this.flareItems = []
    for (const s of this.spotItems) {
      s.label.removeFromParent()
      s.div.remove()
    }
    this.spotItems = []
    for (const t of Object.values(this.textures)) t?.dispose()
    for (const m of [this.disc, this.c2, this.c3]) {
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
    }
    this.group.removeFromParent()
  }
}
