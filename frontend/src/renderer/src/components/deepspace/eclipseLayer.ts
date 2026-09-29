// The Moon's shadow on the Earth during a solar eclipse, or the Earth's shadow on the Moon during a lunar eclipse:
// a soft dark decal placed on the body's surface each frame while the eclipse is active, found by intersecting the
// shadow-casting body's line to the Sun with the shadowed body's sphere (the same ray-sphere-and-local-frame idiom
// already used for the live subsolar point). A schematic single shadow (umbra and penumbra blurred together), not
// a two-tone rendering, and sized by the eclipse's real obscuration rather than a modelled shadow cone.

import * as THREE from 'three'

let shadowTexture: THREE.CanvasTexture | null = null
function shadowDecalTexture(): THREE.CanvasTexture {
  if (shadowTexture) return shadowTexture
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(0,0,0,0.95)')
  g.addColorStop(0.55, 'rgba(0,0,0,0.65)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  shadowTexture = new THREE.CanvasTexture(canvas)
  return shadowTexture
}

function makeDecal(): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ map: shadowDecalTexture(), transparent: true, depthWrite: false, opacity: 0, side: THREE.DoubleSide }))
  mesh.visible = false
  mesh.renderOrder = 7
  mesh.frustumCulled = false
  return mesh
}

const UNIT_Z = new THREE.Vector3(0, 0, 1)

export class EclipseShadowLayer {
  readonly solar: THREE.Mesh
  readonly lunar: THREE.Mesh
  private readonly earthMesh: THREE.Object3D
  private readonly moonMesh: THREE.Object3D
  private readonly tmpOc = new THREE.Vector3()
  private readonly tmpHit = new THREE.Vector3()
  private readonly tmpDir = new THREE.Vector3()

  constructor(earthMesh: THREE.Object3D, moonMesh: THREE.Object3D) {
    this.earthMesh = earthMesh
    this.moonMesh = moonMesh
    this.solar = makeDecal()
    earthMesh.add(this.solar)
    this.lunar = makeDecal()
    moonMesh.add(this.lunar)
  }

  private place(decal: THREE.Mesh, mesh: THREE.Object3D, rayFrom: THREE.Vector3, rayDir: THREE.Vector3, sphereCentre: THREE.Vector3, sphereRadius: number, size: number, alpha: number): void {
    if (alpha <= 0.01 || size <= 0 || sphereRadius <= 0) {
      decal.visible = false
      return
    }
    const oc = this.tmpOc.copy(rayFrom).sub(sphereCentre)
    const b = 2 * oc.dot(rayDir)
    const c = oc.lengthSq() - sphereRadius * sphereRadius
    const disc = b * b - 4 * c
    if (disc < 0) {
      decal.visible = false
      return
    }
    const t = (-b - Math.sqrt(disc)) / 2
    if (t <= 0) {
      decal.visible = false
      return
    }
    const hitWorld = this.tmpHit.copy(rayFrom).addScaledVector(rayDir, t)
    const localDir = mesh.worldToLocal(hitWorld).normalize()
    decal.position.copy(localDir).multiplyScalar(1.003)
    decal.quaternion.setFromUnitVectors(UNIT_Z, localDir)
    decal.scale.setScalar(size)
    decal.visible = true
    ;(decal.material as THREE.MeshBasicMaterial).opacity = alpha
  }

  /** `size`: the decal's radius in Earth radii (scaled to the mesh's own unit sphere), from the eclipse's obscuration. */
  setSolar(sunPos: THREE.Vector3, moonPos: THREE.Vector3, earthPos: THREE.Vector3, earthRadiusAU: number, size: number, alpha: number): void {
    const rayDir = this.tmpDir.subVectors(moonPos, sunPos).normalize()
    this.place(this.solar, this.earthMesh, moonPos, rayDir, earthPos, earthRadiusAU, size, alpha)
  }

  setLunar(sunPos: THREE.Vector3, earthPos: THREE.Vector3, moonPos: THREE.Vector3, moonRadiusAU: number, size: number, alpha: number): void {
    const rayDir = this.tmpDir.subVectors(earthPos, sunPos).normalize()
    this.place(this.lunar, this.moonMesh, earthPos, rayDir, moonPos, moonRadiusAU, size, alpha)
  }

  hideSolar(): void {
    this.solar.visible = false
  }

  hideLunar(): void {
    this.lunar.visible = false
  }

  dispose(): void {
    this.solar.geometry.dispose()
    ;(this.solar.material as THREE.Material).dispose()
    this.solar.removeFromParent()
    this.lunar.geometry.dispose()
    ;(this.lunar.material as THREE.Material).dispose()
    this.lunar.removeFromParent()
  }
}
