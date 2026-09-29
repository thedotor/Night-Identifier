import { useMemo, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { KINDS, RATING_LABEL, type EventKind, type SkyEvent } from '@renderer/lib/eventTypes'
import { planetsNow } from '@renderer/lib/skyTonight'
import { usePlace, parsePlace, tidyCoordinates } from '@renderer/components/dashboard/usePlace'
import { useSkyEvents } from '@renderer/components/events/useSkyEvents'
import { EventRow, KindDot, NightCard, RATING_STYLE, dateTimeLabel, dayLabel, deepSpaceUrl, downloadIcs, relativeTime, timeLabel, useReminders } from '@renderer/components/events/EventBits'

import { usePageState } from '@renderer/lib/pageState'
type Tab = 'tonight' | 'week' | 'upcoming' | 'month'
const TABS: { id: Tab; label: string }[] = [
  { id: 'tonight', label: 'Tonight' },
  { id: 'week', label: 'This week' },
  { id: 'upcoming', label: 'Coming up' },
  { id: 'month', label: 'Month' }
]
const TAB_KEY = 'night-identifier:calendar-tab'
const KINDS_KEY = 'night-identifier:calendar-kinds'
const VISIBLE_KEY = 'night-identifier:calendar-visible-only'
const btn = 'rounded-md border border-border bg-surface px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text disabled:opacity-40'

function readTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY)
    return TABS.some((t) => t.id === v) ? (v as Tab) : 'tonight'
  } catch {
    return 'tonight'
  }
}

function readKinds(): Set<EventKind> {
  try {
    const v = JSON.parse(localStorage.getItem(KINDS_KEY) ?? 'null') as string[] | null
    if (Array.isArray(v)) return new Set(v.filter((k): k is EventKind => KINDS.some((x) => x.kind === k)))
  } catch {
    /* default */
  }
  return new Set(KINDS.map((k) => k.kind))
}

function PlaceForm({ onSaved }: { onSaved?: () => void }): ReactElement {
  const { raw, save } = usePlace()
  const [lat, setLat] = useState(raw?.lat ?? '')
  const [lon, setLon] = useState(raw?.lon ?? '')
  const [err, setErr] = useState<string | null>(null)
  return (
    <form
      className="flex flex-wrap items-center gap-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault()
        const t = tidyCoordinates(lat, lon)
        if (!parsePlace(t.lat, t.lon)) return setErr('Latitude is -90 to 90 and longitude -180 to 180 (west and south negative, or add W / S).')
        save(t.lat, t.lon)
        setErr(null)
        onSaved?.()
      }}
    >
      <label className="flex items-center gap-1 text-text-muted">
        Latitude
        <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="51.5074" className="w-28 rounded border border-border bg-bg px-1.5 py-1 text-text" />
      </label>
      <label className="flex items-center gap-1 text-text-muted">
        Longitude
        <input value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-0.1278" className="w-28 rounded border border-border bg-bg px-1.5 py-1 text-text" />
      </label>
      <button type="submit" className={btn}>
        Save location
      </button>
      {err && <span className="basis-full text-danger">{err}</span>}
    </form>
  )
}

function Detail({ e, place, onClose }: { e: SkyEvent; place: { latDeg: number; lonDeg: number } | null; onClose: () => void }): ReactElement {
  const navigate = useNavigate()
  const rem = useReminders()
  const url = deepSpaceUrl(e)
  const now = Date.now()
  const s = e.score
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start gap-2">
        <KindDot kind={e.kind} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text">{e.title}</div>
          <div className="text-xs text-text-muted">
            {dateTimeLabel(e.bestMs ?? e.peakMs)}
            {e.peakMs > now ? ` · ${relativeTime(e.peakMs, now)}` : ''}
          </div>
        </div>
        <button className="text-text-muted hover:text-text" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-text-muted">{e.detail}</p>
      {e.endMs && e.endMs - e.startMs > 3_600_000 && (
        <div className="mt-2 text-xs text-text-muted">
          From {dateTimeLabel(e.startMs)} to {dateTimeLabel(e.endMs)}
        </div>
      )}
      {e.altDeg != null && e.altDeg > 0 && (
        <div className="mt-1 text-xs text-text-muted">
          Where to look: {Math.round(e.altDeg)}° above the horizon{e.azDeg != null ? `, toward ${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(e.azDeg / 45) % 8]} (${Math.round(e.azDeg)}°)` : ''}.
        </div>
      )}
      {s && s.rating !== 'unknown' && (
        <div className="mt-3">
          <span className={`rounded border px-2 py-0.5 text-xs font-medium ${RATING_STYLE[s.rating]}`}>
            {RATING_LABEL[s.rating]} conditions{s.score != null ? ` (${s.score}/100)` : ''}
          </span>
          <ul className="mt-2 list-disc pl-5 text-xs text-text-muted">
            {s.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div className="mt-1 text-[10px] text-text-muted">Judged from the darkness, the Moon, the cloud forecast (about 10 days ahead) and how high it is, at the best moment. A guide, not a promise.</div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {url && (
          <button className={btn} onClick={() => navigate(url)} title="Open Deep Space at the time of this event, centred on the body it is about">
            Show in 3D
          </button>
        )}
        <button className={btn} onClick={() => downloadIcs([e], place, `${e.id.replace(/[^A-Za-z0-9]+/g, '-')}.ics`)} title="Save this event to a file your calendar program can import">
          Add to my calendar (.ics)
        </button>
        {e.remindable && e.peakMs > now && (
          <button className={`${btn} ${rem.has(e.id) ? '!border-accent !text-text' : ''}`} onClick={() => rem.toggle(e.id)} title="Send a notification before this event (needs the Sky event reminders alert on)">
            {rem.has(e.id) ? '🔔 Reminder set' : '🔔 Remind me'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Sky calendar: tonight, this week, what is coming, and a month view, for your location. */
export function Calendar(): ReactElement {
  const { place } = usePlace()
  const ev = useSkyEvents(place)
  const [tab, setTabState] = useState<Tab>(readTab)
  const [kinds, setKinds] = useState<Set<EventKind>>(readKinds)
  const [visibleOnly, setVisibleOnly] = useState(() => {
    try {
      return localStorage.getItem(VISIBLE_KEY) !== 'off'
    } catch {
      return true
    }
  })
  const [selected, setSelected] = useState<SkyEvent | null>(null)
  const [editPlace, setEditPlace] = useState(false)
  const [month, setMonth] = usePageState('calendar', 'month', (() => {
    const d = new Date()
    return { y: d.getFullYear(), m: d.getMonth() }
  })(), (v) => {
    const o = v as { y?: unknown; m?: unknown }
    return typeof o?.y === 'number' && typeof o?.m === 'number' && o.m >= 0 && o.m < 12 ? { y: o.y, m: o.m } : undefined
  })
  const [day, setDay] = usePageState<number | null>('calendar', 'day', null, (v) => (typeof v === 'number' ? v : undefined))

  const setTab = (t: Tab): void => {
    setTabState(t)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      /* not remembered */
    }
  }
  const toggleKind = (k: EventKind): void =>
    setKinds((cur) => {
      const next = new Set(cur)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      try {
        localStorage.setItem(KINDS_KEY, JSON.stringify([...next]))
      } catch {
        /* not remembered */
      }
      return next
    })

  const now = Date.now()
  const shown = useMemo(() => ev.events.filter((e) => kinds.has(e.kind) && (!visibleOnly || e.visible !== 'no')), [ev.events, kinds, visibleOnly])
  const upcoming = useMemo(() => shown.filter((e) => (e.endMs ?? e.peakMs) >= now - 3_600_000), [shown, now])
  const nights = useMemo(() => ev.nights.map((n) => ({ ...n, events: n.events.filter((e) => kinds.has(e.kind)) })), [ev.nights, kinds])
  const tonight = nights[0]
  const planets = useMemo(() => {
    if (!place || !tonight) return []
    const t = tonight.darkStartMs ? tonight.darkStartMs + 3_600_000 : (tonight.sunsetMs ?? now) + 2 * 3_600_000
    return planetsNow(place, new Date(t)).filter((p) => p.altDeg > 5 && p.magnitude < 6.5)
  }, [place, tonight, now])

  const grouped = useMemo(() => {
    const g = new Map<string, SkyEvent[]>()
    for (const e of upcoming) {
      const k = new Date(e.peakMs).toLocaleDateString([], { month: 'long', year: 'numeric' })
      g.set(k, [...(g.get(k) ?? []), e])
    }
    return [...g.entries()]
  }, [upcoming])

  // month grid
  const monthDays = useMemo(() => {
    const first = new Date(month.y, month.m, 1)
    const lead = (first.getDay() + 6) % 7 // weeks start on Monday
    const count = new Date(month.y, month.m + 1, 0).getDate()
    const cells: { d: number | null; events: SkyEvent[] }[] = Array.from({ length: lead }, () => ({ d: null, events: [] }))
    for (let d = 1; d <= count; d++) {
      const s = new Date(month.y, month.m, d).getTime()
      cells.push({ d, events: shown.filter((e) => e.peakMs >= s && e.peakMs < s + 86_400_000) })
    }
    return cells
  }, [month, shown])

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-text">Sky calendar</h1>
          <p className="mt-0.5 text-xs text-text-muted">
            {place ? `Nights and events for ${place.latDeg.toFixed(2)}°, ${place.lonDeg.toFixed(2)}°: computed here from real astronomy, with NASA and NOAA data and a cloud forecast.` : 'Set your location to see what happens in your sky.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className={btn} onClick={() => setEditPlace((v) => !v)}>
            {place ? 'Change location' : 'Set location'}
          </button>
          <button className={btn} disabled={!upcoming.length} onClick={() => downloadIcs(upcoming, place, 'night-identifier-sky-events.ics')} title="Save every event currently shown (the filters apply) as an .ics file for Google, Outlook or Apple Calendar">
            Export shown events (.ics)
          </button>
        </div>
      </div>
      {(editPlace || !place) && (
        <div className="mt-3 rounded-lg border border-border bg-surface p-3">
          <PlaceForm onSaved={() => setEditPlace(false)} />
        </div>
      )}

      {place && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            {TABS.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} className={`rounded-md border px-3 py-1.5 text-xs font-medium ${tab === t.id ? 'border-accent bg-accent/20 text-text' : 'border-border text-text-muted hover:text-text'}`}>
                {t.label}
              </button>
            ))}
            <span className="mx-2 h-5 w-px bg-border" />
            <label className="flex cursor-pointer items-center gap-1 text-xs text-text-muted hover:text-text" title="Hide events that cannot be seen from your location (the Moon and seasons are unaffected)">
              <input
                type="checkbox"
                checked={visibleOnly}
                onChange={(e) => {
                  setVisibleOnly(e.target.checked)
                  try {
                    localStorage.setItem(VISIBLE_KEY, e.target.checked ? 'on' : 'off')
                  } catch {
                    /* not remembered */
                  }
                }}
                className="accent-accent"
              />
              Only what I can see
            </label>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {KINDS.map((k) => (
              <button key={k.kind} onClick={() => toggleKind(k.kind)} className={`rounded-full border px-2.5 py-0.5 text-[11px] ${kinds.has(k.kind) ? 'border-accent/70 text-text' : 'border-border text-text-muted opacity-60'}`} title={kinds.has(k.kind) ? `Hide ${k.label.toLowerCase()}` : `Show ${k.label.toLowerCase()}`}>
                {k.icon} {k.label}
              </button>
            ))}
          </div>

          {ev.loading && (
            <div className="mt-4 rounded-md border border-border bg-surface px-3 py-2 text-xs text-text-muted">Working out a year of events{ev.stage ? ` (${ev.stage})` : ''}…</div>
          )}
          {ev.error && <div className="mt-4 rounded-md border border-danger/50 px-3 py-2 text-xs text-danger">{ev.error}</div>}
          {!ev.hasForecast && !ev.loading && ev.events.length > 0 && <div className="mt-3 text-[11px] text-warning">The cloud forecast could not be loaded (offline?): ratings use the Moon and darkness only.</div>}

          <div className={`mt-4 grid gap-4 ${selected ? 'lg:grid-cols-[minmax(0,1fr)_22rem]' : ''}`}>
            <div className="min-w-0">
              {tab === 'tonight' && tonight && (
                <div className="space-y-4">
                  <NightCard n={tonight} onPick={setSelected} selectedId={selected?.id} />
                  {planets.length > 0 && (
                    <div className="rounded-lg border border-border bg-surface p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">Planets you can see tonight</div>
                      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                        {planets.map((p) => (
                          <span key={p.name} className="text-text">
                            {p.name} <span className="text-text-muted">mag {p.magnitude.toFixed(1)}, {Math.round(p.altDeg)}° {['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(p.azDeg / 45) % 8]}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div>
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Next few days</div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {upcoming
                        .filter((e) => e.kind !== 'moon' && e.kind !== 'season')
                        .slice(0, 6)
                        .map((e) => (
                          <EventRow key={e.id} e={e} onClick={() => setSelected(e)} selected={selected?.id === e.id} />
                        ))}
                    </div>
                  </div>
                </div>
              )}
              {tab === 'week' && (
                <div className="grid gap-3 md:grid-cols-2">
                  {nights.slice(0, 7).map((n) => (
                    <NightCard key={n.noonMs} n={n} onPick={setSelected} selectedId={selected?.id} />
                  ))}
                </div>
              )}
              {tab === 'upcoming' && (
                <div className="space-y-5">
                  {grouped.length === 0 && !ev.loading && <div className="text-sm text-text-muted">Nothing matches these filters.</div>}
                  {grouped.map(([m, list]) => (
                    <div key={m}>
                      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">{m}</div>
                      <div className="grid gap-1.5 md:grid-cols-2">
                        {list.map((e) => (
                          <EventRow key={e.id} e={e} onClick={() => setSelected(e)} selected={selected?.id === e.id} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {tab === 'month' && (
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <button className={btn} onClick={() => setMonth((m) => (m.m === 0 ? { y: m.y - 1, m: 11 } : { y: m.y, m: m.m - 1 }))}>
                      ‹
                    </button>
                    <div className="w-40 text-center text-sm font-semibold text-text">{new Date(month.y, month.m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })}</div>
                    <button className={btn} onClick={() => setMonth((m) => (m.m === 11 ? { y: m.y + 1, m: 0 } : { y: m.y, m: m.m + 1 }))}>
                      ›
                    </button>
                    <button
                      className={btn}
                      onClick={() => {
                        const d = new Date()
                        setMonth({ y: d.getFullYear(), m: d.getMonth() })
                      }}
                    >
                      Today
                    </button>
                  </div>
                  <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-text-muted">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                      <div key={d}>{d}</div>
                    ))}
                  </div>
                  <div className="mt-1 grid grid-cols-7 gap-1">
                    {monthDays.map((c, i) => {
                      const isToday = c.d !== null && new Date().getFullYear() === month.y && new Date().getMonth() === month.m && new Date().getDate() === c.d
                      const notable = c.events
                      return (
                        <button
                          key={i}
                          disabled={c.d === null}
                          onClick={() => setDay(c.d)}
                          className={`min-h-16 rounded border p-1 text-left text-[11px] ${c.d === null ? 'border-transparent' : day === c.d ? 'border-accent bg-accent/10' : isToday ? 'border-accent/60' : 'border-border hover:border-accent/50'}`}
                        >
                          {c.d !== null && (
                            <>
                              <div className="text-text-muted">{c.d}</div>
                              <div className="flex flex-wrap gap-0.5 text-[13px] leading-none">
                                {notable.slice(0, 5).map((e) => (
                                  <span key={e.id} title={e.title}>
                                    {e.kind === 'moon' ? (/^(Full|Super)/.test(e.title) ? '🌕' : /^New/.test(e.title) ? '🌑' : /^First/.test(e.title) ? '🌓' : '🌗') : KINDS.find((k) => k.kind === e.kind)?.icon}
                                  </span>
                                ))}
                                {notable.length > 5 && <span className="text-text-muted">+{notable.length - 5}</span>}
                              </div>
                            </>
                          )}
                        </button>
                      )
                    })}
                  </div>
                  {day !== null && (
                    <div className="mt-3 space-y-1.5">
                      <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">{dayLabel(new Date(month.y, month.m, day).getTime())}</div>
                      {(monthDays.find((c) => c.d === day)?.events ?? []).length === 0 && <div className="text-xs text-text-muted">No events this day.</div>}
                      {(monthDays.find((c) => c.d === day)?.events ?? []).map((e) => (
                        <EventRow key={e.id} e={e} showDate={false} onClick={() => setSelected(e)} selected={selected?.id === e.id} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            {selected && (
              <div className="lg:sticky lg:top-4 lg:self-start">
                <Detail e={selected} place={place} onClose={() => setSelected(null)} />
              </div>
            )}
          </div>
          <div className="mt-6 text-[10px] text-text-muted">
            Times are shown in this computer's time zone. Astronomy: astronomy-engine (Moon, planets, eclipses), IMO meteor shower calendar, NASA/JPL (comets, asteroids), NOAA (space weather), Open-Meteo (cloud). Comet brightness is a prediction from catalogue numbers and often wrong; satellite passes
            are only worked out 10 days ahead.{' '}
            {timeLabel(now) && ev.at ? `Computed at ${timeLabel(ev.at)}.` : ''}
          </div>
        </>
      )}
    </div>
  )
}
