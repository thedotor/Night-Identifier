import { useEffect, useRef, useState, type ReactElement } from 'react'
import { api, LogEntry, LogLevel, wsUrl } from '@renderer/lib/api'

import { usePageState } from '@renderer/lib/pageState'
const LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']
const MAX_DISPLAYED = 1000

const LEVEL_COLOR: Record<LogLevel, string> = {
  DEBUG: 'text-text-muted',
  INFO: 'text-text',
  WARNING: 'text-warning',
  ERROR: 'text-danger',
  CRITICAL: 'text-danger'
}

export function Log(): ReactElement {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [levelFilter, setLevelFilter] = usePageState<LogLevel | 'ALL'>('log', 'level', 'ALL', (v) => (typeof v === 'string' ? (v as LogLevel | 'ALL') : undefined))
  const [autoScroll, setAutoScroll] = usePageState('log', 'autoScroll', true, (v) => (typeof v === 'boolean' ? v : undefined))
  const [connected, setConnected] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.get<LogEntry[]>('/logs?limit=500').then(setEntries).catch(() => {})
  }, [])

  useEffect(() => {
    const ws = new WebSocket(wsUrl('/logs/ws'))
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (msg) => {
      const entry = JSON.parse(msg.data) as LogEntry
      setEntries((prev) => [...prev, entry].slice(-MAX_DISPLAYED))
    }
    return () => ws.close()
  }, [])

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [entries, autoScroll])

  const visible = entries.filter((e) => levelFilter === 'ALL' || e.level === levelFilter)

  return (
    <div className="flex h-full flex-col p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Log</h1>
          <p className="mt-2 text-sm text-text-muted">Application and event log.</p>
        </div>
        <span
          className={`flex items-center gap-1.5 text-xs ${connected ? 'text-success' : 'text-text-muted'}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-success' : 'bg-text-muted'}`} />
          {connected ? 'Live' : 'Disconnected'}
        </span>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value as LogLevel | 'ALL')}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
        >
          <option value="ALL">All levels</option>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          Auto-scroll
        </label>
        <span className="text-xs text-text-muted">{visible.length} entries</span>
      </div>

      <div
        ref={scrollRef}
        className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-bg p-3 font-mono text-xs"
      >
        {visible.length === 0 && <div className="text-text-muted">No log entries yet.</div>}
        {visible.map((e) => (
          <div key={e.id} className="flex gap-2 py-0.5">
            <span className="shrink-0 text-text-muted">
              {new Date(e.timestamp).toLocaleTimeString()}
            </span>
            <span className={`w-16 shrink-0 font-semibold ${LEVEL_COLOR[e.level] ?? 'text-text'}`}>
              {e.level}
            </span>
            <span className="shrink-0 text-text-muted">[{e.source}]</span>
            <span className="text-text">{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
