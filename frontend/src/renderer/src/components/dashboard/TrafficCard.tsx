import { useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { TrafficHistoryView, TrafficLists, TrafficPrivacyNote } from '@renderer/components/traffic/TrafficBits'
import { useTraffic } from '@renderer/lib/traffic'

/** Where this PC's web traffic is going right now: top countries and programs, with the 7-day history one click away. Off until switched on. */
export function TrafficCard(): ReactElement {
  const navigate = useNavigate()
  const traffic = useTraffic()
  const [history, setHistory] = useState(false)
  const [busy, setBusy] = useState(false)
  const live = traffic.live

  const toggle = async (on: boolean): Promise<void> => {
    setBusy(true)
    await traffic.setEnabled(on)
    setBusy(false)
  }

  return (
    <div className="h-full rounded-lg border border-border bg-surface p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-text-muted">🌐 Your web traffic</div>
          <div className="text-[11px] text-text-muted">Where this PC&rsquo;s connections go, right now</div>
        </div>
        <div className="flex items-center gap-1.5">
          {traffic.enabled && (
            <button className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:border-accent hover:text-text" onClick={() => navigate('/earth')}>
              On the globe
            </button>
          )}
          <button
            disabled={busy || !traffic.status}
            onClick={() => void toggle(!traffic.enabled)}
            className={`rounded-md border px-2 py-1 text-[11px] disabled:opacity-50 ${traffic.enabled ? 'border-accent bg-accent/20 text-text' : 'border-border text-text-muted hover:border-accent hover:text-text'}`}
          >
            {traffic.enabled ? 'On' : 'Turn on'}
          </button>
        </div>
      </div>

      {traffic.error && !traffic.status ? (
        <div className="text-xs text-danger">Could not reach the traffic service.</div>
      ) : !traffic.status ? (
        <div className="text-xs text-text-muted">Loading…</div>
      ) : !traffic.enabled ? (
        <div className="space-y-2">
          <div className="text-xs text-text-muted">Off. Nothing is read until you turn it on.</div>
          <TrafficPrivacyNote />
        </div>
      ) : (
        <div className="space-y-2">
          {live ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums text-text">{live.connections}</span>
                <span className="text-xs text-text-muted">
                  open connections to {live.places.filter((p) => p.n > 0).length} places in {live.countries.length} {live.countries.length === 1 ? 'country' : 'countries'}
                </span>
              </div>
              <TrafficLists live={live} max={5} />
            </>
          ) : (
            <div className="text-xs text-text-muted">Reading connections…</div>
          )}
          {(live?.error || traffic.status.error) && <div className="text-xs text-warning">{live?.error ?? traffic.status.error}</div>}
          {traffic.status.database.available === false && <div className="text-xs text-warning">The IP location database is missing, so no places can be shown.</div>}
          <button className="text-[11px] text-text-muted underline-offset-2 hover:text-text hover:underline" onClick={() => setHistory((h) => !h)}>
            {history ? 'Hide history' : 'History (last 7 days)'}
          </button>
          {history && <TrafficHistoryView traffic={traffic} />}
          <div className="text-[10px] text-text-muted">Places are estimates from the address alone, and show where a server is registered. {traffic.status.credit}.</div>
        </div>
      )}
    </div>
  )
}
