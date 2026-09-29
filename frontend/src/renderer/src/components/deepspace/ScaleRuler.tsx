import type { ReactElement } from 'react'
import { AU_PER_LY } from '@renderer/lib/galaxyMath'
import { AU_LIGHT_MINUTES, KM_PER_AU } from '@renderer/lib/solarSystemData'

export interface ScaleStop {
  label: string
  /** camera distance from the centre of view, AU */
  au: number
  /** body to centre on (default: whatever is centred now) */
  focus?: string
  /** view from this ecliptic direction */
  direction?: [number, number, number]
  title?: string
}

interface Props {
  distanceAU: number
  stops: ScaleStop[]
  onStop: (s: ScaleStop) => void
  /** clicked a spot on the bar: zoom to that distance around the current focus */
  onDistance: (au: number) => void
}

const MIN_AU = 1e-4
const MAX_AU = 1e15
const LOG_MIN = Math.log10(MIN_AU)
const LOG_MAX = Math.log10(MAX_AU)

/** Landmarks along the bar, so the position means something. */
const LANDMARKS: { au: number; label: string }[] = [
  { au: 1, label: '1 AU' },
  { au: AU_PER_LY, label: '1 light-year' },
  { au: AU_PER_LY * 1e3, label: '1,000 ly' },
  { au: AU_PER_LY * 1e5, label: '100,000 ly' },
  { au: AU_PER_LY * 1e7, label: '10 million ly' },
  { au: AU_PER_LY * 1e9, label: '1 billion ly' }
]

const frac = (au: number): number => Math.max(0, Math.min(1, (Math.log10(au) - LOG_MIN) / (LOG_MAX - LOG_MIN)))

/** "45 AU (6.2 light-hours)", "8.6 light-years", "2.5 million light-years". */
export function fmtScale(au: number): string {
  if (au < 0.01) return `${Math.round(au * KM_PER_AU).toLocaleString()} km`
  const lightMin = au * AU_LIGHT_MINUTES
  if (au < 1e3) return `${au.toPrecision(au < 10 ? 2 : 3)} AU · ${lightMin < 1.5 ? `${(lightMin * 60).toFixed(0)} light-seconds` : lightMin < 120 ? `${lightMin.toFixed(0)} light-minutes` : `${(lightMin / 60).toFixed(1)} light-hours`}`
  const ly = au / AU_PER_LY
  if (ly < 0.1) return `${Math.round(au).toLocaleString()} AU · ${(ly * 365.25).toFixed(0)} light-days`
  if (ly < 1000) return `${ly.toPrecision(ly < 10 ? 2 : 3)} light-years`
  if (ly < 1e6) return `${Math.round(ly).toLocaleString()} light-years`
  if (ly >= 1e9) return `${(ly / 1e9).toPrecision(2)} billion light-years`
  return `${(ly / 1e6).toPrecision(ly < 1e7 ? 2 : 3)} million light-years`
}

/** A log-scale ruler from a planet's surface to the Local Group: shows where the camera is on it
 * and lets you jump to a scale, or click anywhere along it to zoom to that distance. */
export function ScaleRuler({ distanceAU, stops, onStop, onDistance }: Props): ReactElement {
  return (
    <div className="rounded-md border border-border bg-surface/95 px-3 pb-1.5 pt-2 text-xs backdrop-blur-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-text" title="How far the camera is from the centre of the view">
          {fmtScale(distanceAU)}
        </span>
        <span className="hidden text-[10px] text-text-muted sm:inline">Wheel to zoom · Shift+wheel for big steps · click the bar or a scale to jump</span>
      </div>
      <div
        className="relative mt-2 h-4 cursor-pointer"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const t = (e.clientX - r.left) / r.width
          onDistance(Math.pow(10, LOG_MIN + t * (LOG_MAX - LOG_MIN)))
        }}
        title="Click to zoom to this distance"
      >
        <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
        {LANDMARKS.map((l) => (
          <div key={l.label} className="pointer-events-none absolute top-0 h-full -translate-x-1/2" style={{ left: `${frac(l.au) * 100}%` }}>
            <div className="mx-auto h-2 w-px bg-text-muted/60" />
            <div className="mt-0.5 whitespace-nowrap text-[9px] text-text-muted">{l.label}</div>
          </div>
        ))}
        <div className="pointer-events-none absolute top-0 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-accent shadow" style={{ left: `${frac(distanceAU) * 100}%` }} />
      </div>
      <div className="mt-4 flex flex-wrap gap-1">
        {stops.map((s) => (
          <button key={s.label} title={s.title} onClick={() => onStop(s)} className="rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:border-accent hover:text-text">
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}
