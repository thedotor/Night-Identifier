import { useState, type ReactElement } from 'react'
import { gScale, kpMeaning } from '@renderer/lib/aurora'
import { radiationStormWords, radioBlackout, strongestFlare, type SunActivity } from '@renderer/lib/sun'

const severityOf = (scale: string | null): number => (scale ? Number(scale.slice(1)) || 0 : 0)
const severityColour = (n: number): string => (n >= 4 ? '#ff5050' : n === 3 ? '#ff9a3d' : '#ffd84d')

/** A compact "storm's up" badge: NOAA's G (geomagnetic), S (radiation) and R (radio blackout) scales, at a glance. Hidden when all three are quiet. */
export function SpaceWeatherBadge({ activity, kp }: { activity: SunActivity | null; kp: number | null }): ReactElement | null {
  const [open, setOpen] = useState(false)
  const g = kp != null ? gScale(kp) : null
  const strongest = activity ? strongestFlare(activity.flares, Date.now(), 3) : null
  const r = strongest ? radioBlackout(strongest.class) : null
  const s = activity?.proton?.class ?? null
  const scales = ([['G', g], ['S', s], ['R', r]] as const).filter(([, v]) => v) as [string, string][]
  if (scales.length === 0) return null
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-border bg-surface/90 px-2 py-1 text-xs font-medium text-text hover:border-accent"
        title="Current space-weather storm scales"
      >
        {scales.map(([id, v]) => (
          <span key={id} style={{ color: severityColour(severityOf(v)) }}>
            {v}
          </span>
        ))}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 w-64 space-y-1.5 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
          {g && kp != null && (
            <div>
              <span className="font-semibold" style={{ color: severityColour(severityOf(g)) }}>
                {g}
              </span>{' '}
              geomagnetic storm — {kpMeaning(kp).text}
            </div>
          )}
          {s && (
            <div>
              <span className="font-semibold" style={{ color: severityColour(severityOf(s)) }}>
                {s}
              </span>{' '}
              {radiationStormWords(s)}
            </div>
          )}
          {r && (
            <div>
              <span className="font-semibold" style={{ color: severityColour(severityOf(r)) }}>
                {r}
              </span>{' '}
              radio blackout in progress: shortwave radio goes quiet on the sunlit side of Earth{strongest ? ` (from a ${strongest.class} flare)` : ''}.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
