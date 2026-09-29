import { useMemo, type ReactElement } from 'react'
import { compass, findPasses, SAT_GROUPS, type SatSample, type Site } from '@renderer/lib/satellites'

interface Props {
  sample: SatSample
  site: Site
  /** the moment the satellite is shown at; passes are listed from here */
  date: Date
  onClose: () => void
  /** open this satellite in the 3D view and follow it (when the page has one) */
  onFollow?: (norad: number) => void
  className?: string
}

const pad = (n: number): string => String(n).padStart(2, '0')
const fmtTime = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const fmtDay = (ms: number, from: number): string => {
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date(from).toDateString()
  return sameDay ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}
const km = (n: number): string => `${Math.round(n).toLocaleString()} km`

/** What a picked satellite is and where it is, plus when it next passes over the site. */
export function SatelliteCard({ sample, site, date, onClose, onFollow, className }: Props): ReactElement {
  const rec = sample.rec
  const group = SAT_GROUPS.find((g) => rec.flags & g.bit)
  // Passes are stable for minutes: recompute only when the picked satellite, place or (rounded) time changes.
  const stamp = Math.floor(date.getTime() / 600000)
  const passes = useMemo(
    () => findPasses(rec, site, new Date(stamp * 600000), 24, 10),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rec.norad, site.latDeg, site.lonDeg, stamp]
  )
  const up = sample.altDeg >= 0

  return (
    <div className={`w-72 overflow-hidden rounded-md border border-border bg-surface text-xs shadow-xl ${className ?? ''}`} onPointerDown={(e) => e.stopPropagation()}>
      <div className="p-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-text" title={rec.name}>{rec.name}</div>
            <div className="truncate text-text-muted">
              Satellite · NORAD {rec.norad}
              {rec.intl ? ` · ${rec.intl}` : ''}
            </div>
          </div>
          <button onClick={onClose} title="Close" className="shrink-0 px-1 text-base leading-none text-text-muted hover:text-text">
            ×
          </button>
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-text-muted">Now</dt>
          <dd className={up ? 'text-text' : 'text-warning'}>
            {up
              ? `${sample.altDeg.toFixed(1)}° up, ${sample.azDeg.toFixed(0)}° ${compass(sample.azDeg)}`
              : `below the horizon (${sample.altDeg.toFixed(0)}°)`}
          </dd>
          <dt className="text-text-muted">Lighting</dt>
          <dd className="text-text">{sample.sunlit ? 'Sunlit' : 'In Earth’s shadow (dark to a camera)'}</dd>
          <dt className="text-text-muted">Distance</dt>
          <dd className="text-text">{km(sample.rangeKm)}</dd>
          <dt className="text-text-muted">Altitude</dt>
          <dd className="text-text">{km(sample.heightKm)}</dd>
          <dt className="text-text-muted">Speed</dt>
          <dd className="text-text">{sample.speedKmS.toFixed(2)} km/s ({Math.round(sample.speedKmS * 3600).toLocaleString()} km/h)</dd>
          {group && (
            <>
              <dt className="text-text-muted">Group</dt>
              <dd className="text-text">{group.label}</dd>
            </>
          )}
        </dl>

        <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Next 24 hours (peaks above 10°)</div>
        {passes.length === 0 ? (
          <div className="mt-1 text-text-muted">No passes this high from here.</div>
        ) : (
          <div className="mt-1 max-h-44 space-y-1 overflow-y-auto">
            {passes.map((p) => (
              <div key={p.riseMs} className="rounded border border-border px-1.5 py-1" title={`UTC ${new Date(p.riseMs).toISOString().slice(11, 19)} to ${new Date(p.setMs).toISOString().slice(11, 19)}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-text">
                    {fmtDay(p.peakMs, date.getTime())} {fmtTime(p.riseMs)}–{fmtTime(p.setMs)}
                  </span>
                  {p.visible ? (
                    <span className="rounded bg-success/20 px-1 text-success">visible</span>
                  ) : (
                    <span className="text-text-muted">{p.sunlitAtPeak ? 'daylight' : 'in shadow'}</span>
                  )}
                </div>
                <div className="text-text-muted">
                  up to {p.peakAltDeg.toFixed(0)}° · {compass(p.riseAzDeg)} → {compass(p.setAzDeg)}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-1 text-[10px] text-text-muted">Times are this computer’s clock. “Visible”: sunlit while the Sun is more than 6° below the horizon.</div>

        {onFollow && (
          <button onClick={() => onFollow(rec.norad)} className="mt-3 w-full rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg">
            Follow in 3D →
          </button>
        )}
      </div>
    </div>
  )
}
