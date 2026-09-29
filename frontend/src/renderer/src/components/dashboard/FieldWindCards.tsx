import { useMemo, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { deepspaceSrc } from '@renderer/lib/api'
import { EARTH_RADIUS_KM } from '@renderer/lib/geomag'
import { bzWords, dstLevel, findShocks, findStreams, l1LeadMinutes, magnetosphereFromWind, stationLevel, windWords, type Tone, type WindPoint } from '@renderer/lib/magnetosphere'
import { incomingCmes, relativeTime } from '@renderer/lib/sun'
import { useSpaceWeather } from '@renderer/components/aurora/useAurora'
import { useSunActivity } from '@renderer/components/sun/useSun'
import { useSpaceEnv } from '@renderer/components/space/useSpaceEnv'
import { LineChart } from '@renderer/components/space/LineChart'

const card = 'h-full rounded-lg border border-border bg-surface p-4'
const TONE: Record<Tone, string> = { quiet: 'text-text', good: 'text-text', great: 'text-warning', warn: 'text-danger' }
const TONE_BAR: Record<Tone, string> = { quiet: '#59e08a', good: '#f0e05a', great: '#ff9a3c', warn: '#ff4a3c' }
const dayClock = (ms: number): string => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const parse = (t: string): number => Date.parse(t.endsWith('Z') ? t : `${t}Z`)

function Big({ label, value, unit, sub, tone = 'quiet' }: { label: string; value: string; unit?: string; sub?: string; tone?: Tone }): ReactElement {
  return (
    <div className="min-w-[6.5rem]">
      <div className="text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${TONE[tone]}`}>
        {value}
        {unit && <span className="ml-1 text-xs font-normal text-text-muted">{unit}</span>}
      </div>
      {sub && <div className="text-[11px] text-text-muted">{sub}</div>}
    </div>
  )
}

/** The wind at L1, the size of the magnetosphere, Dst and the ground magnetometers. */
export function FieldWindCard(): ReactElement {
  const navigate = useNavigate()
  const sw = useSpaceWeather(true)
  const env = useSpaceEnv(true)
  const now = Date.now()
  const w = sw.data?.solar_wind_now
  const mag = magnetosphereFromWind(w ?? {})
  const dstNow = env.dst?.now?.[1]
  const dl = dstNow != null ? dstLevel(dstNow) : null
  const speed = sw.data?.solar_wind?.filter((p) => p.speed != null).map((p) => [parse(p.t), p.speed as number] as [number, number]) ?? []
  const bz = sw.data?.solar_wind?.filter((p) => p.bz != null).map((p) => [parse(p.t), p.bz as number] as [number, number]) ?? []
  const stations = env.stations ? [...env.stations.stations].sort((a, b) => b.range_1h - a.range_1h) : []
  const maxRange = Math.max(60, ...stations.map((s) => s.range_1h))
  const dst48 = env.dst?.series.filter((p) => p[0] > now - 48 * 3_600_000) ?? []
  const shocks = sw.data?.solar_wind ? findShocks(sw.data.solar_wind as WindPoint[]).filter((s) => s.t + l1LeadMinutes(s.speedAfter) * 60_000 > now - 5 * 60_000) : []
  return (
    <div className={card}>
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-text-muted">Magnetic field and solar wind</div>
        <button className="rounded-md border border-border px-2 py-1 text-xs text-text-muted hover:border-accent hover:text-text" onClick={() => navigate('/deep-space?view=solar&focus=earth')}>
          See it in 3D
        </button>
      </div>
      {sw.error && !sw.data ? (
        <div className="mt-2 text-xs text-warning">No connection to the space weather data</div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
            <Big label="Wind speed" value={w?.speed != null ? String(Math.round(w.speed)) : '…'} unit="km/s" sub={windWords(w?.speed).text} tone={windWords(w?.speed).tone} />
            <Big label="Density" value={w?.density != null ? w.density.toFixed(1) : '…'} unit="/cm³" />
            <Big label="Bz" value={w?.bz != null ? w.bz.toFixed(1) : '…'} unit="nT" sub={bzWords(w?.bz).text} tone={bzWords(w?.bz).tone} />
            <Big label="Magnetopause" value={mag.r0.toFixed(1)} unit="Re" sub={`${Math.round((mag.r0 * EARTH_RADIUS_KM) / 1000)} thousand km · bow shock ${mag.bowNose.toFixed(1)}`} />
            <Big label="Dst" value={dstNow != null ? String(Math.round(dstNow)) : '…'} unit="nT" sub={dl?.label} tone={dl?.tone} />
          </div>
          {shocks.map((s) => (
            <div key={s.t} className="mt-2 rounded border border-warning/60 bg-warning/10 px-2 py-1 text-xs text-warning">
              Shock seen at L1 {relativeTime(s.t, now)}: reaches Earth {relativeTime(s.t + l1LeadMinutes(s.speedAfter) * 60_000, now)}
            </div>
          ))}
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">Wind speed, last 3 hours</div>
              <LineChart series={[{ points: speed, color: '#59d6ff' }]} nowMs={now} unit="" height={72} formatX={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} />
            </div>
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">Bz (below zero lets energy in)</div>
              <LineChart series={[{ points: bz, color: '#ffb455' }]} refs={[{ y: 0, label: '0' }, { y: -8, label: '-8', color: '#ff6a3d' }]} nowMs={now} height={72} formatX={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} />
            </div>
          </div>
          <div className="mt-3">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">Dst, last 2 days (the storm ring current: below -50 is a storm)</div>
            <LineChart series={[{ points: dst48, color: '#c99bff' }]} refs={[{ y: -50, label: 'storm', color: '#ff9a3c' }, { y: 0, label: '0' }]} yMax={20} nowMs={now} height={72} />
          </div>
          <div className="mt-3">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted" title="How far the ground field moved in the last hour at each USGS observatory (the largest of its three components)">
              Ground magnetometers: nT moved in the last hour
            </div>
            {stations.length === 0 ? (
              <div className="text-xs text-text-muted">{env.error ? 'No connection to the USGS observatories' : 'Loading…'}</div>
            ) : (
              <div className="space-y-0.5">
                {stations.map((s) => {
                  const lv = stationLevel(s.range_1h)
                  return (
                    <div key={s.id} className="flex items-center gap-2 text-[11px]" title={`${s.name}: ${Math.round(s.range_1h)} nT in the last hour, fastest change ${s.max_step.toFixed(1)} nT per minute, field ${(s.f / 1000).toFixed(1)} µT`}>
                      <span className="w-28 shrink-0 truncate text-text-muted">{s.name}</span>
                      <div className="h-2 flex-1 rounded bg-bg">
                        <div className="h-2 rounded" style={{ width: `${Math.min(100, (s.range_1h / maxRange) * 100)}%`, background: TONE_BAR[lv.tone] }} />
                      </div>
                      <span className="w-20 shrink-0 text-right tabular-nums text-text">
                        {Math.round(s.range_1h)} <span className="text-text-muted">{lv.label}</span>
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="mt-1 text-[10px] text-text-muted">The network is US-centred (Alaska, the continental US, Hawaii, Guam, Puerto Rico). High latitudes move most in any storm.</div>
          </div>
        </>
      )}
      <div className="mt-2 text-[10px] text-text-muted">Wind: NOAA SWPC (DSCOVR at L1, ~1.5 million km sunward). Dst: NOAA / Kyoto. Stations: USGS. Boundary sizes are typical shapes for these wind conditions (Shue 1998).</div>
    </div>
  )
}

/** NOAA's WSA-Enlil model: the wind at Earth for the coming week, the model picture, and what is on its way. */
export function WindForecastCard(): ReactElement {
  const navigate = useNavigate()
  const env = useSpaceEnv(true)
  const sun = useSunActivity(true, Date.now())
  const now = Date.now()
  const rows = env.enlilEarth?.rows ?? []
  const speed = rows.map((r) => [r[0], r[1]] as [number, number])
  const dens = rows.map((r) => [r[0], r[2]] as [number, number])
  const streams = useMemo(() => findStreams(rows).filter((s) => s.endMs > now), [rows, now])
  const cmes = sun.data ? incomingCmes(sun.data.cmes, now) : []
  const stamp = Math.floor(now / 3_600_000)
  const img = deepspaceSrc(`/space/enlil/image?panel=velocity&t=${stamp * 3_600_000 + 1_800_000}`)
  return (
    <div className={card}>
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-text-muted">Solar wind forecast</div>
        <button className="rounded-md border border-border px-2 py-1 text-xs text-text-muted hover:border-accent hover:text-text" onClick={() => navigate('/deep-space?view=solar&focus=sun')}>
          Open in Deep Space
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-4">
        <div className="shrink-0" title="NOAA's WSA-Enlil model: the wind's speed in the plane of the planets, out to 1.7 AU. The Sun is at the centre, Earth is the green dot, and the ring is Earth's orbit.">
          <img src={img} alt="NOAA WSA-Enlil model: solar wind speed" className="h-44 w-44 rounded-full bg-black object-cover" />
          <div className="mt-1 w-44 text-center text-[10px] text-text-muted">Speed, now (model)</div>
        </div>
        <div className="min-w-[14rem] flex-1 space-y-3">
          {rows.length === 0 ? (
            <div className="text-xs text-text-muted">{env.error ? 'No connection to NOAA' : 'Loading…'}</div>
          ) : (
            <>
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">Speed at Earth (km/s), model, past and next days</div>
                <LineChart series={[{ points: speed, color: '#59d6ff' }]} refs={[{ y: 500, label: 'fast', color: '#ffb455' }]} nowMs={now} height={80} />
              </div>
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">Density at Earth (per cm³)</div>
                <LineChart series={[{ points: dens, color: '#8fe89a' }]} nowMs={now} height={60} />
              </div>
            </>
          )}
        </div>
      </div>
      <div className="mt-3 space-y-1 text-xs">
        {cmes.map((c) => (
          <div key={c.id} className="rounded border border-warning/60 bg-warning/10 px-2 py-1 text-warning">
            CME ({Math.round(c.speed)} km/s) arrives {relativeTime(c.arrival!, now)} ({dayClock(c.arrival!)}), {c.arrival_source}
          </div>
        ))}
        {streams.map((s) => (
          <div key={s.startMs} className="text-text">
            High-speed stream: {s.startMs > now ? `reaches Earth ${relativeTime(s.startMs, now)} (${dayClock(s.startMs)})` : 'passing now'}, up to <span className="tabular-nums">{Math.round(s.peakSpeed)} km/s</span>
          </div>
        ))}
        {cmes.length === 0 && streams.length === 0 && rows.length > 0 && <div className="text-text-muted">No fast wind or CME is forecast to reach Earth this week</div>}
      </div>
      <div className="mt-2 text-[10px] text-text-muted">NOAA SWPC WSA-Enlil: a forecast model driven by observations of the Sun, not a measurement. Arrival times can be off by half a day or more.</div>
    </div>
  )
}
