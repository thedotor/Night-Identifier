import { readPageState, writePageState } from '@renderer/lib/pageState'

/**
 * Where the Solar System page and the Earth page were left, so coming back (from another page, or after closing the app) finds them as they were:
 * what the camera looked at, how far and from where, the date and the speed, and whether it was following your location, a satellite or a ship.
 * Kept in localStorage, one entry per page.
 */
export type SolarSlot = 'solar' | 'earth'

export interface SolarSession {
  focus: string
  distance: number
  direction: [number, number, number]
  ms: number
  speedIdx: number
  reverse: boolean
  playing: boolean
  /** the camera was following your location */
  homeFollow?: boolean
  /** the satellite that was picked (NORAD number), and whether the camera was following it */
  sat?: number | null
  satFollowing?: boolean
  /** the ship the camera was following (MMSI) */
  ship?: number | null
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

export const readSolarSession = (slot: SolarSlot): SolarSession | null => {
  const s = readPageState<Partial<SolarSession> | null>('3d', slot, null)
  if (!s || typeof s.focus !== 'string' || !finite(s.distance) || s.distance <= 0 || !finite(s.ms) || !finite(s.speedIdx)) return null
  const d = s.direction
  if (!Array.isArray(d) || d.length !== 3 || !d.every(finite)) return null
  return {
    focus: s.focus,
    distance: s.distance,
    direction: [d[0], d[1], d[2]],
    ms: s.ms,
    speedIdx: s.speedIdx,
    reverse: s.reverse === true,
    playing: s.playing !== false,
    homeFollow: s.homeFollow === true,
    sat: finite(s.sat) ? s.sat : null,
    satFollowing: s.satFollowing === true,
    ship: finite(s.ship) ? s.ship : null
  }
}

/** Keep this. With `view` null (the camera was in the middle of a flight, or in fly mode) only the clock is updated and the last good view stays. */
export const saveSolarSession = (slot: SolarSlot, view: Partial<SolarSession> | null, clock: Pick<SolarSession, 'ms' | 'speedIdx' | 'reverse' | 'playing'>): void => {
  const before = readSolarSession(slot)
  if (view && view.focus !== undefined && view.distance !== undefined && view.direction !== undefined) writePageState('3d', slot, { ...view, ...clock })
  else if (before) writePageState('3d', slot, { ...before, ...clock })
}
