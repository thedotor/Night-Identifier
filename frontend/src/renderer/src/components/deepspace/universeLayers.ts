// The scene layers beyond the solar system: the 3D star cloud, the Milky Way, exoplanet hosts and
// the real-sky backdrop, plus the curves that cross-fade them as the camera zooms out.
//
// One number drives all of it: the camera's distance from the centre of view, in AU, on a log
// scale. Each layer has a band of distances where it is fully visible and fades over a couple of
// decades either side, so scrolling out is a continuous zoom (planets -> stars -> galaxy -> Local Group).

import * as THREE from 'three'
import { AU_PER_KPC, AU_PER_LY, absoluteMagnitude, effectiveParallax, milkyWayPoints, parallaxToAU, positionAU, starColour, starVelocityAU } from '@renderer/lib/galaxyMath'
import type { Catalogue } from '@renderer/lib/skyCatalogue'

const DEG = Math.PI / 180

/** 0 below `a`, 1 above `b`, smooth in log10 distance in between. */
export function ramp(d: number, a: number, b: number): number {
  const t = (Math.log10(Math.max(d, 1e-30)) - Math.log10(a)) / (Math.log10(b) - Math.log10(a))
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)
}

export type Tier = 'solar' | 'star' | 'dso' | 'ext' | 'lg'

export interface ScaleAlphas {
  solar: number
  backdrop: number
  starCloud: number
  star: number
  dso: number
  ext: number
  lg: number
  milkyWay: number
  /** the soft kiloparsec-wide glow: only meaningful from far enough to see the disc whole */
  milkyWayGlow: number
}

/** How visible each layer is at a camera distance `d` (AU). */
export function scaleAlphas(d: number): ScaleAlphas {
  return {
    solar: 1 - ramp(d, 4e3, 4e4), // planets, moons, orbits, belts: out past ~0.6 light-year
    backdrop: 1 - ramp(d, 2e5, 3e6), // the directional star sphere, once parallax starts to matter
    starCloud: 1 - ramp(d, 3e8, 3e10), // the neighbourhood shrinks to a speck at galaxy scale
    star: ramp(d, 3e3, 3e4) * (1 - ramp(d, 2e8, 2e9)), // named stars
    dso: ramp(d, 3e4, 3e5) * (1 - ramp(d, 5e10, 5e11)), // nebulae and clusters in our galaxy
    ext: ramp(d, 2e9, 2e10), // galaxies beyond the Local Group
    lg: ramp(d, 1e8, 1e9) * (1 - ramp(d, 5e12, 5e13)), // Local Group galaxies and the Milky Way's label
    milkyWay: ramp(d, 3e7, 3e8) * (1 - ramp(d, 5e12, 5e13)),
    milkyWayGlow: ramp(d, 3e8, 3e9) * (1 - ramp(d, 5e12, 5e13))
  }
}

// ---------- textures ----------

export function ringTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.strokeStyle = '#fff'
  g.lineWidth = 6
  g.beginPath()
  g.arc(32, 32, 24, 0, Math.PI * 2)
  g.stroke()
  return new THREE.CanvasTexture(c)
}

// ---------- the real sky behind everything ----------

const BACKDROP_RADIUS = 9000

/** Directional stars from the app's catalogue, minus those that are drawn in 3D instead. */
export function buildBackdrop(cat: Catalogue, exclude: ReadonlySet<number>): THREE.Group {
  const group = new THREE.Group()
  const ce = Math.cos(23.4392911 * DEG)
  const se = Math.sin(23.4392911 * DEG)
  const tiers = [
    { max: 2.5, size: 3.4, opacity: 1, color: 0xffffff },
    { max: 4.5, size: 2.2, opacity: 0.85, color: 0xdfe8ff },
    { max: 6.3, size: 1.3, opacity: 0.55, color: 0xc0d0ff }
  ]
  let lo = -10
  for (const t of tiers) {
    const pts: number[] = []
    for (let i = 0; i < cat.count; i++) {
      if (cat.mag[i] <= lo || cat.mag[i] > t.max || exclude.has(i)) continue
      const ra = cat.ra[i] * DEG
      const dec = cat.dec[i] * DEG
      const x = Math.cos(dec) * Math.cos(ra)
      const y = Math.cos(dec) * Math.sin(ra)
      const z = Math.sin(dec)
      pts.push(x * BACKDROP_RADIUS, (y * ce + z * se) * BACKDROP_RADIUS, (-y * se + z * ce) * BACKDROP_RADIUS)
    }
    lo = t.max
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    const m = new THREE.PointsMaterial({ size: t.size, sizeAttenuation: false, color: t.color, transparent: true, opacity: t.opacity, depthWrite: false })
    m.userData.base = t.opacity
    const p = new THREE.Points(g, m)
    p.frustumCulled = false
    p.renderOrder = -10
    group.add(p)
  }
  return group
}

// ---------- Hipparcos stars in 3D ----------

const STAR_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aAbsMag;
attribute vec3 aColor;
attribute vec3 aVel;
uniform float uAlpha;
uniform float uPx;
uniform float uYears;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 wp = modelMatrix * vec4(position + aVel * uYears, 1.0);    // the star, moved by its proper motion
  float d = max(length(wp.xyz - cameraPosition), 1.0);            // AU
  float m = aAbsMag + 5.0 * log2(d / 2062648.06) * 0.30103;        // apparent magnitude from where the camera is
  float size = 4.2 * exp2(-0.42 * (m - 1.0));                      // brighter stars are bigger dots
  gl_PointSize = clamp(size, 0.0, 10.0) * uPx;
  vAlpha = uAlpha * clamp((8.6 - m) / 2.5, 0.0, 1.0) * clamp(size / 1.0, 0.0, 1.0);
  vColor = aColor;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`

const STAR_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vAlpha;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.0, r);
  a *= a;
  gl_FragColor = vec4(vColor, a * vAlpha);
  if (gl_FragColor.a < 0.01) discard;
}`

export interface StarCloud {
  points: THREE.Points
  material: THREE.ShaderMaterial
}

/** Positions (AU, ecliptic, at the Hipparcos epoch 1991.25) and velocities (AU/yr) for star rows of
 * [ra, dec, parallax_mas, vmag, b-v, cat, pmRA, pmDec]. */
export function starMotion(rows: number[][]): { base: Float64Array; vel: Float64Array } {
  const base = new Float64Array(3 * rows.length)
  const vel = new Float64Array(3 * rows.length)
  rows.forEach((r, i) => {
    const plx = effectiveParallax(r[2], r[8])
    base.set(positionAU(r[0], r[1], parallaxToAU(plx)), 3 * i)
    vel.set(starVelocityAU(r[0], r[1], plx, r[6] ?? 0, r[7] ?? 0), 3 * i)
  })
  return { base, vel }
}

/** Rows of [ra, dec, parallax_mas, vmag, b-v, ...]. Each star is a dot whose size follows its
 * apparent magnitude from wherever the camera is, so flying away from the Sun re-arranges the sky,
 * and which drifts by its proper motion as the clock runs (`uYears`, counted from epoch 1991.25). */
export function buildStarCloud(rows: number[][], pixelRatio: number): StarCloud {
  const n = rows.length
  const { base, vel } = starMotion(rows)
  const position = Float32Array.from(base)
  const velocity = Float32Array.from(vel)
  const absMag = new Float32Array(n)
  const colour = new Float32Array(3 * n)
  rows.forEach(([, , plx, vmag, bv, , , , ePlx], i) => {
    absMag[i] = absoluteMagnitude(vmag, effectiveParallax(plx, ePlx))
    colour.set(starColour(bv), 3 * i)
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(position, 3))
  g.setAttribute('aVel', new THREE.BufferAttribute(velocity, 3))
  g.setAttribute('aAbsMag', new THREE.BufferAttribute(absMag, 1))
  g.setAttribute('aColor', new THREE.BufferAttribute(colour, 3))
  const material = new THREE.ShaderMaterial({
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    uniforms: { uAlpha: { value: 1 }, uPx: { value: pixelRatio }, uYears: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  })
  const points = new THREE.Points(g, material)
  points.frustumCulled = false
  points.renderOrder = -9
  return { points, material }
}

// ---------- the Milky Way ----------

export interface MilkyWayCloud {
  /** both layers, to be shifted and shown together */
  points: THREE.Group
  /** the fine points */
  material: THREE.PointsMaterial
  /** the soft glow that makes the arms read as smooth light rather than sparse dots */
  diffuse: THREE.PointsMaterial
  glow: THREE.Texture
}

export const MILKY_WAY_OPACITY = 0.55
export const MILKY_WAY_GLOW_OPACITY = 0.07
const GLOW_KPC = 1.1 // width of each soft blob
const GLOW_EVERY = 30 // one soft blob per this many stars

export function buildMilkyWay(count = 220000): MilkyWayCloud {
  const mw = milkyWayPoints(count)
  const fine = new THREE.BufferGeometry()
  fine.setAttribute('position', new THREE.BufferAttribute(mw.positions, 3))
  fine.setAttribute('color', new THREE.BufferAttribute(mw.colours, 3))
  const material = new THREE.PointsMaterial({ size: 1.3, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: MILKY_WAY_OPACITY, depthWrite: false, blending: THREE.AdditiveBlending })
  const finePoints = new THREE.Points(fine, material)

  const n = Math.floor(count / GLOW_EVERY)
  const gp = new Float32Array(3 * n)
  const gc = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    gp.set(mw.positions.subarray(3 * i * GLOW_EVERY, 3 * i * GLOW_EVERY + 3), 3 * i)
    gc.set(mw.colours.subarray(3 * i * GLOW_EVERY, 3 * i * GLOW_EVERY + 3), 3 * i)
  }
  const soft = new THREE.BufferGeometry()
  soft.setAttribute('position', new THREE.BufferAttribute(gp, 3))
  soft.setAttribute('color', new THREE.BufferAttribute(gc, 3))
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g2 = c.getContext('2d')!
  const grad = g2.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g2.fillStyle = grad
  g2.fillRect(0, 0, 64, 64)
  const glow = new THREE.CanvasTexture(c)
  const diffuse = new THREE.PointsMaterial({ size: GLOW_KPC * AU_PER_KPC, sizeAttenuation: true, map: glow, vertexColors: true, transparent: true, opacity: MILKY_WAY_GLOW_OPACITY, depthWrite: false, blending: THREE.AdditiveBlending })
  const softPoints = new THREE.Points(soft, diffuse)

  const points = new THREE.Group()
  for (const p of [softPoints, finePoints]) {
    p.frustumCulled = false
    p.renderOrder = -8
    points.add(p)
  }
  return { points, material, diffuse, glow }
}

// ---------- exoplanet hosts ----------

export interface HostCloud {
  points: THREE.Points
  material: THREE.PointsMaterial
}

/** Rows of [ra, dec, distance_pc, planets, vmag, name]: each a ring around the star's place. */
export function buildHosts(rows: (number | string | null)[][], ring: THREE.Texture): HostCloud {
  const pos = new Float32Array(3 * rows.length)
  rows.forEach((r, i) => pos.set(positionAU(r[0] as number, r[1] as number, (r[2] as number) * 206_264.806), 3 * i))
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const material = new THREE.PointsMaterial({ size: 11, sizeAttenuation: false, map: ring, color: 0x5eead4, transparent: true, opacity: 0.85, depthWrite: false })
  const points = new THREE.Points(g, material)
  points.frustumCulled = false
  points.renderOrder = -7
  return { points, material }
}

// ---------- physical sizes for named stars ----------

const SOLAR_RADIUS_AU = 0.00465047

/** Radius (AU) of a star from its absolute magnitude and B-V colour (blackbody estimate). */
export function starRadiusAU(absMag: number, bv: number): number {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62))
  const lum = Math.pow(10, -0.4 * (absMag - 4.83))
  const r = Math.sqrt(lum) * Math.pow(5772 / t, 2)
  return Math.min(1000, Math.max(0.08, r)) * SOLAR_RADIUS_AU
}

/** Light-years for a distance in AU, for readouts. */
export const auToLy = (au: number): number => au / AU_PER_LY
