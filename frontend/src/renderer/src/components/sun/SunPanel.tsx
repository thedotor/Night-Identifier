import type { ReactElement } from 'react'
import { PanelHeader } from '@renderer/components/deepspace/panelChrome'
import { SURFACE_KINDS, cmeDirection, cmeFront, cmeVisible, flareWords, incomingCmes, radioBlackout, relativeTime, strongestFlare, type SunActivity, type SurfaceKind } from '@renderer/lib/sun'

const utc = (iso: string | null): string => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '…')
const dayTime = (ms: number): string => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** The Sun chip in Deep Space: what it is doing at the scene's date, and what the pictures on it are. */
export function SunPanel({
  activity,
  error,
  sceneMs,
  kind,
  surfaceTime,
  coronaTime,
  loading,
  open,
  onToggle
}: {
  activity: SunActivity | null
  error: string | null
  sceneMs: number
  kind: SurfaceKind
  surfaceTime: string | null
  coronaTime: string | null
  loading: boolean
  open: boolean
  onToggle: () => void
}): ReactElement {
  const now = Date.now()
  const live = activity?.live ?? Math.abs(sceneMs - now) < 45 * 60_000
  const flare = activity ? strongestFlare(activity.flares, live ? now : sceneMs, 24) : null
  const inFlight = activity ? activity.cmes.filter((c) => cmeVisible(c, sceneMs)) : []
  const incoming = activity && live ? incomingCmes(activity.cmes, now) : []
  const label = SURFACE_KINDS.find((k) => k.kind === kind)?.label ?? kind
  return (
    <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-1.5 text-xs text-text-muted">
      <PanelHeader open={open} onToggle={onToggle}>
        <span style={{ color: '#ffb455' }}>☀</span> {live ? 'The Sun now' : `The Sun on ${new Date(sceneMs).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`}
        {loading && <span className="ml-1">(loading…)</span>}
      </PanelHeader>
      {open && (
        <>
      {error && !activity && <div className="text-warning">No connection to the solar data ({error})</div>}
      {activity?.xray && live && (
        <div title={flareWords(activity.xray.class)}>
          X-rays: <span className="tabular-nums text-text">{activity.xray.class}</span>
          <span> · {activity.xray.class[0] === 'X' || activity.xray.class[0] === 'M' ? 'flaring' : activity.xray.class[0] === 'C' ? 'small flares' : 'quiet'}</span>
        </div>
      )}
      {flare && (
        <div title={flareWords(flare.class)}>
          Strongest flare {live ? 'in 24 h' : 'that day'}: <span className="tabular-nums text-text">{flare.class}</span> at {dayTime(flare.peak)}
          {radioBlackout(flare.class) && <span> · radio blackout {radioBlackout(flare.class)}</span>}
        </div>
      )}
      {activity && !flare && <div>No notable flares in the day before</div>}
      {live && activity && activity.regions.length > 0 && (
        <div>
          Sunspot groups on the disc: <span className="tabular-nums text-text">{activity.regions.length}</span>
        </div>
      )}
      {activity && (
        <div>
          CMEs travelling out: <span className="tabular-nums text-text">{inFlight.length}</span>
          {inFlight.length > 0 && <span> (fastest {Math.round(Math.max(...inFlight.map((c) => c.speed)))} km/s)</span>}
        </div>
      )}
      {incoming.length > 0 && (
        <div className="text-warning">
          Heading for Earth: arrives {relativeTime(incoming[0].arrival!, now)} ({dayTime(incoming[0].arrival!)}), {incoming[0].arrival_source}
        </div>
      )}
      {activity && live && incoming.length === 0 && <div>No CME is forecast to hit Earth</div>}
      {inFlight.slice(0, 1).map((c) => (
        <div key={c.id} className="text-[10px]">
          Latest: {Math.round(c.speed)} km/s, {cmeDirection(c)}, now {cmeFront(c, sceneMs).toFixed(0)} solar radii out
        </div>
      ))}
      <div className="text-[10px]" title="The far side of the Sun is not observed from Earth: it shows a dimmed mirror of the near side. The corona sheets turn to face you from anywhere, so they are only exact when seen from Earth.">
        {label}, taken {utc(surfaceTime)}
        {coronaTime && ` · corona (SOHO) ${utc(coronaTime)}`}. Far side: a dimmed mirror, not observed.
      </div>
      <div className="text-[10px]">{activity?.credit ?? 'Solar images: NASA SDO and SOHO via Helioviewer. Activity: NOAA SWPC and NASA DONKI.'}</div>
        </>
      )}
    </div>
  )
}
