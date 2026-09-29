import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadSatellites } from '@renderer/components/sky/useSatellites'
import { compass, findPasses, globalState, sampleOne, type SatCatalogue } from '@renderer/lib/satellites'
import { fmtAge } from '@renderer/lib/satelliteText'
import type { Place } from '@renderer/lib/skyTonight'
import { GroundTrack } from './GroundTrack'
import { useStoredFlag } from './usePlace'

const ISS_NORAD = 25544
const ISS_COLOR = '#ff5c5c'

const clock = (d: Date | number): string => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const dayLabel = (ms: number): string => {
  const d = new Date(ms)
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime()) / 86_400_000)
  return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}
const untilText = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}

function Row({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-text-muted">{label}</span>
      <span className="text-right tabular-nums text-text">{value}</span>
    </div>
  )
}

/** The International Space Station: where it is now, whether it is over you, and when to look up. Its own tick box, off = nothing is downloaded. */
export function IssCard({ place }: { place: Place | null }): ReactElement {
  const navigate = useNavigate()
  const [on, setOn] = useStoredFlag('night-identifier:dash-iss', true)
  const [cat, setCat] = useState<SatCatalogue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // a widget two columns wide is too narrow for the map and the details side by side
  const box = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= 820))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!on) return
    let live = true
    setError(null)
    loadSatellites(['iss'])
      .then((c) => live && setCat(c))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'could not load the orbit data'))
    return () => {
      live = false
    }
  }, [on])

  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [on])

  const rec = useMemo(() => cat?.records.find((r) => r.norad === ISS_NORAD) ?? null, [cat])
  const here = useMemo(() => (rec && place ? sampleOne(rec, new Date(now), place) : null), [rec, place, now])
  const where = useMemo(() => (rec ? globalState(rec, new Date(now)) : null), [rec, now])
  const tenMin = Math.floor(now / 600_000)
  const passes = useMemo(
    () => (rec && place ? findPasses(rec, place, new Date(tenMin * 600_000), 48, 10) : []),
    // recomputed every ten minutes, not every second
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rec, place, tenMin]
  )
  const upcoming = passes.filter((p) => p.setMs > now)
  const nextSeen = upcoming.find((p) => p.visible) ?? null
  const overNow = here && here.altDeg > 0 ? upcoming.find((p) => p.riseMs <= now && p.setMs > now) : null

  return (
    <div ref={box} className="h-full rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-text" title="Track the International Space Station. Off: nothing is downloaded or calculated.">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="accent-accent" />
          Track the ISS
        </label>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: ISS_COLOR }} />
        {on && (
          <>
            <span className="text-xs text-text-muted">International Space Station, live</span>
            <div className="ml-auto flex gap-2">
              <button className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text" onClick={() => navigate(`/deep-space?view=solar&sat=${ISS_NORAD}`)}>
                Follow it in 3D
              </button>
              <button className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text" onClick={() => navigate('/sky-overlay')}>
                Sky overlay
              </button>
            </div>
          </>
        )}
      </div>

      {!on && <div className="mt-2 text-xs text-text-muted">Tick to see where the ISS is right now, its path around the world and when it passes over you.</div>}

      {on && (
        <div className={`mt-3 grid gap-4 ${wide ? 'grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : ''}`}>
          <div className="space-y-2">
            <GroundTrack rec={rec} nowMs={now} place={place} color={ISS_COLOR} />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
              <span>
                <span style={{ color: ISS_COLOR }}>●</span> ISS (path: last 45 min dashed, next 90 min solid)
              </span>
              <span>
                <span className="text-success">●</span> you
              </span>
              <span>
                <span style={{ color: '#ffd966' }}>●</span> Sun overhead · dark = night
              </span>
            </div>
          </div>

          <div className="space-y-3">
            {error && <div className="text-xs text-danger">Could not load the ISS orbit: {error}</div>}
            {!cat && !error && <div className="text-xs text-text-muted">Loading orbit data…</div>}
            {cat && !rec && <div className="text-xs text-warning">The ISS is not in the orbit data{cat.missing.length ? ' (offline?)' : ''}.</div>}

            {where && (
              <div className="space-y-1">
                <Row label="Over" value={`${Math.abs(where.latDeg).toFixed(2)}° ${where.latDeg >= 0 ? 'N' : 'S'}, ${Math.abs(where.lonDeg).toFixed(2)}° ${where.lonDeg >= 0 ? 'E' : 'W'}`} />
                <Row label="Altitude" value={`${Math.round(where.heightKm)} km`} />
                <Row label="Speed" value={`${where.speedKmS.toFixed(2)} km/s (${Math.round(where.speedKmS * 3600).toLocaleString()} km/h)`} />
                <Row label="Sunlight" value={where.sunlit ? 'in sunlight' : 'in Earth’s shadow'} />
              </div>
            )}

            {place ? (
              rec && (
                <div className="space-y-2 rounded-md border border-border p-2.5">
                  {here && here.altDeg > 0 ? (
                    <div className="text-sm font-medium text-success">
                      Above your horizon now: {here.altDeg.toFixed(0)}° up in the {compass(here.azDeg)}
                      {overNow ? `, sets ${clock(overNow.setMs)}` : ''}
                    </div>
                  ) : nextSeen ? (
                    <div className="text-sm font-medium text-text">
                      Next visible pass in {untilText(nextSeen.riseMs - now)}
                      <span className="ml-1 text-xs font-normal text-text-muted">
                        ({dayLabel(nextSeen.riseMs)} {clock(nextSeen.riseMs)})
                      </span>
                    </div>
                  ) : (
                    <div className="text-sm text-text-muted">No visible pass in the next 2 days.</div>
                  )}
                  {upcoming.slice(0, 4).map((p) => (
                    <div key={p.riseMs} className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="tabular-nums text-text">
                        {dayLabel(p.riseMs)} {clock(p.riseMs)}
                      </span>
                      <span className="text-text-muted">
                        max {p.peakAltDeg.toFixed(0)}° · {compass(p.riseAzDeg)} → {compass(p.setAzDeg)}
                      </span>
                      <span className={p.visible ? 'text-success' : 'text-text-muted'}>{p.visible ? 'visible' : 'not visible'}</span>
                    </div>
                  ))}
                  <div className="text-[10px] leading-snug text-text-muted">Visible = the ISS is in sunlight while you are in twilight or darkness. Passes below 10° are left out.</div>
                </div>
              )
            ) : (
              <div className="rounded-md border border-warning/40 p-2.5 text-xs text-warning">Set your location above to see when the ISS passes over you.</div>
            )}
            {cat?.fetchedAt && <div className="text-[10px] text-text-muted">Orbit data {fmtAge(cat.fetchedAt)} · {cat.credit}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
