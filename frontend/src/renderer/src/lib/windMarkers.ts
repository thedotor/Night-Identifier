// What is on its way to Earth, as markers for the 3D view and lines for the panel: CMEs (NASA DONKI), high-speed streams (NOAA's
// WSA-Enlil forecast at Earth) and shocks the L1 spacecraft has just seen. Pure (scripts/magnetosphere.check.ts).

import { findShocks, findStreams, l1LeadMinutes, type WindPoint } from './magnetosphere'
import { incomingCmes, relativeTime, type Cme } from './sun'

export interface WindMarkerSpec {
  id: string
  kind: 'cme' | 'stream' | 'shock'
  arrivalMs: number
  speed: number
  label: string
}

export function windMarkers(input: { cmes: Cme[] | null; wind: WindPoint[] | null; enlilRows: number[][] | null }, nowMs: number): WindMarkerSpec[] {
  const out: WindMarkerSpec[] = []
  for (const c of input.cmes ? incomingCmes(input.cmes, nowMs) : []) {
    out.push({ id: `cme:${c.id}`, kind: 'cme', arrivalMs: c.arrival!, speed: c.speed, label: `CME ${Math.round(c.speed)} km/s · reaches Earth ${relativeTime(c.arrival!, nowMs)}` })
  }
  for (const s of input.enlilRows ? findStreams(input.enlilRows) : []) {
    if (s.startMs <= nowMs || s.startMs > nowMs + 6 * 86_400_000) continue
    // the front moves at about the speed it will have on arrival, and no faster than the wind ahead of it allows
    const v = Math.min(s.peakSpeed, Math.max(s.baseSpeed + 60, 450))
    out.push({ id: `stream:${Math.round(s.startMs / 3_600_000)}`, kind: 'stream', arrivalMs: s.startMs, speed: v, label: `High-speed stream to ${Math.round(s.peakSpeed)} km/s (NOAA model) · Earth ${relativeTime(s.startMs, nowMs)}` })
  }
  for (const sh of input.wind ? findShocks(input.wind) : []) {
    const arrival = sh.t + l1LeadMinutes(sh.speedAfter) * 60_000
    if (arrival < nowMs) continue
    out.push({ id: `shock:${sh.t}`, kind: 'shock', arrivalMs: arrival, speed: sh.speedAfter, label: `Shock seen at L1 (${Math.round(sh.speedBefore)} to ${Math.round(sh.speedAfter)} km/s) · Earth ${relativeTime(arrival, nowMs)}` })
  }
  return out
}
