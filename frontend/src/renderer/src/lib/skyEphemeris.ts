// Sun, Moon and planet positions for the Sky Overlay, computed in the renderer so the
// overlay stays live as the observation time changes. Pure functions (no DOM), so they run
// under `node` for scripts/ephemeris.check.ts.
//
// Planets: JPL's approximate Keplerian elements for 1800-2050 (E.M. Standish, "Keplerian
// Elements for Approximate Positions of the Major Planets"): about an arcminute for most
// bodies, up to ~10 arcminutes for Jupiter and Saturn -- far finer than a photo can show. Moon: the Astronomical Almanac's low-precision series
// (about 0.3 degrees), plus a topocentric parallax correction because the Moon is close
// enough that the observer's place on Earth shifts it by up to a degree.

import * as S from './skyMath'

const DEG = Math.PI / 180
const OBLIQUITY_J2000 = 23.43928 * DEG
const MOON_RADIUS_ER = 0.2725
const SUN_RADIUS_DEG = 0.2666

export interface Body {
  id: string
  name: string
  kind: 'sun' | 'moon' | 'planet'
  vec: S.Vec3 // unit direction in the of-date equatorial frame the camera lives in
  mag: number // rough apparent magnitude, for symbol size
  radiusDeg: number // apparent angular radius
  color: string
  /** Moon only: fraction of the disc that is lit (0 new .. 1 full) */
  lit?: number
}

// [a, da, e, de, I, dI, L, dL, long.peri, d long.peri, long.node, d long.node]
// a in AU, angles in degrees; d* are rates per Julian century.
const ELEMENTS: Record<string, number[]> = {
  mercury: [0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.2503235, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
  venus: [0.72333566, 0.0000039, 0.00677672, -0.00004107, 3.39467605, -0.0007889, 181.9790995, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418],
  earth: [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0, 0],
  mars: [1.52371034, 0.00001847, 0.0933941, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343],
  jupiter: [5.202887, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106],
  saturn: [9.53667594, -0.0012506, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794],
  uranus: [19.18916464, -0.00196176, 0.04725744, -0.00004397, 0.77263783, -0.00242939, 313.23810451, 428.48202785, 170.9542763, 0.40805281, 74.01692503, 0.04240589],
  neptune: [30.06992276, 0.00026291, 0.00859048, 0.00005105, 1.77004347, 0.00035372, -55.12002969, 218.45945325, 44.96476227, -0.32241464, 131.78422574, -0.00508664]
}

const PLANETS: { id: string; name: string; mag: number; color: string }[] = [
  { id: 'mercury', name: 'Mercury', mag: 0, color: '#d1d5db' },
  { id: 'venus', name: 'Venus', mag: -4, color: '#fde68a' },
  { id: 'mars', name: 'Mars', mag: 0.5, color: '#fb7185' },
  { id: 'jupiter', name: 'Jupiter', mag: -2.2, color: '#fdba74' },
  { id: 'saturn', name: 'Saturn', mag: 0.7, color: '#fcd34d' },
  { id: 'uranus', name: 'Uranus', mag: 5.7, color: '#67e8f9' },
  { id: 'neptune', name: 'Neptune', mag: 7.8, color: '#93c5fd' }
]

const sind = (d: number): number => Math.sin(d * DEG)
const cosd = (d: number): number => Math.cos(d * DEG)

/** Heliocentric position in the J2000 ecliptic frame, AU. */
function heliocentric(name: string, T: number): S.Vec3 {
  const el = ELEMENTS[name]
  const a = el[0] + el[1] * T
  const e = el[2] + el[3] * T
  const I = (el[4] + el[5] * T) * DEG
  const L = el[6] + el[7] * T
  const peri = el[8] + el[9] * T
  const node = (el[10] + el[11] * T) * DEG

  let M = (((L - peri) % 360) + 540) % 360 - 180
  M *= DEG
  let E = M + e * Math.sin(M)
  for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))

  const xv = a * (Math.cos(E) - e)
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E)
  const w = peri * DEG - node
  const cw = Math.cos(w)
  const sw = Math.sin(w)
  const cO = Math.cos(node)
  const sO = Math.sin(node)
  const cI = Math.cos(I)
  const sI = Math.sin(I)
  return [
    (cw * cO - sw * sO * cI) * xv + (-sw * cO - cw * sO * cI) * yv,
    (cw * sO + sw * cO * cI) * xv + (-sw * sO + cw * cO * cI) * yv,
    sw * sI * xv + cw * sI * yv
  ]
}

const sub3 = (a: S.Vec3, b: S.Vec3): S.Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

/** J2000 ecliptic -> J2000 equatorial. */
function eclipticToEquatorial(v: S.Vec3, eps: number): S.Vec3 {
  const c = Math.cos(eps)
  const s = Math.sin(eps)
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]
}

/** Geocentric Moon, equatorial of date: unit direction and distance in Earth radii. */
function moonOfDate(T: number): { dir: S.Vec3; distER: number } {
  const lon =
    218.32 + 481267.881 * T +
    6.29 * sind(135.0 + 477198.87 * T) - 1.27 * sind(259.3 - 413335.36 * T) +
    0.66 * sind(235.7 + 890534.22 * T) + 0.21 * sind(269.9 + 954397.74 * T) -
    0.19 * sind(357.5 + 35999.05 * T) - 0.11 * sind(186.5 + 966404.03 * T)
  const lat =
    5.13 * sind(93.3 + 483202.02 * T) + 0.28 * sind(228.2 + 960400.89 * T) -
    0.28 * sind(318.3 + 6003.15 * T) - 0.17 * sind(217.6 - 407332.21 * T)
  const parallax =
    0.9508 + 0.0518 * cosd(135.0 + 477198.87 * T) + 0.0095 * cosd(259.3 - 413335.36 * T) +
    0.0078 * cosd(235.7 + 890534.22 * T) + 0.0028 * cosd(269.9 + 954397.74 * T)
  const eps = (23.439291 - 0.0130042 * T) * DEG
  const ecl: S.Vec3 = [cosd(lat) * cosd(lon), cosd(lat) * sind(lon), sind(lat)]
  return { dir: eclipticToEquatorial(ecl, eps), distER: 1 / sind(parallax) }
}

/**
 * The Sun, Moon and planets as seen at the given instant. Directions are in the of-date
 * equatorial frame (the camera's frame). Pass the observer to get the Moon where it appears
 * from that spot on Earth rather than from the Earth's centre.
 */
export function solarSystem(jd: number, obs: S.Observer | null = null): Body[] {
  const T = (jd - 2451545.0) / 36525
  const precess = S.precessionMatrix(jd)
  const toDate = (v: S.Vec3): S.Vec3 => S.normalize(S.applyMatrix(precess, v))

  const earth = heliocentric('earth', T)
  const bodies: Body[] = []

  const sunEq = eclipticToEquatorial(S.scale3(earth, -1), OBLIQUITY_J2000)
  const sunDist = S.norm(sunEq)
  const sunVec = toDate(sunEq)
  bodies.push({ id: 'sun', name: 'Sun', kind: 'sun', vec: sunVec, mag: -26.7, radiusDeg: SUN_RADIUS_DEG / sunDist, color: '#fde047' })

  const moon = moonOfDate(T)
  let moonVec = moon.dir
  if (obs) {
    // Topocentric: subtract the observer's offset from the Earth's centre (about one Earth radius, toward the zenith).
    const zenith = S.altAzToVec(90, 0, obs)
    moonVec = S.normalize(sub3(S.scale3(moon.dir, moon.distER), zenith))
  }
  const elong = S.angleBetween(moon.dir, sunVec)
  bodies.push({
    id: 'moon',
    name: 'Moon',
    kind: 'moon',
    vec: moonVec,
    mag: -12,
    radiusDeg: Math.asin(MOON_RADIUS_ER / moon.distER) / DEG,
    color: '#e5e7eb',
    lit: (1 - Math.cos(elong)) / 2
  })

  for (const p of PLANETS) {
    const geo = sub3(heliocentric(p.id, T), earth)
    bodies.push({ id: p.id, name: p.name, kind: 'planet', vec: toDate(eclipticToEquatorial(geo, OBLIQUITY_J2000)), mag: p.mag, radiusDeg: 0, color: p.color })
  }
  return bodies
}
