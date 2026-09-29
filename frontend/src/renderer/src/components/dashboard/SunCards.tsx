import { useMemo, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { deepspaceSrc } from '@renderer/lib/api'
import { cmeDirection, cmeFront, cmeVisible, flareFlux, flareWords, incomingCmes, radioBlackout, regionLon, relativeTime, strongestFlare, type SunActivity } from '@renderer/lib/sun'
import { useSunActivity } from '@renderer/components/sun/useSun'

const card = 'h-full rounded-lg border border-border bg-surface p-4'
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const dayClock = (ms: number): string => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const errMsg = (e: string | null): string => (e ? e.replace(/^\{"detail":"|"\}$/g, '') : 'no connection')

const XRAY_LEVELS: { flux: number; label: string }[] = [
  { flux: 1e-4, label: 'X' },
  { flux: 1e-5, label: 'M' },
  { flux: 1e-6, label: 'C' },
  { flux: 1e-7, label: 'B' }
]

/** The last six hours of GOES X-rays on a log scale, with the flare classes marked. */
function XrayGraph({ series }: { series: [number, number][] }): ReactElement {
  const W = 300
  const H = 84
  const lo = Math.log10(1e-8)
  const hi = Math.log10(1e-3)
  const x0 = series[0][0]
  const x1 = series[series.length - 1][0]
  const px = (t: number): number => ((t - x0) / Math.max(1, x1 - x0)) * W
  const py = (f: number): number => H - ((Math.log10(Math.max(f, 1e-8)) - lo) / (hi - lo)) * H
  const d = series.map(([t, f], i) => `${i ? 'L' : 'M'}${px(t).toFixed(1)},${py(f).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" role="img" aria-label="GOES X-ray flux, last six hours">
      {XRAY_LEVELS.map((l) => (
        <g key={l.label}>
          <line x1={0} x2={W} y1={py(l.flux)} y2={py(l.flux)} stroke="currentColor" strokeOpacity={0.15} strokeDasharray="3 3" />
          <text x={W - 2} y={py(l.flux) - 2} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.5}>
            {l.label}
          </text>
        </g>
      ))}
      <path d={d} fill="none" stroke="#ffb455" strokeWidth={1.6} />
    </svg>
  )
}

function Row({ k, children }: { k: string; children: React.ReactNode }): ReactElement {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-text-muted">{k}</span>
      <span className="text-right text-text">{children}</span>
    </div>
  )
}

/** "The Sun now": a live picture, the X-ray level, and the strongest recent flare. */
export function SunCard(): ReactElement {
  const navigate = useNavigate()
  const now = Date.now()
  const { data, error, loading } = useSunActivity(true, now)
  const [kind, setKind] = useState<'euv' | 'visual' | 'euv304'>('euv')
  const stamp = Math.floor(now / 900_000)
  const src = useMemo(() => deepspaceSrc(`/sun/image?kind=${kind}&t=${stamp}`), [kind, stamp])
  const flare = data ? strongestFlare(data.flares, now, 24) : null
  const xr = data?.xray
  const state = !xr ? '' : flareFlux(xr.class) >= 1e-4 ? 'a major flare' : flareFlux(xr.class) >= 1e-5 ? 'flaring' : flareFlux(xr.class) >= 1e-6 ? 'small flares' : 'quiet'
  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-text-muted">The Sun now</div>
        <div className="flex items-center gap-1">
          {(
            [
              ['euv', 'Extreme UV'],
              ['visual', 'Visible'],
              ['euv304', '304 Å']
            ] as const
          ).map(([k, label]) => (
            <button key={k} onClick={() => setKind(k)} className={`rounded border px-1.5 py-0.5 text-[11px] ${kind === k ? 'border-accent text-text' : 'border-border text-text-muted hover:text-text'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-4">
        <div className="relative h-44 w-44 shrink-0 overflow-hidden rounded-full bg-black" title="A real picture of the Sun from NASA's Solar Dynamics Observatory (the visible-light picture can be a few hours old)">
          {/* the picture is 1024 px with the Sun's disc taking 72% of it: crop to the disc */}
          <img src={src} alt="The Sun" className="absolute left-1/2 top-1/2 max-w-none -translate-x-1/2 -translate-y-1/2" style={{ width: '138.9%', height: '138.9%' }} />
        </div>
        <div className="min-w-[13rem] flex-1 space-y-1.5">
          {error && !data ? (
            <div className="text-xs text-warning">No connection to the solar data ({errMsg(error)})</div>
          ) : (
            <>
              <div>
                <span className="text-2xl font-semibold text-text tabular-nums">{xr?.class ?? '…'}</span>
                <span className="ml-2 text-xs text-text-muted">X-ray level · {state || (loading ? 'loading…' : '')}</span>
              </div>
              {xr && <XrayGraph series={xr.series} />}
              <div className="text-[10px] text-text-muted">GOES X-ray flux, last 6 hours (B, C, M and X are the flare classes: each step is 10 times stronger)</div>
              {flare ? (
                <Row k="Strongest flare in 24 h">
                  <span title={flareWords(flare.class)}>
                    {flare.class} at {dayClock(flare.peak)}
                    {radioBlackout(flare.class) ? ` · radio blackout ${radioBlackout(flare.class)}` : ''}
                  </span>
                </Row>
              ) : (
                data && <Row k="Strongest flare in 24 h">none notable</Row>
              )}
              {data && <Row k="Sunspot groups on the disc">{data.regions.length}</Row>}
            </>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="text-[10px] text-text-muted">Pictures: NASA SDO via Helioviewer. X-rays: NOAA GOES.</div>
        <button className="rounded-md border border-border px-2 py-1 text-xs text-text-muted hover:border-accent hover:text-text" onClick={() => navigate('/deep-space?view=solar&focus=sun')}>
          Open in Deep Space
        </button>
      </div>
    </div>
  )
}

function CmeLine({ c, now }: { c: SunActivity['cmes'][number]; now: number }): ReactElement {
  const r = cmeFront(c, now)
  return (
    <div className={`rounded border px-2 py-1 text-xs ${c.earth_directed ? 'border-warning/60 bg-warning/10' : 'border-border'}`} title={c.note ?? undefined}>
      <div className="flex justify-between gap-2">
        <span className="text-text">
          {Math.round(c.speed)} km/s · {c.earth_directed ? 'toward Earth' : Math.abs(c.lon) > 90 ? 'far side' : 'not at Earth'}
        </span>
        <span className="text-text-muted">{dayClock(c.start)}</span>
      </div>
      <div className="text-[11px] text-text-muted">
        {cmeDirection(c)} · {cmeVisible(c, now) ? `${r.toFixed(0)} solar radii out` : r > 100 ? 'past the planets’ region' : 'just leaving'}
      </div>
      {c.earth_directed && c.arrival && (
        <div className="text-[11px] text-warning">
          Arrives at Earth {relativeTime(c.arrival, now)} ({dayClock(c.arrival)}), {c.arrival_source}
        </div>
      )}
    </div>
  )
}

/** Coronal mass ejections and the numbered sunspot groups. */
export function SunActivityCard(): ReactElement {
  const now = Date.now()
  const { data, error } = useSunActivity(true, now)
  const incoming = data ? incomingCmes(data.cmes, now) : []
  const recent = data ? [...data.cmes].sort((a, b) => b.t215 - a.t215).slice(0, 5) : []
  const regions = data ? [...data.regions].sort((a, b) => (b.m_prob ?? 0) + (b.x_prob ?? 0) - ((a.m_prob ?? 0) + (a.x_prob ?? 0)) || (b.area ?? 0) - (a.area ?? 0)).slice(0, 6) : []
  return (
    <div className={card}>
      <div className="text-xs uppercase tracking-wide text-text-muted">Solar storms and sunspots</div>
      {error && !data ? (
        <div className="mt-2 text-xs text-warning">No connection to the solar data ({errMsg(error)})</div>
      ) : (
        <div className="mt-2 space-y-3">
          <div className="text-sm text-text">
            {incoming.length > 0 ? (
              <span className="text-warning">
                A CME is heading for Earth: arrives {relativeTime(incoming[0].arrival!, now)} ({clock(incoming[0].arrival!)})
              </span>
            ) : data ? (
              'No CME is forecast to reach Earth'
            ) : (
              'Loading…'
            )}
          </div>
          <div className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-wide text-text-muted">Recent coronal mass ejections</div>
            {recent.length === 0 && data && <div className="text-xs text-text-muted">None catalogued in the last week</div>}
            {recent.map((c) => (
              <CmeLine key={c.id} c={c} now={now} />
            ))}
          </div>
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-wide text-text-muted">Sunspot groups (most flare-prone first)</div>
            {regions.length === 0 && data && <div className="text-xs text-text-muted">No numbered groups reported</div>}
            {regions.map((r) => {
              const lon = regionLon(r, now)
              return (
                <div key={r.number} className="flex justify-between gap-2 text-xs">
                  <span className="text-text">
                    AR{r.number} <span className="text-text-muted">{r.lat >= 0 ? 'N' : 'S'}{Math.abs(Math.round(r.lat))}{lon >= 0 ? 'W' : 'E'}{Math.abs(Math.round(lon))}</span>
                  </span>
                  <span className="text-text-muted">
                    {r.spot_class ?? ''} {r.mag_class ? `· ${r.mag_class}` : ''} · M-flare chance {r.m_prob ?? 0}%
                  </span>
                </div>
              )
            })}
          </div>
          <div className="text-[10px] text-text-muted">CMEs: NASA DONKI. Sunspot groups and flare chances: NOAA SWPC. Arrival times are model estimates and can be off by half a day.</div>
        </div>
      )}
    </div>
  )
}
