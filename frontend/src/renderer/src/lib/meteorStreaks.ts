// Live-View meteor streaks: brief moving/fading lines radiating from a shower's real radiant, spawned
// at a rate approximating its ZHR while that shower is really active from this place. Purely client-side
// and stochastic -- this does not simulate individual real meteoroids, just a plausible rate and radiant.

import { activeShowers, obsOf, radiantAlt } from './eventsSky'
import type { Place } from './skyTonight'
import { add3, altAzToVec, cross, normalize, scale3, type Vec3 } from './skyMath'

const DEG = Math.PI / 180
/** How long one streak stays on screen, and its wall-clock fade curve. */
const LIFE_MS = 700
/** How far the streak starts from the radiant, and how long it runs, both degrees. */
const START_DEG = [2, 8] as const
const LEN_DEG = [4, 16] as const

export interface MeteorStreak {
  code: string
  /** unit vectors, the same frame altAzToVec/project use */
  tail: Vec3
  head: Vec3
  /** 0..1: quick brighten then fade over its short lifetime, already worked out for `nowMs` */
  alpha: number
}

interface LiveStreak {
  code: string
  bornMs: number
  tail: Vec3
  head: Vec3
}

/** A unit vector `angleRad` away from `r` along a random great circle through it. */
function offset(r: Vec3, tangentSeed: Vec3, angleRad: number): Vec3 {
  return normalize(add3(scale3(r, Math.cos(angleRad)), scale3(tangentSeed, Math.sin(angleRad))))
}

function randomTangent(r: Vec3): Vec3 {
  const arbitrary: Vec3 = Math.abs(r[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const t0 = normalize(cross(r, arbitrary))
  const t1 = cross(r, t0)
  const theta = Math.random() * Math.PI * 2
  return normalize(add3(scale3(t0, Math.cos(theta)), scale3(t1, Math.sin(theta))))
}

/** Spawns and ages streaks from whichever showers are really active right now, at roughly their real rate. */
export class MeteorStreakSpawner {
  private streaks: LiveStreak[] = []
  private lastMs = 0

  /** Advance to `nowMs` (spawning zero or more new streaks) and return the currently-live ones, each with
   * its brighten-then-fade alpha for this moment. */
  step(nowMs: number, place: Place | null): MeteorStreak[] {
    const dt = this.lastMs > 0 ? Math.max(0, Math.min(2, (nowMs - this.lastMs) / 1000)) : 0
    this.lastMs = nowMs
    this.streaks = this.streaks.filter((s) => nowMs - s.bornMs < LIFE_MS)
    if (place && dt > 0) {
      const obs = obsOf(place)
      for (const { shower, rateNow } of activeShowers(nowMs, place)) {
        if (rateNow <= 0) continue
        if (Math.random() >= (rateNow / 3600) * dt) continue
        const r = radiantAlt(shower, nowMs, obs)
        if (r.alt <= -5) continue // well below the horizon: nothing to draw
        this.spawn(shower.code, r.alt, r.az, place, nowMs)
      }
    }
    return this.streaks.map((s) => {
      const age = (nowMs - s.bornMs) / LIFE_MS
      const alpha = age < 0.15 ? age / 0.15 : 1 - (age - 0.15) / 0.85
      return { code: s.code, tail: s.tail, head: s.head, alpha: Math.max(0, Math.min(1, alpha)) }
    })
  }

  private spawn(code: string, altDeg: number, azDeg: number, place: Place, nowMs: number): void {
    // The radiant direction, in the same of-date equatorial frame the overlay projects everything
    // through (the same conversion the horizon and satellite/aircraft alt-az positions use).
    const r = altAzToVec(altDeg, azDeg, { latDeg: place.latDeg, lonDeg: place.lonDeg, date: new Date(nowMs) })
    const t = randomTangent(r)
    const start = (START_DEG[0] + Math.random() * (START_DEG[1] - START_DEG[0])) * DEG
    const len = (LEN_DEG[0] + Math.random() * (LEN_DEG[1] - LEN_DEG[0])) * DEG
    this.streaks.push({ code, bornMs: this.lastMs, tail: offset(r, t, start), head: offset(r, t, start + len) })
  }
}
