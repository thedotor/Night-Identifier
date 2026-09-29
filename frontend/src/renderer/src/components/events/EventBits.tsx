import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { KIND_BY_ID, RATING_LABEL, type Rating, type SkyEvent } from '@renderer/lib/eventTypes'
import { eventsToIcs } from '@renderer/lib/eventIcs'
import type { NightSummary } from '@renderer/lib/eventScore'
import type { Place } from '@renderer/lib/skyTonight'
import { relativeTime } from '@renderer/lib/sun'

export const RATING_STYLE: Record<Rating, string> = {
  good: 'border-success/60 bg-success/15 text-success',
  fair: 'border-warning/60 bg-warning/15 text-warning',
  poor: 'border-danger/50 bg-danger/10 text-danger',
  unknown: 'border-border text-text-muted'
}

export const dayLabel = (ms: number): string => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
export const timeLabel = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
export const dateTimeLabel = (ms: number): string => `${dayLabel(ms)}, ${timeLabel(ms)}`

/** The phase emoji for an illuminated percentage and whether it is waxing. */
export function moonEmoji(illumPct: number, waxing: boolean): string {
  const f = illumPct / 100
  if (f < 0.04) return '🌑'
  if (f > 0.96) return '🌕'
  if (f < 0.4) return waxing ? '🌒' : '🌘'
  if (f < 0.6) return waxing ? '🌓' : '🌗'
  return waxing ? '🌔' : '🌖'
}

export function RatingPill({ event }: { event: SkyEvent }): ReactElement | null {
  const s = event.score
  if (!s || s.rating === 'unknown') return null
  return (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium ${RATING_STYLE[s.rating]}`} title={s.reasons.join(' · ')}>
      {RATING_LABEL[s.rating]}
      {s.score != null && s.rating !== 'poor' ? ` ${s.score}` : ''}
    </span>
  )
}

export function KindDot({ kind }: { kind: SkyEvent['kind'] }): ReactElement {
  const k = KIND_BY_ID.get(kind)!
  return (
    <span title={k.label} className="w-5 shrink-0 text-center">
      {k.icon}
    </span>
  )
}

/** One line: icon, title, when, and how good it will be. */
export function EventRow({ e, onClick, selected, showDate = true }: { e: SkyEvent; onClick?: () => void; selected?: boolean; showDate?: boolean }): ReactElement {
  const now = Date.now()
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs ${selected ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/60'} ${e.visible === 'no' ? 'opacity-60' : ''}`}>
      <KindDot kind={e.kind} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-text">{e.title}</span>
        <span className="block truncate text-[11px] text-text-muted">
          {showDate ? dateTimeLabel(e.bestMs ?? e.peakMs) : timeLabel(e.bestMs ?? e.peakMs)}
          {e.peakMs > now ? ` · ${relativeTime(e.peakMs, now)}` : ''}
          {e.visible === 'no' ? ' · not visible from here' : e.visible === 'partly' ? ' · partly visible' : ''}
        </span>
      </span>
      <RatingPill event={e} />
    </button>
  )
}

// ---------- reminders you set by hand ----------

const REMIND_KEY = 'night-identifier:event-reminders'

function readRemind(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(REMIND_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Events you asked to be reminded of (the reminder alert includes these whatever their kind or score). */
export function useReminders(): { has: (id: string) => boolean; toggle: (id: string) => void } {
  const [ids, setIds] = useState(readRemind)
  useEffect(() => {
    const on = (e: StorageEvent): void => {
      if (e.key === REMIND_KEY) setIds(readRemind())
    }
    window.addEventListener('storage', on)
    return () => window.removeEventListener('storage', on)
  }, [])
  const toggle = useCallback((id: string) => {
    setIds((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-200)
      try {
        localStorage.setItem(REMIND_KEY, JSON.stringify(next))
      } catch {
        /* not remembered */
      }
      return next
    })
  }, [])
  return { has: (id) => ids.includes(id), toggle }
}

export const readReminderIds = readRemind

/** Save events as an .ics file the user can open in any calendar program. */
export function downloadIcs(events: SkyEvent[], place: Place | null, filename: string): void {
  const blob = new Blob([eventsToIcs(events, place)], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** The Deep Space address for an event: the body it is about, at the time it happens. */
export function deepSpaceUrl(e: SkyEvent): string | null {
  if (!e.deepSpace) return null
  return `/deep-space?view=solar&focus=${encodeURIComponent(e.deepSpace.focus)}&t=${Math.round(e.deepSpace.whenMs)}`
}

// ---------- one night ----------

export function NightCard({ n, compact = false, onPick, selectedId }: { n: NightSummary; compact?: boolean; onPick?: (e: SkyEvent) => void; selectedId?: string | null }): ReactElement {
  const waxing = n.moonPhase.startsWith('Waxing') || n.moonPhase === 'First quarter'
  return (
    <div className="rounded-lg border border-border bg-bg/40 p-3">
      <div className="flex items-center gap-2">
        <span className="text-xl" title={`${n.moonPhase}, ${Math.round(n.moonIllumPct)}% lit`}>
          {moonEmoji(n.moonIllumPct, waxing)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text">{dayLabel(n.noonMs)}</div>
          <div className="truncate text-[11px] text-text-muted">
            Sunset {n.sunsetMs ? timeLabel(n.sunsetMs) : '–'} · dark {n.darkStartMs && n.darkEndMs ? `${timeLabel(n.darkStartMs)} to ${timeLabel(n.darkEndMs)}` : n.darkHours && n.darkHours > 0 ? 'all night' : 'none'}
          </div>
        </div>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium ${RATING_STYLE[n.rating]}`} title={n.reasons.join(' · ')}>
          {RATING_LABEL[n.rating]} {n.score}
        </span>
      </div>
      {!compact && <div className="mt-1 text-[11px] text-text-muted">{n.reasons.join(' · ')}</div>}
      {n.events.length > 0 && (
        <div className="mt-2 space-y-1">
          {n.events.slice(0, compact ? 3 : 8).map((e) => (
            <EventRow key={e.id} e={e} showDate={false} onClick={onPick ? () => onPick(e) : undefined} selected={selectedId === e.id} />
          ))}
          {compact && n.events.length > 3 && <div className="text-[11px] text-text-muted">+{n.events.length - 3} more</div>}
        </div>
      )}
      {n.events.length === 0 && !compact && <div className="mt-2 text-[11px] text-text-muted">Nothing special is scheduled, but the sky is always worth a look.</div>}
    </div>
  )
}

export { relativeTime }
