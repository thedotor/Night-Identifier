import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@renderer/lib/api'
import { compass } from '@renderer/lib/satellites'
import { nightInfo, planetsNow, type DayState, type Place } from '@renderer/lib/skyTonight'
import { stateDot } from '@renderer/components/live/ui'
import { parsePlace } from './usePlace'
import { describeInternetPlace, readOverride, useLocationSettings, type LocationMode } from '@renderer/lib/location'

const card = 'h-full rounded-lg border border-border bg-surface p-4'
const clock = (d: Date | null): string => (d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-')

function Title({ children, hint }: { children: ReactNode; hint?: string }): ReactElement {
  return (
    <div className="mb-2">
      <div className="text-xs uppercase tracking-wide text-text-muted">{children}</div>
      {hint && <div className="text-[11px] text-text-muted">{hint}</div>}
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-text-muted">{label}</span>
      <span className={`text-right tabular-nums ${tone ?? 'text-text'}`}>{value}</span>
    </div>
  )
}

/** A clock that ticks every `everyMs`, so the cards stay current. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(t)
  }, [everyMs])
  return now
}

// ---------- where you are ----------

const MODES: { id: LocationMode; label: string; title: string }[] = [
  { id: 'manual', label: 'Manual', title: 'The place you type in' },
  { id: 'internet', label: 'Internet', title: 'Found from this computer’s internet address (approximate: a city, not a street). Looked up at every start and when you press Refresh.' },
  { id: 'override', label: 'Override', title: 'Coordinates you force by hand. They win over everything else, to look at the sky from another site.' }
]

const ago = (ms: number): string => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000))
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

export function PlaceBar({ raw, place, save }: { raw: { lat: string; lon: string } | null; place: Place | null; save: (lat: string, lon: string) => boolean }): ReactElement {
  const loc = useLocationSettings()
  const inet = loc.mode === 'internet'
  // Override with nothing forced yet, or Manual with no place: ask for one
  const [editing, setEditing] = useState(!place)
  const [lat, setLat] = useState(raw?.lat ?? '')
  const [lon, setLon] = useState(raw?.lon ?? '')
  useEffect(() => {
    setLat(raw?.lat ?? '')
    setLon(raw?.lon ?? '')
  }, [raw?.lat, raw?.lon])
  const bad = (lat !== '' || lon !== '') && !parsePlace(lat, lon)
  const input = 'w-28 rounded-md border border-border bg-bg px-2 py-1 text-xs text-text focus:border-accent focus:outline-none'
  const forced = loc.mode === 'override' && !readOverride()

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
      <span>Your location:</span>
      <span className="flex overflow-hidden rounded-md border border-border" role="group" aria-label="Where your location comes from">
        {MODES.map((m) => (
          <button
            key={m.id}
            title={m.title}
            onClick={() => {
              loc.setMode(m.id)
              setEditing(m.id === 'override' && !readOverride())
            }}
            className={`px-2 py-1 font-medium ${loc.mode === m.id ? 'bg-accent/30 text-text' : 'bg-surface text-text-muted hover:text-text'}`}
          >
            {m.label}
          </button>
        ))}
      </span>
      {inet ? (
        <>
          {loc.internet ? (
            <>
              <span className="tabular-nums text-text">
                {Math.abs(Number(loc.internet.lat)).toFixed(3)}° {Number(loc.internet.lat) >= 0 ? 'N' : 'S'}, {Math.abs(Number(loc.internet.lon)).toFixed(3)}° {Number(loc.internet.lon) >= 0 ? 'E' : 'W'}
              </span>
              <span title="Approximate: a lookup from the internet address is good to a city, often tens of kilometres off">
                {describeInternetPlace(loc.internet)} (approximate) · {ago(loc.internet.at)}
              </span>
            </>
          ) : (
            <span>{loc.busy ? 'Looking up your place…' : 'Not looked up yet.'}</span>
          )}
          <button className="rounded-md border border-border px-2 py-1 hover:border-accent hover:text-text disabled:opacity-50" disabled={loc.busy} onClick={loc.refresh}>
            {loc.busy ? 'Looking up…' : 'Refresh'}
          </button>
          {loc.error && <span className="text-warning">{loc.error}{place ? ' (still using the last place)' : ''}</span>}
        </>
      ) : place && !editing && !forced ? (
        <>
          <span className="tabular-nums text-text">
            {Math.abs(place.latDeg).toFixed(3)}° {place.latDeg >= 0 ? 'N' : 'S'}, {Math.abs(place.lonDeg).toFixed(3)}° {place.lonDeg >= 0 ? 'E' : 'W'}
          </span>
          {loc.mode === 'override' && <span className="rounded border border-accent/60 px-1.5 text-[10px] uppercase tracking-wide text-text">override</span>}
          <button className="rounded-md border border-border px-2 py-1 hover:border-accent hover:text-text" onClick={() => setEditing(true)}>
            Change
          </button>
        </>
      ) : (
        <>
          <input className={input} placeholder="latitude (N +)" value={lat} onChange={(e) => setLat(e.target.value)} />
          <input className={input} placeholder="longitude (E +)" value={lon} onChange={(e) => setLon(e.target.value)} />
          <button
            className="rounded-md border border-accent bg-accent/20 px-2.5 py-1 font-medium text-text disabled:opacity-50"
            disabled={!parsePlace(lat, lon)}
            onClick={() => save(lat, lon) && setEditing(false)}
          >
            Save
          </button>
          {bad && <span className="text-warning">Latitude −90 to 90, longitude −180 to 180 (west is negative).</span>}
          {forced && !bad && <span>Enter the coordinates to force. Until then the app keeps using your manual place.</span>}
          {!place && !bad && !forced && <span>Enter where you observe from to see tonight’s sky, the weather and ISS passes.</span>}
        </>
      )}
    </div>
  )
}

// ---------- tonight ----------

const STATE_TEXT: Record<DayState, string> = {
  day: 'Daytime',
  civil: 'Civil twilight',
  nautical: 'Nautical twilight',
  astronomical: 'Astronomical twilight',
  night: 'Fully dark'
}

const hours = (h: number): string => `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, '0')} min`

export function TonightCard({ place }: { place: Place | null }): ReactElement {
  const now = useNow(60_000)
  const info = useMemo(() => (place ? nightInfo(place, new Date(now)) : null), [place, now])
  return (
    <div className={card}>
      <Title>Tonight</Title>
      {!info ? (
        <div className="text-xs text-text-muted">Needs your location.</div>
      ) : (
        <div className="space-y-1">
          <div className="pb-1 text-base font-semibold text-text">{STATE_TEXT[info.state]}</div>
          <Row label="Sunset" value={clock(info.sunset)} />
          <Row label="Sunrise" value={clock(info.sunrise)} />
          {info.alreadyDark ? (
            <Row label="Dark sky until" value={clock(info.darkEnd)} tone="text-success" />
          ) : info.darkStart ? (
            <Row label="Fully dark from" value={`${clock(info.darkStart)} to ${clock(info.darkEnd)}`} />
          ) : (
            <Row label="Fully dark" value="not tonight" tone="text-warning" />
          )}
          {info.darkHours !== null && info.moonlessHours !== null && (
            <Row label="Moon-free darkness" value={`${hours(info.moonlessHours)} of ${hours(info.darkHours)}`} />
          )}
          <div className="!mt-3 border-t border-border pt-2" />
          <Row label="Moon" value={`${info.moon.phaseName}, ${info.moon.illuminatedPct.toFixed(0)}% lit`} />
          <Row label={info.moon.altDeg > 0 ? 'Moon is up' : 'Moon is down'} value={`${info.moon.altDeg.toFixed(0)}° altitude`} />
          <Row label="Moonrise" value={clock(info.moon.rise)} />
          <Row label="Moonset" value={clock(info.moon.set)} />
        </div>
      )}
    </div>
  )
}

// ---------- planets ----------

export function PlanetsCard({ place }: { place: Place | null }): ReactElement {
  const now = useNow(60_000)
  const planets = useMemo(() => (place ? planetsNow(place, new Date(now)) : []), [place, now])
  return (
    <div className={card}>
      <Title>Planets now</Title>
      {!place ? (
        <div className="text-xs text-text-muted">Needs your location.</div>
      ) : (
        <div className="space-y-1">
          {planets.map((p) => (
            <div key={p.name} className="flex items-baseline justify-between gap-2 text-xs">
              <span className={p.altDeg > 0 ? 'font-medium text-text' : 'text-text-muted'}>{p.name}</span>
              <span className="tabular-nums text-text-muted">mag {p.magnitude.toFixed(1)}</span>
              <span className={`text-right tabular-nums ${p.altDeg > 0 ? 'text-success' : 'text-text-muted'}`}>
                {p.altDeg > 0 ? `${p.altDeg.toFixed(0)}° ${compass(p.azDeg)}` : p.next ? `rises ${clock(p.next.at)}` : 'below horizon'}
              </span>
            </div>
          ))}
          <div className="pt-1 text-[10px] text-text-muted">Green: above your horizon now. Times are local.</div>
        </div>
      )}
    </div>
  )
}

// ---------- weather ----------

interface Forecast {
  current: { temperature_2m: number; relative_humidity_2m: number; cloud_cover: number; wind_speed_10m: number; wind_gusts_10m: number; precipitation: number; weather_code: number; is_day: number }
  hourly: { time: string[]; cloud_cover: number[]; precipitation_probability: (number | null)[]; temperature_2m: number[]; visibility: (number | null)[] }
  stale: boolean
  credit: string
}

/** WMO weather codes, in words. */
function describe(code: number): string {
  if (code === 0) return 'Clear'
  if (code === 1) return 'Mainly clear'
  if (code === 2) return 'Partly cloudy'
  if (code === 3) return 'Overcast'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 57) return 'Drizzle'
  if (code >= 61 && code <= 67) return 'Rain'
  if (code >= 71 && code <= 77) return 'Snow'
  if (code >= 80 && code <= 82) return 'Rain showers'
  if (code === 85 || code === 86) return 'Snow showers'
  if (code >= 95) return 'Thunderstorm'
  return 'Unsettled'
}

const cloudTone = (pct: number): string => (pct < 25 ? 'bg-success' : pct < 60 ? 'bg-warning' : 'bg-danger')

export function WeatherCard({ place }: { place: Place | null }): ReactElement {
  const [data, setData] = useState<Forecast | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lat = place?.latDeg
  const lon = place?.lonDeg

  useEffect(() => {
    if (lat === undefined || lon === undefined) return
    let live = true
    const load = (): void => {
      api
        .get<Forecast>(`/weather?lat=${lat}&lon=${lon}`)
        .then((d) => {
          if (!live) return
          setData(d)
          setError(null)
        })
        .catch(() => live && setError('No connection to the weather service'))
    }
    load()
    const t = window.setInterval(load, 10 * 60_000)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [lat, lon])

  const next = data ? data.hourly.time.slice(0, 12).map((t, i) => ({ t, cloud: data.hourly.cloud_cover[i], rain: data.hourly.precipitation_probability[i] })) : []
  const best = next.length ? next.reduce((a, b) => (b.cloud < a.cloud ? b : a)) : null
  const hourLabel = (iso: string): string => new Date(`${iso}:00Z`).toLocaleTimeString([], { hour: '2-digit' })
  const c = data?.current

  return (
    <div className={card}>
      <Title hint="For stargazing">Weather</Title>
      {!place ? (
        <div className="text-xs text-text-muted">Needs your location.</div>
      ) : error && !data ? (
        <div className="text-xs text-danger">{error}</div>
      ) : !c ? (
        <div className="text-xs text-text-muted">Loading…</div>
      ) : (
        <div className="space-y-1">
          <div className="pb-1 text-base font-semibold text-text">
            {describe(c.weather_code)}, {Math.round(c.temperature_2m)}°C
          </div>
          <Row label="Cloud cover" value={`${c.cloud_cover}%`} tone={c.cloud_cover < 25 ? 'text-success' : c.cloud_cover < 60 ? 'text-warning' : 'text-danger'} />
          <Row label="Humidity" value={`${c.relative_humidity_2m}%`} />
          <Row label="Wind" value={`${Math.round(c.wind_speed_10m)} km/h (gusts ${Math.round(c.wind_gusts_10m)})`} />
          {c.precipitation > 0 && <Row label="Rain now" value={`${c.precipitation} mm`} tone="text-warning" />}
          <div className="!mt-3 text-[11px] text-text-muted">Cloud cover, next 12 hours</div>
          <div className="flex h-14 items-end gap-0.5" title="Taller = cloudier. Green is good for stargazing.">
            {next.map((h) => (
              <div key={h.t} className="flex flex-1 flex-col items-center justify-end">
                <div className={`w-full rounded-sm ${cloudTone(h.cloud)}`} style={{ height: `${Math.max(4, h.cloud * 0.5)}px` }} />
              </div>
            ))}
          </div>
          <div className="flex gap-0.5 text-[9px] text-text-muted">
            {next.map((h, i) => (
              <span key={h.t} className="flex-1 text-center">
                {i % 2 === 0 ? hourLabel(h.t) : ''}
              </span>
            ))}
          </div>
          {best && (
            <div className="text-[11px] text-text-muted">
              Clearest hour: <span className="text-text">{hourLabel(best.t)}:00</span> ({best.cloud}% cloud)
            </div>
          )}
          <div className="text-[10px] text-text-muted">{data?.stale ? 'Offline: last forecast. ' : ''}{data?.credit}</div>
        </div>
      )}
    </div>
  )
}

// ---------- cameras ----------

interface CameraRow {
  id: string
  name: string
  status: { state: string; fps: number }
}

export function CamerasCard(): ReactElement {
  const navigate = useNavigate()
  const [cams, setCams] = useState<CameraRow[] | null>(null)
  useEffect(() => {
    let live = true
    const load = (): void => {
      api
        .get<CameraRow[]>('/live/cameras')
        .then((c) => live && setCams(c))
        .catch(() => live && setCams(null))
    }
    load()
    const t = window.setInterval(load, 5000)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [])
  const running = cams?.filter((c) => c.status.state === 'running').length ?? 0
  return (
    <div className={card}>
      <Title>Cameras</Title>
      {!cams ? (
        <div className="text-xs text-text-muted">-</div>
      ) : cams.length === 0 ? (
        <div className="text-xs text-text-muted">No cameras added yet.</div>
      ) : (
        <div className="space-y-1">
          <div className="pb-1 text-base font-semibold text-text">
            {running} of {cams.length} live
          </div>
          {cams.slice(0, 5).map((c) => (
            <div key={c.id} className="flex items-center gap-2 text-xs">
              <span className={`h-2 w-2 shrink-0 rounded-full ${stateDot(c.status.state)}`} />
              <span className="min-w-0 flex-1 truncate text-text">{c.name}</span>
              <span className="tabular-nums text-text-muted">{c.status.state === 'running' ? `${c.status.fps.toFixed(0)} fps` : c.status.state}</span>
            </div>
          ))}
        </div>
      )}
      <button className="mt-3 rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text" onClick={() => navigate('/live')}>
        Open Live View
      </button>
    </div>
  )
}
