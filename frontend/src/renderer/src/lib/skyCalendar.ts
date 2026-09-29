// Put all the event sources together for a place and a range, score them, and sort them. Pure apart from the optional yield
// between stages (so a screen stays responsive while a year is computed).

import type { Place } from './skyTonight'
import type { SkyEvent } from './eventTypes'
import { eclipseEvents, moonEvents, moonPlanetEvents, planetEvents, planetPairEvents, seasonEvents, showerEvents } from './eventsSky'
import { occultationEvents } from './eventsOccult'
import { asteroidEvents, cometEvents, type AsteroidPass, type CometElements } from './eventsSmall'
import { passEvents, spaceEvents, type KpForecastRow } from './eventsSpace'
import { scoreAll, type Outlook } from './eventScore'
import type { Cme } from './sun'
import type { SatPass } from './satellites'

export interface CalendarInputs {
  comets: CometElements[] | null
  asteroids: AsteroidPass[] | null
  kp: KpForecastRow[] | null
  cmes: Cme[] | null
  enlilRows: number[][] | null
  passes: { name: string; norad: number; passes: SatPass[] }[]
}

export const NO_INPUTS: CalendarInputs = { comets: null, asteroids: null, kp: null, cmes: null, enlilRows: null, passes: [] }

/** What to skip when only a few days are wanted (the reminders check): the year-long searches. */
export interface CalendarOptions {
  /** include the searches that take the longest (occultations, planet pairs, Moon-planet passes) */
  heavy: boolean
  onStage?: (stage: string) => void
  /** awaited between stages; give the browser a chance to paint */
  yieldNow?: () => Promise<void>
}

/** Every event from `fromMs` to `toMs` for the place, unscored, sorted by time. */
export async function computeEvents(place: Place, fromMs: number, toMs: number, inputs: CalendarInputs, opts: CalendarOptions = { heavy: true }): Promise<SkyEvent[]> {
  const out: SkyEvent[] = []
  const stage = async (name: string, fn: () => SkyEvent[]): Promise<void> => {
    opts.onStage?.(name)
    if (opts.yieldNow) await opts.yieldNow()
    try {
      out.push(...fn())
    } catch (e) {
      console.warn(`events: ${name} failed`, e)
    }
  }
  await stage('the Moon', () => moonEvents(place, fromMs, toMs))
  await stage('planets', () => planetEvents(place, fromMs, toMs))
  await stage('meteor showers', () => showerEvents(place, fromMs, toMs))
  await stage('eclipses', () => eclipseEvents(place, fromMs, toMs))
  await stage('seasons', () => seasonEvents(place, fromMs, toMs))
  if (opts.heavy) {
    await stage('the Moon and the planets', () => moonPlanetEvents(place, fromMs, toMs))
    await stage('planets close together', () => planetPairEvents(place, fromMs, toMs))
    await stage('occultations', () => occultationEvents(place, fromMs, toMs))
  }
  if (inputs.comets) await stage('comets', () => cometEvents(place, inputs.comets!, fromMs, toMs))
  if (inputs.asteroids) await stage('asteroids', () => asteroidEvents(inputs.asteroids!, fromMs, toMs))
  await stage('space weather', () => spaceEvents(place, { kp: inputs.kp, cmes: inputs.cmes, enlilRows: inputs.enlilRows }, Date.now()).filter((e) => e.peakMs >= fromMs && e.peakMs <= toMs))
  for (const p of inputs.passes) await stage(`${p.name} passes`, () => passEvents(p.name, p.passes, fromMs, toMs, p.norad))
  // the same event can come from two sources (a CME from the space list and the wind panel): keep the first
  const seen = new Set<string>()
  return out.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).sort((a, b) => a.peakMs - b.peakMs)
}

export const scoreEvents = scoreAll

/** The most interesting events first: by priority, then by how good they are to see, then by date. */
export function highlights(events: SkyEvent[], nowMs: number, count: number): SkyEvent[] {
  return events
    .filter((e) => e.peakMs >= nowMs && e.visible !== 'no' && e.kind !== 'moon' && e.kind !== 'season')
    .sort((a, b) => a.priority - b.priority || a.peakMs - b.peakMs)
    .slice(0, count)
    .sort((a, b) => a.peakMs - b.peakMs)
}
