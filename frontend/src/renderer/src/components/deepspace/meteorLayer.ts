// Meteor shower radiants: a fixed point on the sky each active shower's meteors appear to stream from, with a
// handful of short decorative streaks (illustrative, not simulated meteors). Uses the exact RA/Dec -> scene-frame
// transform the star backdrop uses (see universeLayers.ts's buildBackdrop), at a radius just inside it, so radiants
// sit correctly among the real stars and share the same camera-following/fade behaviour.

import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import type { Shower } from '@renderer/lib/eventsSky'

const DEG = Math.PI / 180
const RADIANT_RADIUS = 8500
const CE = Math.cos(23.4392911 * DEG)
const SE = Math.sin(23.4392911 * DEG)

function radiantDir(s: Shower): THREE.Vector3 {
  const ra = s.raH * 15 * DEG
  const dec = s.decDeg * DEG
  const x = Math.cos(dec) * Math.cos(ra)
  const y = Math.cos(dec) * Math.sin(ra)
  const z = Math.sin(dec)
  return new THREE.Vector3(x, y * CE + z * SE, -y * SE + z * CE)
}

const labelStyle = (color: string): string => `padding-left:8px;font:11px/1.25 system-ui,sans-serif;color:${color};text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:none;user-select:none`

export interface RadiantHit {
  code: string
  name: string
  zhr: number
  rateNow: number
  note: string
}

interface RadiantItem {
  shower: Shower
  rateNow: number
  dir: THREE.Vector3
  label: CSS2DObject
  labelDiv: HTMLDivElement
}

const rand = (seed: number): number => {
  const x = Math.sin(seed) * 43758.5453
  return x - Math.floor(x)
}

export class MeteorRadiantLayer {
  readonly group = new THREE.Group()
  private readonly points: THREE.Points
  private readonly streaks: THREE.LineSegments
  private items: RadiantItem[] = []
  private readonly tmp = new THREE.Vector3()

  constructor() {
    this.points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, color: 0xffe9a8, transparent: true, opacity: 0, depthWrite: false }))
    this.points.frustumCulled = false
    this.points.renderOrder = -9
    this.streaks = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0, depthWrite: false }))
    this.streaks.frustumCulled = false
    this.streaks.renderOrder = -9
    this.group.add(this.points, this.streaks)
  }

  /** Rebuild the active-radiant list. Small and infrequent (about once a minute), so a full rebuild is cheap. */
  setActive(rows: { shower: Shower; rateNow: number }[]): void {
    const keep = new Set(rows.map((r) => r.shower.code))
    for (const it of this.items) {
      if (!keep.has(it.shower.code)) {
        it.label.removeFromParent()
        it.labelDiv.remove()
      }
    }
    const prev = new Map(this.items.map((it) => [it.shower.code, it]))
    this.items = rows.map(({ shower, rateNow }) => {
      const dir = radiantDir(shower)
      let it = prev.get(shower.code)
      if (!it) {
        const labelDiv = document.createElement('div')
        labelDiv.style.cssText = labelStyle('#ffe9a8')
        const label = new CSS2DObject(labelDiv)
        this.group.add(label)
        it = { shower, rateNow, dir, label, labelDiv }
      }
      it.dir = dir
      it.rateNow = rateNow
      it.label.position.copy(dir).multiplyScalar(RADIANT_RADIUS)
      const text = `☄ ${shower.name}${rateNow > 0 ? ` · ~${rateNow}/hr` : ''}`
      if (it.labelDiv.textContent !== text) it.labelDiv.textContent = text
      return it
    })
    this.rebuildGeometry()
  }

  private rebuildGeometry(): void {
    const pts: number[] = []
    const lines: number[] = []
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i]
      const p = this.tmp.clone().copy(it.dir).multiplyScalar(RADIANT_RADIUS)
      pts.push(p.x, p.y, p.z)
      const upRef = Math.abs(it.dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
      const a = new THREE.Vector3().crossVectors(it.dir, upRef).normalize()
      const b = new THREE.Vector3().crossVectors(it.dir, a).normalize()
      for (let k = 0; k < 8; k++) {
        const ang = rand(i * 97 + k) * Math.PI * 2
        const len = 40 + rand(i * 53 + k * 7) * 60
        const dx = Math.cos(ang)
        const dy = Math.sin(ang)
        const inner = p.clone().addScaledVector(a, dx * 6).addScaledVector(b, dy * 6)
        const outer = p.clone().addScaledVector(a, dx * len).addScaledVector(b, dy * len)
        lines.push(inner.x, inner.y, inner.z, outer.x, outer.y, outer.z)
      }
    }
    this.points.geometry.dispose()
    this.points.geometry = new THREE.BufferGeometry()
    this.points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    this.streaks.geometry.dispose()
    this.streaks.geometry = new THREE.BufferGeometry()
    this.streaks.geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3))
  }

  /** Recenter on the camera each frame (same trick as the star backdrop) and fade with it. */
  layout(camPos: THREE.Vector3, backdropAlpha: number): void {
    this.group.position.copy(camPos)
    this.group.visible = backdropAlpha > 0.01 && this.items.length > 0
    ;(this.points.material as THREE.PointsMaterial).opacity = backdropAlpha
    ;(this.streaks.material as THREE.LineBasicMaterial).opacity = 0.35 * backdropAlpha
    for (const it of this.items) it.label.visible = backdropAlpha > 0.3
  }

  pick(px: number, py: number, width: number, height: number, camera: THREE.PerspectiveCamera): RadiantHit | null {
    if (!this.group.visible) return null
    let best: { it: RadiantItem; d: number } | null = null
    for (const it of this.items) {
      const wp = it.label.getWorldPosition(this.tmp)
      const v = wp.clone().project(camera)
      if (v.z > 1 || v.z < -1) continue
      const sx = ((v.x + 1) / 2) * width
      const sy = ((1 - v.y) / 2) * height
      const d = Math.hypot(sx - px, sy - py)
      if (d > 16 || (best && d >= best.d)) continue
      best = { it, d }
    }
    return best ? { code: best.it.shower.code, name: best.it.shower.name, zhr: best.it.shower.zhr, rateNow: best.it.rateNow, note: best.it.shower.note } : null
  }

  dispose(): void {
    for (const it of this.items) {
      it.label.removeFromParent()
      it.labelDiv.remove()
    }
    this.items = []
    this.points.geometry.dispose()
    ;(this.points.material as THREE.Material).dispose()
    this.streaks.geometry.dispose()
    ;(this.streaks.material as THREE.Material).dispose()
    this.group.removeFromParent()
  }
}
