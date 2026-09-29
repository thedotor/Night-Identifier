import type { ReactElement } from 'react'
import { EARTH_RADIUS_KM } from '@renderer/lib/geomag'
import { bzWords, dstLevel, findShocks, findStreams, l1LeadMinutes, magnetosphereFromWind, stationLevel, windWords, type Tone, type WindPoint } from '@renderer/lib/magnetosphere'
import { incomingCmes, relativeTime, type SunActivity } from '@renderer/lib/sun'
import type { SpaceWeather } from '@renderer/lib/aurora'
import { PanelHeader } from '@renderer/components/deepspace/panelChrome'
import type { DstPayload, EnlilEarth, EnlilFrameInfo, StationsPayload } from './useSpaceEnv'

const TONE: Record<Tone, string> = { quiet: 'text-text', good: 'text-text', great: 'text-warning', warn: 'text-danger' }
const clock = (ms: number): string => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** The chip in Deep Space: the wind at L1, the size of the magnetosphere, the storm level, the busiest magnetometer, and what is on its way. */
export function FieldWindPanel({
  sw,
  dst,
  stations,
  enlilEarth,
  sun,
  frame,
  showFlow,
  live,
  year,
  open,
  onToggle
}: {
  sw: SpaceWeather | null
  dst: DstPayload | null
  stations: StationsPayload | null
  enlilEarth: EnlilEarth | null
  sun: SunActivity | null
  frame: EnlilFrameInfo
  showFlow: boolean
  live: boolean
  year: number
  open: boolean
  onToggle: () => void
}): ReactElement {
  const now = Date.now()
  const w = sw?.solar_wind_now
  const mag = magnetosphereFromWind(w ?? {})
  const wind = windWords(w?.speed)
  const bz = bzWords(w?.bz)
  const dstNow = dst?.now?.[1]
  const dl = dstNow != null ? dstLevel(dstNow) : null
  const busiest = stations?.stations.length ? [...stations.stations].sort((a, b) => b.range_1h - a.range_1h)[0] : null
  const shocks = sw?.solar_wind ? findShocks(sw.solar_wind as WindPoint[]).filter((s) => s.t + l1LeadMinutes(s.speedAfter) * 60_000 > now - 5 * 60_000) : []
  const streams = enlilEarth ? findStreams(enlilEarth.rows).filter((s) => s.startMs > now && s.startMs < now + 6 * 86_400_000) : []
  const cmes = sun ? incomingCmes(sun.cmes, now) : []
  return (
    <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-1.5 text-xs text-text-muted">
      <PanelHeader open={open} onToggle={onToggle}>
        <span style={{ color: '#7ff0dc' }}>🧲</span> Magnetic field and solar wind {live ? 'now' : <span className="text-warning">(live data only for now)</span>}
      </PanelHeader>
      {open && (
        <>
      {w ? (
        <>
          <div>
            Wind at L1: <span className="tabular-nums text-text">{Math.round(w.speed ?? 0)} km/s</span> ({wind.text}) ·{' '}
            <span className="tabular-nums text-text">{(w.density ?? 0).toFixed(1)}</span>/cm³
          </div>
          <div>
            Bz <span className={`tabular-nums ${TONE[bz.tone]}`}>{(w.bz ?? 0).toFixed(1)} nT</span>: {bz.text}
          </div>
          <div title="Where the wind's pressure balances the Earth's magnetic field (Shue 1998), and the bow shock in front of it">
            Magnetopause <span className="tabular-nums text-text">{mag.r0.toFixed(1)}</span> Earth radii ({Math.round((mag.r0 * EARTH_RADIUS_KM) / 1000)} thousand km), bow shock{' '}
            <span className="tabular-nums text-text">{mag.bowNose.toFixed(1)}</span>
          </div>
        </>
      ) : (
        <div>Waiting for the solar wind data…</div>
      )}
      {dl && (
        <div>
          Dst <span className={`tabular-nums ${TONE[dl.tone]}`}>{Math.round(dstNow!)} nT</span>: {dl.label}
        </div>
      )}
      {busiest && (
        <div>
          Busiest ground station: <span className="text-text">{busiest.name}</span> moved <span className={`tabular-nums ${TONE[stationLevel(busiest.range_1h).tone]}`}>{Math.round(busiest.range_1h)} nT</span> in an hour ({stationLevel(busiest.range_1h).label})
        </div>
      )}
      {shocks.map((s) => (
        <div key={s.t} className="text-warning">
          Shock seen at L1 {relativeTime(s.t, now)}: reaches Earth {relativeTime(s.t + l1LeadMinutes(s.speedAfter) * 60_000, now)}
        </div>
      ))}
      {cmes.slice(0, 2).map((c) => (
        <div key={c.id} className="text-warning">
          CME ({Math.round(c.speed)} km/s) arrives {relativeTime(c.arrival!, now)} ({clock(c.arrival!)})
        </div>
      ))}
      {streams.slice(0, 2).map((s) => (
        <div key={s.startMs}>
          High-speed stream (to {Math.round(s.peakSpeed)} km/s, NOAA model) reaches Earth {relativeTime(s.startMs, now)}
        </div>
      ))}
      {showFlow && (
        <div className={frame.covered ? '' : 'text-warning'}>
          {frame.covered
            ? frame.loading && !frame.frameMs
              ? 'Flow map: loading…'
              : `Flow map: NOAA WSA-Enlil, frame of ${frame.frameMs ? clock(frame.frameMs) : '…'}`
            : `Flow map: NOAA's model only covers ${frame.firstMs ? clock(frame.firstMs) : ''} to ${frame.lastMs ? clock(frame.lastMs) : ''}`}
        </div>
      )}
      <div className="text-[10px]" title="IGRF-14 is the field made inside the Earth (the core), valid for 2020 to 2030 here. The bending of the lines by the wind, the magnetopause and the bow shock are typical shapes fitted to many spacecraft crossings for these wind conditions, not measurements of where the boundaries are this minute. The particle stream is sped up: the real wind takes about 4 days to cross.">
        Field: IGRF-14 for {year.toFixed(1)}. Boundaries are typical shapes for this wind; the stream is sped up ~6,000×. Hover for details.
      </div>
      <div className="text-[10px]">Wind: NOAA SWPC (DSCOVR at L1). Ground stations: USGS (US only). Flow: NOAA WSA-Enlil model.</div>
        </>
      )}
    </div>
  )
}
