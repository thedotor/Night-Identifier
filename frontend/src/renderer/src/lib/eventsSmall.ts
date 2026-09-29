// Comets and asteroids for the calendar. Pure (astronomy-engine for the Earth and the sky maths).
//
// Comets: the position comes from the orbital elements (elliptic, parabolic and hyperbolic orbits), and the brightness from the
// catalogue's two numbers, m = M1 + 5 log10(distance from Earth) + K1 log10(distance from the Sun). Those are averages fitted to
// past observations: a comet can flare up by several magnitudes or fade or break apart, so a predicted magnitude is a guide only.

import * as Astronomy from 'astronomy-engine'
import type { Place } from './skyTonight'
import type { SkyEvent } from './eventTypes'
import { DAY, altAz, clockText, compass } from './eventsSky'

const DEG = Math.PI / 180
const K = 0.01720209895 // Gauss's constant, AU^1.5 / day / solar mass^0.5
const JD_UNIX = 2440587.5

export interface CometElements {
  name: string
  e: number
  q: number
  i: number
  om: number
  w: number
  tp: number
  m1: number
  k1: number
}

export interface AsteroidPass {
  name: string
  t: number
  ld: number
  v: number
  h: number | null
}

const jdOf = (ms: number): number => ms / DAY + JD_UNIX

/** Heliocentric position (ecliptic J2000, AU) of a body on a conic orbit, at a Julian date. Handles ellipses, parabolas and hyperbolas. */
export function conicPosition(el: { q: number; e: number; i: number; om: number; w: number; tp: number }, jd: number): [number, number, number] {
  const { q, e } = el
  const dt = jd - el.tp
  let x: number
  let y: number
  if (Math.abs(e - 1) < 1e-4) {
    // parabola (Barker's equation): D^3 + 3 D = W, D = tan(nu / 2)
    const W = (3 * K * dt) / (Math.SQRT2 * Math.pow(q, 1.5))
    const s = Math.sqrt(W * W + 4)
    const D = Math.cbrt((W + s) / 2) - Math.cbrt((s - W) / 2)
    const nu = 2 * Math.atan(D)
    const r = q * (1 + D * D)
    x = r * Math.cos(nu)
    y = r * Math.sin(nu)
  } else if (e < 1) {
    const a = q / (1 - e)
    const M = (K / Math.pow(a, 1.5)) * dt
    let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1)
    for (let n = 0; n < 60; n++) {
      const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
      E -= d
      if (Math.abs(d) < 1e-13) break
    }
    x = a * (Math.cos(E) - e)
    y = a * Math.sqrt(1 - e * e) * Math.sin(E)
  } else {
    const a = q / (1 - e) // negative
    const M = (K / Math.pow(-a, 1.5)) * dt
    // e sinh H - H = M is monotonic in H: bracket the root, then Newton with bisection as a safeguard
    let lo = -1
    let hi = 1
    const g = (H: number): number => e * Math.sinh(H) - H - M
    while (g(lo) > 0) lo *= 2
    while (g(hi) < 0) hi *= 2
    let H = 0.5 * (lo + hi)
    for (let n = 0; n < 200; n++) {
      const f = g(H)
      if (Math.abs(f) < 1e-13 * Math.max(1, Math.abs(M))) break
      if (f > 0) hi = H
      else lo = H
      const nH = H - f / (e * Math.cosh(H) - 1)
      H = nH > lo && nH < hi ? nH : 0.5 * (lo + hi)
    }
    x = a * (Math.cosh(H) - e)
    y = -a * Math.sqrt(e * e - 1) * Math.sinh(H)
  }
  // perifocal -> ecliptic
  const i = el.i * DEG
  const om = el.om * DEG
  const w = el.w * DEG
  const cw = Math.cos(w)
  const sw = Math.sin(w)
  const co = Math.cos(om)
  const so = Math.sin(om)
  const ci = Math.cos(i)
  const si = Math.sin(i)
  return [(co * cw - so * sw * ci) * x + (-co * sw - so * cw * ci) * y, (so * cw + co * sw * ci) * x + (-so * sw + co * cw * ci) * y, sw * si * x + cw * si * y]
}

const ECL_TO_EQJ = Astronomy.Rotation_ECL_EQJ()
const EQJ_TO_ECL = Astronomy.Rotation_EQJ_ECL()

function earthEcl(ms: number): [number, number, number] {
  const v = Astronomy.RotateVector(EQJ_TO_ECL, Astronomy.HelioVector(Astronomy.Body.Earth, new Date(ms)))
  return [v.x, v.y, v.z]
}

export interface CometState {
  ms: number
  /** predicted total magnitude */
  mag: number
  /** distance from the Sun and from the Earth, AU */
  r: number
  delta: number
  /** angle from the Sun as seen from Earth, degrees */
  elongDeg: number
  raH: number
  decDeg: number
}

export function cometState(c: CometElements, ms: number): CometState {
  const p = conicPosition(c, jdOf(ms))
  const e = earthEcl(ms)
  const g: [number, number, number] = [p[0] - e[0], p[1] - e[1], p[2] - e[2]]
  const r = Math.hypot(...p)
  const delta = Math.hypot(...g)
  const eqj = Astronomy.RotateVector(ECL_TO_EQJ, new Astronomy.Vector(g[0], g[1], g[2], Astronomy.MakeTime(new Date(ms))))
  const eq = Astronomy.EquatorFromVector(eqj)
  const sun: [number, number, number] = [-e[0], -e[1], -e[2]] // Earth -> Sun
  const cos = (g[0] * sun[0] + g[1] * sun[1] + g[2] * sun[2]) / (delta * Math.hypot(...sun))
  return { ms, mag: c.m1 + 5 * Math.log10(delta) + c.k1 * Math.log10(r), r, delta, elongDeg: Math.acos(Math.max(-1, Math.min(1, cos))) / DEG, raH: eq.ra, decDeg: eq.dec }
}

/**
 * Comets that are predicted to get brighter than `maxMag` while at least `minElong` degrees from the Sun within the range: one event each,
 * at the day of greatest brightness. Daily steps.
 */
export function cometEvents(place: Place, comets: CometElements[], fromMs: number, toMs: number, maxMag = 11, minElong = 25): SkyEvent[] {
  const out: SkyEvent[] = []
  for (const c of comets) {
    let best: CometState | null = null
    for (let t = fromMs; t <= toMs; t += DAY) {
      const s = cometState(c, t)
      if (!Number.isFinite(s.mag) || s.elongDeg < minElong) continue
      if (!best || s.mag < best.mag) best = s
    }
    if (!best || best.mag > maxMag) continue
    const maxAlt = 90 - Math.abs(place.latDeg - best.decDeg)
    const seen = maxAlt > 25 ? 'yes' : maxAlt > 8 ? 'partly' : 'no'
    const con = Astronomy.Constellation(best.raH, best.decDeg).name
    const how = best.mag <= 6 ? 'visible to the naked eye under dark skies' : best.mag <= 9 ? 'a binocular object' : 'needs a telescope'
    // find a good hour that night: highest while the Sun is well down
    const obs = new Astronomy.Observer(place.latDeg, place.lonDeg, 0)
    let look = { ms: best.ms, alt: -90, az: 0 }
    for (let t = best.ms - 12 * 3_600_000; t <= best.ms + 12 * 3_600_000; t += 30 * 60_000) {
      if (altAz(Astronomy.Body.Sun, t, obs).alt > -12) continue
      const h = Astronomy.Horizon(new Date(t), obs, best.raH, best.decDeg, 'normal')
      if (h.altitude > look.alt) look = { ms: t, alt: h.altitude, az: h.azimuth }
    }
    out.push({
      id: `comet:${c.name}`,
      kind: 'comet',
      title: `Comet ${c.name} at its brightest`,
      detail: `Predicted magnitude ${best.mag.toFixed(1)} around ${new Date(best.ms).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}: ${how}. It is ${best.r.toFixed(2)} AU from the Sun and ${best.delta.toFixed(2)} AU from the Earth, in ${con}, ${best.elongDeg.toFixed(0)}° from the Sun. ${
        seen === 'no' ? 'From your latitude it stays too low to see.' : look.alt > 5 ? `From your location it is best ${compass(look.az)} at ${Math.round(look.alt)}° around ${clockText(look.ms)}.` : 'It is not up in the dark hours that night from your location.'
      } Brightness is predicted from the comet's catalogue numbers: comets often flare or fade by several magnitudes, so treat it as a guide.`,
      startMs: best.ms - 7 * DAY,
      peakMs: best.ms,
      endMs: best.ms + 7 * DAY,
      priority: best.mag <= 6 ? 1 : best.mag <= 8.5 ? 2 : 3,
      visible: seen,
      altDeg: look.alt > -90 ? look.alt : undefined,
      azDeg: look.alt > -90 ? look.az : undefined,
      bestMs: look.alt > 5 ? look.ms : best.ms,
      deepSpace: { focus: 'sun', whenMs: best.ms },
      remindable: best.mag <= 8.5 && seen !== 'no'
    })
  }
  return out
}

/** Asteroids passing close: priority by distance (inside the Moon's orbit is rare), with the size from the absolute magnitude H. */
export function asteroidEvents(passes: AsteroidPass[], fromMs: number, toMs: number, maxLunar = 20): SkyEvent[] {
  return passes
    .filter((a) => a.t >= fromMs && a.t <= toMs && a.ld <= maxLunar)
    .map((a) => {
      // diameter (km) from H with an albedo of 0.14: D = 1329 / sqrt(p) * 10^(-H/5)
      const km = a.h != null ? (1329 / Math.sqrt(0.14)) * Math.pow(10, -a.h / 5) : null
      const size = km == null ? 'of unknown size' : km < 0.1 ? `about ${Math.max(1, Math.round(km * 1000))} m across` : `about ${km.toFixed(km < 1 ? 2 : 1)} km across`
      const priority: 1 | 2 | 3 = a.ld < 1 && (km ?? 0) > 0.03 ? 1 : a.ld < 5 && (km ?? 0) > 0.05 ? 2 : 3
      return {
        id: `asteroid:${a.name}:${Math.round(a.t / 3_600_000)}`,
        kind: 'asteroid' as const,
        title: `Asteroid ${a.name} passes ${a.ld < 1 ? 'inside the Moon\'s orbit' : `${a.ld.toFixed(1)} Moon distances away`}`,
        detail: `${a.name}, ${size}, passes the Earth at ${clockText(a.t)} at ${a.ld.toFixed(2)} times the Moon's distance (${Math.round(a.ld * 384_400).toLocaleString()} km), moving ${a.v.toFixed(1)} km/s. It is ${a.h != null && a.h > 22 ? 'far too faint to see without a large telescope' : 'faint: a telescope and a finder chart are needed'}. There is no danger: these orbits are known well enough to say it will miss.`,
        startMs: a.t - 6 * 3_600_000,
        peakMs: a.t,
        endMs: a.t + 6 * 3_600_000,
        priority,
        visible: 'no' as const,
        deepSpace: { focus: 'earth', whenMs: a.t },
        remindable: false
      } satisfies SkyEvent
    })
}
