import { useMemo, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { RATING_LABEL } from '@renderer/lib/eventTypes'
import { highlights } from '@renderer/lib/skyCalendar'
import { useSkyEvents } from '@renderer/components/events/useSkyEvents'
import { EventRow, NightCard, RATING_STYLE, dayLabel, moonEmoji } from '@renderer/components/events/EventBits'
import type { Place } from '@renderer/lib/skyTonight'

const card = 'h-full rounded-lg border border-border bg-surface p-4'
const head = 'text-xs uppercase tracking-wide text-text-muted'

function Setup(): ReactElement {
  return <div className="mt-2 text-xs text-text-muted">Set your location on the Dashboard (or in the Sky Calendar) to see the events in your sky.</div>
}

function Open({ label = 'Open the calendar' }: { label?: string }): ReactElement {
  const navigate = useNavigate()
  return (
    <button className="rounded-md border border-border px-2 py-1 text-xs text-text-muted hover:border-accent hover:text-text" onClick={() => navigate('/calendar')}>
      {label}
    </button>
  )
}

/** Tonight: the night's quality, when it is dark, the Moon, and what is on. */
export function EventsTonightCard({ place }: { place: Place | null }): ReactElement {
  const ev = useSkyEvents(place)
  const n = ev.nights[0]
  return (
    <div className={card}>
      <div className="flex items-center justify-between">
        <div className={head}>Tonight's sky</div>
        <Open />
      </div>
      {!place ? (
        <Setup />
      ) : !n ? (
        <div className="mt-2 text-xs text-text-muted">{ev.error ?? `Working it out${ev.stage ? ` (${ev.stage})` : ''}…`}</div>
      ) : (
        <div className="mt-3">
          <NightCard n={n} compact />
          <div className="mt-1 text-[11px] text-text-muted">{n.reasons.join(' · ')}</div>
        </div>
      )}
    </div>
  )
}

/** The next seven nights at a glance. */
export function EventsWeekCard({ place }: { place: Place | null }): ReactElement {
  const ev = useSkyEvents(place)
  const navigate = useNavigate()
  return (
    <div className={card}>
      <div className="flex items-center justify-between">
        <div className={head}>This week's nights</div>
        <Open label="Week view" />
      </div>
      {!place ? (
        <Setup />
      ) : ev.nights.length === 0 ? (
        <div className="mt-2 text-xs text-text-muted">{ev.error ?? `Working it out${ev.stage ? ` (${ev.stage})` : ''}…`}</div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {ev.nights.slice(0, 7).map((n) => (
            <button key={n.noonMs} onClick={() => navigate('/calendar')} className="rounded-lg border border-border bg-bg/40 p-2 text-left hover:border-accent/60" title={`${n.moonPhase}, ${Math.round(n.moonIllumPct)}% lit. ${n.reasons.join(' · ')}`}>
              <div className="flex items-center justify-between text-xs text-text">
                <span>{dayLabel(n.noonMs)}</span>
                <span className="text-lg">{moonEmoji(n.moonIllumPct, n.moonPhase.startsWith('Waxing') || n.moonPhase === 'First quarter')}</span>
              </div>
              <div className={`mt-1 inline-block rounded border px-1.5 py-0.5 text-[11px] font-medium ${RATING_STYLE[n.rating]}`}>
                {RATING_LABEL[n.rating]} {n.score}
              </div>
              <div className="mt-1 text-[11px] text-text-muted">{n.darkHours && n.darkHours > 0 ? `${n.darkHours.toFixed(1)} h dark` : 'no full dark'}</div>
              <div className="text-[11px] text-text-muted">{n.cloudAvg != null ? `cloud ${Math.round(n.cloudAvg)}%` : 'no forecast'}</div>
              {n.events.length > 0 && <div className="mt-1 truncate text-[11px] text-text">{n.events[0].title}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The most interesting events coming up. */
export function EventsUpcomingCard({ place }: { place: Place | null }): ReactElement {
  const ev = useSkyEvents(place)
  const navigate = useNavigate()
  const list = useMemo(() => highlights(ev.events, Date.now(), 8), [ev.events])
  return (
    <div className={card}>
      <div className="flex items-center justify-between">
        <div className={head}>Coming up</div>
        <Open label="All events" />
      </div>
      {!place ? (
        <Setup />
      ) : list.length === 0 ? (
        <div className="mt-2 text-xs text-text-muted">{ev.error ?? (ev.loading ? `Working it out${ev.stage ? ` (${ev.stage})` : ''}…` : 'Nothing notable is coming up from your location.')}</div>
      ) : (
        <div className="mt-3 space-y-1.5">
          {list.map((e) => (
            <EventRow key={e.id} e={e} onClick={() => navigate('/calendar')} />
          ))}
        </div>
      )}
    </div>
  )
}
