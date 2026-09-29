import * as THREE from 'three'

/**
 * Sharp close-up imagery for the Earth: as the camera comes down, patches of the globe are replaced by real satellite
 * tiles (Sentinel-2 cloudless, web-map numbering) of the right detail for the distance, streamed through the backend.
 * The whole-Earth picture underneath stays until a tile has arrived, so nothing ever flashes or goes blank.
 * The patches are children of the globe (unit radius), so they turn with it.
 */

const FIRST_DRAWN = 7 // 91 px per degree: a little sharper than the 10240 px Blue Marble the globe already carries
const ROOT_Z = 3
const TILE_PX = 256
const GRID = 8 // segments along a patch
const MAX_LOADS = 8
const KEEP = 420 // textures kept in memory
const REFINE_PX = 420 // a tile is split once it would be drawn wider than this on screen
const RETRY_MS = 30_000
const FADE_S = 0.9 // a tile fades in (and out) over this long, so detail levels blend instead of popping

/** "Full daylight": how bright the ground is made where the Sun is not shining, and how far past the terminator that fades (shared with the globe under the tiles). */
export const FULL_DAYLIGHT_GAIN = '1.6'
export const FULL_DAYLIGHT_RAMP = '0.5'

interface Tile {
  key: string
  z: number
  x: number
  y: number
  state: 'idle' | 'loading' | 'ready' | 'failed'
  failedAt: number
  mesh: THREE.Mesh | null
  /** how much of the tile is showing, 0..1 */
  alpha: number
  used: number
  /** distance to the camera when last wanted (loading order) */
  dist: number
}

/** Latitude (radians) of a web-map row, where `t` is 0 at the top of the world and 1 at the bottom. */
const latOf = (t: number): number => Math.atan(Math.sinh(Math.PI * (1 - 2 * t)))

export class EarthDetail {
  readonly group = new THREE.Group()
  private readonly tiles = new Map<string, Tile>()
  private readonly loader = new THREE.TextureLoader()
  private readonly index: THREE.BufferAttribute
  private loading = 0
  private frame = 0
  private lastAt = 0
  private disposed = false
  private wanted = new Map<string, Tile>()
  /** something changed that needs another frame (a tile arrived) */
  changed = false
  maxZ = 13
  private readonly aniso: number

  constructor(
    parent: THREE.Object3D,
    private readonly sunView: { value: THREE.Vector3 },
    private readonly full: { value: number },
    private readonly urlFor: (z: number, x: number, y: number) => string,
    maxAniso: number
  ) {
    this.loader.setCrossOrigin('anonymous')
    this.aniso = Math.min(8, maxAniso)
    // No group render order: a group's order outranks every object's own, and would draw the tiles after (over) the aircraft, ships, clouds...
    parent.add(this.group)
    const idx: number[] = []
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        const a = j * (GRID + 1) + i
        const b = a + 1
        const c = a + GRID + 1
        const d = c + 1
        idx.push(a, c, b, b, c, d)
      }
    this.index = new THREE.BufferAttribute(new Uint16Array(idx), 1)
  }

  private get(z: number, x: number, y: number): Tile {
    const key = `${z}/${x}/${y}`
    let t = this.tiles.get(key)
    if (!t) {
      t = { key, z, x, y, state: 'idle', failedAt: 0, mesh: null, alpha: 0, used: 0, dist: 0 }
      this.tiles.set(key, t)
    }
    return t
  }

  /** The patch of globe for a tile, textured. Finer tiles sit a hair higher so they win where they overlap a coarser one. */
  private makeMesh(t: Tile, tex: THREE.Texture): THREE.Mesh {
    const n = 1 << t.z
    const r = 1.00002 + 1.4e-5 * t.z
    const pos = new Float32Array(3 * (GRID + 1) * (GRID + 1))
    const uv = new Float32Array(2 * (GRID + 1) * (GRID + 1))
    for (let j = 0; j <= GRID; j++) {
      const lat = latOf((t.y + j / GRID) / n)
      for (let i = 0; i <= GRID; i++) {
        const lon = (2 * Math.PI * (t.x + i / GRID)) / n - Math.PI
        const k = j * (GRID + 1) + i
        pos[3 * k] = r * Math.cos(lat) * Math.cos(lon)
        pos[3 * k + 1] = r * Math.cos(lat) * Math.sin(lon)
        pos[3 * k + 2] = r * Math.sin(lat)
        uv[2 * k] = i / GRID
        uv[2 * k + 1] = 1 - j / GRID
      }
    }
    const nrm = new Float32Array(pos.length)
    for (let k = 0; k < pos.length; k += 3) {
      const l = Math.hypot(pos[k], pos[k + 1], pos[k + 2])
      nrm[k] = pos[k] / l
      nrm[k + 1] = pos[k + 1] / l
      nrm[k + 2] = pos[k + 2] / l
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.setIndex(this.index)
    // No depth writing: tiles blend over one another (coarse first, see renderOrder below) while they fade, and stay under the aircraft, ships, etc.
    const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, transparent: true, opacity: 0, depthWrite: false })
    const sunView = this.sunView
    const full = this.full
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uSunView = sunView
      shader.uniforms.uFull = full
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uSunView;\nuniform float uFull;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          // the same sunrise and sunset colours as the globe under it, and gone on the night side, where the globe's city lights show (unless Full daylight is on)
          float tileSun = dot(normalize(vNormal), normalize(uSunView));
          float tileDusk = exp(-pow(tileSun / 0.11, 2.0)) * step(-0.02, tileSun) * (1.0 - uFull);
          diffuseColor.rgb *= mix(vec3(1.0), vec3(1.35, 0.66, 0.38), tileDusk * 0.75);
          diffuseColor.a *= max(smoothstep(-0.10, 0.06, tileSun), uFull); // (in full daylight the night side has its close-up too)`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          totalEmissiveRadiance += diffuseColor.rgb * ${FULL_DAYLIGHT_GAIN} * uFull * (1.0 - smoothstep(0.0, ${FULL_DAYLIGHT_RAMP}, tileSun));`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          float tileWater = clamp((diffuseColor.b - max(diffuseColor.r, diffuseColor.g) * 1.12) * 7.0, 0.0, 1.0);
          roughnessFactor = mix(roughnessFactor, 0.30, tileWater);`
        )
    }
    m.customProgramCacheKey = () => 'earth-detail-tile'
    const mesh = new THREE.Mesh(g, m)
    mesh.frustumCulled = false
    mesh.renderOrder = 2 + t.z * 0.01 // finer tiles after coarser ones, all before the layers on top (3 and up)
    mesh.visible = false
    this.group.add(mesh)
    return mesh
  }

  private request(t: Tile): void {
    if (t.state !== 'idle' && !(t.state === 'failed' && performance.now() - t.failedAt > RETRY_MS)) return
    t.state = 'idle'
    this.wanted.set(t.key, t)
  }

  private startLoads(): void {
    if (this.loading >= MAX_LOADS || this.wanted.size === 0) return
    // coarse first (it is the fallback for the fine ones), then nearest first
    const queue = [...this.wanted.values()].filter((t) => t.state === 'idle').sort((a, b) => a.z - b.z || a.dist - b.dist)
    for (const t of queue) {
      if (this.loading >= MAX_LOADS) break
      t.state = 'loading'
      this.loading++
      this.loader.load(
        this.urlFor(t.z, t.x, t.y),
        (tex) => {
          this.loading--
          if (this.disposed) return tex.dispose()
          tex.colorSpace = THREE.SRGBColorSpace
          tex.anisotropy = this.aniso
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
          t.mesh = this.makeMesh(t, tex)
          t.state = 'ready'
          this.changed = true
        },
        undefined,
        () => {
          this.loading--
          t.state = 'failed'
          t.failedAt = performance.now()
        }
      )
    }
    this.wanted.clear()
  }

  /**
   * Choose the tiles for this view and show them. `camLocal` is the camera in the globe's own units (radius 1);
   * `world` and `view` take a globe point to camera space; `pxPerRad` is the screen's pixels per radian.
   */
  update(camLocal: THREE.Vector3, world: THREE.Matrix4, view: THREE.Matrix4, worldRadius: number, pxPerRad: number, tanX: number, tanY: number): void {
    this.frame++
    const camDist = camLocal.length()
    const alt = camDist - 1
    const active = alt < 0.6
    this.group.visible = active
    if (!active) return
    const camDir = camLocal.clone().divideScalar(camDist)
    const horizon = Math.acos(Math.min(1, 1 / camDist))
    const centre = new THREE.Vector3()
    const v = new THREE.Vector3()
    const drawn = new Set<Tile>()

    const visit = (z: number, x: number, y: number): boolean => {
      const n = 1 << z
      const lon = (2 * Math.PI * (x + 0.5)) / n - Math.PI
      const lat = latOf((y + 0.5) / n)
      const size = ((2 * Math.PI) / n) * Math.cos(lat)
      const rad = 0.75 * size
      centre.set(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat))
      if (centre.dot(camDir) < Math.cos(Math.min(Math.PI, horizon + rad))) return true // over the horizon
      v.copy(centre).applyMatrix4(world).applyMatrix4(view)
      const rw = rad * worldRadius
      if (v.z > rw) return true // behind the camera
      const front = -v.z
      if (front > rw && (Math.abs(v.x) - rw * 1.5 > front * tanX || Math.abs(v.y) - rw * 1.5 > front * tanY)) return true // off the side
      const d = Math.max(centre.distanceTo(camLocal) - size * 0.5, alt * 0.5, 1e-7)
      const refine = z < this.maxZ && (size / d) * pxPerRad > REFINE_PX
      let covered: boolean
      if (refine) {
        covered = true
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) if (!visit(z + 1, 2 * x + i, 2 * y + j)) covered = false
      } else {
        covered = z < FIRST_DRAWN // too far away for tiles to beat the globe's own picture
      }
      if (z < FIRST_DRAWN) return covered
      const t = this.get(z, x, y)
      t.used = this.frame
      t.dist = d
      if (covered && refine) return true
      if (t.state === 'ready') {
        drawn.add(t)
        return true
      }
      this.request(t)
      return covered && !refine
    }
    for (let x = 0; x < 1 << ROOT_Z; x++) for (let y = 0; y < 1 << ROOT_Z; y++) visit(ROOT_Z, x, y)

    this.fade(drawn)
    this.startLoads()
    this.trim()
  }

  /** The tiles above `t` (coarser, down to the first drawn level) that have a picture. */
  private ancestors(t: Tile): Tile[] {
    const out: Tile[] = []
    for (let z = t.z - 1; z >= FIRST_DRAWN; z--) {
      const up = this.tiles.get(`${z}/${t.x >> (t.z - z)}/${t.y >> (t.z - z)}`)
      if (up?.mesh) out.push(up)
    }
    return out
  }

  /**
   * Fade the chosen tiles in and the rest out. A coarse tile stays under the finer ones that replace it until they are fully in,
   * and when finer tiles are going away (zooming out) the coarse tile below is already there for them to fade over.
   */
  private fade(drawn: Set<Tile>): void {
    const now = performance.now()
    const step = Math.min(0.1, (now - this.lastAt) / 1000) / FADE_S
    this.lastAt = now
    const hold = new Set<Tile>()
    for (const t of this.tiles.values()) {
      if (!t.mesh || t.alpha <= 0) continue
      if (drawn.has(t)) {
        if (t.alpha < 1) for (const up of this.ancestors(t)) hold.add(up)
      } else {
        for (const up of this.ancestors(t)) if (drawn.has(up)) up.alpha = 1
      }
    }
    for (const t of this.tiles.values()) {
      if (!t.mesh) continue
      const before = t.alpha
      t.alpha = drawn.has(t) || hold.has(t) ? Math.min(1, before + step) : Math.max(0, before - step)
      if (t.alpha !== before) this.changed = true
      t.mesh.visible = t.alpha > 0
      ;(t.mesh.material as THREE.MeshStandardMaterial).opacity = t.alpha * t.alpha * (3 - 2 * t.alpha)
    }
  }

  private trim(): void {
    if (this.tiles.size <= KEEP) return
    const old = [...this.tiles.values()].filter((t) => t.state !== 'loading' && t.used < this.frame - 30).sort((a, b) => a.used - b.used)
    for (const t of old.slice(0, this.tiles.size - KEEP)) {
      if (t.mesh) {
        this.group.remove(t.mesh)
        t.mesh.geometry.dispose()
        const m = t.mesh.material as THREE.MeshStandardMaterial
        m.map?.dispose()
        m.dispose()
      }
      this.tiles.delete(t.key)
    }
  }

  get loadingCount(): number {
    return this.loading
  }

  dispose(): void {
    this.disposed = true
    for (const t of this.tiles.values()) {
      if (!t.mesh) continue
      t.mesh.geometry.dispose()
      const m = t.mesh.material as THREE.MeshStandardMaterial
      m.map?.dispose()
      m.dispose()
    }
    this.tiles.clear()
    this.group.removeFromParent()
  }
}
