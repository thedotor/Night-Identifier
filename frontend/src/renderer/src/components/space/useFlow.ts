import { useEffect, useRef, useState } from 'react'
import { fetchFlow, FlowNoData, type FlowGrid, type FlowKind, type WindLevel } from '@renderer/lib/flow'

export interface FlowState {
  grid: FlowGrid | null
  status: 'off' | 'loading' | 'live' | 'nodata' | 'error'
  message?: string
}

const HOUR = 3_600_000
const REFRESH_MS = 20 * 60_000

/**
 * The wind or current field for the scene's date: the wind changes every 3 hours (analysis and forecast), the currents every hour.
 * The last good picture stays on screen while the next one loads, and again if the connection drops.
 */
export function useFlowGrid(kind: FlowKind, enabled: boolean, level: WindLevel, sceneMs: number): FlowState {
  const [state, setState] = useState<FlowState>({ grid: null, status: 'off' })
  const bucket = Math.floor(sceneMs / (kind === 'wind' ? 3 * HOUR : HOUR))
  const latest = useRef(sceneMs)
  latest.current = sceneMs
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const t = window.setInterval(() => setTick((n) => n + 1), REFRESH_MS) // new model runs appear through the day
    return () => window.clearInterval(t)
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.status === 'off' ? s : { grid: null, status: 'off' }))
      return
    }
    const ctl = new AbortController()
    // a short wait, so dragging the date slider does not fetch every step it passes
    const timer = window.setTimeout(() => {
      setState((s) => ({ grid: s.grid, status: s.grid ? 'live' : 'loading' }))
      fetchFlow(kind, level, latest.current, ctl.signal)
        .then((grid) => setState({ grid, status: 'live' }))
        .catch((e: unknown) => {
          if (ctl.signal.aborted) return
          if (e instanceof FlowNoData) setState((s) => ({ grid: null, status: 'nodata', message: s.message }))
          else setState((s) => ({ grid: s.grid, status: 'error', message: e instanceof Error ? e.message : 'could not load' }))
        })
    }, 350)
    return () => {
      window.clearTimeout(timer)
      ctl.abort()
    }
  }, [enabled, kind, level, bucket, tick])

  return state
}
