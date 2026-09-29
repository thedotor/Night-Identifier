import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { api } from '@renderer/lib/api'
import { flagOf, minutesWords, placeName, portLabel, portWords, programName, type TrafficApi, type TrafficDetail, type TrafficHistory, type TrafficLive, type TrafficPlace } from '@renderer/lib/traffic'

/** What the feature reads and keeps, in plain words: shown next to every switch that turns it on. */
export function TrafficPrivacyNote(): ReactElement {
  return (
    <div className="space-y-1 text-[11px] text-text-muted">
      <div>
        Reads this PC&rsquo;s own list of open internet connections, and which program owns each one. It sees <em>where</em> they go, never what is sent or how much. Nothing is captured off the network and no administrator rights are needed.
      </div>
      <div>
        Places come from a database on this PC, so no address is sent to anyone. Local-network addresses are ignored. What you see live is held in memory only. The history keeps country, city and program name (never addresses, ports or pages) for 7 days, encrypted for your Windows account.
      </div>
    </div>
  )
}

const Flag = ({ cc }: { cc: string }): ReactElement => <span className="mr-1 inline-block w-5 text-center text-[10px] font-semibold text-text-muted">{flagOf(cc) || cc}</span>

/** The countries and programs the traffic is going to and coming from right now. */
export function TrafficLists({ live, max = 5 }: { live: TrafficLive; max?: number }): ReactElement {
  const countries = live.countries.slice(0, max)
  const programs = live.programs.slice(0, max)
  if (!countries.length) return <div className="text-xs text-text-muted">No outside connections open right now.</div>
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
      <div>
        <div className="mb-0.5 text-[10px] uppercase tracking-wide text-text-muted">Countries</div>
        {countries.map((c) => (
          <div key={c.cc || c.country} className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-text">
              <Flag cc={c.cc} />
              {c.country || c.cc}
            </span>
            <span className="tabular-nums text-text-muted">{c.n}</span>
          </div>
        ))}
        {live.countries.length > max && <div className="text-[10px] text-text-muted">and {live.countries.length - max} more</div>}
      </div>
      <div>
        <div className="mb-0.5 text-[10px] uppercase tracking-wide text-text-muted">Programs</div>
        {programs.map((p) => (
          <div key={p.name} className="flex items-baseline justify-between gap-2" title={`${p.name}: ${p.n} connections to ${p.countries} ${p.countries === 1 ? 'country' : 'countries'}`}>
            <span className="min-w-0 truncate text-text">{programName(p.name)}</span>
            <span className="tabular-nums text-text-muted">{p.n}</span>
          </div>
        ))}
        {live.programs.length > max && <div className="text-[10px] text-text-muted">and {live.programs.length - max} more</div>}
      </div>
    </div>
  )
}

/** One destination on the globe: where, which programs, and (only when asked) the addresses and their host names. */
export function TrafficDetailCard({ place, onClose }: { place: TrafficPlace; onClose: () => void }): ReactElement {
  const [detail, setDetail] = useState<TrafficDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    setDetail(null)
    setError(null)
  }, [place.id])

  const showAddresses = async (): Promise<void> => {
    setError(null)
    try {
      setDetail(await api.get<TrafficDetail>(`/traffic/place/${encodeURIComponent(place.id)}`))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the addresses')
    }
  }

  const lookUp = async (ip: string): Promise<void> => {
    setBusy(ip)
    try {
      const r = await api.post<{ ip: string; host: string | null }>(`/traffic/place/${encodeURIComponent(place.id)}/host`, { ip })
      setDetail((d) => (d ? { ...d, addresses: d.addresses.map((a) => (a.ip === ip ? { ...a, host: r.host ?? '(no name published)' } : a)) } : d))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="max-w-xs space-y-1 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">
          <span style={{ color: '#e879f9' }}>●</span> {placeName(place)}
        </span>
        <button className="text-text-muted hover:text-text" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="text-text-muted">
        {place.n > 0 ? `${place.n} open ${place.n === 1 ? 'connection' : 'connections'}` : 'Closed a moment ago'} · {place.lat.toFixed(2)}°, {place.lon.toFixed(2)}°
      </div>
      <div>
        {place.procs.map(([name, n]) => (
          <div key={name} className="flex justify-between gap-3">
            <span>{programName(name)}</span>
            <span className="tabular-nums text-text-muted">{n}</span>
          </div>
        ))}
      </div>
      {!detail ? (
        <button className="mt-1 rounded border border-border px-2 py-0.5 hover:border-accent hover:text-text" onClick={() => void showAddresses()}>
          Show addresses
        </button>
      ) : (
        <div className="space-y-1 border-t border-border pt-1">
          {detail.addresses.map((a) => (
            <div key={a.ip} className="space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px]">{a.ip}</span>
                {a.host ? (
                  <span className="min-w-0 truncate text-text-muted" title={a.host}>
                    {a.host}
                  </span>
                ) : (
                  <button
                    className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:border-accent hover:text-text disabled:opacity-50"
                    disabled={busy === a.ip}
                    onClick={() => void lookUp(a.ip)}
                    title="Asks this PC's DNS server for the name of this one address. That is the only step that sends an address anywhere, so it only happens when you click."
                  >
                    {busy === a.ip ? '…' : 'Look up name'}
                  </button>
                )}
              </div>
              <div className="text-[10px] text-text-muted">{a.programs.map(([n, c]) => `${programName(n)} ×${c}`).join(', ')}</div>
              {a.ports.length > 0 && (
                <div className="text-[10px] text-text-muted">
                  {a.ports
                    .slice(0, 3)
                    .map(([port, proto, c]) => `${portLabel(port, proto)}${portWords(port) ? ` (${portWords(port)})` : ''} ×${c}`)
                    .join(', ')}
                </div>
              )}
              {a.org && (
                <div className="text-[10px] text-text-muted" title={a.asn ? `AS${a.asn}` : undefined}>
                  {a.org}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <div className="text-[11px] text-danger">{error}</div>}
      <div className="text-[10px] text-text-muted">A server&rsquo;s place is where its owner registered the address: content networks and clouds often sit far from the site behind them.</div>
    </div>
  )
}

/** The kept history, and the controls that go with it: keep on/off, wipe, and the IP database. */
export function TrafficHistoryView({ traffic }: { traffic: TrafficApi }): ReactElement {
  const status = traffic.status
  const [h, setH] = useState<TrafficHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setH(await api.get<TrafficHistory>('/traffic/history'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the history')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const clear = async (): Promise<void> => {
    if (!window.confirm('Delete all kept web traffic history? This cannot be undone.')) return
    setBusy(true)
    try {
      setH(await api.delete<TrafficHistory>('/traffic/history'))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not clear the history')
    } finally {
      setBusy(false)
    }
  }
  const keep = async (on: boolean): Promise<void> => {
    try {
      await traffic.setHistory(on)
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the setting')
    }
  }
  const updateDb = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.post('/traffic/database/update')
      await traffic.refreshStatus()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the IP database')
    } finally {
      setBusy(false)
    }
  }

  const maxDay = Math.max(1, ...(h?.daily.map((d) => d.minutes) ?? [1]))
  return (
    <div className="space-y-2 text-xs">
      {status && !status.history_available ? (
        <div className="text-warning">History needs Windows account encryption, which is not available here, so none is kept.</div>
      ) : (
        <label className="flex items-center gap-2 text-text-muted">
          <input type="checkbox" className="accent-accent" checked={status?.history ?? true} onChange={(e) => void keep(e.target.checked)} />
          Keep a 7-day history while this is on
        </label>
      )}
      {h && h.rows === 0 ? (
        <div className="text-text-muted">Nothing kept yet.</div>
      ) : h ? (
        <>
          <div className="flex items-end gap-1" aria-label="Minutes connected per day">
            {h.daily.map((d) => (
              <div key={d.day} className="flex max-w-[3.5rem] flex-1 flex-col items-center gap-0.5" title={`${d.day}: about ${minutesWords(d.minutes)} of connections`}>
                <div className="w-full rounded-sm bg-accent/70" style={{ height: `${Math.max(2, (d.minutes / maxDay) * 36)}px` }} />
                <span className="text-[9px] text-text-muted">{d.day.slice(8)}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-4">
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wide text-text-muted">Countries</div>
              {h.countries.slice(0, 8).map((c) => (
                <div key={c.cc || c.country} className="flex items-baseline justify-between gap-2" title={c.cities.join(', ')}>
                  <span className="min-w-0 truncate text-text">
                    <Flag cc={c.cc} />
                    {c.country || c.cc}
                  </span>
                  <span className="whitespace-nowrap tabular-nums text-text-muted">{minutesWords(c.minutes)}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wide text-text-muted">Programs</div>
              {h.programs.slice(0, 8).map((p) => (
                <div key={p.name} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-text">{programName(p.name)}</span>
                  <span className="whitespace-nowrap tabular-nums text-text-muted">{minutesWords(p.minutes)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="text-[10px] text-text-muted">Times are rough: how long a connection to that place was open while the app watched.</div>
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button className="rounded border border-border px-2 py-0.5 text-danger hover:border-danger disabled:opacity-50" disabled={busy || !h || h.rows === 0} onClick={() => void clear()}>
          Clear history
        </button>
        <button className="rounded border border-border px-2 py-0.5 hover:border-accent hover:text-text disabled:opacity-50" disabled={busy} onClick={() => void updateDb()} title="Downloads the newest monthly DB-IP Lite release. It only fetches the database: it sends no addresses.">
          {busy ? 'Working…' : 'Update IP database'}
        </button>
        <span className="text-[10px] text-text-muted">
          {status?.database.available ? `IP database from ${status.database.built}${status.database.downloaded ? ' (downloaded)' : ''}` : 'IP database missing'}
        </span>
      </div>
      {error && <div className="text-danger">{error}</div>}
    </div>
  )
}
