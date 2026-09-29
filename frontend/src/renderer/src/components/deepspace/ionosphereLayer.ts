// Global ionospheric TEC on the 3D Earth (CODE, via the backend): a translucent glow shell coloured by total
// electron content, using the same lon/lat -> uv reconstruction as the aurora layer (see auroraLayer.ts) so the
// two share an idiom. No curtains (TEC has no pole-hugging analogue to the auroral oval) and no per-frame
// animation: the underlying map only changes once an hour, so it is just rebuilt when new data arrives.

import * as THREE from 'three'
import type { IonosphereGrid } from '@renderer/lib/ionosphere'

function makeTexture(g: IonosphereGrid): THREE.DataTexture {
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

const VERT = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
    #include <logdepthbuf_vertex>
  }`
const FRAG = `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uGrid;
  uniform float uTecuScale;
  varying vec3 vDir;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 d = normalize(vDir);
    float lon = atan(d.y, d.x);
    float lat = asin(clamp(d.z, -1.0, 1.0));
    float u = fract(lon / 6.28318530718);
    float v = (lat * 57.2957795 + 87.5) / 175.0;
    float tecu = texture2D(uGrid, vec2(u, v)).r * 255.0 / uTecuScale;
    // a sequential blue (quiet) -> cyan -> yellow -> red (busy) scale, normalised against ~60 TECU as "very active"
    float t = clamp(tecu / 60.0, 0.0, 1.0);
    vec3 col = mix(vec3(0.10, 0.25, 0.85), vec3(0.15, 0.85, 0.85), smoothstep(0.0, 0.4, t));
    col = mix(col, vec3(0.95, 0.85, 0.15), smoothstep(0.35, 0.7, t));
    col = mix(col, vec3(0.95, 0.2, 0.15), smoothstep(0.65, 1.0, t));
    gl_FragColor = vec4(col, smoothstep(0.05, 0.3, t) * 0.5);
  }`

export class IonosphereLayer {
  readonly mesh: THREE.Mesh
  private texture: THREE.DataTexture | null = null

  constructor(parent: THREE.Object3D) {
    const geo = new THREE.SphereGeometry(1.008, 96, 48)
    geo.rotateX(Math.PI / 2) // poles along +z, like the Earth's own globe
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uGrid: { value: null as THREE.Texture | null }, uTecuScale: { value: 2 } },
        vertexShader: VERT,
        fragmentShader: FRAG
      })
    )
    this.mesh.visible = false
    this.mesh.renderOrder = 5
    this.mesh.frustumCulled = false
    parent.add(this.mesh)
  }

  setGrid(g: IonosphereGrid): void {
    this.texture?.dispose()
    this.texture = makeTexture(g)
    const mat = this.mesh.material as THREE.ShaderMaterial
    mat.uniforms.uGrid.value = this.texture
    mat.uniforms.uTecuScale.value = g.tecuScale
  }

  setVisible(on: boolean): void {
    this.mesh.visible = on && !!this.texture
  }

  dispose(): void {
    this.texture?.dispose()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.mesh.removeFromParent()
  }
}
