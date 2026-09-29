// The aurora on the 3D Earth, from NOAA's OVATION aurora grid (percent chance at every degree of longitude and latitude).
//
// Two layers share that grid. From a distance, a glow shell just above the atmosphere: each point's colour and brightness
// come from the grid (green, with pink and violet in the strong parts), with a slow shimmer. Close to a pole, standing
// curtains: a ribbon that follows the strongest part of the oval around each pole, rising from about 95 km to 250 km, with
// vertical rays that move. Both are dimmed where the Sun is up (aurora cannot be seen in daylight) rather than removed,
// so the whole oval is always visible as a ghost.

import * as THREE from 'three'
import { chanceAt, type AuroraGrid } from '@renderer/lib/aurora'

const DEG = Math.PI / 180
const EARTH_KM = 6371
const CURTAIN_STEPS = 720 // half a degree of longitude each
const CURTAIN_BOTTOM = 1 + 95 / EARTH_KM
const CURTAIN_TOP = 1 + 250 / EARTH_KM
/** the aurora's usual latitudes: the oval is searched for between these */
const BAND: [number, number] = [45, 88]

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Shared by both layers: value noise for the shimmer and the rays. */
const NOISE = `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }`

export class AuroraLayer {
  private readonly parent: THREE.Object3D
  private readonly texture: THREE.DataTexture
  private readonly grid: AuroraGrid
  private readonly uniforms: {
    uGrid: { value: THREE.DataTexture }
    uTime: { value: number }
    uGlow: { value: number }
    uCurtain: { value: number }
    uSun: { value: THREE.Vector3 }
  }
  readonly glow: THREE.Mesh
  private curtains: THREE.Mesh | null = null
  visible = true

  constructor(parent: THREE.Object3D, grid: AuroraGrid, sunWorld: { value: THREE.Vector3 }) {
    this.parent = parent
    this.grid = grid
    this.texture = this.makeTexture(grid)
    this.uniforms = { uGrid: { value: this.texture }, uTime: { value: 0 }, uGlow: { value: 0 }, uCurtain: { value: 0 }, uSun: sunWorld }

    const geo = new THREE.SphereGeometry(1.011, 128, 64)
    geo.rotateX(Math.PI / 2) // poles along +z, like the Earth's own globe
    this.glow = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        // double-sided: standing on the ground puts the camera inside this shell, looking up at its underside
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: this.uniforms,
        vertexShader: `
          #include <common>
          #include <logdepthbuf_pars_vertex>
          varying vec3 vDir;
          varying vec3 vNW;
          void main() {
            vDir = normalize(position);
            vNW = normalize(mat3(modelMatrix) * position);
            gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
            #include <logdepthbuf_vertex>
          }`,
        fragmentShader: `
          #include <common>
          #include <logdepthbuf_pars_fragment>
          uniform sampler2D uGrid;
          uniform float uTime;
          uniform float uGlow;
          uniform vec3 uSun;
          varying vec3 vDir;
          varying vec3 vNW;
          ${NOISE}
          void main() {
            #include <logdepthbuf_fragment>
            vec3 d = normalize(vDir);
            float lon = atan(d.y, d.x);
            float lat = asin(clamp(d.z, -1.0, 1.0));
            float u = fract(lon / 6.28318530718);
            float v = (lat * 57.2957795 + 90.5) / 181.0;
            float chance = texture2D(uGrid, vec2(u, v)).r * 255.0;
            float t = clamp(chance / 45.0, 0.0, 1.0);
            // slow shimmer: two scales of noise drifting past each other
            float n1 = vnoise(vec2(lon * 60.0 + uTime * 0.35, lat * 45.0));
            float n2 = vnoise(vec2(lon * 150.0 - uTime * 0.6, lat * 110.0 + uTime * 0.25));
            float shimmer = 0.5 + 0.95 * n1 * (0.5 + n2) + 0.15 * sin(uTime * 1.1 + lon * 25.0);
            float strength = smoothstep(0.03, 0.55, t) * shimmer;
            vec3 col = mix(vec3(0.10, 1.00, 0.45), vec3(0.30, 1.00, 0.80), n1);
            col = mix(col, vec3(0.95, 0.30, 0.80), smoothstep(0.70, 1.0, t) * 0.65);
            float sunlit = smoothstep(-0.10, 0.30, dot(normalize(vNW), normalize(uSun)));
            float dim = mix(1.0, 0.13, sunlit); // in daylight the oval is only a faint ghost
            gl_FragColor = vec4(col, strength * 0.85 * dim * uGlow);
          }`
      })
    )
    this.glow.renderOrder = 5
    this.glow.frustumCulled = false
    parent.add(this.glow)
    this.buildCurtains(grid)
  }

  private makeTexture(g: AuroraGrid): THREE.DataTexture {
    const t = new THREE.DataTexture(g.data.slice(), g.width, g.height, THREE.RedFormat, THREE.UnsignedByteType)
    t.magFilter = THREE.LinearFilter
    t.minFilter = THREE.LinearFilter
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.ClampToEdgeWrapping
    t.generateMipmaps = false
    t.unpackAlignment = 1
    t.needsUpdate = true
    return t
  }

  /** New data from NOAA (every few minutes): the glow reads the new grid at once and the curtains are rebuilt along the new oval. */
  setGrid(g: AuroraGrid): void {
    ;(this.texture.image as { data: Uint8Array }).data.set(g.data)
    this.texture.needsUpdate = true
    this.buildCurtains(g)
  }

  /**
   * The curtains: for each half degree of longitude around each pole, the latitude where the chance is greatest (smoothed
   * against its neighbours so the ribbon does not jump about) and a wall of light standing there.
   */
  private buildCurtains(g: AuroraGrid): void {
    if (this.curtains) {
      this.curtains.removeFromParent()
      this.curtains.geometry.dispose()
      ;(this.curtains.material as THREE.Material).dispose()
      this.curtains = null
    }
    const positions: number[] = []
    const aU: number[] = []
    const aV: number[] = []
    const aI: number[] = []
    const index: number[] = []
    for (const sign of [1, -1]) {
      const lats = new Float32Array(CURTAIN_STEPS)
      const vals = new Float32Array(CURTAIN_STEPS)
      for (let i = 0; i < CURTAIN_STEPS; i++) {
        const lon = (i / CURTAIN_STEPS) * 360
        let best = 0
        let bestLat = sign * 67
        for (let a = BAND[0]; a <= BAND[1]; a += 0.5) {
          const c = chanceAt(g, sign * a, lon)
          if (c > best) {
            best = c
            bestLat = sign * a
          }
        }
        lats[i] = bestLat
        vals[i] = best
      }
      // smooth the latitude along the ring (a moving average, weighted by strength) and the strength a little
      const sl = new Float32Array(CURTAIN_STEPS)
      const sv = new Float32Array(CURTAIN_STEPS)
      for (let i = 0; i < CURTAIN_STEPS; i++) {
        let ws = 0
        let ls = 0
        let vs = 0
        for (let k = -6; k <= 6; k++) {
          const j = (i + k + CURTAIN_STEPS) % CURTAIN_STEPS
          const w = 1 + vals[j]
          ws += w
          ls += lats[j] * w
          vs += vals[j]
        }
        sl[i] = ls / ws
        sv[i] = vs / 13
      }
      const base = positions.length / 3
      for (let i = 0; i <= CURTAIN_STEPS; i++) {
        const k = i % CURTAIN_STEPS
        const lat = sl[k] * DEG
        const lon = (i / CURTAIN_STEPS) * 2 * Math.PI
        for (const [r, v] of [[CURTAIN_BOTTOM, 0], [CURTAIN_TOP, 1]] as const) {
          positions.push(r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat))
          aU.push(lon)
          aV.push(v)
          aI.push(Math.min(1, sv[k] / 40))
        }
        if (i < CURTAIN_STEPS) {
          const a = base + i * 2
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
        }
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute('aU', new THREE.Float32BufferAttribute(aU, 1))
    geo.setAttribute('aV', new THREE.Float32BufferAttribute(aV, 1))
    geo.setAttribute('aI', new THREE.Float32BufferAttribute(aI, 1))
    geo.setIndex(index)
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: this.uniforms,
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aU;
        attribute float aV;
        attribute float aI;
        varying float vU;
        varying float vV;
        varying float vI;
        varying vec3 vNW;
        void main() {
          vU = aU;
          vV = aV;
          vI = aI;
          vNW = normalize(mat3(modelMatrix) * position);
          gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float uTime;
        uniform float uCurtain;
        uniform vec3 uSun;
        varying float vU;
        varying float vV;
        varying float vI;
        varying vec3 vNW;
        ${NOISE}
        void main() {
          #include <logdepthbuf_fragment>
          // vertical rays: brightness varies along the ribbon and drifts and pulses with time
          float r1 = vnoise(vec2(vU * 420.0 + uTime * 0.7, uTime * 0.15));
          float r2 = vnoise(vec2(vU * 95.0 - uTime * 0.4, 3.0));
          float rays = 0.15 + 0.95 * pow(r1, 1.6) * (0.5 + r2);
          // brightest at the bottom edge, thinning out upward
          float height = smoothstep(0.0, 0.06, vV) * pow(1.0 - vV, 1.35);
          vec3 col = mix(vec3(0.95, 0.30, 0.65), vec3(0.12, 1.0, 0.50), smoothstep(0.0, 0.22, vV)); // pink base, green body
          col = mix(col, vec3(0.45, 0.30, 1.0), smoothstep(0.55, 1.0, vV) * 0.7);                     // violet tops
          float sunlit = smoothstep(-0.10, 0.30, dot(normalize(vNW), normalize(uSun)));
          float dim = mix(1.0, 0.10, sunlit);
          float strength = smoothstep(0.08, 0.5, vI);
          gl_FragColor = vec4(col, rays * height * strength * dim * uCurtain);
        }`
    })
    this.curtains = new THREE.Mesh(geo, mat)
    this.curtains.frustumCulled = false
    this.curtains.renderOrder = 6
    this.parent.add(this.curtains)
  }

  /** `alt`: the camera's height above the surface in Earth radii. `relevance` (0..1): how much this real-time picture still means for the scene's date. Returns true when it is on screen and animating. */
  update(alt: number, relevance: number, nowMs = Date.now()): boolean {
    const on = this.visible && relevance > 0.02
    this.uniforms.uTime.value = (nowMs % 3_600_000) / 1000
    this.uniforms.uGlow.value = relevance
    // close to a pole the curtains take over: they fade in as you come within about a Earth radius and a half
    this.uniforms.uCurtain.value = relevance * (1 - smooth(0.35, 1.5, alt))
    this.glow.visible = on
    if (this.curtains) this.curtains.visible = on && this.uniforms.uCurtain.value > 0.02
    return on
  }

  dispose(): void {
    this.glow.removeFromParent()
    this.glow.geometry.dispose()
    ;(this.glow.material as THREE.Material).dispose()
    if (this.curtains) {
      this.curtains.removeFromParent()
      this.curtains.geometry.dispose()
      ;(this.curtains.material as THREE.Material).dispose()
    }
    this.texture.dispose()
  }
}
