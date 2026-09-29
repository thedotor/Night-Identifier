// Where this PC's web traffic goes: the shapes the backend sends (see backend app/services/traffic.py) and one shared
// store for them. Every view that shows traffic (the 3D Earth, the dashboard card) reads the same store, so there is one
// on/off switch, kept by the backend, and one poll however many views are open.

import { useSyncExternalStore } from 'react'
import { api } from '@renderer/lib/api'

export interface TrafficPlace {
  id: string
  lat: number
  lon: number
  city: string
  country: string
  cc: string
  /** connections open right now (0 while a closed one is still fading out) */
  n: number
  /** programs with the most connections there: [name, connections] */
  procs: [string, number][]
  /** seconds since a connection there was last seen */
  age_s: number
}

export interface TrafficLive {
  enabled: boolean
  updated_ms: number
  connections: number
  places: TrafficPlace[]
  countries: { cc: string; country: string; n: number; places: number }[]
  programs: { name: string; n: number; countries: number }[]
  error: string | null
  credit: string
}

export interface TrafficStatus {
  enabled: boolean
  history: boolean
  history_available: boolean
  running: boolean
  samples: number
  error: string | null
  database: { available: boolean; built?: string; downloaded?: boolean; credit: string }
  credit: string
}

export interface TrafficDetail {
  id: string
  city: string
  country: string
  cc: string
  addresses: { ip: string; programs: [string, number][]; ports: [number, 'TCP' | 'UDP', number][]; host: string | null; asn: number | null; org: string | null }[]
}

/** Well-known ports, for a plain-language guess of what a connection is (not a claim - any program can use any port). */
const PORT_WORDS: Record<number, string> = {
  80: 'web (HTTP)',
  443: 'web (HTTPS)',
  22: 'SSH',
  21: 'FTP',
  25: 'email (SMTP)',
  465: 'email (SMTPS)',
  587: 'email (SMTP submission)',
  110: 'email (POP3)',
  143: 'email (IMAP)',
  993: 'email (IMAPS)',
  995: 'email (POP3S)',
  53: 'DNS',
  123: 'time (NTP)',
  3389: 'Remote Desktop',
  1194: 'VPN (OpenVPN)',
  51820: 'VPN (WireGuard)',
  3478: 'video/voice call (STUN/TURN)',
  5060: 'voice call (SIP)',
  6881: 'BitTorrent'
}

/** A plain-language guess for a port, or null if it isn't a well-known one. */
export const portWords = (port: number): string | null => PORT_WORDS[port] ?? null

/** "443/TCP" style label for a port and protocol. */
export const portLabel = (port: number, proto: string): string => `${port}/${proto}`

export interface TrafficHistory {
  days: number
  keeping: boolean
  encrypted: boolean
  rows: number
  countries: { cc: string; country: string; minutes: number; cities: string[] }[]
  programs: { name: string; minutes: number; countries: number }[]
  daily: { day: string; minutes: number }[]
}

interface Snapshot {
  status: TrafficStatus | null
  live: TrafficLive | null
  error: string | null
}

const LIVE_MS = 3000
const IDLE_MS = 8000

let snap: Snapshot = { status: null, live: null, error: null }
const listeners = new Set<() => void>()
let timer: number | null = null
let busy = false

const publish = (next: Partial<Snapshot>): void => {
  snap = { ...snap, ...next }
  listeners.forEach((l) => l())
}

async function poll(): Promise<void> {
  if (busy) return
  busy = true
  try {
    if (!snap.status?.enabled) {
      const status = await api.get<TrafficStatus>('/traffic/status')
      publish({ status, live: null, error: null })
      if (!status.enabled) return
    }
    const live = await api.get<TrafficLive>('/traffic/live')
    // the switch was turned off elsewhere (another window): follow it
    publish({ live: live.enabled ? live : null, error: null, status: live.enabled || !snap.status ? snap.status : { ...snap.status, enabled: false } })
  } catch (e) {
    publish({ error: e instanceof Error ? e.message : 'could not reach the traffic service' })
  } finally {
    busy = false
  }
}

function schedule(): void {
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    void poll().finally(() => {
      if (listeners.size) schedule()
      else timer = null
    })
  }, snap.status?.enabled ? LIVE_MS : IDLE_MS)
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  if (listeners.size === 1) {
    void poll().finally(() => {
      if (listeners.size) schedule()
    })
  }
  return () => {
    listeners.delete(l)
    if (!listeners.size && timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  }
}

/** Switch reading this PC's connections on or off (the backend remembers it). */
async function setEnabled(on: boolean): Promise<void> {
  try {
    const status = await api.put<TrafficStatus>('/traffic/enabled', { enabled: on })
    publish({ status, live: on ? snap.live : null, error: null })
    if (on) {
      await poll()
      schedule()
    }
  } catch (e) {
    publish({ error: e instanceof Error ? e.message : 'could not change the traffic setting' })
  }
}

async function setHistory(keep: boolean): Promise<void> {
  const status = await api.put<TrafficStatus>('/traffic/history/keep', { keep })
  publish({ status })
}

async function refreshStatus(): Promise<void> {
  publish({ status: await api.get<TrafficStatus>('/traffic/status') })
}

export interface TrafficApi extends Snapshot {
  enabled: boolean
  setEnabled: (on: boolean) => Promise<void>
  setHistory: (keep: boolean) => Promise<void>
  refreshStatus: () => Promise<void>
}

const actions = { setEnabled, setHistory, refreshStatus }

/** The shared traffic state. The first component to use it starts the polling; the last to leave stops it. */
export function useTraffic(): TrafficApi {
  const s = useSyncExternalStore(subscribe, () => snap)
  return { ...s, enabled: !!s.status?.enabled, ...actions }
}

export { flagOf, minutesWords, placeName, programName } from './trafficText'
