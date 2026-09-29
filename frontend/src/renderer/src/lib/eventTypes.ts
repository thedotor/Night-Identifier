// The sky-events calendar: what an event is, and how kinds are named and coloured. No computation here.

export type EventKind = 'moon' | 'planet' | 'meteor' | 'eclipse' | 'occultation' | 'iss' | 'comet' | 'asteroid' | 'space' | 'season'

export interface KindInfo {
  kind: EventKind
  label: string
  icon: string
  color: string
  /** true when the event is a faint one that moonlight and light pollution spoil (the Moon term counts fully in the score) */
  faint: boolean
}

export const KINDS: KindInfo[] = [
  { kind: 'moon', label: 'Moon', icon: '🌙', color: '#e6e2c8', faint: false },
  { kind: 'planet', label: 'Planets', icon: '🪐', color: '#ffb455', faint: false },
  { kind: 'meteor', label: 'Meteor showers', icon: '☄️', color: '#8fd0ff', faint: true },
  { kind: 'eclipse', label: 'Eclipses', icon: '🌒', color: '#ff8f6a', faint: false },
  { kind: 'occultation', label: 'Occultations', icon: '🌓', color: '#c79bff', faint: false },
  { kind: 'iss', label: 'ISS and satellites', icon: '🛰️', color: '#ff6a6a', faint: false },
  { kind: 'comet', label: 'Comets', icon: '💫', color: '#9fe8ff', faint: true },
  { kind: 'asteroid', label: 'Asteroids', icon: '🪨', color: '#c2b59b', faint: false },
  { kind: 'space', label: 'Space weather and aurora', icon: '🌌', color: '#5fe0a0', faint: true },
  { kind: 'season', label: 'Seasons and milestones', icon: '🗓️', color: '#f0d060', faint: false }
]

export const KIND_BY_ID = new Map(KINDS.map((k) => [k.kind, k]))

export type Rating = 'good' | 'fair' | 'poor' | 'unknown'

export interface EventScore {
  /** 0..100, or null when the event is not one you look at (a Moon phase, a season) */
  score: number | null
  rating: Rating
  /** short reasons, best first: "dark sky", "Moon 85% and up", "cloud 70%" */
  reasons: string[]
  /** true when the weather forecast did not reach this far, so the cloud was left out */
  noForecast: boolean
}

export interface SkyEvent {
  /** stable across runs, so reminders and "seen" lists can refer to it */
  id: string
  kind: EventKind
  title: string
  /** what is happening, in plain words (one or two sentences) */
  detail: string
  /** when it starts, ms since 1970 (UTC) */
  startMs: number
  /** the moment it is at its best (peak, closest, greatest), ms; defaults to the start */
  peakMs: number
  endMs?: number
  /** 1 rare and remarkable, 2 notable, 3 routine: for sorting and the Coming-up highlights */
  priority: 1 | 2 | 3
  /** can it be seen from the place at all? 'no' events are still listed (with the reason) but not scored */
  visible: 'yes' | 'partly' | 'no'
  /** where to look at the peak, when that means something */
  altDeg?: number
  azDeg?: number
  /** the Deep Space button: the body to focus on and the time to show */
  deepSpace?: { focus: string; whenMs: number }
  /** the score at the best time, filled in by the scorer */
  score?: EventScore
  /** the best moment to look, ms (may differ from the peak: the hour the radiant is highest in the dark) */
  bestMs?: number
  /** whether a reminder makes sense (not for routine Moon phases and the like) */
  remindable: boolean
}

export const RATING_LABEL: Record<Rating, string> = { good: 'Good', fair: 'Fair', poor: 'Poor', unknown: '' }
