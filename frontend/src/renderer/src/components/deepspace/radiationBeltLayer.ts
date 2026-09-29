// The Van Allen radiation belts: two schematic, textbook-shaped shells (not a physical AE9/AP9 model) around the
// Earth, tilted to the real geomagnetic dipole axis (from the same IGRF coefficients the field-line layer already
// uses). The inner belt (trapped protons) is fairly static; the outer belt (trapped electrons) brightens and dims
// with NOAA's live GOES >=2 MeV electron flux, a standard proxy for how "charged up" it is.

import * as THREE from 'three'
import { coefficientsAt, geomagneticPole } from '@renderer/lib/geomag'

const DEG = Math.PI / 180
const UNIT_Z = new THREE.Vector3(0, 0, 1)

const BELT_VERT = `
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`
const BELT_FRAG = `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uMajor;
  uniform float uMinor;
  varying vec3 vPos;
  void main() {
    float ringR = length(vPos.xy);
    float d = length(vec2(ringR - uMajor, vPos.z));
    float fade = 1.0 - smoothstep(uMinor * 0.25, uMinor, d);
    gl_FragColor = vec4(uColor, uOpacity * fade);
  }`

function dipoleLocalDir(year: number): THREE.Vector3 {
  const pole = geomagneticPole(coefficientsAt(year))
  const lat = pole.latDeg * DEG
  const lon = pole.lonDeg * DEG
  return new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat))
}

function makeBelt(major: number, minor: number, color: string): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.TorusGeometry(major, minor, 24, 64),
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0 }, uMajor: { value: major }, uMinor: { value: minor } },
      vertexShader: BELT_VERT,
      fragmentShader: BELT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    })
  )
  mesh.renderOrder = 3
  mesh.visible = false
  mesh.frustumCulled = false
  return mesh
}

export class RadiationBeltLayer {
  readonly inner: THREE.Mesh
  readonly outer: THREE.Mesh
  private year = NaN
  private on = false

  constructor(earthMesh: THREE.Object3D) {
    this.inner = makeBelt(1.8, 0.7, '#ff9a5a')
    this.outer = makeBelt(6.5, 2.6, '#6ad0ff')
    earthMesh.add(this.inner, this.outer)
  }

  setVisible(on: boolean): void {
    this.on = on
    this.inner.visible = on
    this.outer.visible = on
  }

  /** `year`: decimal year, for the dipole tilt (changes extremely slowly - only recomputed when it changes). `electronFlux`: NOAA's live >=2 MeV flux at geostationary orbit (particles/cm2-s-sr), or null if unavailable. */
  update(year: number, electronFlux: number | null): void {
    if (!this.on) return
    if (year !== this.year) {
      this.year = year
      const q = new THREE.Quaternion().setFromUnitVectors(UNIT_Z, dipoleLocalDir(year))
      this.inner.quaternion.copy(q)
      this.outer.quaternion.copy(q)
    }
    ;(this.inner.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0.22
    const quiet = 1e4 // a typical quiet-time >=2 MeV flux
    const storm = 1e6 // a strongly enhanced outer belt
    const t = electronFlux == null || electronFlux <= 0 ? 0.3 : Math.min(1, Math.max(0, (Math.log10(electronFlux) - Math.log10(quiet)) / (Math.log10(storm) - Math.log10(quiet))))
    ;(this.outer.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0.12 + 0.35 * t
  }

  dispose(): void {
    for (const m of [this.inner, this.outer]) {
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
      m.removeFromParent()
    }
  }
}
