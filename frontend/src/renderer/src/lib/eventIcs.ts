// Export events as an iCalendar (.ics) file that Google Calendar, Outlook, Apple Calendar and others can import. Pure.

import type { Place } from './skyTonight'
import { KIND_BY_ID, type SkyEvent } from './eventTypes'

const pad = (n: number): string => String(n).padStart(2, '0')

/** 20261012T101500Z */
export function icsTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

/** Text values: backslash, semicolon, comma and newlines are escaped (RFC 5545 3.3.11). */
export const icsEscape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

/** Lines may not be longer than 75 octets: fold them with CRLF + space (counting UTF-8 bytes, never splitting a character). */
export function icsFold(line: string): string {
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return line
  const parts: string[] = []
  let cur = ''
  let bytes = 0
  let limit = 75
  for (const ch of line) {
    const b = enc.encode(ch).length
    if (bytes + b > limit) {
      parts.push(cur)
      cur = ch
      bytes = b
      limit = 74 // continuation lines start with a space
    } else {
      cur += ch
      bytes += b
    }
  }
  parts.push(cur)
  return parts.join('\r\n ')
}

/** A whole calendar. `nowMs` is the DTSTAMP. */
export function eventsToIcs(events: SkyEvent[], place: Place | null, nowMs = Date.now()): string {
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Night Identifier//Sky events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Night Identifier sky events']
  for (const e of events) {
    const start = e.startMs
    const end = e.endMs && e.endMs > e.startMs ? e.endMs : e.startMs + 3_600_000
    const score = e.score?.score != null ? ` Viewing from your location: ${e.score.rating} (${e.score.score}/100; ${e.score.reasons.join(', ')}).` : ''
    lines.push('BEGIN:VEVENT', `UID:${icsEscape(e.id)}@night-identifier`, `DTSTAMP:${icsTime(nowMs)}`, `DTSTART:${icsTime(start)}`, `DTEND:${icsTime(end)}`, `SUMMARY:${icsEscape(`${KIND_BY_ID.get(e.kind)?.icon ?? ''} ${e.title}`.trim())}`, `DESCRIPTION:${icsEscape(`${e.detail}${score}`)}`, `CATEGORIES:${icsEscape(KIND_BY_ID.get(e.kind)?.label ?? e.kind)}`)
    if (place) lines.push(`GEO:${place.latDeg.toFixed(4)};${place.lonDeg.toFixed(4)}`)
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(icsFold).join('\r\n') + '\r\n'
}
