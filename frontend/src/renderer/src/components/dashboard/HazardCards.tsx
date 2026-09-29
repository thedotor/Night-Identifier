import { useEffect, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@renderer/lib/api'
import { ago, distanceKm, magnitudeWords, VOLCANO_LEVELS, WINDOWS } from '@renderer/lib/hazards'
import { useVolcanoes } from '@renderer/components/deepspace/useHazards'
import { isPopout } from '@renderer/lib/storeNs'
import { usePlace } from './usePlace'

const inMonitor = isPopout

interface RecentQuake {
  id: string
  t: number
  lat: number
  lon: number
  depth: number
  mag: number
  tsunami: number
  place: string
  alert: string | null
  felt: number | null
}
interface RecentPayload {
  quakes: RecentQuake[]
  total: number
  status: { ok: boolean | null; error: string | null }
  credit: string
}

const MAGS = [2.5, 3, 4, 4.5, 5, 6]
const sel = 'rounded border border-border bg-bg px-1 py-0.5 text-[11px] text-text'

/** The Earth page, looking down on a place (the monitoring window has no Earth page to open, so its rows are only for reading). */
function useOpenOnEarth(): (lat: number, lon: number, show: 'quakes' | 'volcanoes') => void {
  const navigate = useNavigate()
  return (lat, lon, show) => {
    if (inMonitor()) return
    navigate(`/deep-space?view=solar&focus=earth&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&show=${show}`)
  }
}

/** A live list of recent earthquakes (USGS), by time or by size. Click one to look at it on the Earth. */
export function RecentQuakesCard(): ReactElement {
  const [minMag, setMinMag] = useState(4.5)
  const [hours, setHours] = useState(24)
  const [by, setBy] = useState<'time' | 'mag'>('time')
  const [data, setData] = useState<RecentPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { place } = usePlace()
  const open = useOpenOnEarth()
  const monitor = inMonitor()

  useEffect(() => {
    let live = true
    const load = (): void => {
      api
        .get<RecentPayload>(`/hazards/quakes/recent?min_mag=${minMag}&hours=${hours}&limit=60&by=${by}`)
        .then((d) => live && (setData(d), setError(null)))
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'Could not load'))
    }
    load()
    const early = window.setTimeout(load, 8000) // the first answer can come before the backend has fetched anything
    const t = window.setInterval(load, 60_000)
    return () => {
      live = false
      window.clearTimeout(early)
      window.clearInterval(t)
    }
  }, [minMag, hours, by])

  return (
    <div className="h-full min-h-[14rem] rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-text-muted">Earthquakes</div>
          <div className="text-xs text-text-muted">Live from the USGS{data ? ` · ${data.total.toLocaleString()} match` : ''}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <select className={sel} value={minMag} onChange={(e) => setMinMag(Number(e.target.value))} title="Smallest earthquake listed">
            {MAGS.map((m) => (
              <option key={m} value={m}>
                M {m}+
              </option>
            ))}
          </select>
          <select className={sel} value={hours} onChange={(e) => setHours(Number(e.target.value))} title="How far back">
            {WINDOWS.map((w) => (
              <option key={w.hours} value={w.hours}>
                {w.label}
              </option>
            ))}
          </select>
          <select className={sel} value={by} onChange={(e) => setBy(e.target.value as 'time' | 'mag')} title="Order">
            <option value="time">Newest</option>
            <option value="mag">Biggest</option>
          </select>
        </div>
      </div>
      {error && !data && <div className="mt-3 text-xs text-danger">{error}</div>}
      {data && data.quakes.length === 0 && <div className="mt-3 text-sm text-text-muted">No earthquakes that size in that time.</div>}
      <ul className="mt-2 max-h-[28rem] space-y-0.5 overflow-y-auto pr-1">
        {data?.quakes.map((q) => (
          <li key={q.id}>
            <button
              disabled={monitor}
              onClick={() => open(q.lat, q.lon, 'quakes')}
              className={`flex w-full items-center gap-3 rounded px-1.5 py-1 text-left text-xs ${monitor ? 'cursor-default' : 'hover:bg-accent/10'}`}
              title={monitor ? undefined : 'Look at it on the Earth'}
            >
              <span
                className="w-11 shrink-0 rounded px-1 py-0.5 text-center text-[11px] font-semibold tabular-nums text-bg"
                style={{ background: q.mag >= 6 ? '#ff5050' : q.mag >= 5 ? '#ff9a3d' : q.mag >= 4 ? '#ffd84d' : '#9fe3a8' }}
              >
                {q.mag.toFixed(1)}
              </span>
              <span className="min-w-0 flex-1 truncate text-text" title={q.place}>
                {q.place || 'Not named'}
                {q.tsunami === 1 && <span className="ml-1 font-semibold text-danger">tsunami warning</span>}
              </span>
              <span className="shrink-0 text-right tabular-nums text-text-muted">
                {ago(q.t)}
                <span className="block text-[10px]">
                  {magnitudeWords(q.mag)} · {q.depth.toFixed(0)} km deep{place ? ` · ${Math.round(distanceKm(place.latDeg, place.lonDeg, q.lat, q.lon)).toLocaleString()} km away` : ''}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {data && <div className="mt-2 text-[10px] text-text-muted">{data.credit}</div>}
    </div>
  )
}

/** The volcanoes erupting, in unrest or on alert now (Smithsonian / USGS weekly report and USGS alert levels). Click one to look at it on the Earth. */
export function VolcanoActivityCard(): ReactElement {
  const feed = useVolcanoes(true)
  const open = useOpenOnEarth()
  const monitor = inMonitor()
  const { place } = usePlace()
  return (
    <div className="h-full min-h-[14rem] rounded-lg border border-border bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-text-muted">Volcano activity</div>
      <div className="text-xs text-text-muted">
        {feed.status === 'loading' ? 'Loading…' : feed.status === 'error' ? (feed.message ?? 'Could not load') : `${feed.active.length} erupting, in unrest or on alert`} · weekly report, updated Thursdays, and USGS alert levels
      </div>
      {feed.status !== 'loading' && feed.active.length === 0 && feed.status !== 'error' && <div className="mt-3 text-sm text-text-muted">No volcano is reported as active right now.</div>}
      <ul className="mt-2 max-h-[28rem] space-y-1 overflow-y-auto pr-1">
        {feed.active.map((v) => (
          <li key={v.vnum}>
            <button
              disabled={monitor}
              onClick={() => open(v.lat, v.lon, 'volcanoes')}
              className={`block w-full rounded px-1.5 py-1 text-left text-xs ${monitor ? 'cursor-default' : 'hover:bg-accent/10'}`}
              title={monitor ? undefined : 'Look at it on the Earth'}
            >
              <div className="flex items-center gap-2">
                <span style={{ color: VOLCANO_LEVELS[v.level].colour }}>▲</span>
                <span className="font-medium text-text">{v.name}</span>
                <span className="text-text-muted">{v.country}</span>
                <span className="ml-auto shrink-0 text-right text-text-muted">
                  {v.category || VOLCANO_LEVELS[v.level].label}
                  {v.usgs_level ? ` · USGS ${v.usgs_color} ${v.usgs_level}` : ''}
                </span>
              </div>
              {v.summary && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-text-muted">{v.summary}</div>}
              {place && <div className="text-[10px] text-text-muted">{Math.round(distanceKm(place.latDeg, place.lonDeg, v.lat, v.lon)).toLocaleString()} km from your saved location</div>}
            </button>
          </li>
        ))}
      </ul>
      {feed.payload && <div className="mt-2 text-[10px] text-text-muted">{feed.payload.credit}</div>}
    </div>
  )
}
